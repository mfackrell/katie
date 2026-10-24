import test from 'node:test';import assert from 'node:assert/strict';
import {runNativeBenchmark} from '../scripts/benchmark/native-agent-runtime.mjs';
const gateway={attested:true,enforcesEveryRequest:true,baseUrl:'https://metering.example.test/v1',id:'gateway-1'};
const approvalReceipt={accountId:'account-1',gatewayId:'gateway-1',status:'approved'};
const opts={gateway,approvalReceipt,approvedAccountId:'account-1',arm:'native',
 workingDirectory:'/tmp/benchmark-worktree',prompt:'Implement from canonical contract',
 model:'configured-model'};
test('native runner uses SDK repository tools behind approved gateway',async()=>{
 let initialized;
 const result=await runNativeBenchmark({...opts,createCodex:async config=>{
  initialized=config;
  return{startThread:settings=>{
   assert.equal(settings.workingDirectory,opts.workingDirectory);
   assert.equal(settings.skipGitRepoCheck,false);
   return {id:'session-1',runStreamed:async()=>({events:(async function*(){
    yield {type:'item.completed',item:{type:'command_execution'}};
    yield {type:'turn.completed',usage:{input_tokens:4,output_tokens:2}};
   })()})};
  }};
 }});
 assert.equal(initialized.baseUrl,gateway.baseUrl);
 assert.equal(result.accounting,'REQUIRES_GATEWAY_RECONCILIATION');
 assert.equal(result.accepted,false);
});
test('untrusted gateway cannot start agent',async()=>{
 let created=false;
 await assert.rejects(runNativeBenchmark({...opts,gateway:{...gateway,enforcesEveryRequest:false},
 createCodex:async()=>{created=true}}),/GATEWAY_NOT_VERIFIED/);
 assert.equal(created,false);
});
test('invalid owner approval cannot start agent',async()=>{
 await assert.rejects(runNativeBenchmark({...opts,approvalReceipt:{...approvalReceipt,accountId:'different'},createCodex:async()=>{}}),/OWNER_AUTHORIZATION/);
});
test('failed or incomplete turn cannot claim success',async()=>{
 await assert.rejects(runNativeBenchmark({...opts,createCodex:async()=>({startThread:()=>({
 runStreamed:async()=>({events:(async function*(){yield {type:'turn.failed'}})()})
 })})}),/TURN_FAILED/);
});
