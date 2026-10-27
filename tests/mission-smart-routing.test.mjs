import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {shouldFallbackIncompleteReview} from '../lib/missions/review-fallback.mjs';
const source=readFileSync('lib/missions/model.ts','utf8');
function loadRouterFixture({failPrimary=false,incompletePrimary=false,emptyTruncation=false,allow=true,acceptance=false,fullBound=false}={}){
 let calls=[],reserve=[],rpcEvents=[],chosen=0,routingOptions;
 const first={name:'google',generate:async p=>{calls.push(['google',p.modelId]);if(failPrimary){const err=Error('quota');err.status=429;err.code='insufficient_quota';throw err;}return{text:'valid model result',model:p.modelId,provider:'google',usage:{totalTokens:65}};}};
 const second={name:'anthropic',generate:async p=>{calls.push(['anthropic',p.modelId]);return{text:'recovered verified text',model:p.modelId,provider:'anthropic',usage:{totalTokens:72}};}};
 const openai={name:'openai',generate:async p=>{calls.push(['openai',p.modelId]);return{text:'full trial model result',model:p.modelId,provider:'openai',usage:{totalTokens:53}};}};
 const out=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,exports={};
 const require=name=>name==='./review-fallback.mjs'?{shouldFallbackIncompleteReview}
 :name==='@/lib/orchestration/routing'?{orchestrationChoices:async options=>{chosen++;routingOptions=options;if(fullBound){const id=await options.accounting.reserve('openai:gpt-5.3-codex',100);await options.accounting.finish(id,5);return[{provider:openai,modelId:'gpt-5.3-codex',reasoning:'fixed benchmark policy'}];}return[{provider:first,modelId:'gemini-3.1-pro',reasoning:'fixture'},{provider:second,modelId:'claude-sonnet-4-6',reasoning:'fixture'}];},orchestrationFailure:async()=> 'provider'}
 :name==='@/lib/orchestration/bounded-provider'?{boundedProvider:choice=>({post:async()=>({input_tokens:20}),responses:{create:async request=>{const r=await choice.provider.generate({modelId:request.model});return{status:(incompletePrimary||emptyTruncation)&&choice.provider===first?'incomplete':'completed',incomplete_details:{reason:emptyTruncation?'max_output_tokens':'provider_interrupted'},output_text:emptyTruncation&&choice.provider===first?'':r.text,output:[],usage:{total_tokens:r.usage.totalTokens}};}}})}
:name==='./request-budget'?{fitsMissionEnvelope:()=>true,missionInputLimit:()=>48000,missionOutputLimit:claim=>claim.job.role==='review'?5000:3000,missionExecutionDeadline:()=>Date.now()+240000,missionAttemptTimeout:()=>90000,assertSpecificationStageCapacity:async()=>true,MissionAdmissionError:class extends Error{},explainAdmissionDenial:async()=>{throw Error('Worker no longer authorized or mission allowance exhausted');}}
 :name==='@/lib/orchestration/request-rejection'?{rejectedBeforeInference:()=>false}
 :name==='@/lib/providers'?{getAvailableProviders:()=>[first,second]}
 :name==='@/lib/router/master-router'?{chooseProvider:async()=>{chosen++;return{provider:first,modelId:'gemini-3.1-pro',fallbackChain:[{provider:second,modelId:'claude-sonnet-4-6',score:1}]};}}
 :name==='@/lib/missions/store'||name==='./store'?{rpc:async(n,a)=>{rpcEvents.push({name:n,...a});if(n==='reserve_mission_call'||n==='benchmark_reserve_mission_call')reserve.push({name:n,...a});if(n==='reserve_mission_call')return allow;if(n==='benchmark_reserve_mission_call')return 'ledger-receipt';return true;}}
 :name==='@/lib/data/supabase/admin'?{getSupabaseAdminClient:()=>({from:table=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:fullBound?{trial_id:'trial',account_id:'account',benchmark_contract_hash:'c'.repeat(64),baseline_sha:'0015bcdb8ac9ad94b7c74d1a4cd76737903b1319',model:'gpt-5.3-codex'}:null,error:null})})})})})}
 :name==='node:crypto'?{randomUUID:()=>String(reserve.length+1)}
 :name==='openai'?{default:class{}}:name==='openai/helpers/zod'?{zodTextFormat:()=>({})}
 :name==='../../scripts/project-game-rules.mjs'?{GAME_RULE_CATEGORIES:[]}
 :name==='@/lib/projects/contract'?{projectPlanSchema:{omit:()=>({})}}
 :name==='./types'?{planSchema:{}}:{};
 vm.runInNewContext(out,{exports,require,process,Buffer,console,setTimeout,clearTimeout},{filename:'model.js'});
 const claim={mission:{id:'m',project_id:'p',objective:acceptance?'[SYNTHETIC PROVIDER FAILOVER ACCEPTANCE] Validate a bounded operations memo':'Implement an original game',project_evidence:acceptance?{syntheticFaultAcceptance:true}:undefined,team:[{id:'agent',config:{research:false}}],project_kind:'specification'},job:{id:'job',agent_id:'agent',lease:'lease',role:acceptance||emptyTruncation?'work':'review'}};
 return{run:()=>exports.missionModel(claim,'Review independent specification','Saved exact candidate'),calls,reserve,rpcEvents,chosen:()=>chosen,routing:()=>routingOptions};
}
test('mission router selects capable candidate before inference and preserves model evidence',async()=>{
 const t=loadRouterFixture();const result=await t.run();
 assert.equal(result.provider,'google');assert.equal(result.model,'gemini-3.1-pro');assert.equal(t.chosen(),1);
 assert.deepEqual(t.calls,[['google','gemini-3.1-pro']]);
 assert.equal(t.reserve.length,1);assert.equal(t.reserve[0].p_model,'google:gemini-3.1-pro');
});
test('mission router uses ranked chain only after eligible provider failure',async()=>{
 const t=loadRouterFixture({failPrimary:true});const result=await t.run();
 assert.equal(result.provider,'anthropic');assert.equal(result.model,'claude-sonnet-4-6');
 assert.deepEqual(t.calls.map(c=>c[0]),['google','anthropic']);
 assert.equal(t.reserve.length,2);
});
test('no provider call when mission budget disallows reservation',async()=>{
 const t=loadRouterFixture({allow:false});await assert.rejects(t.run(),/budget|allowance/);assert.equal(t.calls.length,0);
});

test('incomplete independent review falls back to the next capable model without discarding charges',async()=>{
 const t=loadRouterFixture({incompletePrimary:true});const result=await t.run();
 assert.equal(result.provider,'anthropic');
 assert.deepEqual(t.calls.map(c=>c[0]),['google','anthropic']);
 assert.equal(t.reserve.length,2);
});

test('production acceptance injection is mission-scoped, applies to first candidate only, and recovers across providers',async()=>{
 const old=process.env.KATIE_ACCEPTANCE_MISSION_ID;
 try{
  process.env.KATIE_ACCEPTANCE_MISSION_ID='m';
  const injected=loadRouterFixture({acceptance:true});
  const success=await injected.run();
  assert.equal(success.provider,'anthropic');
  assert.deepEqual(injected.calls.map(x=>x[0]),['anthropic']);
  assert.equal(injected.reserve.length,2);
  assert.equal(injected.reserve[0].p_model,'google:gemini-3.1-pro');
  assert.equal(injected.reserve[1].p_model,'anthropic:claude-sonnet-4-6');
  const ordinary=loadRouterFixture();
  assert.equal((await ordinary.run()).provider,'google');
 }finally{if(old===undefined)delete process.env.KATIE_ACCEPTANCE_MISSION_ID;else process.env.KATIE_ACCEPTANCE_MISSION_ID=old;}
});


test('empty output at the model cap falls back without buying a larger empty retry',async()=>{
 const t=loadRouterFixture({emptyTruncation:true});const result=await t.run();
 assert.equal(result.provider,'anthropic');assert.deepEqual(t.calls.map(c=>c[0]),['google','anthropic']);assert.equal(t.reserve.length,2);
 assert.equal(t.reserve[0].p_tokens,t.reserve[1].p_tokens,'Fallback retains the original tool/output budget');
});

test('Full DO model route is fixed, ledger-bound, and does not call a provider when paid execution is disabled',async()=>{
 const names=['NEXT_PUBLIC_SUPABASE_URL','KATIE_FULL_BENCHMARK_DISPATCH','KATIE_BENCHMARK_PAID_EXECUTION'];
 const old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 try{
  process.env.NEXT_PUBLIC_SUPABASE_URL='https://iytvavgbaainnsrecmcx.supabase.co';
  process.env.KATIE_FULL_BENCHMARK_DISPATCH='enabled';process.env.KATIE_BENCHMARK_PAID_EXECUTION='disabled';
  const denied=loadRouterFixture({fullBound:true});
  await assert.rejects(denied.run(),/paid execution is disabled/);
  assert.equal(denied.calls.length,0);assert.equal(denied.chosen(),0);
  process.env.KATIE_BENCHMARK_PAID_EXECUTION='enabled';
  const admitted=loadRouterFixture({fullBound:true});const result=await admitted.run();
  assert.equal(result.model,'gpt-5.3-codex');assert.equal(result.provider,'openai');
  assert.equal(admitted.routing().fixedModel.provider,'openai');assert.equal(admitted.routing().fixedModel.modelId,'gpt-5.3-codex');
  const reservations=admitted.reserve.filter(x=>x.name==='benchmark_reserve_mission_call');
  assert.equal(reservations.length,2);assert.ok(reservations.some(x=>x.p_routing===true));
  assert.ok(reservations.some(x=>x.p_routing===false));
  assert.ok(reservations.every(x=>x.p_model==='openai:gpt-5.3-codex'));
  assert.equal(admitted.rpcEvents.filter(x=>x.name==='benchmark_finish_mission_call').length,2);
 }finally{for(const k of names){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}}
});
