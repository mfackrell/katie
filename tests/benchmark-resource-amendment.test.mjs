import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
const source=readFileSync('lib/agents/development.ts','utf8');
const start=source.indexOf('async function dispatchOwnerResourceAmendment('),end=source.indexOf('// Dispatch only a separately',start);
const code=stripTypeScriptTypes(source.slice(start,end));
function harness({approved=true,ready=true,runtime=true,wrongRun=false,dispatchError=false}={}){
 const receipt={run_id:128,outcome:'BLOCKED',pr_url:null,tested_head_sha:null,reviewed_head_sha:null},calls=[];let sent=false;
 const amendment={id:'amendment',renewal_id:'renewal',approval_id:'new-approval',task_id:'task',continuation_id:'new-continuation',successor_id:'successor',failed_run:128,release_sha:'new',receipt,source_snapshot:{approval:{id:'old-approval'},previousContinuation:{id:'old-continuation'},successor:{release_sha:'old'}}};
 const rows={benchmark_native_spending_approvals:{id:'new-approval',task_id:'task',project_id:'project',trial_id:'trial',continuation_id:'new-continuation',deadline:new Date(Date.now()+3600000).toISOString()},benchmark_development_dispatches:{contract_hash:'contract',trial_id:'trial',benchmark_contract_hash:'benchmark'}};
 const db={from(table){return {select(){return this},eq(){return this},order(){return this},limit(){return this},async returns(){return {data:approved?[amendment]:[]};},async maybeSingle(){return {data:table==='benchmark_development_amendment_dispatches'?(sent?{amendment_id:'amendment'}:null):rows[table]};}};},async rpc(name,args){calls.push(name);if(name==='benchmark_development_amendment_ready')return {data:ready};if(name==='benchmark_claim_development_amendment'){assert.equal(args.p_release,'new');const ok=!sent;sent=true;return {data:ok};}throw Error('Unexpected authority mutation');}};
 const client={actions:{async getWorkflowRun(){return {data:{id:128,status:'completed',conclusion:'failure',event:'workflow_dispatch',path:'.github/workflows/autonomous-development.yml',head_sha:wrongRun?'other':'old',head_branch:'main',repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}}};},async listWorkflowRunArtifacts(){return {data:{artifacts:[{id:2,name:'agent-completion',expired:false,size_in_bytes:100}]}};},async downloadArtifact(){return {data:new ArrayBuffer(0)};},async createWorkflowDispatch(){calls.push('workflow_dispatch');if(dispatchError)throw Error('Lost dispatch response');}},issues:{async get(){return {data:{user:{login:'mfackrell'},body:'marker\n\n<!-- katie-native-benchmark:a.b -->'}};},async update(){calls.push('issue_update');}}};
 const context={Buffer,Date,process:{env:{SUPABASE_SERVICE_ROLE_KEY:'synthetic'}},qualifiedDevelopmentAmendmentRelease:async()=>runtime?'new':null,readTask:async()=>({id:'task',status:'dispatching',external:{resourceAmendmentId:'amendment',receipt,issueNumber:829}}),getDevelopmentProjectContext:async()=>({projectId:'project',contractHash:'contract',baselineSha:'baseline'}),receiptSchema:{safeParse:data=>({success:true,data})},github:()=>client,repository:async()=>({owner:'mfackrell',repo:'katie',fullName:'mfackrell/katie'}),parseCompletionReceipt:()=>receipt,completionJson:()=>receipt,acceptanceBinding:x=>x,digest:JSON.stringify,unpackDevelopmentRequest:x=>x,packDevelopmentRequest:x=>x,marker:()=> 'marker',readNativeHandoff:()=>({taskId:'task',approvalId:'old-approval',paidSuccessorId:'successor',continuationId:'old-continuation',trialId:'trial',projectId:'project',contractHash:'contract',benchmarkContractHash:'benchmark',baselineSha:'baseline'}),encodeNativeHandoff:p=>{assert.equal(p.resourceAmendmentId,'amendment');assert.equal(p.approvalId,'new-approval');assert.equal(p.paidSuccessorId,undefined);calls.push('signed_new_owner_authority');return 'signed';},sealNativeProductionRuntime:()=> 'capsule'};
 const run=vm.runInNewContext(code+';dispatchOwnerResourceAmendment',context);return {calls,run:()=>run(db,'key','new')};
}
test('amendment dispatcher requires explicit approved row and verified counted runtime',async()=>{
 for(const options of [{approved:false},{ready:false},{runtime:false},{wrongRun:true}]){const h=harness(options);assert.equal(await h.run(),false);assert.ok(!h.calls.includes('workflow_dispatch'));assert.ok(!h.calls.includes('benchmark_claim_development_amendment'));}
 const h=harness();assert.equal(await h.run(),true);assert.equal(await h.run(),false);assert.equal(h.calls.filter(x=>x==='workflow_dispatch').length,1);assert.ok(!h.calls.some(x=>/issue.*grant|approve|prepare/.test(x)));
});
test('amended dispatch acceptance uncertainty never resubmits',async()=>{const h=harness({dispatchError:true});await assert.rejects(h.run(),/Lost dispatch response/);assert.equal(await h.run(),false);assert.equal(h.calls.filter(x=>x==='workflow_dispatch').length,1);});
test('exact deployed main source must contain counted provider, gateway and host capability',async()=>{
 const start=source.indexOf('export async function qualifiedDevelopmentAmendmentRelease('),end=source.indexOf('// Owner consent binds',start);
 const code=stripTypeScriptTypes(source.slice(start,end).replace('export async','async'));
 for(const wrong of ['none','main','provider','gateway','host']){
  const release='a'.repeat(40),texts=["export const NATIVE_INPUT_COUNT_VERSION='provider-input-count-v1'; export const NATIVE_MONETARY_CONTROL_VERSION='atomic-exposure-v1'",'countInputTokens','NATIVE_INPUT_COUNT_VERSION resourceAmendmentId'];
  const context={Buffer,process:{env:{VERCEL_GIT_COMMIT_SHA:release,KATIE_FULL_BENCHMARK_ENVIRONMENT:'production'}},github:()=>({repos:{getCommit:async()=>({data:{sha:wrong==='main'?'b'.repeat(40):release}}),getContent:async({path,ref})=>{assert.equal(ref,release);const i=path.includes('provider-receipts')?0:path.includes('authenticated')?1:2;return {data:{type:'file',content:Buffer.from(wrong===['provider','gateway','host'][i]?'':texts[i]).toString('base64')}};}}})};
  const run=vm.runInNewContext(code+';qualifiedDevelopmentAmendmentRelease',context);assert.equal(await run(),wrong==='none'?release:null);
 }
});
test('reconcile waits before amended dispatch and excludes every preserved predecessor',async()=>{
 const start=source.indexOf('export async function reconcileDevelopment('),end=source.indexOf('  const client = github(), binding = await repository(task);',start);
 const prefix=stripTypeScriptTypes(source.slice(start,end).replace('export async','async')+'return task;}');let detail;
 const reconcile=vm.runInNewContext(prefix+';reconcileDevelopment',{save:async(task,status,d)=>{detail=d;return task;},Date});
 const task={id:'task',status:'dispatching',external:{resourceAmendmentId:'amendment',paidSuccessorId:'prior',paidSuccessorSince:'2026-10-30T00:20:00Z',paidSuccessorRelease:'old',pregrantRecoverySince:'2026-10-29T23:00:00Z',pregrantRecoveryRelease:'older'}};
 await reconcile(task,{});assert.match(detail,/Waiting for the owner-approved resource amendment dispatch/);
 const guards=source.split('\n').filter(line=>line.includes('run.created_at')&&['resourceAmendmentSince','paidSuccessorSince','pregrantRecoverySince','developmentRenewalSince'].some(x=>line.includes(x))).join('\n');
 const filter=new Function('task','runs','const accepted=[];for(const run of runs){'+guards+';accepted.push(run.id);}return accepted;');
 task.external.resourceAmendmentSince='2026-10-30T01:00:00Z';task.external.resourceAmendmentRelease='new';
 assert.deepEqual(filter(task,[{id:'old',created_at:'2026-10-30T00:25:00Z',head_sha:'old',event:'workflow_dispatch'},{id:'new',created_at:'2026-10-30T01:01:00Z',head_sha:'new',event:'workflow_dispatch'}]),['new']);
});
test('owner API GET is read-only and amendment POST requires its explicit authorization and current plan',async()=>{
 const raw=readFileSync('app/api/benchmark/715/continuation/route.ts','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');const code=stripTypeScriptTypes(raw);
 const calls=[],env={NEXT_PUBLIC_SUPABASE_URL:'https://production.test',NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic',VERCEL_ENV:'production',KATIE_OWNER_AUTH_USER_ID:'owner'};
 const context={process:{env},AbortSignal,NextResponse:{json:(body,opts)=>({body,status:opts.status})},config:{productionDatabaseUrl:env.NEXT_PUBLIC_SUPABASE_URL,productionUrl:'https://katie.test'},fetch:async()=>({ok:true,json:async()=>({id:'owner'})}),qualifiedAmendmentSuccessorRelease:async()=>null,qualifiedDevelopmentAmendmentRelease:async()=> 'a'.repeat(40),getSupabaseAdminClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return args.p_approve&&args.p_plan_hash!=='c'.repeat(64)?{error:{message:'stale'}}:{data:{approved:Boolean(args.p_approve)}};}})};
 const api=vm.runInNewContext(code+';({GET,POST})',context),request=body=>({headers:{get:k=>k==='authorization'?'Bearer synthetic-owner':k==='origin'?'https://katie.test':null},json:async()=>body});
 assert.equal((await api.GET(request())).status,200);assert.equal(calls[0].name,'benchmark_dashboard_development_amendment');assert.equal(calls[0].args.p_approve,undefined);
 const body={approve:true,authorization:'full-development-resource-amendment-550000tokens-10usd-4hours',projectId:'11111111-1111-4111-8111-111111111111',planHash:'c'.repeat(64)};
 assert.equal((await api.POST(request({...body,approve:false}))).status,400);assert.equal(calls.length,1);
 assert.equal((await api.POST(request({...body,planHash:'d'.repeat(64)}))).status,409);
 assert.equal((await api.POST(request(body))).status,200);assert.equal(calls.at(-1).args.p_approve,true);assert.equal(calls.at(-1).args.p_runtime,'provider-input-count-v1');
});


test('coordinator accepts preserved amended development arithmetic before assessment',()=>{
 const raw=readFileSync('lib/projects/worker.ts','utf8');const start=raw.indexOf('const valid=plan&&'),end=raw.indexOf('if(!valid)',start);
 assert.ok(start>0&&end>start);const validate=new Function('plan','p','renewal',stripTypeScriptTypes(raw.slice(start,end))+'return valid;');
 assert.equal(validate({specificationTokens:0,developmentTokens:373279,assessmentTokens:60000,developmentRemainingTokens:294059,developmentSpentTokens:79220,additionalTokenCap:354059},{phase:'assessment'},true),true);
 assert.equal(validate({specificationTokens:0,developmentTokens:373279,assessmentTokens:60000,developmentRemainingTokens:294060,developmentSpentTokens:79220,additionalTokenCap:354059},{phase:'assessment'},true),false);
});
