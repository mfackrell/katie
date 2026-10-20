import {GAME_RULE_CATEGORIES} from '../../scripts/project-game-rules.mjs';
import {projectPlanSchema} from '@/lib/projects/contract';
import OpenAI from 'openai';
import {getAvailableProviders} from '@/lib/providers';
import {chooseProvider} from '@/lib/router/master-router';
import { zodTextFormat } from 'openai/helpers/zod';
import { randomUUID } from 'node:crypto';
import { rpc } from './store';
import { calculate,planSchema,type Claim } from './types';
const WORKER_MODEL='gpt-5-mini';
const REVIEW_MODEL='gpt-5.4';

const calculator={type:'function',name:'calculate',description:'Execute a deterministic arithmetic calculation. Numbers must come from supplied evidence or explicitly labeled assumptions.',strict:true,parameters:{type:'object',properties:{operation:{type:'string',enum:['add','subtract','multiply','divide','power']},values:{type:'array',items:{type:'number'},minItems:2,maxItems:12}},required:['operation','values'],additionalProperties:false}};
export class MissionModelFailure extends Error { constructor(message:string,readonly partial:Record<string,unknown>){super(message);this.name='MissionModelFailure';} }
export type ModelResult={text:string;sources:Array<{url:string;title:string}>;calculations:unknown[];model:string};
export function isCreditExhaustion(error:unknown):boolean{
 const e=error as {status?:number;code?:string;error?:{code?:string;message?:string};message?:string}|null;
 const code=String(e?.code??e?.error?.code??'').toLowerCase();
 const message=String(e?.message??e?.error?.message??'').toLowerCase();
 return (e?.status===429||code==='insufficient_quota'||code==='billing_hard_limit_reached')&&
  (/credit|quota|balance|billing|insufficient/.test(message)||code==='insufficient_quota'||code==='billing_hard_limit_reached');
}
// Provider routing is shared with ordinary Katie chats. Quota failures may
// switch providers, but cannot waive mission budgets, role permissions, or
// independent review. Never retry a possibly completed output as fallback.
export async function missionCreditFallback(claim:Claim,instruction:string,input:string,outputTokens:number,
   quotaError:unknown):Promise<ModelResult>{
 if(!isCreditExhaustion(quotaError))throw quotaError;
 const providers=getAvailableProviders().filter(p=>p.name!=='openai');
 const selected=providers.find(p=>p.name==='google')??providers.find(p=>p.name==='anthropic')??providers.find(p=>p.name==='grok');
 if(!selected)throw new MissionModelFailure('OpenAI credits exhausted and no configured alternative provider is available.',{providerErrorCode:'insufficient_quota',fallbackUnavailable:true});
 const models=selected.name==='google'?['gemini-3.1-pro','gemini-2.5-pro']:
   selected.name==='anthropic'?['claude-sonnet-4-6','claude-sonnet-4-5']:['grok-4'];
 const model=models[0];
 const reserve=Math.max(6000,Math.ceil(Buffer.byteLength(instruction+input,'utf8')/2)+outputTokens+512);
 const callId=randomUUID();
 if(!await rpc<boolean>('reserve_mission_call',{p_id:claim.job.id,p_lease:claim.job.lease,p_call:callId,p_model:selected.name+':'+model,p_tokens:reserve}))
    throw new MissionModelFailure('Fallback blocked by original mission token budget or lease.',{fallbackBudgetExhausted:true});
 try{
  const result=await selected.generate({name:'Katie mission worker',persona:instruction,summary:'Bounded, role-scoped mission.',user:input,history:[],modelId:model});
  const content=String(result.text??'').trim();
  if(!content||content.length>Math.max(24000,outputTokens*5)||result.truncated)
   throw new MissionModelFailure('Fallback output incomplete or oversized.',{fallbackProvider:selected.name,fallbackModel:model});
  await rpc('finish_mission_call',{p_call:callId,p_tokens:result.usage?.totalTokens??null});
  return {text:content,sources:[],calculations:[],model:selected.name+':'+result.model};
 }catch(error){
  await rpc('finish_mission_call',{p_call:callId,p_tokens:null}).catch(()=>{});
  throw error;
 }
}

// All text-only mission roles use Katie's capability-aware router BEFORE
// attempting inference. The same ranked fallback chain is used when a provider
// is temporarily unavailable. Model selection never grants tool permissions.
export async function routedMissionText(claim:Claim,instruction:string,input:string,outputTokens:number):Promise<ModelResult>{
 const providers=getAvailableProviders();
 if(!providers.length)throw Error('No configured model providers available for this mission');
 const purpose=claim.mission.project_kind+' / '+claim.job.role;
 const decision=await chooseProvider(purpose+'\n'+claim.mission.objective.slice(0,3600),
  instruction.slice(0,3000),providers);
 const choices=[{provider:decision.provider,modelId:decision.modelId},
   ...decision.fallbackChain.map(x=>({provider:x.provider,modelId:x.modelId}))];
 const dedup=new Set<string>();let lastError:unknown;
 const reserve=Math.max(5000,Math.ceil(Buffer.byteLength(instruction+input,'utf8')/2)+outputTokens+512);
 for(const choice of choices){
  const key=choice.provider.name+':'+choice.modelId;
  if(dedup.has(key))continue;dedup.add(key);
  const callId=randomUUID();
  if(!await rpc<boolean>('reserve_mission_call',{p_id:claim.job.id,p_lease:claim.job.lease,
     p_call:callId,p_model:key,p_tokens:reserve}))
    throw new MissionModelFailure('Mission exhausted its original authorization or token budget.',{routingBudgetBlocked:true});
  try{
   const result=await choice.provider.generate({
    name:'Katie mission '+claim.job.role,persona:instruction,summary:'Execute ONLY the specified mission stage. Do not invent tools, completion or permissions.',
    user:input,history:[],modelId:choice.modelId});
   const content=String(result.text??'').trim();
   if(!content||result.truncated)throw new MissionModelFailure('Routed model output incomplete.',{
      selectedProvider:key,outputIncomplete:true});
   await rpc('finish_mission_call',{p_call:callId,p_tokens:result.usage?.totalTokens??null});
   return{text:content,sources:[],calculations:[],model:key};
  }catch(error){
   await rpc('finish_mission_call',{p_call:callId,p_tokens:null}).catch(()=>{});
   lastError=error;
   const status=(error as {status?:number})?.status;
   const code=String((error as {code?:string})?.code??'').toLowerCase();
   if(!isCreditExhaustion(error)&&status!==429&&status!==502&&status!==503&&status!==504&&
      !['server_error','rate_limit_exceeded'].includes(code))throw error;
   console.warn('[Missions] Model route failed; trying next ranked compatible provider',{role:claim.job.role,model:key,status,code});
  }
 }
 throw new MissionModelFailure('All authorized model candidates failed.',{routingExhausted:true,
  lastProviderFailure:lastError instanceof Error?lastError.message.slice(0,500):'unknown'});
}
// A bounded execution adapter uses the existing OpenAI credential/SDK. Ordinary
// chat adapters remain unchanged; their unbounded continuation defaults cannot
// enforce a mission allowance. No SDK inference retries or automatic fallback.
export async function missionModel(claim:Claim,instruction:string,input:string,tools:'none'|'research'|'calculate'='none'):Promise<ModelResult>{
 const agent=claim.mission.team.find(a=>a.id===claim.job.agent_id);
 if(!agent)throw Error('Saved worker unavailable');
 if(tools==='research'&&!agent.config.research)throw Error('Research permission denied');
 if(tools!=='none'&&!process.env.OPENAI_API_KEY)throw Error('Research/calculation tool provider unavailable');
 const selectedModel=claim.job.role==='plan'||tools==='research'||claim.job.role==='review'||claim.job.role==='compose'||claim.job.role==='revise'||tools==='calculate'?REVIEW_MODEL:WORKER_MODEL;
 const gameSpecification=claim.mission.project_kind==='specification'&&(claim.mission.project_evidence as {projectProfile?:string}|null)?.projectProfile==='game';
 const outputTokens=gameSpecification&&['compose','revise'].includes(claim.job.role)?16000:claim.mission.project_kind==='specification'&&['compose','revise'].includes(claim.job.role)?6000:claim.job.role==='review'?5000:3000;
 if(input.length>48000)throw Error('Mission evidence exceeds bounded context. Narrow the objective or deliverable.');
 if(tools==='none')return routedMissionText(claim,instruction+
   (gameSpecification&&['compose','revise'].includes(claim.job.role)?'\nRespond with complete minified expanded game specification JSON; preserve every original rule, model and browser acceptance and obey the saved validation feedback.':''),input,outputTokens);
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
  const request={model:selectedModel,reasoning:{effort:'low'},instructions:instruction+(gameSpecification&&['compose','revise'].includes(claim.job.role)?'\nGAME RULE SCHEMA: Every rule.category must be one of '+GAME_RULE_CATEGORIES.join(', ')+'. Do not invent categories such as state, transition, outcome, invalid-action, terminal or architecture; use an applicable allowed category or other. Every verified/approved rule ID, including engine architecture and UI requirements, must appear in at least one acceptance scenario ruleIds list. UNKNOWN SCHEMA: game.rules.unknowns must be an array; use [] if none. Every entry needs {id,question,status:\"open\"|\"resolved\",blocking:boolean,ruleIds:[existingRuleId]}. For resolved entries, also include decisionSourceId identifying a real source. A descriptive {id,description} entry is INVALID. Unspecified cosmetic or storage-key details can remain open nonblocking questions only if their ruleIds resolve; never silently treat a blocking gameplay decision as nonblocking. Each scenario needs nonempty valid ruleIds and invariantIds. On repair, satisfy ALL supplied diagnostics together, including missingRuleCoverage, uniqueCharacterLimit and assessmentCapacity; fixing only the first error is insufficient.\nGAME SPECIFICATION SIZE: Return minified complete JSON. The unique specification must fit 20,000 characters; the server counts canonically identical repeated browser contracts once. Return the complete expanded JSON with all required copies; do not emit references or omit data. Use one complete milestone when the original request permits it; do not invent staged increments. Each browser contract has at most 100 TOTAL steps across all scenarios, not 100 per scenario. Count navigation, clicks and assertions. Use concise rule descriptions and consolidated browser paths while retaining every required rule, state assertion, invalid action and reload check. No omitted requirements or placeholder references.':'')+calculatorPhase+(tools==='research'?'\nUse live web search for this assignment and cite consulted primary pages with native inline URL citations. Use at most four native web calls. If the first query returns no results, broaden the query before concluding that research is unavailable. Return source-supported findings and explicitly identify gaps; do not substitute remembered URLs or claim uncited research.':''),input:context,max_output_tokens:outputTokens,store:false,
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
  }catch(error){await rpc('finish_mission_call',{p_call:callId,p_tokens:null}).catch(()=>{});
   if(tools==='none'&&isCreditExhaustion(error))return missionCreditFallback(claim,String(request.instructions),input,outputTokens,error);
   throw error;}
 }
 throw Error('Calculation output did not complete within its call allowance');
}
