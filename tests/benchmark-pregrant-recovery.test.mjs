import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
const source=readFileSync('lib/agents/development.ts','utf8');
const start=source.indexOf('async function recoverOwnerRenewalPregrant('),end=source.indexOf('// Capability proof',start);
const code=stripTypeScriptTypes(source.slice(start,end));
function harness({unused=true,log='Error: NATIVE_HOST_DENIED: model price evidence unavailable\n',binary=false,releaseWrong=false,dispatchError=false}={}){
 const receipt={run_id:126,outcome:'BLOCKED',pr_url:null,tested_head_sha:null,reviewed_head_sha:null},calls=[];
 let prepared=false,claimed=false;
 const rows={benchmark_development_renewal_dispatches:{release_sha:'old'},benchmark_native_spending_approvals:{id:'approval',task_id:'task',project_id:'project',trial_id:'trial',continuation_id:'continuation',deadline:new Date(Date.now()+3600000).toISOString()},benchmark_development_dispatches:{contract_hash:'contract',trial_id:'trial',benchmark_contract_hash:'benchmark'}};
 const db={from(table){return {select(){return this},eq(){return this},order(){return this},limit(){return this},async returns(){return {data:[{id:'renewal',approval_id:'approval',task_id:'task',prior_run:125}]};},async maybeSingle(){return {data:table==='benchmark_development_pregrant_recoveries'?(prepared?{id:'recovery',release_sha:'new'}:null):table==='benchmark_development_pregrant_dispatches'?(claimed?{recovery_id:'recovery'}:null):rows[table]};}};},async rpc(name){calls.push(name);if(name==='benchmark_development_pregrant_unused')return {data:unused};if(name==='benchmark_prepare_development_pregrant_recovery'){prepared=true;return {data:{id:'recovery'}};}if(name==='benchmark_claim_development_pregrant_dispatch'){const ok=!claimed;claimed=true;return {data:ok};}throw Error('Unexpected authority mutation');}};
 const client={actions:{async getWorkflowRun(){return {data:{id:126,status:'completed',conclusion:'failure',event:'workflow_dispatch',path:'.github/workflows/autonomous-development.yml',head_sha:releaseWrong?'other':'old',head_branch:'main',repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}}};},async listJobsForWorkflowRun(){return {data:{jobs:[{id:1,name:'build',status:'completed',conclusion:'failure'}]}};},async downloadJobLogsForWorkflowRun(){return {data:binary?new TextEncoder().encode(log).buffer:log};},async listWorkflowRunArtifacts(){return {data:{artifacts:[{id:2,name:'agent-completion',expired:false,size_in_bytes:100}]}};},async downloadArtifact(){return {data:new ArrayBuffer(0)};},async createWorkflowDispatch(){calls.push('workflow_dispatch');if(dispatchError)throw Error('Lost dispatch response');}},repos:{async getCommit(){return {data:{sha:'new'}};}},issues:{async get(){return {data:{user:{login:'mfackrell'},body:'marker\n\n<!-- katie-native-benchmark:a.b -->'}};},async update(){calls.push('issue_update');}}};
 const context={Buffer,Date,process:{env:{SUPABASE_SERVICE_ROLE_KEY:'synthetic'}},readTask:async()=>({id:'task',status:prepared?'dispatching':'blocked',external:{developmentRenewalId:'renewal',receipt,issueNumber:829}}),getDevelopmentProjectContext:async()=>({projectId:'project',contractHash:'contract',baselineSha:'baseline'}),receiptSchema:{safeParse:data=>({success:true,data})},github:()=>client,repository:async()=>({owner:'mfackrell',repo:'katie',fullName:'mfackrell/katie'}),parseCompletionReceipt:()=>receipt,completionJson:()=>receipt,acceptanceBinding:x=>x,digest:JSON.stringify,unpackDevelopmentRequest:x=>x,packDevelopmentRequest:x=>x,marker:()=> 'marker',readNativeHandoff:()=>({taskId:'task',approvalId:'approval',developmentRenewalId:'renewal',trialId:'trial',projectId:'project',contractHash:'contract',benchmarkContractHash:'benchmark',baselineSha:'baseline'}),encodeNativeHandoff:p=>{assert.equal(p.pregrantRecoveryId,'recovery');assert.equal(p.approvalId,'approval');calls.push('signed_same_approval');return 'signed';},sealNativeProductionRuntime:()=> 'capsule'};
 const run=vm.runInNewContext(code+';recoverOwnerRenewalPregrant',context);
 return {calls,run:()=>run(db,'key','new')};
}
test('verified pregrant dispatcher binds same approval and one recovered dispatch for text/binary logs',async()=>{
 for(const binary of [false,true]){const h=harness({binary});assert.equal(await h.run(),true);assert.equal(await h.run(),false);assert.equal(h.calls.filter(x=>x==='workflow_dispatch').length,1);assert.ok(!h.calls.some(x=>/grant|reserve/.test(x)&&x!=='benchmark_development_pregrant_unused'&&x!=='benchmark_prepare_development_pregrant_recovery'&&x!=='benchmark_claim_development_pregrant_dispatch'));}
});
test('wrong release, unknown failure, or spent authority never prepares or dispatches',async()=>{
 for(const options of [{unused:false},{releaseWrong:true},{log:'Error: unrelated failure\n'}]){const h=harness(options);assert.equal(await h.run(),false);assert.ok(!h.calls.includes('benchmark_prepare_development_pregrant_recovery'));assert.ok(!h.calls.includes('workflow_dispatch'));}
});
test('uncertain accepted dispatch is not automatically submitted twice',async()=>{
 const h=harness({dispatchError:true});await assert.rejects(h.run(),/Lost dispatch response/);assert.equal(await h.run(),false);assert.equal(h.calls.filter(x=>x==='workflow_dispatch').length,1);
});
test('host recovery checks record/release and uses only recovery grant endpoint',async()=>{
 const host=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
 const start=host.indexOf('if(proof.pregrantRecoveryId){'),end=host.indexOf('const clientToken=',start);
 // The extracted block depends on the continuation read earlier by the real host.
 // This legacy pre-grant fixture has no capacity-renewal continuation.
 // These authority fixtures represent tasks with no saved WIP. The full host
 // preflight tests separately exercise restoration rejection before grants.
 const recoveryFixture="const requestFile='/trusted/request',boundary={root:'/fixture'};const execFileSync=()=> '{}',join=(...parts)=>parts.join('/'),recoveryRefs=()=>[];";
 const run=new (Object.getPrototypeOf(async function(){}).constructor)('proof','productionRuntime','readOne','task','process','db','randomBytes','tokenDigest','denied','continuation','const ordinary=false;'+recoveryFixture+host.slice(start,end)+'return {grantId,executionEpoch};');
 const proof={pregrantRecoveryId:'recovery',developmentRenewalId:'renewal',approvalId:'approval',taskId:'task'};
 for(const wrong of [false,true]){
  const calls=[];const promise=run(proof,{},async()=>({id:'recovery',renewal_id:'renewal',release_sha:wrong?'old':'new'}),{external:{pregrantRecoveryId:'recovery'}},{env:{GITHUB_SHA:'new'}},{rpc:async(name,args)=>{calls.push(name);assert.equal(args.p_approval,'approval');return {data:{grantId:'grant',executionEpoch:4}};}},()=>({toString:()=> 'token'}),()=> 'digest',message=>{throw Error(message);});
  if(wrong){await assert.rejects(promise,/release mismatch/);assert.deepEqual(calls,[]);}else{assert.equal((await promise).executionEpoch,4);assert.deepEqual(calls,['benchmark_issue_development_pregrant_recovery_grant']);}
 }
});
test('reconciliation waits before recovery dispatch and cannot reuse predecessor failure afterwards',async()=>{
 const start=source.indexOf('export async function reconcileDevelopment('),end=source.indexOf('  const client = github(), binding = await repository(task);',start);
 const prefix=stripTypeScriptTypes(source.slice(start,end).replace('export async','async')+'return task;}');
 let persisted;
 const reconcile=vm.runInNewContext(prefix+';reconcileDevelopment',{save:async(task,status,detail,external,lease)=>{persisted={status,detail,lease};return {...task,status,details:detail,external};},Date});
 const task={id:'same-task',status:'dispatching',external:{pregrantRecoveryId:'recovery',developmentRenewalSince:'2026-10-29T20:00:00Z'}};
 await reconcile(task,{},'same-lease');assert.match(persisted.detail,/Waiting for verified pregrant recovery dispatch/);assert.equal(persisted.lease,'same-lease');
 const guards=source.split('\n').filter(line=>line.includes('run.created_at')&&(line.includes('pregrantRecoverySince')||line.includes('developmentRenewalSince'))).join('\n');
 const filter=new Function('task','runs','const accepted=[];for(const run of runs){'+guards+';accepted.push(run.id);}return accepted;');
 task.external.pregrantRecoverySince='2026-10-29T21:00:00Z';task.external.pregrantRecoveryRelease='new';task.external.developmentRenewalRelease='old';
 const runs=[{id:'old-failure',created_at:'2026-10-29T20:30:00Z',head_sha:'old',event:'workflow_dispatch'},{id:'new-attempt',created_at:'2026-10-29T21:01:00Z',head_sha:'new',event:'workflow_dispatch'},{id:'wrong-event',created_at:'2026-10-29T21:01:00Z',head_sha:'new',event:'issues'}];
 assert.deepEqual(filter(task,runs),['new-attempt']);
});


