import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {nativeChildInterruptionRetryable,nativeGatewayFailureClass,createNativeHttpBridge} from '../scripts/benchmark/native-http-bridge.mjs';
const host=readFileSync(new URL('../scripts/benchmark/native-development-host.mjs',import.meta.url),'utf8');
const loop=host.slice(host.indexOf(' const safelyRunPhase='),host.indexOf(' stopTimer=setInterval'))+'\n safelyRunPhase("implementation");';
async function runLoop({signal=null,code=1,gatewayFailure=null,pending=[],live=true,ownerApprovedSuccessor=false}={}){
 let runs=0,reads=0,resets=0;
 const context={ownerApprovedSuccessor,snapshot:()=>{},saveDiagnostics:()=>{},nativeChildInterruptionRetryable,gatewayFailure,account:{id:'account'},proof:{trialId:'trial'},grantToken:'token',executionEpoch:1,tokenDigest:()=>'',trustedCheckpointSha:'head',console:{log:()=>{}},denied:message=>{throw Error(message)},git:()=>resets++,runPhase:async()=>{runs++;if(runs===1)throw Object.assign(Error('child failed'),{nativeChildOutcome:{signal,code}});},db:{from:()=>({select:()=>({eq:()=>({in:()=>({limit:async()=>{reads++;return {data:pending}}})})})}),rpc:async()=>({data:live})}};
 let error;try{await vm.runInNewContext(loop,context);}catch(e){error=e;}
 return {runs,reads,resets,error};
}
test('actual host recovery loop never repeats deterministic gateway denials or generic exit1',async()=>{
 for(const gatewayFailure of ['admission','authorization','request-schema','upstream-uncertain','gateway-failure',null]){
  const result=await runLoop({gatewayFailure});assert.equal(result.runs,1);assert.equal(result.reads,0);assert.equal(result.resets,0);assert.ok(result.error);
 }
 for(const signal of ['SIGTERM','SIGINT'])assert.equal((await runLoop({signal,code:null})).runs,1);
 assert.equal((await runLoop({signal:'SIGKILL',code:null,gatewayFailure:'admission'})).runs,1);
 assert.equal((await runLoop({signal:'SIGKILL',code:null,gatewayFailure:'host-stop'})).runs,1);
});
test('positive process interruption still needs settled ledger and live grant',async()=>{
 for(const signal of ['SIGKILL','SIGHUP']){const r=await runLoop({signal,code:null});assert.equal(r.runs,2);assert.equal(r.resets,2);assert.equal(r.error,undefined);}
 assert.equal((await runLoop({signal:'SIGKILL',code:null,pending:[{id:'held'}]})).runs,1);
 assert.equal((await runLoop({signal:'SIGKILL',code:null,live:false})).runs,1);
});
test('watchdog state failure and read uncertainty latch a nonretryable host stop before kill',async()=>{
 const watchdog=host.slice(host.indexOf(' stopTimer=setInterval'),host.indexOf(" await safelyRunPhase('implementation')"));
 for(const mode of ['stopped','read-error']){
  let callback,killed=0;
  const context={stopTimer:null,gatewayFailure:null,setInterval:fn=>{callback=fn;return 1;},grantId:'grant',proof:{projectId:'project'},child:{kill:()=>killed++},readOne:async table=>{if(mode==='read-error')throw Error('unavailable');return table==='benchmark_execution_grants'?{stopped_at:'stopped',deadline:'2099-01-01'}:{status:'running',deadline:'2099-01-01',approved_hash:'scope',approval_hash:'scope'};}};
  vm.runInNewContext(watchdog,context);await callback();assert.equal(killed,1);assert.equal(context.gatewayFailure,'host-stop');assert.equal((await runLoop({signal:'SIGKILL',code:null,gatewayFailure:context.gatewayFailure})).runs,1);
 }
});
test('amendment host gate binds record identity, runtime and claimed release',async()=>{
 const gate=host.slice(host.indexOf('if(proof.resourceAmendmentId){'),host.indexOf('const grantToken=randomBytes'));
 const proof={resourceAmendmentId:'amendment',developmentRenewalId:'renewal',approvalId:'approval',taskId:'task',continuationId:'continuation'};
 const row={id:'amendment',renewal_id:'renewal',approval_id:'approval',task_id:'task',continuation_id:'continuation',release_sha:'release',runtime_version:'provider-input-count-v1'};
 const run=async change=>vm.runInNewContext('(async()=>{'+gate+'})()',{proof,productionRuntime:{},NATIVE_INPUT_COUNT_VERSION:'provider-input-count-v1',process:{env:{GITHUB_SHA:'release'}},task:{external:{resourceAmendmentId:'amendment'}},readOne:async()=>({...row,...change}),denied:message=>{throw Error(message);}});
 await run({});for(const key of ['renewal_id','approval_id','task_id','continuation_id','release_sha','runtime_version'])await assert.rejects(run({[key]:'wrong'}),/identity or release/);
});
test('real bridge capacity refusal latches trusted fixed class and cannot trigger paid restart',async()=>{
 let gatewayFailure=null,paid=0;
 const server=createNativeHttpBridge({db:{rpc:async name=>name==='benchmark_gateway_execution_live'?{data:true}:{error:{message:'mission capacity exhausted'}}},grantToken:'x'.repeat(48),trialId:'trial',executionEpoch:1,providerNamespace:'fixture',upperTokens:120000,clientToken:'fixture-client-token',upstream:async()=>{paid++;},recordReceipt:async()=>{},onFailure:kind=>{gatewayFailure??=kind;}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/responses',{method:'POST',headers:{authorization:'Bearer fixture-client-token'},body:JSON.stringify({model:'gpt-5.3-codex',input:'bounded'})});assert.equal(response.status,403);assert.equal(gatewayFailure,'admission');const r=await runLoop({gatewayFailure});assert.equal(r.runs,1);assert.equal(paid,0);}finally{await new Promise(resolve=>server.close(resolve));}
 assert.equal(nativeGatewayFailureClass(Error('secret arbitrary content')),'gateway-failure');
});


test('owner-approved successor never retries even a settled live process interruption',async()=>{
 for(const signal of ['SIGKILL','SIGHUP']){
  const r=await runLoop({ownerApprovedSuccessor:true,signal,code:null});
  assert.equal(r.runs,1);assert.equal(r.reads,0);assert.equal(r.resets,0);
  assert.equal(r.error?.message,'child failed');
 }
});
