import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { rpc } from './store';
import { calculate,type Claim } from './types';
const WORKER_MODEL='gpt-5-mini';
const REVIEW_MODEL='gpt-5.4';
const OUTPUT_TOKENS=3000;
const calculator={type:'function',name:'calculate',description:'Execute a deterministic arithmetic calculation. Numbers must come from supplied evidence or explicitly labeled assumptions.',strict:true,parameters:{type:'object',properties:{operation:{type:'string',enum:['add','subtract','multiply','divide','power']},values:{type:'array',items:{type:'number'},minItems:2,maxItems:12}},required:['operation','values'],additionalProperties:false}};
export type ModelResult={text:string;sources:Array<{url:string;title:string}>;calculations:unknown[];model:string};
// A bounded execution adapter uses the existing OpenAI credential/SDK. Ordinary
// chat adapters remain unchanged; their unbounded continuation defaults cannot
// enforce a mission allowance. No SDK inference retries or automatic fallback.
export async function missionModel(claim:Claim,instruction:string,input:string,tools:'none'|'research'|'calculate'='none'):Promise<ModelResult>{
 const agent=claim.mission.team.find(a=>a.id===claim.job.agent_id);
 if(!agent)throw Error('Saved worker unavailable');
 if(tools==='research'&&!agent.config.research)throw Error('Research permission denied');
 if(!process.env.OPENAI_API_KEY)throw Error('Existing OpenAI connection unavailable');
 const selectedModel=claim.job.role==='review'?REVIEW_MODEL:WORKER_MODEL;
 const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,maxRetries:0,timeout:90_000,fetch:globalThis.fetch.bind(globalThis)});
 const sources:ModelResult['sources']=[],calculations:unknown[]=[];
 if(input.length>48000)throw Error('Mission evidence exceeds bounded context. Narrow the objective or deliverable.');
 let context:unknown[]=[{role:'user',content:input}];
 let text='';
 for(let turn=0;turn<(tools==='calculate'?2:1);turn++){
  const callId=randomUUID();
  const request={model:selectedModel,reasoning:{effort:'low'},instructions:instruction,input:context,max_output_tokens:OUTPUT_TOKENS,store:false,
   ...(tools==='research'?{tools:[{type:'web_search',search_context_size:'low'}],tool_choice:'required',max_tool_calls:1}:tools==='calculate'&&turn===0?{tools:[calculator]}:{}),
  };
  // UTF-8 bytes conservatively reserve visible input tokens. Native search has
  // additional metering; reserve headroom and expose actual usage separately.
  const reserve=Buffer.byteLength(JSON.stringify(request),'utf8')+OUTPUT_TOKENS+(tools==='research'?8000:0);
  if(!await rpc<boolean>('reserve_mission_call',{p_id:claim.job.id,p_lease:claim.job.lease,p_call:callId,p_model:selectedModel,p_tokens:reserve}))throw Error('Worker no longer authorized or mission allowance exhausted');
  try{
   const response=await client.responses.create(request as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming);
   await rpc('finish_mission_call',{p_call:callId,p_tokens:response.usage?.total_tokens??null});
   if(response.status!=='completed')throw Error('Model output incomplete: '+response.status);
   text=response.output_text?.trim()??'';
   const output=response.output as unknown as Array<Record<string,unknown>>;
   for(const item of output){for(const block of (Array.isArray(item.content)?item.content:[]) as Array<Record<string,unknown>>){for(const a of (Array.isArray(block.annotations)?block.annotations:[]) as Array<Record<string,unknown>>){if(a.type==='url_citation'&&typeof a.url==='string'&&/^https?:\/\//.test(a.url))sources.push({url:a.url,title:String(a.title??'')});}}}
   const calls=output.filter(x=>x.type==='function_call');
   if(calls.length){
    if(tools!=='calculate'||turn!==0||calls.length>8)throw Error('Unpermitted or excessive tool calls');
    const answers=calls.map(c=>{if(c.name!=='calculate'||typeof c.arguments!=='string'||typeof c.call_id!=='string')throw Error('Invalid tool request');const result=calculate(JSON.parse(c.arguments));calculations.push(result);return{type:'function_call_output',call_id:c.call_id,output:JSON.stringify(result)};});
    context=[...context,...output,...answers];continue;
   }
   if(!text)throw Error('Empty model result');
   if(tools==='research'&&!sources.length)throw Error('Research returned no cited live sources');
   return{text,sources,calculations,model:selectedModel};
  }catch(error){await rpc('finish_mission_call',{p_call:callId,p_tokens:null}).catch(()=>{});throw error;}
 }
 throw Error('Calculation output did not complete within its call allowance');
}
