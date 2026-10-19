import {projectPlanSchema} from '@/lib/projects/contract';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { randomUUID } from 'node:crypto';
import { rpc } from './store';
import { calculate,planSchema,type Claim } from './types';
const WORKER_MODEL='gpt-5-mini';
const REVIEW_MODEL='gpt-5.4';

const calculator={type:'function',name:'calculate',description:'Execute a deterministic arithmetic calculation. Numbers must come from supplied evidence or explicitly labeled assumptions.',strict:true,parameters:{type:'object',properties:{operation:{type:'string',enum:['add','subtract','multiply','divide','power']},values:{type:'array',items:{type:'number'},minItems:2,maxItems:12}},required:['operation','values'],additionalProperties:false}};
export class MissionModelFailure extends Error { constructor(message:string,readonly partial:Record<string,unknown>){super(message);this.name='MissionModelFailure';} }
export type ModelResult={text:string;sources:Array<{url:string;title:string}>;calculations:unknown[];model:string};
// A bounded execution adapter uses the existing OpenAI credential/SDK. Ordinary
// chat adapters remain unchanged; their unbounded continuation defaults cannot
// enforce a mission allowance. No SDK inference retries or automatic fallback.
export async function missionModel(claim:Claim,instruction:string,input:string,tools:'none'|'research'|'calculate'='none'):Promise<ModelResult>{
 const agent=claim.mission.team.find(a=>a.id===claim.job.agent_id);
 if(!agent)throw Error('Saved worker unavailable');
 if(tools==='research'&&!agent.config.research)throw Error('Research permission denied');
 if(!process.env.OPENAI_API_KEY)throw Error('Existing OpenAI connection unavailable');
 const selectedModel=claim.job.role==='plan'||tools==='research'||claim.job.role==='review'||claim.job.role==='compose'||claim.job.role==='revise'||tools==='calculate'?REVIEW_MODEL:WORKER_MODEL;
 const gameSpecification=claim.mission.project_kind==='specification'&&(claim.mission.project_evidence as {projectProfile?:string}|null)?.projectProfile==='game';
 const outputTokens=gameSpecification&&['compose','revise'].includes(claim.job.role)?16000:claim.mission.project_kind==='specification'&&['compose','revise'].includes(claim.job.role)?6000:claim.job.role==='review'?5000:3000;
 const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,maxRetries:0,timeout:90_000,fetch:globalThis.fetch.bind(globalThis)});
 const sources:ModelResult['sources']=[],calculations:unknown[]=[];
 if(input.length>48000)throw Error('Mission evidence exceeds bounded context. Narrow the objective or deliverable.');
 let context:unknown[]=[{role:'user',content:input}];
 let text='';
 const calculationDeadline=Date.now()+180_000;
 for(let turn=0;turn<(tools==='calculate'?4:1);turn++){
  if(tools==='calculate'&&Date.now()>calculationDeadline-10_000)throw Error('Calculation execution time allowance exhausted');
  const callId=randomUUID();
  const calculatorAvailable=tools==='calculate'&&turn<3&&calculations.length<8;
  const calculatorPhase=tools!=='calculate'?'':'\nUse the calculator whenever the assignment needs arithmetic; for qualitative analysis without arithmetic, return the complete analysis directly without a tool call. Return the COMPLETE assigned analysis as explanatory prose and tables when ready. Do not emit tool arguments as your final answer. '+(calculatorAvailable?`Request useful independent calculations together. At most ${8-calculations.length} additional calculator calls are available across ${3-turn} remaining tool turns; finish as soon as you have the needed results.`:'The calculator phase is finished. No tools remain; finish using the returned results and state any remaining limitation.');
  const request={model:selectedModel,reasoning:{effort:'low'},instructions:instruction+(gameSpecification&&['compose','revise'].includes(claim.job.role)?'\nGAME SPECIFICATION SIZE: Return minified complete JSON. The unique specification must fit 20,000 characters; the server counts canonically identical repeated browser contracts once. Return the complete expanded JSON with all required copies; do not emit references or omit data. Use one complete milestone when the original request permits it; do not invent staged increments. Each browser contract has at most 100 TOTAL steps across all scenarios, not 100 per scenario. Count navigation, clicks and assertions. Use concise rule descriptions and consolidated browser paths while retaining every required rule, state assertion, invalid action and reload check. No omitted requirements or placeholder references.':'')+calculatorPhase+(tools==='research'?'\nUse live web search for this assignment and cite consulted primary pages with native inline URL citations. Use at most four native web calls. If the first query returns no results, broaden the query before concluding that research is unavailable. Return source-supported findings and explicitly identify gaps; do not substitute remembered URLs or claim uncited research.':''),input:context,max_output_tokens:outputTokens,store:false,
   ...(claim.job.role==='plan'?{text:{format:zodTextFormat(planSchema,'mission_plan')}}:claim.mission.project_kind==='specification'&&['compose','revise'].includes(claim.job.role)?{text:{format:gameSpecification?{type:'json_object'}:zodTextFormat(projectPlanSchema.omit({game:true}),'project_specification')}}:{}),
   ...(tools==='research'?{tools:[{type:'web_search',search_context_size:'low'}],include:['web_search_call.action.sources'],tool_choice:'required',max_tool_calls:4}:calculatorAvailable?{tools:[calculator],tool_choice:'auto'}:{}),
  };
  // Count the complete input, including tools and review schemas, without an
  // inference. Keep a conservative byte fallback if counting is unavailable.
  const countInput:Record<string,unknown>={...request};
  delete countInput.max_output_tokens;delete countInput.store;delete countInput.max_tool_calls;
  const counted=await client.post<unknown,{input_tokens:number}>('/responses/input_tokens',{body:countInput,timeout:15_000}).catch(()=>null);
  const inputTokens=counted&&Number.isSafeInteger(counted.input_tokens)&&counted.input_tokens>=0?counted.input_tokens+256:Buffer.byteLength(JSON.stringify(request),'utf8');
  // Output includes reasoning; native search requires additional headroom.
  const reserve=inputTokens+outputTokens+(tools==='research'?32000:0);
  const inferenceTimeout=tools==='calculate'?Math.min(90_000,calculationDeadline-Date.now()-5000):90_000;
  if(inferenceTimeout<1000)throw Error('Calculation execution time allowance exhausted');
  if(!await rpc<boolean>('reserve_mission_call',{p_id:claim.job.id,p_lease:claim.job.lease,p_call:callId,p_model:selectedModel,p_tokens:reserve}))throw Error('Worker no longer authorized or mission allowance exhausted');
  try{
   const response=await client.responses.create(request as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,{timeout:inferenceTimeout});
   await rpc('finish_mission_call',{p_call:callId,p_tokens:response.usage?.total_tokens??null});
   if(response.status!=='completed')throw new MissionModelFailure('Model output incomplete: '+response.status,{responseStatus:response.status,incompleteReason:response.incomplete_details?.reason??null,outputTokenLimit:outputTokens,providerErrorCode:response.error?.code??null,providerErrorMessage:response.error?.message?.slice(0,600)??null});
   text=response.output_text?.trim()??'';
   const output=response.output as unknown as Array<Record<string,unknown>>;
   for(const item of output){for(const block of (Array.isArray(item.content)?item.content:[]) as Array<Record<string,unknown>>){for(const a of (Array.isArray(block.annotations)?block.annotations:[]) as Array<Record<string,unknown>>){if(a.type==='url_citation'&&typeof a.url==='string'&&/^https?:\/\//.test(a.url))sources.push({url:a.url,title:String(a.title??'')});}}}
   const calls=output.filter(x=>x.type==='function_call');
   if(calls.length){
    if(!calculatorAvailable)throw Error('Unpermitted calculator request');
    // Model-generated parallel calculator requests can exceed the allowed
    // budget. Execute only permitted calls and explicitly reject the rest,
    // preserving one response for every tool call without exceeding limits.
    const remaining=8-calculations.length;
    const answers=calls.map((c,index)=>{
     if(c.name!=='calculate'||typeof c.arguments!=='string'||typeof c.call_id!=='string')throw Error('Invalid tool request');
     if(index>=remaining)return{type:'function_call_output',call_id:c.call_id,output:JSON.stringify({error:'Calculator call allowance exhausted; finish with available results, noting any missing calculations.'})};
     const result=calculate(JSON.parse(c.arguments));calculations.push(result);
     return{type:'function_call_output',call_id:c.call_id,output:JSON.stringify(result)};
    });
    context=[...context,...output,...answers];continue;
   }
   if(!text)throw Error('Empty model result');
   if(tools==='calculate'){
    if(text.length<500&&/"operation"\s*:/.test(text)&&/"values"\s*:/.test(text))throw Error('Calculation returned tool arguments instead of the assigned analysis');
    let value:unknown;try{value=JSON.parse(text);}catch{/* Prose is the expected final analysis. */}
    if(value&&typeof value==='object'&&'operation' in value&&'values' in value)throw Error('Calculation returned tool arguments instead of the assigned analysis');
   }
   if(tools==='research'){
    // Some Responses-compatible transports return explicit links but
    // omit inline annotations. Accept those only when the native search output
    // independently records the same URL as consulted, never from text alone.
    const linked=new Set(Array.from(text.matchAll(/https?:\/\/[^\s<>()\[\]]+/g),m=>m[0].replace(/[.,;:!?*_`]+$/g,''))); 
    const consulted=new Set<string>();
    for(const item of output){if(item.type!=='web_search_call'||!item.action||typeof item.action!=='object')continue;const action=item.action as Record<string,unknown>;
     if((action.type==='open_page'||action.type==='find_in_page')&&typeof action.url==='string')consulted.add(action.url);
     for(const source of (Array.isArray(action.sources)?action.sources:[]) as Array<Record<string,unknown>>)if(source.type==='url'&&typeof source.url==='string')consulted.add(source.url);
    }
    for(const url of linked)if(consulted.has(url)&&!sources.some(s=>s.url===url))sources.push({url,title:''});
    if(!sources.length)throw new MissionModelFailure('Research returned no cited live sources',{text,sources,calculations,model:selectedModel,consultedSources:[...consulted],outputTypes:output.map(item=>String(item.type))});
   }
   return{text,sources,calculations,model:selectedModel};
  }catch(error){await rpc('finish_mission_call',{p_call:callId,p_tokens:null}).catch(()=>{});throw error;}
 }
 throw Error('Calculation output did not complete within its call allowance');
}
