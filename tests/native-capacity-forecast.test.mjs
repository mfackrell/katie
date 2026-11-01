import test from 'node:test';
import assert from 'node:assert/strict';
import {readNativeLifecycleCapacity,capacityProgress} from '../scripts/benchmark/native-capacity-forecast.mjs';
function setup(){
 const now=Date.parse('2026-10-31T18:00:00Z'),deadline=new Date(now+14400000).toISOString();
 const task={id:'task'},project={id:'project',approved_hash:'b'.repeat(64),approval_hash:'b'.repeat(64),status:'running',deadline},approval={id:'approval',trial_id:'trial',account_id:'account',task_id:'task',project_id:'project',model:'gpt-5.3-codex',deadline};
 const rows={work_projects:[project],benchmark_native_spending_approvals:[approval],agent_missions:[{id:'mission',project_id:'project',calls:11,routing_calls:0,actual_tokens:1100,reserved_tokens:1100}],mission_assignments:[{id:'task',mission_id:'mission'}],benchmark_budget_accounts:[{id:'account',spent_tokens:1100,frozen_at:null}],
  benchmark_budget_calls:Array.from({length:11},(_,i)=>({id:'c'+i,account_id:'account',legacy_mission_call_id:'m'+i,request_key:'m'+i,state:'settled',actual_tokens:100,reserved_tokens:100,model:'gpt-5.3-codex',provider_usage:{input_tokens:90,output_tokens:10}})),
  benchmark_execution_grants:[{id:'grant',trial_id:'trial',continuation_id:'continuation',account_id:'account',project_id:'project',mission_assignment_id:'task',deadline,stopped_at:null,revoked_at:null}],
  mission_calls:Array.from({length:11},(_,i)=>({id:'m'+i,job_id:'task'})),model_registry:[{provider_name:'openai',model_id:'gpt-5.3-codex',pricing_status:'verified',pricing_input_per_1m:'2.5',pricing_output_per_1m:'14',pricing_verified_at:new Date(now-1000).toISOString()}]};
 const reads=[],rpcs={benchmark_effective_mission_allowance:448279,benchmark_effective_mission_call_limit:15,benchmark_continuation_live:true,benchmark_full_monetary_control:{version:'atomic-exposure-v1',cumulativeTokenCap:625000,dollarCeilingMicrousd:10000000,exposureMicrousd:5000000}};
 let changed=false;
 const db={from(table){assert.ok(rows[table]);reads.push(table);let filtered=rows[table],single=false;return {select(){return this;},eq(k,v){filtered=filtered.filter(r=>r[k]===v);return this;},limit(n){filtered=filtered.slice(0,n);return this;},maybeSingle(){single=true;return this;},async abortSignal(){if(changed&&table==='benchmark_budget_accounts')rows[table][0].spent_tokens++;return {data:structuredClone(single?filtered[0]:filtered),error:null};}};},rpc(name){assert.ok(Object.hasOwn(rpcs,name),'Unexpected mutation RPC: '+name);reads.push(name);return {async abortSignal(){return {data:structuredClone(rpcs[name]),error:null};}};}};
 return {rows,reads,rpcs,setChanged(){changed=true;},args:{db,task,project,approval,continuation:{id:'continuation',deadline,plan:{version:6,serviceTier:'default',developmentClosureCalls:4,developmentClosureTokens:60000,assessmentTokens:60000}},context:{baselineSha:'a'.repeat(40),contractHash:'c'.repeat(64)},recovery:{phase:'repair',checkpointSha:'d'.repeat(40)},now}};
}
test('live adapter detects exhausted native allocation using immutable-plan-independent live rows',async()=>{
 const f=setup(),before=structuredClone(f.rows);const r=await readNativeLifecycleCapacity(f.args);
 assert.equal(r.status,'insufficient');assert.ok(r.shortages.includes('nativeCalls'));assert.equal(r.dimensions.nativeCalls.authorizedRemaining,0);assert.equal(r.dimensions.completionCalls.authorizedRemaining,4);assert.equal(r.dimensions.money.authorizedRemaining,'5000000');assert.deepEqual(f.rows,before);
 assert.ok(f.reads.includes('benchmark_effective_mission_call_limit'));assert.ok(f.reads.includes('benchmark_full_monetary_control'));
});
test('current account holds and max mission actual/reserved remain encumbered',async()=>{
 const f=setup();f.rows.benchmark_budget_calls.push({id:'hold',account_id:'account',state:'unresolved',reserved_tokens:500000});f.rows.agent_missions[0].reserved_tokens=2000;
 const r=await readNativeLifecycleCapacity(f.args);assert.equal(r.dimensions.totalTokens.authorizedRemaining,123900);assert.equal(r.dimensions.nativeTokens.authorizedRemaining,3900);assert.equal(r.authorization.spendingPermission,'unchanged');
});
test('changing or incomplete ledger snapshot remains unknown',async()=>{
 const f=setup();f.setChanged();const r=await readNativeLifecycleCapacity(f.args);assert.equal(r.status,'indeterminate');assert.equal(r.dimensions.nativeCalls.authorizedRemaining,null);assert.ok(r.uncertainties.includes('authoritative_snapshot_unavailable_or_changed'));
 const g=setup();g.rows.mission_calls.pop();const s=await readNativeLifecycleCapacity(g.args);assert.equal(s.dimensions.nativeCalls.authorizedRemaining,null);
});
test('unverified pricing does not erase established call shortage or monetary headroom',async()=>{
 const f=setup();f.rows.model_registry[0].pricing_status='unverified';const r=await readNativeLifecycleCapacity(f.args);assert.ok(r.shortages.includes('nativeCalls'));assert.equal(r.dimensions.money.projectedRemaining,null);assert.equal(r.dimensions.money.authorizedRemaining,'5000000');
});
test('expired authority reports unusable resources without mutations',async()=>{
 const f=setup();f.rpcs.benchmark_continuation_live=false;f.rpcs.benchmark_full_monetary_control=null;f.args.continuation.deadline=new Date(f.args.now-1).toISOString();const before=structuredClone(f.rows),r=await readNativeLifecycleCapacity(f.args);assert.ok(r.shortages.includes('executionAuthority'));assert.equal(r.dimensions.completionCalls.currentlyUsable,0);assert.deepEqual(f.rows,before);
});
test('receipt mismatches cannot calibrate phase forecasts',async()=>{
 const f=setup();f.args.observations=[0,1,2].map(i=>({id:'observation'+i,source:'verified_phase_receipts',completed:true,stage:'repair',binding:{projectId:'project',scopeHash:f.args.project.approved_hash},cohort:f.args.project.approved_hash,calls:1,operationIds:['missing'+i],inputTokens:10,outputTokens:10,seconds:10}));
 const r=await readNativeLifecycleCapacity(f.args);assert.equal(r.stages.find(s=>s.stage==='repair').metrics.inputTokens.projected,null);
});
test('host phase mapping keeps recovered engineering complete and final verification outstanding',()=>{
 const binding={};const r=capacityProgress({binding,recovery:{phase:'repair',checkpointSha:'hash'},phase:'repair'});assert.deepEqual(r.completedStages,['implementation','initial_review']);assert.equal(r.source,'authenticated_recovery');
 const final=capacityProgress({binding,phase:'final-review'});assert.ok(!final.completedStages.includes('verification'));assert.ok(!final.completedStages.includes('final_review'));
});

test('stopped, revoked, expired or mismatched current execution grant is never usable',async()=>{
 for(const patch of [{stopped_at:'stopped'},{revoked_at:'revoked'},{deadline:'2000-01-01'},{mission_assignment_id:'other'}]){
  const f=setup();Object.assign(f.rows.benchmark_execution_grants[0],patch);f.args.grantId='grant';const r=await readNativeLifecycleCapacity(f.args);assert.equal(r.authorization.executionAuthorized,false);assert.equal(r.dimensions.completionCalls.currentlyUsable,0);assert.ok(r.shortages.includes('executionAuthority'));
 }
 const f=setup();f.args.grantId='grant';const live=await readNativeLifecycleCapacity(f.args);assert.equal(live.authorization.executionAuthorized,true);f.args.grantId=null;const pre=await readNativeLifecycleCapacity(f.args);assert.equal(pre.authorization.executionAuthorized,null);assert.equal(pre.dimensions.completionCalls.currentlyUsable,null);
});
test('unsafe numeric exposure is unknown instead of rounded money',async()=>{
 const f=setup();f.rpcs.benchmark_full_monetary_control.exposureMicrousd=Number.MAX_SAFE_INTEGER+1;const r=await readNativeLifecycleCapacity(f.args);assert.equal(r.dimensions.money.authorizedRemaining,null);assert.ok(r.shortages.includes('nativeCalls'));
});
test('trusted workflow stages the complete relative import closure',async()=>{
 const {readFileSync}=await import('node:fs');
 const workflow=readFileSync('.github/workflows/autonomous-development.yml','utf8');
 const names=workflow.match(/cp scripts\/benchmark\/\{([^}]+)\}\.mjs/)[1].split(',').map(x=>x+'.mjs');
 assert.ok(names.includes('lifecycle-capacity.mjs'));assert.ok(names.includes('native-capacity-forecast.mjs'));
 for(const name of names){const source=readFileSync('scripts/benchmark/'+name,'utf8');for(const m of source.matchAll(/from ['"]\.\/([^'"]+)['"]/g))assert.ok(names.includes(m[1]),name+' missing staged dependency '+m[1]);}
});

test('execution time is bounded by the live grant, not just the later owner window',async()=>{
 const f=setup();f.args.grantId='grant';f.rows.benchmark_execution_grants[0].deadline=new Date(f.args.now+30000).toISOString();const r=await readNativeLifecycleCapacity(f.args);assert.equal(r.authorization.executionAuthorized,true);assert.equal(r.dimensions.time.authorizedRemaining,30);
});

test('revoked continuation preserves known authority denial when monetary RPC returns null',async()=>{
 const f=setup();f.rpcs.benchmark_continuation_live=false;f.rpcs.benchmark_full_monetary_control=null;f.rows.benchmark_native_spending_approvals[0].revoked_at='revoked';const before=structuredClone(f.rows);
 const r=await readNativeLifecycleCapacity(f.args);assert.equal(r.status,'insufficient');assert.ok(r.shortages.includes('executionAuthority'));assert.equal(r.authorization.live,false);assert.equal(r.dimensions.money.authorizedRemaining,null);assert.equal(r.dimensions.money.currentlyUsable,'0');assert.equal(r.dimensions.nativeCalls.currentlyUsable,0);assert.deepEqual(f.rows,before);
});

 test('additional repair reopens repair verification and final review including restored flags',()=>{
 const r=capacityProgress({binding:{},recovery:{phase:'final-review',checkpointSha:'a'.repeat(40),lastCompleted:{repairPerformed:true}},phase:'repair',completedStages:['implementation','initial_review','repair','verification','final_review'],notRequiredStages:['repair']});
 assert.deepEqual(r.completedStages,['implementation','initial_review']);assert.deepEqual(r.notRequiredStages,[]);
 });
