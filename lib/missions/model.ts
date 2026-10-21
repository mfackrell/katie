import {GAME_RULE_CATEGORIES} from '../../scripts/project-game-rules.mjs';
import {projectPlanSchema} from '@/lib/projects/contract';
import { zodTextFormat } from 'openai/helpers/zod';
import {orchestrationChoices,orchestrationFailure,type OrchestrationChoice} from '@/lib/orchestration/routing';
import {boundedProvider} from '@/lib/orchestration/bounded-provider';
import { createHash, randomUUID } from 'node:crypto';
import { rpc } from './store';
import { calculate,planSchema,type Claim } from './types';
import {MissionAdmissionError,explainAdmissionDenial,missionExecutionDeadline,missionAttemptTimeout,fitsMissionEnvelope,missionInputLimit} from './request-budget';

const calculator={type:'function',name:'calculate',description:'Execute a deterministic arithmetic calculation. Numbers must come from supplied evidence or explicitly labeled assumptions.',strict:true,parameters:{type:'object',properties:{operation:{type:'string',enum:['add','subtract','multiply','divide','power']},values:{type:'array',items:{type:'number'},minItems:2,maxItems:12}},required:['operation','values'],additionalProperties:false}};
export class MissionModelFailure extends Error { constructor(message:string,readonly partial:Record<string,unknown>){super(message);this.name='MissionModelFailure';} }
export type ModelResult={text:string;sources:Array<{url:string;title:string}>;calculations:unknown[];model:string;provider?:string;routingReason?:string;attemptedModels?:string[]};
export function isCreditExhaustion(error:unknown):boolean{
 const e=error as {status?:number;code?:string;error?:{code?:string;message?:string};message?:string}|null;
 const code=String(e?.code??e?.error?.code??'').toLowerCase();
 const message=String(e?.message??e?.error?.message??'').toLowerCase();
 return (e?.status===429||code==='insufficient_quota'||code==='billing_hard_limit_reached')&&
  (/credit|quota|balance|billing|insufficient/.test(message)||code==='insufficient_quota'||code==='billing_hard_limit_reached');
}
// Every stage and child mission routes against the active model registry. Only
// an unchanged, draft-blind review-contract response may be reused; the worker
// still validates its source provenance, and independently reviews the candidate.
export async function missionModel(claim:Claim,instruction:string,input:string,tools:'none'|'research'|'calculate'='none'):Promise<ModelResult>{
 const agent=claim.mission.team.find(a=>a.id===claim.job.agent_id);
 if(!agent)throw Error('Saved worker unavailable');
 if(tools==='research'&&!agent.config.research)throw Error('Research permission denied');
 if(!fitsMissionEnvelope(instruction,input,missionInputLimit(claim)))throw Error('Mission evidence exceeds bounded context. Narrow the objective or deliverable.');
 const executionDeadline=missionExecutionDeadline(claim);
 const checkpointStage=claim.job.role==='review'&&tools==='none'&&input.startsWith('AUTHORITATIVE_USER_TURNS:\n');
 const checkpointHash=checkpointStage?createHash('sha256').update(JSON.stringify({instruction,input,tools,objective:claim.mission.objective,agent:claim.job.agent_id})).digest('hex'):null;
 const checkpoint=claim.job.payload?.reviewModelCheckpoint as {hash?:string;response?:ModelResult}|undefined;
 if(checkpointHash&&checkpoint?.hash===checkpointHash&&typeof checkpoint.response?.text==='string'
   &&typeof checkpoint.response.model==='string'&&Array.isArray(checkpoint.response.sources)&&Array.isArray(checkpoint.response.calculations))return checkpoint.response;
 const choices=await orchestrationChoices({objective:claim.mission.objective,instruction:claim.job.instruction+'\n'+instruction,
  requestId:claim.job.id,accounting:{
   reserve:async(model,tokens)=>{if(Date.now()>=executionDeadline-5000)throw Error('Mission execution time window exhausted before routing dispatch');const id=randomUUID();if(!await rpc<boolean>('reserve_mission_routing_call',{p_id:claim.job.id,p_lease:claim.job.lease,p_call:id,p_model:model,p_tokens:tokens}))throw Error('Worker no longer authorized or mission allowance exhausted');return id;},
   finish:async(id,tokens)=>{await rpc('finish_mission_call',{p_call:id,p_tokens:tokens});}
  },research:tools==='research',review:claim.job.role==='review',
  // The server already knows specification writing is architecture/planning.
  // Avoid paying a second classifier to rediscover this known phase.
  planning:claim.job.role==='plan'||(claim.mission.project_kind==='specification'&&['compose','revise'].includes(claim.job.role))});
 const attemptedModels:string[]=[];
 const failedProviders=new Set<string>();
 let last:unknown;
 for(const choice of choices){
  if(failedProviders.has(choice.provider.name))continue;
  attemptedModels.push(choice.provider.name+':'+choice.modelId);
  try{
   const result=await executeMissionModel(claim,instruction,input,tools,choice,executionDeadline);
   const complete={...result,provider:choice.provider.name,routingReason:choice.reasoning,attemptedModels};
   if(checkpointHash&&!await rpc<boolean>('checkpoint_mission_review_model',{p_id:claim.job.id,p_lease:claim.job.lease,p_hash:checkpointHash,p_response:complete}))throw Error('Worker no longer authorized to persist review checkpoint');
   return complete;
  }catch(error){
   last=error;
   if(error instanceof MissionAdmissionError){
    if(!error.canTryAlternative)throw error;
    console.info('[Missions] Candidate not admitted; no provider call made',{jobId:claim.job.id,model:choice.modelId,requested:error.requestedTokens,remaining:error.capacity?.remainingTokens});
    continue;
   }
   const detail=error instanceof Error?error.message:String(error);
   if(/allowance exhausted|no longer authorized|permission denied|Invalid tool|Unpermitted|tool arguments instead|execution time window/i.test(detail)||(error instanceof MissionModelFailure&&!['server_error','rate_limit_exceeded','insufficient_quota'].includes(String(error.partial.providerErrorCode))&&!(error.partial.responseStatus==='incomplete'&&(error.partial.incompleteReason===null||error.partial.incompleteReason==='max_output_tokens'))))throw error;
   if(error instanceof MissionModelFailure&&error.partial.responseStatus==='incomplete'){failedProviders.add(choice.provider.name);}else if(await orchestrationFailure(choice,error)==='provider'||isCreditExhaustion(error))failedProviders.add(choice.provider.name);
   console.warn('[Missions] Model attempt failed; trying next eligible provider',{jobId:claim.job.id,provider:choice.provider.name,model:choice.modelId,error:detail.slice(0,350)});
  }
 }
 if(last instanceof MissionAdmissionError)throw new MissionModelFailure('No eligible model request fits the remaining mission allowance. Saved work and all usage are preserved.',{admissionDenied:true,requestedTokens:last.requestedTokens,remainingTokens:last.capacity?.remainingTokens,attemptedModels});
 if(last instanceof MissionModelFailure)throw new MissionModelFailure(last.message,{...last.partial,attemptedModels,providerFailure:true});
 if(last instanceof Error)throw new MissionModelFailure(last.message,{attemptedModels,providerFailure:true});
 throw Error('No eligible orchestration model could execute this assignment');
}
async function executeMissionModel(claim:Claim,instruction:string,input:string,tools:'none'|'research'|'calculate',choice:OrchestrationChoice,executionDeadline:number):Promise<ModelResult>{
 const selectedModel=choice.modelId;
 const gameSpecification=claim.mission.project_kind==='specification'&&(claim.mission.project_evidence as {projectProfile?:string}|null)?.projectProfile==='game';
 const outputTokens=gameSpecification&&['compose','revise'].includes(claim.job.role)?16000:claim.mission.project_kind==='specification'&&['compose','revise'].includes(claim.job.role)?6000:claim.job.role==='review'?(gameSpecification?10000:5000):3000;
 const client=boundedProvider(choice);
 const sources:ModelResult['sources']=[],calculations:unknown[]=[];
 if(!fitsMissionEnvelope(instruction,input,missionInputLimit(claim)))throw Error('Mission evidence exceeds bounded context. Narrow the objective or deliverable.');
 let context:unknown[]=[{role:'user',content:input}];
 let text='';
 const calculationDeadline=Math.min(executionDeadline,Date.now()+180_000);
 for(let turn=0;turn<(tools==='calculate'?4:1);turn++){
  if(tools==='calculate'&&Date.now()>calculationDeadline-10_000)throw Error('Calculation execution time allowance exhausted');
  const callId=randomUUID();
  const calculatorAvailable=tools==='calculate'&&turn<3&&calculations.length<8;
  const calculatorPhase=tools!=='calculate'?'':'\nUse the calculator whenever the assignment needs arithmetic; for qualitative analysis without arithmetic, return the complete analysis directly without a tool call. Return the COMPLETE assigned analysis as explanatory prose and tables when ready. Do not emit tool arguments as your final answer. '+(calculatorAvailable?`Request useful independent calculations together. At most ${8-calculations.length} additional calculator calls are available across ${3-turn} remaining tool turns; finish as soon as you have the needed results.`:'The calculator phase is finished. No tools remain; finish using the returned results and state any remaining limitation.');
  const request={model:selectedModel,instructions:instruction+(gameSpecification&&['compose','revise'].includes(claim.job.role)?'\nGAME RULE SCHEMA: Every rule.category must be one of '+GAME_RULE_CATEGORIES.join(', ')+'. Do not invent categories such as state, transition, outcome, invalid-action, terminal or architecture; use an applicable allowed category or other. Every verified/approved rule ID, including engine architecture and UI requirements, must appear in at least one acceptance scenario ruleIds list. UNKNOWN SCHEMA: game.rules.unknowns must be an array; use [] if none. Every entry needs {id,question,status:\"open\"|\"resolved\",blocking:boolean,ruleIds:[existingRuleId]}. For resolved entries, also include decisionSourceId identifying a real source. A descriptive {id,description} entry is INVALID. Unspecified cosmetic or storage-key details can remain open nonblocking questions only if their ruleIds resolve; never silently treat a blocking gameplay decision as nonblocking. Each scenario needs nonempty valid ruleIds and invariantIds. On repair, satisfy ALL supplied diagnostics together, including missingRuleCoverage, uniqueCharacterLimit and assessmentCapacity; fixing only the first error is insufficient.\nGAME SPECIFICATION SIZE: Return minified complete JSON. The unique specification must fit 20,000 characters; the server counts canonically identical repeated browser contracts once. Return the complete expanded JSON with all required copies; do not emit references or omit data. Use one complete milestone when the original request permits it; do not invent staged increments. Each browser contract has at most 100 TOTAL steps across all scenarios, not 100 per scenario. Count navigation, clicks and assertions. Use concise rule descriptions and consolidated browser paths while retaining every required rule, state assertion, invalid action and reload check. No omitted requirements or placeholder references.':'')+calculatorPhase+(tools==='research'?'\nUse live web search for this assignment and cite consulted primary pages with native inline URL citations. Use at most four native web calls. If the first query returns no results, broaden the query before concluding that research is unavailable. Return source-supported findings and explicitly identify gaps; do not substitute remembered URLs or claim uncited research.':''),input:context,max_output_tokens:outputTokens,store:false,
   ...(claim.job.role==='plan'?{text:{format:zodTextFormat(planSchema,'mission_plan')}}:claim.mission.project_kind==='specification'&&['compose','revise'].includes(claim.job.role)?{text:{format:gameSpecification?{type:'json_object'}:zodTextFormat(projectPlanSchema.omit({game:true}),'project_specification')}}:{}),
   ...(tools==='research'?{tools:[{type:'web_search',search_context_size:'low'}],include:['web_search_call.action.sources'],tool_choice:'required',max_tool_calls:4}:calculatorAvailable?{tools:[calculator],tool_choice:'auto'}:{}),
  };
  const countInput:Record<string,unknown>={...request};
  delete countInput.max_output_tokens;delete countInput.store;delete countInput.max_tool_calls;
  const countingTimeout=Math.min(15000,executionDeadline-Date.now()-5000);
  if(countingTimeout<1000)throw Error('Mission execution time window exhausted before dispatch; saved work remains intact');
  const counted=await client.post('/responses/input_tokens',{body:countInput,timeout:countingTimeout}).catch(()=>null);
  const inputTokens=counted&&Number.isSafeInteger(counted.input_tokens)&&counted.input_tokens>=0?counted.input_tokens+256:Buffer.byteLength(JSON.stringify(request),'utf8');
  const reserve=inputTokens+outputTokens+(tools==='research'?32000:0);
  const inferenceTimeout=tools==='calculate'?Math.min(90_000,calculationDeadline-Date.now()-5000):missionAttemptTimeout(executionDeadline,outputTokens);
  if(inferenceTimeout<1000)throw Error('Mission execution time window exhausted before dispatch; saved work remains intact');
  if(!await rpc<boolean>('reserve_mission_call',{p_id:claim.job.id,p_lease:claim.job.lease,p_call:callId,p_model:choice.provider.name+':'+selectedModel,p_tokens:reserve}))await explainAdmissionDenial(claim,reserve);
  const started=Date.now();
  try{
   const response=await client.responses.create(request,{timeout:inferenceTimeout});
   await rpc('finish_mission_call',{p_call:callId,p_tokens:response.usage?.total_tokens??null});
   if(response.status!=='completed')throw new MissionModelFailure('Model output incomplete: '+response.status,{responseStatus:response.status,incompleteReason:response.incomplete_details?.reason??null,outputTokenLimit:outputTokens,providerErrorCode:response.error?.code??null,providerErrorMessage:response.error?.message?.slice(0,600)??null});
   text=response.output_text?.trim()??'';
   const output=response.output as unknown as Array<Record<string,unknown>>;
   for(const item of output){for(const block of (Array.isArray(item.content)?item.content:[]) as Array<Record<string,unknown>>){for(const a of (Array.isArray(block.annotations)?block.annotations:[]) as Array<Record<string,unknown>>){if(a.type==='url_citation'&&typeof a.url==='string'&&/^https?:\/\//.test(a.url))sources.push({url:a.url,title:String(a.title??'')});}}}
   const calls=output.filter(x=>x.type==='function_call');
   if(calls.length){
    if(!calculatorAvailable)throw Error('Unpermitted calculator request');
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
  }catch(error){
   await rpc('finish_mission_call',{p_call:callId,p_tokens:null}).catch(()=>{});
   console.warn('[Missions] Provider attempt ended',{jobId:claim.job.id,callId,provider:choice.provider.name,model:selectedModel,durationMs:Date.now()-started,reservedTokens:reserve,countMethod:counted?'provider':'conservative-bytes',error:error instanceof Error?error.message.slice(0,350):'Unknown provider failure'});
   throw error;
  }
 }
 throw Error('Calculation output did not complete within its call allowance');
}
