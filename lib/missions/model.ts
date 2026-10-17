import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { randomUUID } from 'node:crypto';
import { rpc } from './store';
import { calculate,planSchema,type Claim } from './types';
const WORKER_MODEL='gpt-5-mini';
const REVIEW_MODEL='gpt-5.4';

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
 const selectedModel=claim.job.role==='review'||claim.job.role==='compose'||claim.job.role==='revise'||tools==='calculate'?REVIEW_MODEL:WORKER_MODEL;
 const outputTokens=claim.job.role==='review'?5000:3000;
 const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,maxRetries:0,timeout:90_000,fetch:globalThis.fetch.bind(globalThis)});
 const sources:ModelResult['sources']=[],calculations:unknown[]=[];
 if(input.length>48000)throw Error('Mission evidence exceeds bounded context. Narrow the objective or deliverable.');
 let context:unknown[]=[{role:'user',content:input}];
 let text='';
 for(let turn=0;turn<(tools==='calculate'?2:1);turn++){
  const callId=randomUUID();
  const calculatorPhase=tools!=='calculate'?'':turn===0?'\nThe calculator is available for this turn only. Request all useful independent calculations together, at most eight tool calls, then finish the entire assignment using their results.':'\nThe calculator phase is finished. Return the COMPLETE assigned analysis as explanatory prose and tables using the tool results. No tools remain. Do not emit tool arguments or a request for another calculation as your answer.';
  const request={model:selectedModel,reasoning:{effort:'low'},instructions:instruction+calculatorPhase,input:context,max_output_tokens:outputTokens,store:false,
   ...(claim.job.role==='plan'?{text:{format:zodTextFormat(planSchema,'mission_plan')}}:{}),
   ...(tools==='research'?{tools:[{type:'web_search',search_context_size:'low'}],tool_choice:'required',max_tool_calls:1}:tools==='calculate'&&turn===0?{tools:[calculator],tool_choice:'required'}:{}),
  };
  // Count the complete input, including tools and review schemas, without an
  // inference. Keep a conservative byte fallback if counting is unavailable.
  const countInput:Record<string,unknown>={...request};
  delete countInput.max_output_tokens;delete countInput.store;delete countInput.max_tool_calls;
  const counted=await client.post<unknown,{input_tokens:number}>('/responses/input_tokens',{body:countInput,timeout:15_000}).catch(()=>null);
  const inputTokens=counted&&Number.isSafeInteger(counted.input_tokens)&&counted.input_tokens>=0?counted.input_tokens+256:Buffer.byteLength(JSON.stringify(request),'utf8');
  // Output includes reasoning; native search requires additional headroom.
  const reserve=inputTokens+outputTokens+(tools==='research'?8000:0);
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
   if(tools==='calculate'){
    if(text.length<500&&/"operation"\s*:/.test(text)&&/"values"\s*:/.test(text))throw Error('Calculation returned tool arguments instead of the assigned analysis');
    let value:unknown;try{value=JSON.parse(text);}catch{/* Prose is the expected final analysis. */}
    if(value&&typeof value==='object'&&'operation' in value&&'values' in value)throw Error('Calculation returned tool arguments instead of the assigned analysis');
   }
   if(tools==='research'&&!sources.length)throw Error('Research returned no cited live sources');
   return{text,sources,calculations,model:selectedModel};
  }catch(error){await rpc('finish_mission_call',{p_call:callId,p_tokens:null}).catch(()=>{});throw error;}
 }
 throw Error('Calculation output did not complete within its call allowance');
}
