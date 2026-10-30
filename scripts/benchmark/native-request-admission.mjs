import {createHash} from 'node:crypto';
export const NATIVE_ADMISSION_DIAGNOSTICS_VERSION='bounded-schema-v1';
const diagnosticRecords=new WeakMap();
const reasonCodes=new Set(['request-object','nontext-input','client-metadata','prompt-cache-key','request-fields','instructions-type','input-type','stored-context','automatic-truncation','include-fields','input-item-object','reasoning-fields','reasoning-summary','reasoning-content','reasoning-provenance','tool-call-fields','tool-output-fields','text-array','text-part-object','text-part-type','text-part-text','text-part-fields','text-part-annotations','text-part-logprobs','message-role','message-fields','message-type','message-id','message-phase']);
const schemaFields=['model','input','instructions','max_output_tokens','stream','tools','tool_choice','parallel_tool_calls','reasoning','text','temperature','top_p','store','include','metadata','truncation','client_metadata','prompt_cache_key','type','role','content','status','id','phase','summary','encrypted_content','encrypted_function_args','namespace','name','call_id','arguments','output','annotations','logprobs','refusal','response','object','usage','input_tokens','output_tokens','total_tokens','input_tokens_details','output_tokens_details','reasoning_tokens','cached_tokens','incomplete_details','created_at','service_tier','finish_reason','reason'];
const schemaTags=new Set(['message','reasoning','function_call','custom_tool_call','function_call_output','custom_tool_call_output','input_text','output_text','text','summary_text','reasoning_text','input_image','input_audio','input_video','compaction','item_reference']);
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const allowed=(x,keys)=>Object.keys(x).every(k=>keys.includes(k));
// Content-free shape: known keys only, never arbitrary key names, string values,
// ids, encrypted bytes or prompts. Depth and array sampling remain bounded.
export function nativeSchemaShape(value){
 let remaining=128;
 const visit=(node,depth=0)=>{
  if(--remaining<0)return {kind:'truncated'};
  if(node===null)return {kind:'null'};
  if(Array.isArray(node))return {kind:'array',count:node.length,...(depth<6?{items:node.slice(0,12).map(x=>visit(x,depth+1))}:{})};
  if(!object(node))return {kind:typeof node};
  const fields={};
  if(depth<6)for(const key of schemaFields)if(Object.hasOwn(node,key))fields[key]=visit(node[key],depth+1);
  return {kind:'object',...(schemaTags.has(node.type)?{tag:node.type}:{}),unknownFieldCount:Object.keys(node).filter(k=>!schemaFields.includes(k)).length,fields};
 };
 return visit(value);
}
export function nativeAdmissionError(reason,node){
 if(!reasonCodes.has(reason))throw Error('NATIVE_ADMISSION_DIAGNOSTIC_CONFIGURATION');
 const error=Error('GATEWAY_UNBOUNDED_INPUT_DENIED');
 diagnosticRecords.set(error,Object.freeze({version:NATIVE_ADMISSION_DIAGNOSTICS_VERSION,reason,node:nativeSchemaShape(node)}));
 return error;
}
export const nativeAdmissionDiagnostic=error=>diagnosticRecords.get(error);
const denied=(reason,node)=>{throw nativeAdmissionError(reason,node);};
const textParts=x=>{
 if(!Array.isArray(x))denied('text-array',x);
 for(const p of x){
  if(!object(p))denied('text-part-object',p);
  if(!['input_text','output_text','text'].includes(p.type))denied('text-part-type',p);
  if(typeof p.text!=='string')denied('text-part-text',p);
  if(!allowed(p,p.type==='output_text'?['type','text','annotations','logprobs']:['type','text']))denied('text-part-fields',p);
  if(p.annotations!==undefined&&!(p.type==='output_text'&&Array.isArray(p.annotations)&&p.annotations.length===0))denied('text-part-annotations',p);
  if(p.logprobs!==undefined&&!(p.type==='output_text'&&Array.isArray(p.logprobs)&&p.logprobs.length===0))denied('text-part-logprobs',p);
 }
 return true;
};
const reasoningKey=(item,model)=>createHash('sha256').update(JSON.stringify([model,item.id,item.encrypted_content,item.summary??[],item.content??[]])).digest('hex');

// Scope is one trusted bridge/grant, never caller-supplied evidence. OpenAI's
// Responses contract defines encrypted_content as encrypted reasoning tokens;
// max_output_tokens bounds all generated tokens, including hidden reasoning.
// https://developers.openai.com/api/reference/resources/responses/methods/create
export function createNativeReasoningProvenance(){
 const caps=new Map();
 return {
  bound(item,model){return caps.get(reasoningKey(item,model));},
  remember(result,model,outputCap){
   let terminal;
   if(result.contentType?.includes('text/event-stream')){
    for(const line of result.body.split('\n')){
     if(!line.startsWith('data: '))continue;
     try{const e=JSON.parse(line.slice(6));if(e.type==='response.completed')terminal=e.response;}catch{}
    }
   }else{try{terminal=JSON.parse(result.body);}catch{}}
   if(terminal?.status!=='completed'||terminal.id!==result.providerRequestId||
      terminal.usage?.total_tokens!==result.actualTokens||!Number.isSafeInteger(terminal.usage?.output_tokens)||terminal.usage.output_tokens<0||terminal.usage.output_tokens>outputCap||!Array.isArray(terminal.output))return;
   for(const item of terminal.output){
    if(item?.type!=='reasoning'||typeof item.id!=='string'||typeof item.encrypted_content!=='string'||!item.encrypted_content)continue;
    const key=reasoningKey(item,model);
    // Existing provenance can never be replaced with a smaller bound.
    caps.set(key,Math.max(caps.get(key)??0,outputCap));
   }
  }
 };
}

export function admitNativeRequest(request,provenance){
 if(!object(request))denied('request-object',request);
 const body={...request};
 // SDK correlation fields do not add model context and are not Responses input.
 if(body.client_metadata!==undefined){
  if(!object(body.client_metadata)||!Object.values(body.client_metadata).every(v=>typeof v==='string'||v===null))denied('client-metadata',body.client_metadata);
  delete body.client_metadata;
 }
 if(body.prompt_cache_key!==undefined){if(body.prompt_cache_key!==null&&typeof body.prompt_cache_key!=='string')denied('prompt-cache-key',body.prompt_cache_key);delete body.prompt_cache_key;}
 if(!allowed(body,['model','input','instructions','max_output_tokens','stream','tools','tool_choice','parallel_tool_calls','reasoning','text','temperature','top_p','store','include','metadata','truncation']))denied('request-fields',body);
 if(body.instructions!==undefined&&body.instructions!==null&&typeof body.instructions!=='string')denied('instructions-type',body.instructions);
 if(body.input!==undefined&&typeof body.input!=='string'&&!Array.isArray(body.input))denied('input-type',body.input);
 if(body.store===true)denied('stored-context',body);
 if(body.truncation==='auto')denied('automatic-truncation',body);
 if(body.include!==undefined&&body.include!==null&&(!Array.isArray(body.include)||body.include.some(x=>x!=='reasoning.encrypted_content')))denied('include-fields',body.include);
 let opaqueTokens=0;
 if(Array.isArray(body.input))body.input=body.input.map(original=>{
  if(!object(original))denied('input-item-object',original);const item={...original};
  if(item.type==='reasoning'){
   if(!allowed(item,['type','id','summary','content','encrypted_content','status'])||typeof item.id!=='string'||typeof item.encrypted_content!=='string'||!item.encrypted_content)denied('reasoning-fields',item);
   if(item.summary!==undefined&&(!Array.isArray(item.summary)||!item.summary.every(p=>object(p)&&p.type==='summary_text'&&typeof p.text==='string'&&allowed(p,['type','text']))))denied('reasoning-summary',item);
   if(item.content!==undefined&&item.content!==null&&(!Array.isArray(item.content)||!item.content.every(p=>object(p)&&p.type==='reasoning_text'&&typeof p.text==='string'&&allowed(p,['type','text']))))denied('reasoning-content',item);
   const cap=provenance?.bound(item,body.model);
   if(!Number.isSafeInteger(cap)||cap<=0)denied('reasoning-provenance',item);
   opaqueTokens+=cap;return item;
  }
  if(['custom_tool_call','function_call'].includes(item.type)){
   const field=item.type==='custom_tool_call'?'input':'arguments';
   if(!allowed(item,['type','call_id','name','namespace',field,'status','id'])||typeof item.call_id!=='string'||typeof item.name!=='string'||typeof item[field]!=='string'||(item.namespace!==undefined&&item.namespace!==null&&typeof item.namespace!=='string'))denied('tool-call-fields',item);
   return item;
  }
  if(['custom_tool_call_output','function_call_output'].includes(item.type)){
   if(!allowed(item,['type','call_id','output','id','status','name',...(item.type==='function_call_output'?['namespace']:[])])||typeof item.call_id!=='string'||(item.name!==undefined&&item.name!==null&&typeof item.name!=='string')||(item.namespace!==undefined&&item.namespace!==null&&typeof item.namespace!=='string')||!(typeof item.output==='string'||textParts(item.output)))denied('tool-output-fields',item);
   return item;
  }
  if(!['user','assistant','developer','system','tool'].includes(item.role))denied('message-role',item);
  if(!allowed(item,['role','content','type','status','id','phase']))denied('message-fields',item);
  textParts(item.content);
  if(item.type!==undefined&&item.type!=='message')denied('message-type',item);
  if(item.id!==undefined&&item.id!==null&&typeof item.id!=='string')denied('message-id',item);
  if(item.phase!==undefined&&item.phase!==null&&!['commentary','final_answer'].includes(item.phase))denied('message-phase',item);
  delete item.id;return item;
 });
 const counted={...body,...(Array.isArray(body.input)?{input:body.input.map(item=>item.type==='reasoning'?{...item,encrypted_content:''}:item)}:{})};
 return {body,opaqueTokens,plaintextBytes:Buffer.byteLength(JSON.stringify(counted),'utf8')};
}


