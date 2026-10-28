import { createHash } from "node:crypto";
import { deepFreeze, getModelPrice, priceTokenUsage, PRICING_VERSION, type AccountingProvider, type ModelPrice } from "./pricing";
/** Changing counting/admissibility rules requires a new estimator identity. */
export const ESTIMATOR_VERSION = "standalone-estimator-v2";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key:string]: JsonValue };
export type JsonObject = { [key:string]: JsonValue };
export type FrozenPreparedRequest = Readonly<{schemaVersion:"standalone-request-v1";provider:AccountingProvider;model:string;endpoint:string;payload:JsonObject;hash:string;serializedBody:string}>;
export type StandaloneEstimate = {
  status:"estimated"|"unsupported";pricingVersion:string;estimatorVersion:string;requestHash:string;currency:"USD";isCeiling:false;
  estimatedCostMicrousd:string|null;reservationMicrousd:string|null;inputTokens:number;outputAllowance:number;imageTokens:number;
  issues:string[];assumptions:string[];breakdown:Array<{dimension:string;tokens:number;costMicrousd:string}>;
};
export function canonicalJson(value: unknown): string {
  if (value===null||typeof value==="string"||typeof value==="boolean") return JSON.stringify(value);
  if (typeof value==="number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "["+value.map(canonicalJson).join(",")+"]";
  if (value && typeof value==="object" && Object.getPrototypeOf(value)===Object.prototype) return "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonicalJson((value as Record<string,unknown>)[key])).join(",")+"}";
  throw new Error("Prepared request must contain only finite JSON values");
}
export function freezePreparedRequest(provider: AccountingProvider,model:string,endpoint:string,payload:unknown):FrozenPreparedRequest {
  const serializedBody=canonicalJson(payload);const clone=JSON.parse(serializedBody) as JsonObject;
  if (!clone||Array.isArray(clone)||typeof clone!=="object") throw new Error("Request body must be a JSON object");
  const data={schemaVersion:"standalone-request-v1" as const,provider,model,endpoint,payload:clone};
  const hash=createHash("sha256").update(canonicalJson(data)).digest("hex");
  return deepFreeze({...data,hash,serializedBody});
}
export function outputCapField(provider:AccountingProvider,endpoint:string):string {
  if(provider==="google") return "maxOutputTokens";
  return /responses/.test(endpoint)?"max_output_tokens":"max_tokens";
}
export function prepareStandaloneRequest(provider:AccountingProvider,model:string,endpoint:string,payload:unknown):FrozenPreparedRequest {
  const body=JSON.parse(canonicalJson(payload)) as JsonObject;
  if(provider==="google") {
    const config=(body.generationConfig??body.config??{}) as JsonObject;
    if(config.maxOutputTokens===undefined) config.maxOutputTokens=4096;
    if(body.config) body.config=config;else body.generationConfig=config;
  } else if(body.max_tokens===undefined&&body.max_completion_tokens===undefined&&body.max_output_tokens===undefined) body[provider==="openai"&&!/responses/.test(endpoint)&&/^(gpt-[56]|o[1-9])/.test(model)?"max_completion_tokens":outputCapField(provider,endpoint)]=4096;
  return freezePreparedRequest(provider,model,endpoint,body);
}
const obj=(x:JsonValue|undefined):JsonObject => x&&typeof x==="object"&&!Array.isArray(x)?x as JsonObject:{};
const positiveInt=(x:unknown):x is number => Number.isSafeInteger(x)&&Number(x)>0;
const byteTokens=(text:string)=>Buffer.byteLength(text,"utf8");
/** Read dimensions from inline PNG/GIF/JPEG/WebP. Never dereference mutable external URLs. */
export function inlineImageDimensions(url:string):{width:number;height:number}|undefined {
  const match=/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
  if(!match)return;const b=Buffer.from(match[1],"base64");let width=0,height=0;
  if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {width=b.readUInt32BE(16);height=b.readUInt32BE(20);}
  else if(b.length>=10&&/^GIF8[79]a$/.test(b.toString("ascii",0,6))) {width=b.readUInt16LE(6);height=b.readUInt16LE(8);}
  else if(b.length>=30&&b.toString("ascii",0,4)==="RIFF"&&b.toString("ascii",8,12)==="WEBP") {
    if(b.toString("ascii",12,16)==="VP8X") {width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);}
    else if(b.toString("ascii",12,16)==="VP8 "&&b[23]===157&&b[24]===1&&b[25]===42) {width=b.readUInt16LE(26)&16383;height=b.readUInt16LE(28)&16383;}
    else if(b.toString("ascii",12,16)==="VP8L"&&b[20]===47) {const bits=b.readUInt32LE(21);width=1+(bits&16383);height=1+((bits>>>14)&16383);}
  } else if(b.length>4&&b[0]===255&&b[1]===216) {
    let i=2;while(i+8<b.length) {if(b[i]!==255)break;const marker=b[i+1];if(marker===217||marker===218)break;const len=b.readUInt16BE(i+2);if(len<2||i+2+len>b.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){height=b.readUInt16BE(i+5);width=b.readUInt16BE(i+7);break;}i+=2+len;}
  }
  if(positiveInt(width)&&positiveInt(height)&&width<=100000&&height<=100000)return{width,height};
}
function estimateVision(price:ModelPrice,url:string,detail:string,issues:string[],assumptions:string[]):number {
  if(!price.vision){issues.push("Image billing is unsupported for this model");return 0;}
  if(price.vision.kind==="claude") {assumptions.push("Claude image allowance uses documented per-image visual-token maximum");return price.vision.maximum;}
  if(price.vision.kind==="tiles"&&detail==="low")return price.vision.base;
  const dimensions=inlineImageDimensions(url);
  if(!dimensions){issues.push("Image dimensions are unavailable from immutable inline image bytes");return 0;}
  let {width,height}=dimensions;
  if(price.vision.kind==="gemini25") {if(width<=384&&height<=384)return 258;const crop=Math.max(1,Math.floor(Math.min(width,height)/1.5));assumptions.push("Gemini 2.5 image allowance uses documented approximate crop formula");return Math.ceil(width/crop)*Math.ceil(height/crop)*258;}
  if(!["low","high","auto"].includes(detail)){issues.push("Unknown image detail");return 0;}
  const fit=Math.min(1,2048/Math.max(width,height));width*=fit;height*=fit;
  const short=Math.min(width,height);if(short>768){const resize=768/short;width=Math.floor(width*resize);height=Math.floor(height*resize);}
  return price.vision.base+Math.ceil(width/512)*Math.ceil(height/512)*price.vision.tile;
}
function validEndpoint(r:FrozenPreparedRequest):boolean {
  let path=r.endpoint;
  if(/^https?:/.test(path)) {try{const u=new URL(path);const hosts={openai:"api.openai.com",anthropic:"api.anthropic.com",google:"generativelanguage.googleapis.com",grok:"api.x.ai"};if(u.protocol!=="https:"||u.hostname!==hosts[r.provider]||(u.search&&!(r.provider==="google"&&u.search==="?alt=sse")))return false;path=u.pathname;}catch{return false;}}
  if(r.provider==="google")return /^\/v1(?:beta)?\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/.test(path);
  if(r.provider==="anthropic")return path==="/v1/messages";
  return ["/v1/responses","/v1/chat/completions","responses","chat-completions"].includes(path);
}
export function estimatePreparedRequest(request:FrozenPreparedRequest):StandaloneEstimate {
  const issues:string[]=[];const assumptions=["Input text allowance is one token per UTF-8 byte plus framing allowance; it is an estimate, not a provider token count or guaranteed spending ceiling.","All allowed output tokens are reserved, including hidden reasoning/thinking. No future cache-hit discount is assumed."];
  let textTokens=256,imageTokens=0,outputAllowance=0;
  const price=getModelPrice(request.provider,request.model),body=request.payload;
  if(request.schemaVersion!=="standalone-request-v1")issues.push("Unsupported prepared request schema version");
  try {if(freezePreparedRequest(request.provider,request.model,request.endpoint,body).hash!==request.hash||canonicalJson(body)!==request.serializedBody)issues.push("Prepared request hash or serialized body mismatch");}catch{issues.push("Invalid prepared request");}
  if(!price)issues.push("No reviewed immutable price for this exact provider/model");
  if(!validEndpoint(request))issues.push("Unsupported endpoint or billing region");
  if(price?.responsesOnly&&!/responses$/.test(request.endpoint))issues.push("This model requires the Responses endpoint");
  if(price?.supportsStreaming===false&&body.stream===true)issues.push("Streaming is unsupported for this exact model");
  if(body.model!==undefined&&body.model!==request.model)issues.push("Body model differs from prepared model");
  if(request.provider==="google") {const pathModel=request.endpoint.match(/\/models\/([^/]+):/);if(pathModel&&decodeURIComponent(pathModel[1])!==request.model)issues.push("Google endpoint model differs from prepared model");}
  const topAllowed=request.provider==="google"?"model contents generationConfig config systemInstruction safetySettings tools toolConfig cachedContent":"model messages input instructions system max_tokens max_output_tokens max_completion_tokens stream stream_options temperature top_p stop stop_sequences seed presence_penalty frequency_penalty logprobs top_logprobs response_format text reasoning reasoning_effort store metadata user n tools tool_choice parallel_tool_calls service_tier"+(request.provider==="anthropic"?" thinking output_config":"");
  for(const key of Object.keys(body))if(!topAllowed.split(" ").includes(key))issues.push("Unpriced request field: "+key);
  if(body.cachedContent!==undefined)issues.push("Unsupported billing dimension: cachedContent");
  if(body.service_tier!==undefined&&body.service_tier!=="default")issues.push("Unsupported service tier");
  if(body.n!==undefined&&body.n!==1)issues.push("Multiple output candidates are unsupported");
  const onlyKeys=(part:JsonObject,keys:string,label:string):void=>{const allowed=new Set(keys.split(" "));for(const key of Object.keys(part))if(!allowed.has(key))issues.push(`Unsupported ${label} field: ${key}`);};
  const countJson=(value:JsonValue|undefined):void=>{if(value!==undefined)textTokens+=byteTokens(canonicalJson(value));};
  const stringField=(part:JsonObject,key:string,label:string):void=>{if(typeof part[key]!=="string"||!(part[key] as string).length)issues.push(`Invalid ${label} ${key}`);};
  const functionSchema=(definition:JsonObject,google=false):void=>{
    onlyKeys(definition,google?"name description parameters parametersJsonSchema response responseJsonSchema":"name description parameters strict","function definition");
    stringField(definition,"name","function definition");
    if(definition.description!==undefined&&typeof definition.description!=="string")issues.push("Invalid function description");
    if(definition.strict!==undefined&&typeof definition.strict!=="boolean")issues.push("Invalid function strict option");
    if(definition.parameters!==undefined&&definition.parametersJsonSchema!==undefined)issues.push("Conflicting function parameter schemas");
  };
  if(body.tools!==undefined) {
    if(!Array.isArray(body.tools))issues.push("Invalid tools list");
    else for(const toolValue of body.tools) {
      const tool=obj(toolValue);
      if(request.provider==="anthropic") {
        onlyKeys(tool,"name description input_schema strict","client tool definition");stringField(tool,"name","client tool definition");
        if(!tool.input_schema||typeof tool.input_schema!=="object"||Array.isArray(tool.input_schema))issues.push("Invalid client tool input_schema");
        if(tool.strict!==undefined&&typeof tool.strict!=="boolean")issues.push("Invalid client tool strict option");
      } else if(request.provider==="google") {
        onlyKeys(tool,"functionDeclarations","function tool");
        if(!Array.isArray(tool.functionDeclarations)||!tool.functionDeclarations.length)issues.push("Only local function declarations are supported");
        else tool.functionDeclarations.forEach(definition=>functionSchema(obj(definition),true));
      } else {
        if(tool.type!=="function")issues.push("Only local function tools are priced; server tools remain unsupported");
        if(tool.function!==undefined) {onlyKeys(tool,"type function","function tool");functionSchema(obj(tool.function));}
        else {onlyKeys(tool,"type name description parameters strict","function tool");const {type:ignored,...definition}=tool;void ignored;functionSchema(definition);}
      }
      countJson(toolValue);
    }
    if(Array.isArray(body.tools)&&body.tools.length){textTokens+=1024;assumptions.push("Local function schemas are counted from exact canonical bytes plus a 1,024-token tool framing allowance; no provider-hosted tool fee is assumed.");}
  }
  if(body.toolConfig!==undefined) {
    const config=obj(body.toolConfig);onlyKeys(config,"functionCallingConfig","toolConfig");const fc=obj(config.functionCallingConfig);onlyKeys(fc,"mode allowedFunctionNames","functionCallingConfig");
    if(fc.mode!==undefined&&!["AUTO","ANY","NONE","VALIDATED"].includes(String(fc.mode)))issues.push("Unknown function calling mode");
    if(fc.allowedFunctionNames!==undefined&&(!Array.isArray(fc.allowedFunctionNames)||fc.allowedFunctionNames.some(x=>typeof x!=="string")))issues.push("Invalid allowedFunctionNames");countJson(body.toolConfig);
  }
  if(body.tool_choice!==undefined) {
    const choice=body.tool_choice;
    if(typeof choice==="string") {if(!["auto","none","required"].includes(choice))issues.push("Unknown local tool choice");}
    else {const c=obj(choice);onlyKeys(c,request.provider==="anthropic"?"type name disable_parallel_tool_use":"type name function","tool choice");
      const modes=request.provider==="anthropic"?["auto","any","tool","none"]:["function"];
      if(!modes.includes(String(c.type)))issues.push("Unsupported tool choice");
      if(c.function!==undefined){onlyKeys(obj(c.function),"name","tool choice function");stringField(obj(c.function),"name","tool choice function");}
      if(request.provider==="anthropic"&&request.model.endsWith("5-5")&&["any","tool"].includes(String(c.type)))issues.push("Forced tool choice unsupported for this Claude model");
    }
    countJson(choice);
  }
  const walk=(value:JsonValue|undefined):void=> {
    if(typeof value==="string") {textTokens+=byteTokens(value);return;}
    if(Array.isArray(value)){value.forEach(walk);return;}
    const part=obj(value);if(!Object.keys(part).length)return;
    if(part.cache_control!==undefined){issues.push("Explicit cache writes are unsupported");return;}
    if(part.type==="function_call"||part.type==="function_call_output") {
      if(request.provider!=="openai"&&request.provider!=="grok")issues.push("Function item belongs to a different provider");
      onlyKeys(part,part.type==="function_call"?"type id call_id name arguments status":"type id call_id output status","function item");stringField(part,"call_id","function item");
      if(part.type==="function_call"){stringField(part,"name","function item");if(typeof part.arguments!=="string")issues.push("Function arguments must be serialized JSON");countJson(part);}
      else {if(typeof part.output!=="string"&&!Array.isArray(part.output))issues.push("Unsupported function output");walk(part.output);textTokens+=64;}
      return;
    }
    if(part.type==="tool_use"||part.type==="tool_result") {
      if(request.provider!=="anthropic")issues.push("Claude tool content belongs to a different provider");
      onlyKeys(part,part.type==="tool_use"?"type id name input":"type tool_use_id content is_error","client tool content");
      if(part.type==="tool_use"){stringField(part,"id","tool use");stringField(part,"name","tool use");countJson(part);}
      else {stringField(part,"tool_use_id","tool result");if(part.is_error!==undefined&&typeof part.is_error!=="boolean")issues.push("Invalid tool result is_error");walk(part.content);textTokens+=64;}
      return;
    }
    if(part.functionCall!==undefined||part.functionResponse!==undefined) {
      if(request.provider!=="google")issues.push("Google function content belongs to a different provider");
      onlyKeys(part,"functionCall functionResponse thoughtSignature thought","function part");
      if(part.functionCall!==undefined&&part.functionResponse!==undefined)issues.push("Conflicting Google function part");
      const key=part.functionCall!==undefined?"functionCall":"functionResponse",f=obj(part[key]);onlyKeys(f,key==="functionCall"?"id name args":"id name response","function continuation");stringField(f,"name","function continuation");
      if(key==="functionResponse"&&(!f.response||typeof f.response!=="object"||Array.isArray(f.response)))issues.push("Invalid Google function response");
      countJson(part);return;
    }
    if(part.type==="reasoning"||part.type==="thinking"||part.type==="redacted_thinking") {
      const allowed=part.type==="reasoning"?"type id summary content encrypted_content status":part.type==="thinking"?"type thinking signature":"type data";
      onlyKeys(part,allowed,"preserved reasoning");
      if(part.type==="reasoning"&&request.provider!=="openai")issues.push("Unsupported reasoning provider");
      if(part.type!=="reasoning"&&request.provider!=="anthropic")issues.push("Unsupported thinking provider");
      countJson(part);assumptions.push("Preserved reasoning/signature content is allowed for continuity and counted from canonical bytes; reconstructed hidden input can differ from this heuristic.");return;
    }
    if(part.type==="image_url"||part.type==="input_image") {onlyKeys(part,"type image_url detail","image content");const image=obj(part.image_url);onlyKeys(image,"url detail","image URL");const url=typeof part.image_url==="string"?part.image_url:typeof image.url==="string"?image.url:"";if(price)imageTokens+=estimateVision(price,url,String(part.detail??image.detail??"auto"),issues,assumptions);return;}
    if(part.type==="image") {onlyKeys(part,"type source","Claude image");const source=obj(part.source);onlyKeys(source,"type media_type data url","Claude image source");if(source.type!=="base64"&&source.type!=="url")issues.push("Unsupported image source");if(price)imageTokens+=estimateVision(price,source.type==="base64"?`data:${source.media_type};base64,${source.data}`:String(source.url??""),"auto",issues,assumptions);return;}
    const inline=obj(part.inlineData??part.inline_data);
    if(Object.keys(inline).length) {onlyKeys(part,"inlineData inline_data thought thoughtSignature","inline image content");onlyKeys(inline,"mimeType mime_type data","inline image data");const mime=String(inline.mimeType??inline.mime_type??"");if(!mime.startsWith("image/"))issues.push("Audio/video/native file billing is unsupported");else if(price)imageTokens+=estimateVision(price,`data:${mime};base64,${inline.data}`,"auto",issues,assumptions);countJson(part.thoughtSignature);return;}
    if(part.fileData||part.file_data||part.file_id||part.type==="input_file"||part.type==="document"||part.type==="input_audio"||part.type==="audio"||part.type==="video"){issues.push("Native file or audio/video billing is unsupported");return;}
    onlyKeys(part,"role content parts text type name id status tool_calls tool_call_id annotations logprobs thought thoughtSignature","content");
    if(part.type!==undefined&&!["text","input_text","output_text","message"].includes(String(part.type)))issues.push("Unknown content type: "+part.type);
    textTokens+=32;walk(part.content);walk(part.parts);walk(part.text);if(typeof part.name==="string")walk(part.name);
    if(part.tool_calls!==undefined) {if(!["openai","grok"].includes(request.provider)||!Array.isArray(part.tool_calls))issues.push("Unsupported tool_calls");else part.tool_calls.forEach(call=>{const c=obj(call);onlyKeys(c,"id type function","chat function call");if(c.type!=="function")issues.push("Only function tool calls are supported");const f=obj(c.function);onlyKeys(f,"name arguments","chat function");stringField(f,"name","chat function");if(typeof f.arguments!=="string")issues.push("Invalid chat function arguments");countJson(call);});}
    countJson(part.tool_call_id);countJson(part.annotations);countJson(part.logprobs);countJson(part.thoughtSignature);
  };
  if(request.provider==="google") {
    const config=obj(body.generationConfig??body.config);
    const allowed=new Set(["maxOutputTokens","temperature","topP","topK","stopSequences","candidateCount","responseMimeType","responseSchema","responseJsonSchema","thinkingConfig","responseModalities"]);
    for(const key of Object.keys(config))if(!allowed.has(key))issues.push("Unpriced generationConfig field: "+key);
    if(config.candidateCount!==undefined&&config.candidateCount!==1)issues.push("Multiple output candidates are unsupported");
    if(config.responseModalities!==undefined&&(!Array.isArray(config.responseModalities)||(config.responseModalities as JsonValue[]).some(x=>x!=="TEXT")))issues.push("Non-text output billing is unsupported");
    outputAllowance=Number(config.maxOutputTokens);walk(body.contents);walk(body.systemInstruction);
    if(config.responseSchema)textTokens+=byteTokens(canonicalJson(config.responseSchema));
    if(config.responseJsonSchema)textTokens+=byteTokens(canonicalJson(config.responseJsonSchema));
    const thinking=obj(config.thinkingConfig);for(const key of Object.keys(thinking))if(!["thinkingBudget","thinkingLevel","includeThoughts"].includes(key))issues.push("Unpriced thinking config field: "+key);
    if(thinking.thinkingBudget!==undefined&&(!Number.isSafeInteger(thinking.thinkingBudget)||Number(thinking.thinkingBudget)<0))issues.push("Unbounded or invalid thinking budget");
    if(positiveInt(thinking.thinkingBudget))outputAllowance+=thinking.thinkingBudget;
  } else {
    const caps=[body.max_output_tokens,body.max_completion_tokens,body.max_tokens].filter(x=>x!==undefined);
    if(caps.length!==1)issues.push("Exactly one finite output cap is required");outputAllowance=Number(caps[0]);
    walk(body.messages??body.input);walk(body.instructions);walk(body.system);
    if(body.response_format)textTokens+=byteTokens(canonicalJson(body.response_format));
    if(body.text)textTokens+=byteTokens(canonicalJson(body.text));
    if(body.reasoning){const reasoning=obj(body.reasoning);for(const key of Object.keys(reasoning))if(!["effort","summary"].includes(key))issues.push("Unpriced reasoning field: "+key);}
    if(request.provider==="anthropic") {
      if(body.thinking!==undefined) {
        const thinking=obj(body.thinking);onlyKeys(thinking,"type budget_tokens display","Claude thinking");
        if(!["enabled","disabled","adaptive","between_tools"].includes(String(thinking.type)))issues.push("Unknown Claude thinking type");
        if(thinking.type==="enabled"&&(!positiveInt(thinking.budget_tokens)||thinking.budget_tokens<1024||thinking.budget_tokens>=outputAllowance))issues.push("Claude thinking budget must be finite and below max_tokens");
        if(thinking.type!=="enabled"&&thinking.budget_tokens!==undefined)issues.push("Unexpected Claude thinking budget");
        if(request.model.endsWith("5-5")&&["enabled","disabled"].includes(String(thinking.type)))issues.push("Unsupported thinking mode for this Claude model");
        if(thinking.type==="between_tools"&&(request.model!=="claude-sonnet-5-5"||Object.keys(thinking).length!==1||["xhigh","max"].includes(String(obj(body.output_config).effort))))issues.push("between_tools requires Sonnet 5.5 at high effort or below");
        if(thinking.display!==undefined&&!["summarized","omitted"].includes(String(thinking.display)))issues.push("Unknown Claude thinking display");
        countJson(body.thinking);
      }
      if(body.output_config!==undefined) {
        const output=obj(body.output_config);onlyKeys(output,"effort format","Claude output_config");
        if(output.effort!==undefined&&!["low","medium","high","xhigh","max"].includes(String(output.effort)))issues.push("Unknown Claude output effort");
        if(output.format!==undefined){const format=obj(output.format);onlyKeys(format,"type schema","Claude output format");if(format.type!=="json_schema"||format.schema===undefined)issues.push("Unsupported Claude output format");textTokens+=1024;assumptions.push("Claude structured output schema uses exact canonical bytes plus a 1,024-token allowance for the provider's injected format instructions.");}
        countJson(body.output_config);
      }
    }
  }
  if(!positiveInt(outputAllowance))issues.push("Missing finite positive output allowance");
  const inputTokens=textTokens+imageTokens;
  if(price&&inputTokens+outputAllowance>price.maxContextTokens)issues.push("Estimated input plus output exceeds supported context window");
  if(price&&outputAllowance>price.maxOutputTokens)issues.push("Output allowance exceeds supported model limit");
  const cost=price&&!issues.length?priceTokenUsage(price,inputTokens,outputAllowance):null;
  return deepFreeze({status:issues.length?"unsupported":"estimated",pricingVersion:PRICING_VERSION,estimatorVersion:ESTIMATOR_VERSION,requestHash:request.hash,currency:"USD",isCeiling:false,estimatedCostMicrousd:cost,reservationMicrousd:cost,inputTokens,outputAllowance:Number.isFinite(outputAllowance)?outputAllowance:0,imageTokens,issues:[...new Set(issues)],assumptions:[...new Set(assumptions)],breakdown:cost&&price?[{dimension:"input allowance (including images)",tokens:inputTokens,costMicrousd:priceTokenUsage(price,inputTokens,0)},{dimension:"output allowance (including reasoning)",tokens:outputAllowance,costMicrousd:(BigInt(cost)-BigInt(priceTokenUsage(price,inputTokens,0))).toString()}]:[]});
}
export type BillableUsage = { inputTokens:number;outputTokens:number;cachedInputTokens?:number;[key:string]:unknown };
export function actualCostFromUsage(request:FrozenPreparedRequest,usage:BillableUsage):{actualMicrousd:string;pricingVersion:string} {
  const estimate=estimatePreparedRequest(request);if(estimate.status!=="estimated")throw new Error("Cannot price unsupported request: "+estimate.issues.join("; "));
  const price=getModelPrice(request.provider,request.model)!;
  for(const key of ["cacheCreationInputTokens","toolCalls","audioTokens","imageOutputTokens"])if(usage[key]!==undefined&&usage[key]!==0)throw new Error("Unsupported usage dimension: "+key);
  return {actualMicrousd:priceTokenUsage(price,usage.inputTokens,usage.outputTokens,usage.cachedInputTokens??0),pricingVersion:PRICING_VERSION};
}
