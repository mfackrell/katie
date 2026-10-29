import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readNativeHandoff,encodeNativeHandoff} from '../scripts/benchmark/native-dispatch-contract.mjs';
import {sealNativeProductionRuntime,openNativeProductionRuntime} from '../scripts/benchmark/native-runtime-capsule.mjs';
import {assertBenchmarkDollarCeiling,readVerifiedBenchmarkPricing} from '../scripts/benchmark/paid-dollar-ceiling.mjs';
import {tokenDigest} from '../scripts/benchmark/authenticated-native-gateway.mjs';
const source=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
const prefix=source.slice(0,source.indexOf('const clientToken=')).replace(/^import .*;\n/gm,'');
const key='synthetic-production-preflight-signing-key';
const ids=['11111111','22222222','33333333','44444444'].map(p=>`${p}-1111-4111-8111-111111111111`);
async function preflight({production=true,qualification={},capsule,manifestChange={},approvalChange={},envChange={},delegated=false,provenance=true,setupError=false,setupRunner,startupRecoveryId,recoveryError=false,recoveryEpoch=2,childStartupError=false,recoveryChange={},taskChange={}}={}){
 const expiresAt=Date.now()+600000,deadline=new Date(expiresAt).toISOString();
 const p={taskId:ids[0],trialId:ids[1],approvalId:ids[2],projectId:ids[3],contractHash:'a'.repeat(64),benchmarkContractHash:'b'.repeat(64),baselineSha:'c'.repeat(40),expiresAt,...(startupRecoveryId?{startupRecoveryId}:{})};
 if(production)p.productionRuntime=capsule??sealNativeProductionRuntime('synthetic-prod-key',p,key);
 const body=encodeNativeHandoff(p,key),manifest={...readNativeHandoff(body,key),...manifestChange};
 const rows={benchmark_native_spending_approvals:{trial_id:p.trialId,task_id:p.taskId,project_id:p.projectId,repository:'mfackrell/katie',revoked_at:null,consumed_at:null,deadline,account_id:'account',actor_id:'actor',chat_id:'chat',owner_id:'owner',model:'gpt-5.3-codex',max_tokens:350000,...approvalChange},
 benchmark_three_arm_trials:{id:p.trialId,arm:'full',state:'qualified',contract_sha256:p.benchmarkContractHash,baseline_sha:p.baselineSha,owner_actor_id:'actor',experiment_id:'experiment'},
 work_projects:{id:p.projectId,actor_id:'actor',chat_id:'chat',status:'running',phase:'development',approved_hash:'scope',approval_hash:'scope',deadline},
 benchmark_budget_accounts:{id:'account',cap_tokens:350000,trial_id:p.trialId,owner_actor_id:'actor',experiment_id:'experiment'},
 benchmark_production_qualifications:{issue:715,revoked_at:null,owner_id:'owner',actor_id:'actor',experiment_id:'experiment',deadline,...qualification},
 agent_tasks:{id:p.taskId,actor_id:delegated?'specialist':'actor',chat_id:delegated?'specialist-chat':'chat',external:{startupRecoveryId},...taskChange},
 benchmark_startup_recoveries:{id:startupRecoveryId,approval_id:p.approvalId,task_id:p.taskId,release_sha:'d'.repeat(40),...recoveryChange},
 benchmark_development_dispatches:{trial_id:p.trialId,contract_hash:p.contractHash,benchmark_contract_hash:p.benchmarkContractHash,baseline_sha:p.baselineSha,status:'qualified'},
 model_registry:{pricing_status:'verified',pricing_input_per_1m:1.75,pricing_output_per_1m:14}};
 const calls={connections:[],grants:0,masks:[],setup:[],rpcNames:[]};
 const db={from:table=>({select(){return this},eq(){return this},abortSignal(signal){assert.ok(signal instanceof AbortSignal);return this},async maybeSingle(){return {data:rows[table],error:null}}}),rpc:async(name,args)=>{calls.rpcNames.push(name);if(name==='benchmark_full_task_provenance'){assert.equal(args.p_task,p.taskId);assert.equal(args.p_project,p.projectId);return {data:provenance,error:null}}calls.grants++;if(name==='benchmark_issue_startup_recovery_grant'){assert.equal(args.p_recovery,startupRecoveryId);assert.equal(args.p_approval,p.approvalId);assert.equal(args.p_task,p.taskId);assert.equal(args.p_release,'d'.repeat(40));assert.match(args.p_digest,/^[a-f0-9]{64}$/);return {data:recoveryError?null:{grantId:'successor-grant',executionEpoch:recoveryEpoch},error:recoveryError?{message:'denied'}:null};}return {data:'grant-id',error:null}}};
 const context={preflightNativeChild:()=>{if(childStartupError)throw Error('child startup failed');},assertTrustedBoundary:()=>({root:'/trusted'}),execFileSync:(command,args,options)=>{calls.setup.push({command,args,options});if(setupError)throw Error('git setup failed');if(setupRunner)setupRunner(command,args,options);},readNativeHandoff,openNativeProductionRuntime,assertBenchmarkDollarCeiling,readVerifiedBenchmarkPricing,tokenDigest,randomBytes,
  createRequire:()=>()=>({createClient:(url,secret)=>{calls.connections.push({url,secret});return db}}),join:(...p)=>p.join('/'),
  readFileSync:path=>path==='request'?body:JSON.stringify(manifest),
  process:{argv:['node','host','request','manifest','child'],cwd:()=>'/trusted',stdout:{write:v=>calls.masks.push(v)},env:{PATH:'/usr/bin',HOME:'/runner',GH_TOKEN:'synthetic-github-token',KATIE_NATIVE_CHECKPOINT_BRANCH:'agent/issue-829-123-1',KATIE_BENCHMARK_PAID_EXECUTION:'enabled',KATIE_NATIVE_HANDOFF_HMAC_KEY:key,GITHUB_REPOSITORY:'mfackrell/katie',NEXT_PUBLIC_SUPABASE_URL:'https://iytvavgbaainnsrecmcx.supabase.co',KATIE_BENCHMARK_SERVICE_ROLE_KEY:'synthetic-stage-key',OPENAI_API_KEY:'synthetic-provider-key',GITHUB_RUN_ID:'123',GITHUB_SHA:'d'.repeat(40),KATIE_BENCHMARK_APPROVED_ARM_USD_CENTS:'1000',KATIE_BENCHMARK_APPROVED_MAX_USD_MICROS_PER_MILLION:'28000000',...envChange}}};
 try{const authority=await vm.runInNewContext(`(async()=>{${prefix};return {grantId,executionEpoch};})()`,context);return {calls,authority}}catch(error){return {calls,error}}
}
test('actual trusted-host preflight uses production capsule only for live matching qualification; legacy stays staging',async()=>{
 const prod=await preflight();assert.equal(prod.error,undefined);assert.equal(prod.calls.grants,1);assert.equal(prod.calls.connections[0].url,'https://barclcqataqyvifoeyop.supabase.co');assert.equal(prod.calls.connections[0].secret,'synthetic-prod-key');assert.equal(prod.calls.masks.length,1);
 const stage=await preflight({production:false});assert.equal(stage.error,undefined);assert.equal(stage.calls.grants,1);assert.equal(stage.calls.connections[0].url,'https://iytvavgbaainnsrecmcx.supabase.co');assert.equal(stage.calls.connections[0].secret,'synthetic-stage-key');
});
test('actual production preflight rejects revoked, expired, wrong-owner, wrong-experiment qualification before issuing grants',async()=>{
 for(const qualification of [{revoked_at:new Date().toISOString()},{deadline:new Date(0).toISOString()},{owner_id:'other'},{actor_id:'other'},{experiment_id:'other'},{issue:714}]){
  const r=await preflight({qualification});assert.match(r.error?.message??'',/qualification/);assert.equal(r.calls.grants,0);
 }
 const r=await preflight({approvalChange:{deadline:new Date(Date.now()+3600000).toISOString()}});assert.match(r.error?.message??'',/qualification/);assert.equal(r.calls.grants,0);
});
test('corrupt or changed capsule never reaches a database or execution grant',async()=>{
 for(const options of [{capsule:'corrupt'},{manifestChange:{productionRuntime:'different'}}]){
  const r=await preflight(options);assert.ok(r.error);assert.equal(r.calls.connections.length,0);assert.equal(r.calls.grants,0);
 }
});

test('production uses its authenticated server authorization and frozen dollar ceiling; staging still needs explicit switch',async()=>{
 const envChange={KATIE_BENCHMARK_PAID_EXECUTION:'disabled',KATIE_BENCHMARK_APPROVED_ARM_USD_CENTS:'',KATIE_BENCHMARK_APPROVED_MAX_USD_MICROS_PER_MILLION:''};
 const p=await preflight({envChange});assert.equal(p.error,undefined);assert.equal(p.calls.grants,1);
 const s=await preflight({production:false,envChange});assert.match(s.error?.message??'',/separately enabled/);assert.equal(s.calls.grants,0);assert.equal(s.calls.connections.length,0);
});

test('delegated specialist identity must be proven by saved DO lineage before grant',async()=>{
 const accepted=await preflight({delegated:true});assert.equal(accepted.error,undefined);assert.equal(accepted.calls.grants,1);
 const denied=await preflight({delegated:true,provenance:false});assert.match(denied.error?.message??'',/state mismatch/);assert.equal(denied.calls.grants,0);
});

test('checkpoint setup preserves HOME but excludes provider and database secrets before grant consumption',async()=>{
 const r=await preflight();assert.equal(r.error,undefined);assert.equal(r.calls.setup.length,1);
 const call=r.calls.setup[0];assert.equal(call.command,'gh');assert.equal(JSON.stringify(call.args),JSON.stringify(['auth','setup-git']));
 assert.equal(JSON.stringify(call.options.env),JSON.stringify({PATH:'/usr/bin',HOME:'/runner',GH_TOKEN:'synthetic-github-token'}));
 for(const options of [{envChange:{HOME:''}},{setupError:true},{childStartupError:true},{envChange:{KATIE_NATIVE_CHECKPOINT_BRANCH:'invalid'}}]){
  const rejected=await preflight(options);assert.ok(rejected.error);assert.equal(rejected.calls.grants,0);
 }
});

test('real GitHub CLI configures its credential helper with the restricted host environment',t=>{
 const probe=spawnSync('gh',['--version'],{encoding:'utf8'});
 if(probe.error){if(process.env.GITHUB_ACTIONS==='true')throw probe.error;t.skip('GitHub CLI unavailable locally; required on hosted runner');return;}
 const taskHome=mkdtempSync(join(tmpdir(),'native-git-setup-'));
 return preflight({envChange:{HOME:taskHome,PATH:process.env.PATH},setupRunner:execFileSync}).then(r=>{
  assert.equal(r.error,undefined);assert.equal(r.calls.grants,1);
  const config=readFileSync(join(taskHome,'.gitconfig'),'utf8');
  assert.match(config,/auth git-credential/);assert.ok(!config.includes('synthetic-github-token'));
 }).finally(()=>rmSync(taskHome,{recursive:true,force:true}));
});

test('consumed approval requires signed startup recovery and successful atomic successor issuance',async()=>{
 const startupRecoveryId='55555555-1111-4111-8111-111111111111';
 const options={startupRecoveryId,approvalChange:{consumed_at:new Date().toISOString()}};
 const accepted=await preflight(options);assert.equal(accepted.error,undefined);
 assert.equal(accepted.authority.grantId,'successor-grant');assert.equal(accepted.authority.executionEpoch,2);
 assert.ok(accepted.calls.rpcNames.includes('benchmark_issue_startup_recovery_grant'));
 assert.ok(!accepted.calls.rpcNames.includes('benchmark_issue_execution_grant'));
 for(const overrides of [{startupRecoveryId:undefined},{recoveryError:true},{recoveryEpoch:0},{production:false},{approvalChange:{consumed_at:null}}]){
  const r=await preflight({...options,...overrides});assert.ok(r.error);assert.equal(r.authority,undefined);
 }
});

test('startup recovery rejects mismatched durable task, approval and deployed release before setup or grant',async()=>{
 const options={startupRecoveryId:'55555555-1111-4111-8111-111111111111',approvalChange:{consumed_at:new Date().toISOString()}};
 for(const overrides of [{recoveryChange:{approval_id:ids[0]}},{recoveryChange:{task_id:ids[2]}},
  {recoveryChange:{release_sha:'e'.repeat(40)}},{envChange:{GITHUB_SHA:''}},
  {envChange:{GITHUB_SHA:'e'.repeat(40)}},{taskChange:{external:{}}}]){
  const r=await preflight({...options,...overrides});assert.match(r.error?.message??'',/recovery task, approval or release mismatch/);
  assert.equal(r.calls.grants,0);assert.equal(r.calls.setup.length,0);
 }
});
