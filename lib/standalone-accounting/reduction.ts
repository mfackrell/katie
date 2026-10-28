import { canonicalJson, estimatePreparedRequest, freezePreparedRequest, type FrozenPreparedRequest, type JsonObject, type JsonValue, type StandaloneEstimate } from "./estimate";
import { deepFreeze, getModelPrice } from "./pricing";
export type ReductionOptions = {maxContextMessages?:number;maxImages?:number;maxOutputTokens?:number;lowerImageDetail?:boolean};
export type ReductionChange={kind:"duplicate"|"context"|"image"|"detail"|"output"|"model";path:string;before:number|string;after:number|string};
export type ReducedPreparedRequest={available:boolean;originalHash:string;revised:FrozenPreparedRequest;estimate:StandaloneEstimate;changes:ReductionChange[];tradeoffs:string[]};
const asObject=(x:JsonValue|undefined):JsonObject=>x&&typeof x==="object"&&!Array.isArray(x)?x as JsonObject:{};
/** New candidate only. The approved request and approval identity are never edited. */
export function reducePreparedRequest(original:FrozenPreparedRequest,options:ReductionOptions={}):ReducedPreparedRequest {
  if(freezePreparedRequest(original.provider,original.model,original.endpoint,original.payload).hash!==original.hash)throw new Error("Prepared request hash mismatch");
  const body=JSON.parse(canonicalJson(original.payload)) as JsonObject;
  const changes:ReductionChange[]=[];const tradeoffs=new Set<string>();
  const maxContext=options.maxContextMessages??4,maxImages=options.maxImages??2,maxOutput=options.maxOutputTokens??2048;
  if(![maxContext,maxImages,maxOutput].every(Number.isSafeInteger)||maxContext<1||maxImages<0||maxOutput<1)throw new Error("Invalid reduction options");
  const hasContinuation=(value:JsonValue):boolean=> {
    if(Array.isArray(value))return value.some(hasContinuation);
    if(!value||typeof value!=="object")return false;
    if(["function_call","function_call_output","tool_use","tool_result","thinking","reasoning","redacted_thinking"].includes(String(value.type))||value.tool_calls||value.tool_call_id||value.functionCall||value.functionResponse||value.thoughtSignature)return true;
    return Object.values(value).some(hasContinuation);
  };
  const preserveContinuation=hasContinuation(body.messages??body.input??body.contents??[]);
  if(preserveContinuation)tradeoffs.add("Native function calls, results and preserved reasoning stay intact; context pruning is skipped to preserve continuation dependencies.");
  const historyKey=Array.isArray(body.messages)?"messages":Array.isArray(body.input)?"input":Array.isArray(body.contents)?"contents":undefined;
  if(historyKey&&!preserveContinuation) {
    const messages=body[historyKey] as JsonValue[];
    const last=messages.length-1;const seen=new Set<string>();
    let deduped=messages.filter((message,index)=>{
      const role=asObject(message).role;
      // Never remove the final message or instruction roles; dedupe only older identical conversation turns.
      if(index===last||!["user","assistant","model"].includes(String(role)))return true;
      const identity=canonicalJson(message);if(seen.has(identity)){changes.push({kind:"duplicate",path:`${historyKey}[${index}]`,before:1,after:0});return false;}seen.add(identity);return true;
    });
    const contextIndexes=deduped.flatMap((m,i)=>["user","assistant","model"].includes(String(asObject(m).role))?[i]:[]);
    const keep=new Set(contextIndexes.slice(-maxContext));
    deduped=deduped.filter((m,i)=>{if(!contextIndexes.includes(i)||keep.has(i))return true;changes.push({kind:"context",path:`${historyKey}[${i}]`,before:1,after:0});tradeoffs.add("Older conversation turns are omitted; the model may lose earlier decisions and references.");return false;});
    body[historyKey]=deduped;
  }
  const imageSeen=new Set<string>();let keptImages=0;
  const finalPromptPrefix=historyKey&&Array.isArray(body[historyKey])?`payload.${historyKey}[${(body[historyKey] as JsonValue[]).length-1}]`:undefined;
  const isImage=(part:JsonObject)=>part.type==="input_image"||part.type==="image_url"||part.type==="image"||String(asObject(part.inlineData??part.inline_data).mimeType??asObject(part.inlineData??part.inline_data).mime_type??"").startsWith("image/");
  const walk=(value:JsonValue,path:string):JsonValue=> {
    // Never edit tool arguments/results, schemas or signed/opaque continuation blocks.
    if(preserveContinuation&&(path==="payload.messages"||path==="payload.input"||path==="payload.contents"))return value;
    if(["payload.tools","payload.response_format","payload.output_config","payload.generationConfig.responseJsonSchema","payload.generationConfig.responseSchema","payload.config.responseJsonSchema","payload.config.responseSchema"].includes(path))return value;
    if(typeof value==="string") {
      if(finalPromptPrefix&&path.startsWith(finalPromptPrefix+"."))return value;
      // Existing adapters embed history in system strings using this exact bounded marker.
      return value.replace(/\[EPISODIC_MEMORY_LOG\]\n([\s\S]*?)\n\[\/EPISODIC_MEMORY_LOG\]/g,(full,history:string)=>{
        const turns=history.split(/\n(?=(?:USER|ASSISTANT): )/);
        const unique=turns.filter((turn,index)=>turns.indexOf(turn)===index);
        const kept=unique.slice(-maxContext);
        if(kept.length===turns.length)return full;
        changes.push({kind:"context",path,before:turns.length,after:kept.length});
        tradeoffs.add("Older embedded history turns are omitted; the model may lose earlier decisions and references.");
        return "[EPISODIC_MEMORY_LOG]\n"+kept.join("\n")+"\n[/EPISODIC_MEMORY_LOG]";
      });
    }
    if(Array.isArray(value))return value.flatMap((entry,index)=>{
      const part=asObject(entry);if(isImage(part)) {
        const identity=canonicalJson(part);const duplicate=imageSeen.has(identity);imageSeen.add(identity);
        if(duplicate||keptImages>=maxImages){changes.push({kind:duplicate?"duplicate":"image",path:`${path}[${index}]`,before:1,after:0});tradeoffs.add("Removed images will not be available for visual comparison or small-detail inspection.");return [];}
        keptImages++;
        if((options.lowerImageDetail??true)&&original.provider==="openai"&&getModelPrice(original.provider,original.model)?.vision?.kind==="tiles"){
          const nested=asObject(part.image_url);const old=String(part.detail??nested.detail??"auto");
          if(old!=="low"){if(part.type==="image_url"&&Object.keys(nested).length)nested.detail="low";else part.detail="low";changes.push({kind:"detail",path:`${path}[${index}].detail`,before:old,after:"low"});tradeoffs.add("Low image detail may miss small text, subtle differences and precise spatial details.");}
        }
      }
      return [walk(entry,`${path}[${index}]`)];
    });
    if(value&&typeof value==="object") {for(const key of Object.keys(value))value[key]=walk(value[key],`${path}.${key}`);}
    return value;
  };
  walk(body,"payload");
  const config=asObject(body.generationConfig??body.config);
  const capOwner=original.provider==="google"?config:body;
  const capKey=original.provider==="google"?"maxOutputTokens":["max_output_tokens","max_completion_tokens","max_tokens"].find(k=>body[k]!==undefined);
  if(capKey&&typeof capOwner[capKey]==="number"&&Number(capOwner[capKey])>maxOutput){changes.push({kind:"output",path:capKey,before:Number(capOwner[capKey]),after:maxOutput});capOwner[capKey]=maxOutput;tradeoffs.add("A smaller output allowance can shorten answers or exhaust reasoning before a complete response.");}
  const thinking=asObject(body.thinking);
  if(thinking.type==="enabled"&&typeof thinking.budget_tokens==="number"&&Number(capOwner[capKey??""])<=thinking.budget_tokens) {
    // A legacy thinking budget must remain below max_tokens. No invalid revised request.
    const newCap=Number(capOwner[capKey??""]);
    if(newCap>1024){const before=thinking.budget_tokens;thinking.budget_tokens=newCap-1;changes.push({kind:"output",path:"thinking.budget_tokens",before,after:newCap-1});}
    else if(capKey){capOwner[capKey]=original.payload[capKey];const index=changes.findIndex(c=>c.path===capKey);if(index>=0)changes.splice(index,1);}
  }
  const baseline=estimatePreparedRequest(original);
  const smaller=(quote:StandaloneEstimate,than:StandaloneEstimate)=>quote.status==="estimated"&&than.status==="estimated"&&quote.reservationMicrousd!==null&&than.reservationMicrousd!==null&&BigInt(quote.reservationMicrousd)<BigInt(than.reservationMicrousd);
  let revised=freezePreparedRequest(original.provider,original.model,original.endpoint,body),estimate=estimatePreparedRequest(revised);
  // Prove that a requested lever, independently of shortening the output, lowers the quote.
  const listedOnly=JSON.parse(canonicalJson(body)) as JsonObject;
  for(const key of ["max_output_tokens","max_completion_tokens","max_tokens"])if(original.payload[key]!==undefined)listedOnly[key]=original.payload[key];
  if(original.provider==="google") {const key=original.payload.config?"config":"generationConfig";const config=asObject(listedOnly[key]);const prior=asObject(original.payload[key]);if(prior.maxOutputTokens!==undefined)config.maxOutputTokens=prior.maxOutputTokens;}
  if(original.payload.thinking!==undefined)listedOnly.thinking=original.payload.thinking;
  const listedEffect=changes.some(change=>change.kind!=="output")&&smaller(estimatePreparedRequest(freezePreparedRequest(original.provider,original.model,original.endpoint,listedOnly)),baseline);
  if(!listedEffect) {
    const candidates:Record<string,string>={
      "gpt-4o":"gpt-4o-mini","gpt-4.1":"gpt-4o-mini",
      "gpt-5.4-pro":"gpt-5.4","gpt-5.4-pro-2026-03-05":"gpt-5.4",
      "gpt-5.5-pro":"gpt-5.4","gpt-5.5-pro-2026-04-23":"gpt-5.4",
      "claude-opus-4-6":"claude-sonnet-4-6","claude-opus-5-5":"claude-sonnet-5-5",
      "grok-4.7":"grok-4.3","grok-4.6":"grok-4.3",
    };
    const hasOpaqueState=(value:JsonValue):boolean=>Array.isArray(value)?value.some(hasOpaqueState):!!value&&typeof value==="object"?(["reasoning","thinking","redacted_thinking"].includes(String(value.type))||value.thoughtSignature!==undefined||Object.values(value).some(hasOpaqueState)):false;
    const target=candidates[original.model];
    // Model-bound opaque state cannot safely be transplanted, even between the same provider's models.
    if(target&&getModelPrice(original.provider,target)&&!hasOpaqueState(body.messages??body.input??body.contents??[])) {
      const candidateBody=JSON.parse(canonicalJson(body)) as JsonObject;
      if(candidateBody.model!==undefined)candidateBody.model=target;
      const sourceThinking=asObject(candidateBody.thinking),effort=asObject(candidateBody.output_config).effort;
      const compatible=!(target==="claude-sonnet-4-6"&&effort==="xhigh")&&!(target==="claude-sonnet-5-5"&&sourceThinking.type==="disabled");
      if(compatible) {
        const candidate=freezePreparedRequest(original.provider,target,original.endpoint,candidateBody),quote=estimatePreparedRequest(candidate);
        if(smaller(quote,baseline)) {
          revised=candidate;estimate=quote;changes.push({kind:"model",path:"model",before:original.model,after:target});
          tradeoffs.add(`Use ${target} instead of ${original.model}. The lower-cost model may produce less accurate reasoning, weaker complex-code analysis, or less complete instruction following. Review this model change before approving the new request.`);
        }
      }
    }
  }
  if(!smaller(estimate,baseline)||(!listedEffect&&!changes.some(change=>change.kind==="model"))) {
    const unchanged=freezePreparedRequest(original.provider,original.model,original.endpoint,original.payload);
    return deepFreeze({available:false,originalHash:original.hash,revised:unchanged,estimate:baseline,changes:[],tradeoffs:["No smaller supported proposal using context, images, image detail or a reviewed compatible model is available. The original request and approval are unchanged."]});
  }
  return deepFreeze({available:true,originalHash:original.hash,revised,estimate,changes,tradeoffs:[...tradeoffs]});
}
