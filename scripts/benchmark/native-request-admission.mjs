import {createHash} from 'node:crypto';
const denied=()=>{throw Error('GATEWAY_UNBOUNDED_INPUT_DENIED');};
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const allowed=(x,keys)=>Object.keys(x).every(k=>keys.includes(k));
// The pinned SDK replays intermediate assistant output_text with annotations:[].
// Empty annotations carry no referenced context. Nonempty annotations and all
// other extra content fields remain denied until independently bounded.
const textParts=x=>Array.isArray(x)&&x.every(p=>object(p)&&['input_text','output_text','text'].includes(p.type)&&typeof p.text==='string'&&
 allowed(p,p.type==='output_text'?['type','text','annotations']:['type','text'])&&
 (p.annotations===undefined||(p.type==='output_text'&&Array.isArray(p.annotations)&&p.annotations.length===0)));
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
 if(!object(request))denied();
 const body={...request};
 // SDK correlation fields do not add model context and are not Responses input.
 if(body.client_metadata!==undefined){
  if(!object(body.client_metadata)||!Object.values(body.client_metadata).every(v=>typeof v==='string'||v===null))denied();
  delete body.client_metadata;
 }
 if(body.prompt_cache_key!==undefined){if(body.prompt_cache_key!==null&&typeof body.prompt_cache_key!=='string')denied();delete body.prompt_cache_key;}
 if(!allowed(body,['model','input','instructions','max_output_tokens','stream','tools','tool_choice','parallel_tool_calls','reasoning','text','temperature','top_p','store','include','metadata','truncation']))denied();
 if(body.instructions!==undefined&&body.instructions!==null&&typeof body.instructions!=='string')denied();
 if(body.input!==undefined&&typeof body.input!=='string'&&!Array.isArray(body.input))denied();
 if(body.store===true||body.truncation==='auto'||(body.include!==undefined&&body.include!==null&&(!Array.isArray(body.include)||body.include.some(x=>x!=='reasoning.encrypted_content'))))denied();
 let opaqueTokens=0;
 if(Array.isArray(body.input))body.input=body.input.map(original=>{
  if(!object(original))denied();const item={...original};
  if(item.type==='reasoning'){
   if(!allowed(item,['type','id','summary','content','encrypted_content','status'])||typeof item.id!=='string'||typeof item.encrypted_content!=='string'||!item.encrypted_content)denied();
   if(item.summary!==undefined&&(!Array.isArray(item.summary)||!item.summary.every(p=>object(p)&&p.type==='summary_text'&&typeof p.text==='string'&&allowed(p,['type','text']))))denied();
   if(item.content!==undefined&&item.content!==null&&(!Array.isArray(item.content)||!item.content.every(p=>object(p)&&p.type==='reasoning_text'&&typeof p.text==='string'&&allowed(p,['type','text']))))denied();
   const cap=provenance?.bound(item,body.model);
   if(!Number.isSafeInteger(cap)||cap<=0)denied();
   opaqueTokens+=cap;return item;
  }
  if(['custom_tool_call','function_call'].includes(item.type)){
   const field=item.type==='custom_tool_call'?'input':'arguments';
   if(!allowed(item,['type','call_id','name',field,'status','id'])||typeof item.call_id!=='string'||typeof item.name!=='string'||typeof item[field]!=='string')denied();
   return item;
  }
  if(['custom_tool_call_output','function_call_output'].includes(item.type)){
   if(!allowed(item,['type','call_id','output','id','status'])||typeof item.call_id!=='string'||!(typeof item.output==='string'||textParts(item.output)))denied();
   return item;
  }
  if(!['user','assistant','developer','system','tool'].includes(item.role)||!textParts(item.content)||
    !allowed(item,['role','content','type','status','id','phase'])||
    (item.type!==undefined&&item.type!=='message')||
    (item.id!==undefined&&item.id!==null&&typeof item.id!=='string')||
    (item.phase!==undefined&&item.phase!==null&&!['commentary','final_answer'].includes(item.phase)))denied();
  delete item.id;return item;
 });
 const counted={...body,...(Array.isArray(body.input)?{input:body.input.map(item=>item.type==='reasoning'?{...item,encrypted_content:''}:item)}:{})};
 return {body,opaqueTokens,plaintextBytes:Buffer.byteLength(JSON.stringify(counted),'utf8')};
}

