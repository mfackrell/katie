import test from 'node:test';
import assert from 'node:assert/strict';
import {executeSharedNativePhase,nativeTurnFailureDetail} from '../scripts/benchmark/shared-native-phase.mjs';
const bearer='synthetic-session-secret';
const args={arm:'full',phase:'implementation',gateway:'http://127.0.0.1:43181/v1',bearer,model:'gpt-5.3-codex',home:'/tmp/synthetic',state:'/tmp/synthetic/.codex',root:'/work',prompt:'Synthetic qualification only'};
test('actual SDK turn.failed message reaches caller with credentials redacted',async()=>{
 class Codex{startThread(){return {runStreamed:async()=>({events:(async function*(){yield {type:'turn.failed',error:{message:'HTTP 403 GATEWAY_REQUEST_DENIED Authorization: Bearer '+bearer+' api_key=sk-synthetic-other-secret\nupstream bounded denial'}};})()})}}}
 await assert.rejects(executeSharedNativePhase({...args,Codex}),error=>{
  assert.match(error.message,/NATIVE_TURN_FAILED.*HTTP 403 GATEWAY_REQUEST_DENIED/);
  assert.match(error.message,/upstream bounded denial/);
  assert.doesNotMatch(error.message,/synthetic-session-secret|sk-synthetic-other-secret|\n/);return true;
 });
});
test('failure diagnostics handle missing SDK fields and bound hostile error text',()=>{
 assert.equal(nativeTurnFailureDetail(null,bearer),'unknown SDK failure');
 assert.equal(nativeTurnFailureDetail({code:'transport_error'},bearer),'transport_error');
 const detail=nativeTurnFailureDetail({message:'Bearer unrelated-secret access_token=second-secret '+('x'.repeat(5000))},bearer);
 assert.equal(detail.length,1200);assert.doesNotMatch(detail,/unrelated-secret|second-secret/);
});
test('successful SDK turns retain existing shared phase semantics',async()=>{
 class Codex{startThread(){return {id:'synthetic-thread',runStreamed:async()=>({events:(async function*(){yield {type:'item.completed',item:{type:'agent_message',text:'PASS: independently verified'}};yield {type:'turn.completed'};})()})}}}
 const result=await executeSharedNativePhase({...args,Codex,phase:'review'});assert.equal(result.reviewMessage,'PASS: independently verified');assert.equal(result.completed,true);
});
