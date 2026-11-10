import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {encodeProviderExecutionHandoff,providerExecutionRequestHash,readProviderExecutionHandoff} from '../scripts/benchmark/provider-execution-handoff.mjs';
import {openNativeProductionRuntime,sealNativeProductionRuntime} from '../scripts/benchmark/native-runtime-capsule.mjs';
import {PROVIDER_EXECUTION_MODEL,providerExecutionForwarder} from '../scripts/benchmark/provider-execution-native.mjs';
import {createNativeReasoningProvenance} from '../scripts/benchmark/native-request-admission.mjs';
import {createResponsesProvider} from '../scripts/benchmark/native-provider-receipts.mjs';
import {executeNativeDevelopmentLifecycle} from '../scripts/benchmark/native-development-lifecycle.mjs';

test('provider execution handoff authenticates the full request and keeps its capsule in its own scope',()=>{
 const key='test-only-key'.repeat(3),now=1_000_000;
 const taskId='11111111-1111-4111-8111-111111111111',projectId='22222222-2222-4222-8222-222222222222';
 const request='exact original request and project context';
 const proof={authorityKind:'provider-execution',taskId,projectId,scopeHash:'a'.repeat(64),contractHash:'b'.repeat(64),
  baselineSha:'c'.repeat(40),releaseSha:'d'.repeat(40),requestHash:providerExecutionRequestHash(request),expiresAt:now+60_000};
 const productionRuntime=sealNativeProductionRuntime('dummy-service-role',proof,key,now);
 const handoff=encodeProviderExecutionHandoff({...proof,productionRuntime},key,now);
 const body=`Issue title\n\n<!-- katie-managed-task:${taskId} -->\n\n${handoff}\n\n${request}\n`;
 assert.equal(readProviderExecutionHandoff(body,key,now).requestHash,proof.requestHash);
 assert.equal(openNativeProductionRuntime(productionRuntime,proof,key,now).serviceRoleKey,'dummy-service-role');
 assert.throws(()=>openNativeProductionRuntime(productionRuntime,{...proof,scopeHash:'e'.repeat(64)},key,now));
 for(const invalid of [body.replace(request,'changed request'),body.replace(taskId,projectId),body+handoff,body+'<!-- katie-native-developer:x.y -->'])
  assert.throws(()=>readProviderExecutionHandoff(invalid,key,now),/HANDOFF_INVALID/);
 assert.throws(()=>readProviderExecutionHandoff(body,key,proof.expiresAt),/HANDOFF_INVALID/);
});

test('native provider-controlled execution forwards without ledger data and stops after refusal',async()=>{
 const calls=[];
 const upstream=Object.assign(async ()=>{
  calls.push('generate');
  return {providerRequestId:'request',actualTokens:null,refusal:calls.filter(x=>x==='generate').length===2};
 },{countInputTokens:async body=>{
  calls.push('count');
  return {requestHash:createHash('sha256').update(JSON.stringify(body)).digest('hex'),inputTokens:10};
 }});
 const forward=providerExecutionForwarder({assertLive:async()=>{calls.push('live');},upstream,
  observe:()=>{calls.push('observe');throw Error('telemetry unavailable');},stop:async error=>{calls.push(error.message);}});
 const provenance=createNativeReasoningProvenance(),request={model:PROVIDER_EXECUTION_MODEL,input:'implementation'};
 assert.equal((await forward(request,provenance)).actualTokens,null);
 await assert.rejects(()=>forward(request,provenance),/GATEWAY_PROVIDER_REFUSED/);
 await assert.rejects(()=>forward(request,provenance),/GATEWAY_EXECUTION_STOPPED/);
 assert.deepEqual(calls,['live','count','live','generate','observe','live','count','live','generate','observe','GATEWAY_PROVIDER_REFUSED']);
});

test('native provider-controlled execution rechecks authority after input count',async()=>{
 let live=0,generated=0,stops=0;
 const upstream=Object.assign(async ()=>{generated++;},{countInputTokens:async body=>({requestHash:createHash('sha256').update(JSON.stringify(body)).digest('hex'),inputTokens:10})});
 const forward=providerExecutionForwarder({assertLive:async()=>{if(++live===2)throw Error('GATEWAY_EXECUTION_STOPPED');},upstream,stop:async()=>{stops++;}});
 await assert.rejects(()=>forward({model:PROVIDER_EXECUTION_MODEL,input:'implementation'},createNativeReasoningProvenance()),/EXECUTION_STOPPED/);
 assert.equal(generated,0);assert.equal(stops,0);
});

test('provider response receipt remains optional only in the explicitly selected mode',async()=>{
 const fetchImpl=async()=>new Response(JSON.stringify({id:'response',status:'completed',service_tier:'default',output:[{content:[{type:'refusal'}]}]}),{headers:{'content-type':'application/json'}});
 const apiKey='dummy-provider-key-for-test';
 await assert.rejects(()=>createResponsesProvider({apiKey,fetchImpl})({}),/AUTHORITATIVE_RECEIPT_MISSING/);
 assert.equal((await createResponsesProvider({apiKey,fetchImpl,usageOptional:true})({})).refusal,true);
});

test('authenticated reasoning can continue without reported usage only in provider-controlled mode',()=>{
 const item={type:'reasoning',id:'reasoning-id',encrypted_content:'opaque-reasoning'};
 const response={providerRequestId:'response-id',actualTokens:null,
  body:JSON.stringify({id:'response-id',status:'completed',output:[item]}),contentType:'application/json'};
 const trial=createNativeReasoningProvenance({usageOptional:true}),legacy=createNativeReasoningProvenance();
 trial.remember(response,PROVIDER_EXECUTION_MODEL,4096);legacy.remember(response,PROVIDER_EXECUTION_MODEL,4096);
 assert.equal(trial.bound(item,PROVIDER_EXECUTION_MODEL),4096);
 assert.equal(legacy.bound(item,PROVIDER_EXECUTION_MODEL),undefined);
});

test('native implementation sends a real rejection to management without autonomous workflow repair',async()=>{
 const phases=[];const head='e'.repeat(40);let terminal;
 await assert.rejects(()=>executeNativeDevelopmentLifecycle({maxRepairIterations:0,
  runPhase:async phase=>{phases.push(phase);return {verdict:'changes_requested',reviewedHeadSha:head,findings:'Incorrect board win handling'};},
  commitCandidate:async()=>head,verifyCandidate:async()=>({passed:false,detail:'diagonal case failed'}),
  onCompleted:evidence=>{terminal=evidence;}}),/NATIVE_MANAGEMENT_CORRECTION_REQUIRED/);
 assert.deepEqual(phases,['implementation','review']);
 assert.equal(terminal.review.verdict,'changes_requested');
 assert.equal(terminal.stopReason,'management_correction_required');
});

test('trusted host preflight consumes only the authorized provider run claim and rejects mismatched releases and packages',async()=>{
 const source=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
 const prefix=source.slice(0,source.indexOf('const clientToken=')).replace(/^import .*;\n/gm,'');
 const key='fixture-provider-signing-key-at-least-32-characters';
 const taskId='11111111-1111-4111-8111-111111111111',projectId='22222222-2222-4222-8222-222222222222';
 const request='exact approved request';
 const proof={authorityKind:'provider-execution',taskId,projectId,scopeHash:'a'.repeat(64),contractHash:'b'.repeat(64),
  baselineSha:'c'.repeat(40),releaseSha:'d'.repeat(40),requestHash:providerExecutionRequestHash(request),expiresAt:Date.now()+60_000};
 const capsule=sealNativeProductionRuntime('fixture-service-role',proof,key);
 const body=`<!-- katie-managed-task:${taskId} -->\n\n${encodeProviderExecutionHandoff({...proof,productionRuntime:capsule},key)}\n\n${request}`;
 const manifest=readProviderExecutionHandoff(body,key);
 const projectBinding={providerExecution:true,projectId,baseSha:proof.baselineSha,baselineSha:proof.baselineSha,contractHash:proof.contractHash,
  allowedPaths:['app/milestone-3-tic-tac-toe/page.tsx'],cumulativePaths:['app/milestone-3-tic-tac-toe/'],codingModel:PROVIDER_EXECUTION_MODEL,reviewModel:PROVIDER_EXECUTION_MODEL};
 const rows={work_projects:{organization_version:1,approved_hash:proof.scopeHash},agent_tasks:{id:taskId},
  mission_assignments:{mission_id:'saved-mission'},project_runs:{binding:projectBinding},project_provider_execution:{deadline:new Date(Date.now()+60_000).toISOString()}};
 const calls=[];
 const run=({releaseSha=proof.releaseSha,binding=projectBinding,allow=true}={})=>{
  const db={from(table){assert.ok(Object.hasOwn(rows,table),`unexpected financial table ${table}`);return{select(){return this;},eq(){return this;},async maybeSingle(){return{data:rows[table]};}};},
   async rpc(name,params){calls.push({name,params});return{data:allow};}};
  return vm.runInNewContext(`(async()=>{${prefix};return grantResult;})()`,{
   readProviderExecutionHandoff,openNativeProductionRuntime,PROVIDER_EXECUTION_MODEL,randomBytes,
   createRequire:()=>()=>({createClient:()=>db}),join:(...parts)=>parts.join('/'),
   readFileSync:path=>path==='request'?body:JSON.stringify(manifest),
   execFileSync:command=>command==='node'?JSON.stringify(binding):'',
   assertTrustedBoundary:()=>({root:'/fixture'}),preflightNativeChild:()=>{},recoveryRefs:()=>[],
   createTask4aVerificationFirstCapability:()=>null,
   process:{execPath:'node',argv:['node','host','request','manifest','child'],cwd:()=>'/fixture',stdout:{write:()=>{}},
    env:{PATH:'/usr/bin',HOME:'/runner',GH_TOKEN:'fixture-github',KATIE_NATIVE_CHECKPOINT_BRANCH:'agent/issue-123-456-1',
     KATIE_NATIVE_HANDOFF_HMAC_KEY:key,OPENAI_API_KEY:'fixture-openai',GITHUB_REPOSITORY:'mfackrell/katie',
     GITHUB_RUN_ID:'456',GITHUB_REF:'refs/heads/main',GITHUB_SHA:releaseSha,RUNNER_TEMP:'/runner'}}
  });
 };
 await assert.rejects(run({releaseSha:'e'.repeat(40)}),/release mismatch/);
 await assert.rejects(run({binding:{...projectBinding,allowedPaths:['app/other/page.tsx']}}),/package dispatch context mismatch/);
 assert.equal(calls.length,0);
 assert.equal(await run(),true);
 assert.equal(calls[0].name,'project_provider_dispatch_start');
 assert.equal(calls[0].params.p_task,taskId);
 assert.equal(calls[0].params.p_scope,proof.scopeHash);
 assert.equal(calls[0].params.p_run,'456');
 await assert.rejects(run({allow:false}),/execution claim rejected/);
});
