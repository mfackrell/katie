import test from 'node:test';
import assert from 'node:assert/strict';
import {executeThreeArmTreatments} from '../scripts/benchmark/three-arm-native-executor.mjs';
const hex=(x,n)=>x.repeat(n);
const sha={baselineSha:hex('a',40),contractSha256:hex('b',64),
 acceptanceSha256:hex('c',64),toolProfileSha256:hex('d',64),
 modelPolicySha256:hex('e',64),runtimeSha256:hex('f',64)};
const arms=['native','thin','full'];
const protocol={...sha,experimentId:'11111111-1111-4111-8111-111111111111',
 replicate:1,tokenCap:1000,trials:arms.map(arm=>({arm,...sha,candidateSha:null}))};
const gateway={id:'synthetic-local',baseUrl:'https://synthetic.invalid/v1',
 attested:true,enforcesEveryRequest:true};
const approvals=Object.fromEntries(arms.map(arm=>[arm,{accountId:'account-'+arm,
 gatewayId:gateway.id,status:'approved'}]));
const qualifications=Object.fromEntries(arms.map(arm=>[arm,{verified:true,
 accountId:'account-'+arm,gatewayId:gateway.id,realSdkTested:true,providerBypassDenied:true}]));
const workspaces=Object.fromEntries(arms.map(arm=>[arm,'/tmp/work-'+arm]));
const homeRoots=Object.fromEntries(arms.map(arm=>[arm,'/tmp/isolated-'+arm]));
const opts={protocol,workspaces,gateway,approvals,qualifications,homeRoots,model:'synthetic',
 composeTreatment:async({arm})=>({...sha,prompt:'Same contract. Treatment: '+arm})};
test('all three arms use one native runtime, same SDK factory/model/tools and separate workspaces',async()=>{
 const calls=[];const events=[];
 const result=await executeThreeArmTreatments({...opts,
 createCodex:async config=>{
  calls.push({config});
  return {startThread:settings=>{
   calls[calls.length-1].settings=settings;
   return{id:'thread-'+calls.length,runStreamed:async()=>({events:(async function*(){
    yield {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}};
   })()})};
  }};
 },onEvent:e=>events.push(e)});
 assert.deepEqual(result.results.map(x=>x.arm),arms);
 assert.equal(calls.length,3);
 assert.deepEqual(calls.map(x=>x.settings.model),['synthetic','synthetic','synthetic']);
 assert.deepEqual(calls.map(x=>x.settings.workingDirectory),arms.map(x=>workspaces[x]));
 assert.deepEqual(calls.map(x=>x.settings.sandboxMode),['workspace-write','workspace-write','workspace-write']);
 assert.equal(new Set(calls.map(x=>x.config.env.HOME)).size,3);
 assert.equal(result.paidExecutionAuthorized,false);
 assert.equal(result.acceptanceVerified,false);
 assert.ok(result.results.every(x=>!x.accepted));
 assert.equal(events.length,3);
});
test('preflight failure stops before any provider or SDK factory',async()=>{
 let starts=0;
 const approvalsBad={...approvals,thin:{...approvals.thin,gatewayId:'wrong'}};
 await assert.rejects(executeThreeArmTreatments({...opts,approvals:approvalsBad,
  createCodex:()=>{starts++;throw Error('must not run');}}),/PREFLIGHT_DENIED:thin/);
 assert.equal(starts,0);
});
test('drift in any common tool/runtime digest blocks entire trial',async()=>{
 let starts=0;
 await assert.rejects(executeThreeArmTreatments({...opts,
  composeTreatment:async({arm})=>({...sha,prompt:arm,toolProfileSha256:arm==='full'?hex('1',64):sha.toolProfileSha256}),
  createCodex:()=>{starts++;}}),/TREATMENT_IDENTITY_INVALID:full/);
 assert.equal(starts,0);
});
