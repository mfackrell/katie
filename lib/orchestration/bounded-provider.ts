import OpenAI from 'openai';
import type {OrchestrationChoice} from './routing';

type Item=Record<string,unknown>;
type GooglePart={text?:string;thought?:boolean;functionCall?:{id?:string;name:string;args:unknown};[key:string]:unknown};
type GoogleContent={role:string;parts:GooglePart[]};
type ClaudeBlock={type:string;text?:string;id?:string;name?:string;input?:unknown;citations?:Array<{url?:string;title?:string}>};
type WireInput={nativeAnthropic?:ClaudeBlock[];nativeGoogle?:GoogleContent;type?:string;call_id?:string;output?:string;role?:string;content?:unknown};
type NativeResponse={content?:ClaudeBlock[];stop_reason?:string;usage?:{input_tokens?:number;output_tokens?:number;cache_read_input_tokens?:number;cache_creation_input_tokens?:number};candidates?:Array<{content?:GoogleContent;finishReason?:string}>;usageMetadata?:{totalTokenCount?:number}};
export type BoundedRequest={model:string;instructions:string;input:unknown[];max_output_tokens:number;executionEffort?:'low'|'medium';tools?:Array<{type:string;name?:string;description?:string;parameters?:unknown}>;text?:{format?:{type?:string;name?:string;schema?:unknown}};[key:string]:unknown};
type BoundedResponse={status?:string;output_text?:string;output:unknown[];usage?:{total_tokens?:number};incomplete_details?:{reason?:string}|null;error?:{code?:string;message?:string}|null};
type Client={post:(path:string,options:{body:Record<string,unknown>;timeout:number})=>Promise<{input_tokens:number}>;responses:{create:(request:BoundedRequest,options:{timeout:number})=>Promise<BoundedResponse>}};

/** Counting and generation MUST serialize the same system prompt, schema,
 * messages and tool definitions. Counting never invokes a generative model. */
function nativeRequest(provider:string,request:BoundedRequest){
 const calculator=request.tools?.find(t=>t.type==='function');
 const research=request.tools?.some(t=>t.type==='web_search');
 const schema=request.text?.format?.schema;
 // Review schemas use only the common native JSON Schema subset. Other
 // contracts retain their existing prompt and server validation behavior.
 const nativeReviewSchema=schema&&/^mission_review_(assessment|comparison|source)$/.test(request.text?.format?.name??'')?schema:undefined;
 const instructions=request.instructions+(schema?'\nReturn ONLY JSON matching this schema: '+JSON.stringify(schema):request.text?.format?'\nReturn ONLY valid JSON.':'');
 let url:string,headers:Record<string,string>,body:Item;
 if(provider==='anthropic'){
  const key=process.env.CLAUDE_API_KEY??process.env.claude_api_key;if(!key)throw Error('Selected Anthropic connection unavailable');
  url='https://api.anthropic.com/v1/messages';headers={'x-api-key':key,'anthropic-version':'2023-06-01'};
  const messages:Item[]=[];
  for(const item of request.input as WireInput[]){
   if(item.nativeAnthropic){messages.push({role:'assistant',content:item.nativeAnthropic});continue;}
   if(item.type==='function_call')continue;
   if(item.type==='function_call_output'){const last=messages.at(-1);const block={type:'tool_result',tool_use_id:item.call_id,content:item.output};if(last?.role==='user'&&Array.isArray(last.content))last.content.push(block);else messages.push({role:'user',content:[block]});continue;}
   if(item.role)messages.push({role:item.role,content:item.content});
  }
  body={model:request.model,max_tokens:request.max_output_tokens,system:instructions,messages,
   ...((request.executionEffort||nativeReviewSchema)&&/^claude-(?:opus|sonnet|haiku|fable|mythos)-5(?:-|$)/.test(request.model)?{output_config:{...(request.executionEffort?{effort:request.executionEffort}:{}),...(nativeReviewSchema?{format:{type:'json_schema',schema:nativeReviewSchema}}:{})}}:{}),
   ...(research?{tools:[{type:'web_search_20250305',name:'web_search',max_uses:4}]}:calculator?{tools:[{name:calculator.name,description:calculator.description,input_schema:calculator.parameters}]}:{})};
 }else{
  if(provider!=='google')throw Error('Unsupported native provider');
  if(research)throw Error('Gemini bounded native search unavailable');
  const key=process.env.GOOGLE_API_KEY;if(!key)throw Error('Selected Google connection unavailable');
  url='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(request.model.replace(/^models\//,''))+':generateContent';headers={'x-goog-api-key':key};
  const contents:GoogleContent[]=[];
  for(const item of request.input as WireInput[]){
   if(item.nativeGoogle){contents.push(item.nativeGoogle);continue;}
   if(item.type==='function_call')continue;
   if(item.type==='function_call_output'){const part={functionResponse:{name:'calculate',...(item.call_id?.startsWith('google-')?{}:{id:item.call_id}),response:JSON.parse(item.output??'{}')}};const last=contents.at(-1);if(last?.role==='user')last.parts.push(part);else contents.push({role:'user',parts:[part]});continue;}
   if(item.role)contents.push({role:item.role==='assistant'?'model':'user',parts:[{text:String(item.content??'')}]});
  }
  body={systemInstruction:{parts:[{text:instructions}]},contents,generationConfig:{maxOutputTokens:request.max_output_tokens,...(request.executionEffort&&/^gemini-3(?:[.-])/.test(request.model.replace(/^models\//,''))?{thinkingConfig:{thinkingLevel:request.executionEffort==='low'?'LOW':/flash/.test(request.model)?'MEDIUM':'HIGH'}}:{}),...(request.text?.format?{responseMimeType:'application/json',...(nativeReviewSchema?{responseJsonSchema:nativeReviewSchema}:{})}:{})},
   ...(calculator?{tools:[{functionDeclarations:[{name:calculator.name,description:calculator.description,parametersJsonSchema:calculator.parameters}]}]}:{})};
 }
 return{url,headers,body};
}
async function nativePost(url:string,headers:Record<string,string>,body:Item,timeout:number){
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
 if(!response.ok){
  const detail=(await response.text()).slice(0,600);
  let code='';try{const parsed=JSON.parse(detail);code=String(parsed.error?.type??parsed.error?.code??'');}catch{/* HTTP status still classifies this failure. */}
  throw Object.assign(Error('Native provider request failed ('+response.status+'): '+detail),{status:response.status,code,requestId:response.headers.get('request-id')??response.headers.get('x-request-id')});
 }
 return response;
}
/** No chat continuation loops, SDK retries, or hidden inference calls. */
export function boundedProvider(choice:OrchestrationChoice):Client{
 const provider=choice.provider.name;
 if(provider==='openai'||provider==='grok'){
  const apiKey=provider==='openai'?process.env.OPENAI_API_KEY:process.env.GROK_API_KEY??process.env.XAI_API_KEY??process.env.grok_api_key;
  if(!apiKey)throw Error('Selected provider connection unavailable: '+provider);
  const client=new OpenAI({apiKey,maxRetries:0,timeout:90_000,fetch:globalThis.fetch.bind(globalThis),...(provider==='grok'?{baseURL:'https://api.x.ai/v1'}:{})});
  return{
   post:async(path,options):Promise<{input_tokens:number}>=>{if(provider!=='openai')throw Error('Conservative byte counting required');const body={...options.body};delete body.executionEffort;return client.post(path,{...options,body});},
   responses:{create:async(request,options)=>{
    const body:Item={...request};delete body.executionEffort;
    if(provider==='grok'){body.tools=request.tools?.map(tool=>{const native:Item={...tool};delete native.search_context_size;return native;});delete body.reasoning;delete body.text;delete body.include;body.input=[{role:'system',content:body.instructions},...request.input];delete body.instructions;}
    return client.responses.create(body as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,options);
   }}
  };
 }
 return{
  post:async(path,options)=>{
   if(path!=='/responses/input_tokens')throw Error('Unsupported token-count operation');
   const request=options.body as BoundedRequest;
   const native=nativeRequest(provider,request);
   let url:string,body:Item;
   if(provider==='anthropic'){
    // Anthropic does not count server-side search tools. Fall back to the
    // existing conservative reservation for those requests, never drop tools.
    if(request.tools?.some(t=>t.type==='web_search'))throw Error('Native search token count unavailable');
    url=native.url+'/count_tokens';body={...native.body};delete body.max_tokens;
   }else{
    url=native.url.replace(/:generateContent$/,':countTokens');
    body={generateContentRequest:{...native.body,model:'models/'+request.model.replace(/^models\//,'')}};
   }
   const response=await nativePost(url,native.headers,body,options.timeout);
   const raw=await response.json() as {input_tokens?:number;totalTokens?:number};
   const tokens=provider==='anthropic'?raw.input_tokens:raw.totalTokens;
   if(!Number.isSafeInteger(tokens)||typeof tokens!=='number'||tokens<0)throw Error('Invalid native token count');
   return{input_tokens:tokens};
  },
  responses:{create:async(request,options)=>{
   const native=nativeRequest(provider,request);
   const response=await nativePost(native.url,native.headers,native.body,options.timeout);
   const raw:NativeResponse=await response.json();
   const output:Item[]=[];let text='',truncated=false,usage=0,incompleteReason='unknown';
   if(provider==='anthropic'){
    output.push({nativeAnthropic:raw.content});
    for(const block of raw.content??[]){
     if(block.type==='tool_use')output.push({type:'function_call',name:block.name,call_id:block.id,arguments:JSON.stringify(block.input)});
     if(block.type==='text'){text+=block.text;output.push({content:[{annotations:(block.citations??[]).filter(c=>typeof c.url==='string').map(c=>({type:'url_citation',url:c.url,title:c.title??''}))}]});}
    }
    truncated=!['end_turn','tool_use'].includes(raw.stop_reason??'');incompleteReason=raw.stop_reason==='max_tokens'?'max_output_tokens':String(raw.stop_reason??'missing_stop_reason');
    usage=(raw.usage?.input_tokens??0)+(raw.usage?.output_tokens??0)+(raw.usage?.cache_read_input_tokens??0)+(raw.usage?.cache_creation_input_tokens??0);
   }else{
    const candidate=raw.candidates?.[0],parts=candidate?.content?.parts??[];
    if(candidate?.content)output.push({nativeGoogle:candidate.content});
    for(const [index,part] of parts.entries()){
     if(part.functionCall)output.push({type:'function_call',name:part.functionCall.name,call_id:part.functionCall.id??'google-'+index,arguments:JSON.stringify(part.functionCall.args)});
     if(part.text&&!part.thought)text+=part.text;
    }
    truncated=candidate?.finishReason!=='STOP';incompleteReason=candidate?.finishReason==='MAX_TOKENS'?'max_output_tokens':String(candidate?.finishReason??'missing_candidate');usage=raw.usageMetadata?.totalTokenCount??0;
   }
   return{status:truncated?'incomplete':'completed',incomplete_details:truncated?{reason:incompleteReason}:undefined,output_text:text,output,usage:{total_tokens:usage||undefined}};
  }}
 };
}
