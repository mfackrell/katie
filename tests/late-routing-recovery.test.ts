import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverLateRoutingResponse} from '../lib/chat/late-routing-recovery';
import {isPausedRoutingTimeout,isSavedRoutingAttemptReady,verifiedLateRoutingRecoveryReady} from '../lib/chat/paused-workflow-recovery';

test('late routing readiness requires the original settled provider checkpoint',()=>{
 const valid={state:'settled',response_checkpoint:{status:200,body:'{"id":"response","output":[]}'},actual_microusd:'9320',cancelled_by_owner_at:null};
 assert.equal(isPausedRoutingTimeout({status:'paused',error:'ProviderResponseError: standalone_outcome_unknown: routing-rerank:openai:gpt-5-mini timed out after 17000ms'}),true);
 assert.equal(isPausedRoutingTimeout({status:'paused',error:'standalone_outcome_unknown: intent-classification timed out'}),false);
 assert.equal(isPausedRoutingTimeout({status:'completed',error:'standalone_outcome_unknown: routing-rerank:openai:gpt-5-mini'}),false);
 assert.equal(isSavedRoutingAttemptReady(valid),true);
 assert.equal(isSavedRoutingAttemptReady({...valid,state:'dispatched'}),false);
 assert.equal(isSavedRoutingAttemptReady({...valid,state:'uncertain'}),false);
 assert.equal(isSavedRoutingAttemptReady({...valid,actual_microusd:null}),false);
 assert.equal(isSavedRoutingAttemptReady({...valid,response_checkpoint:null}),false);
 assert.equal(isSavedRoutingAttemptReady({...valid,cancelled_by_owner_at:'2026-11-17T00:00:00Z'}),false);
 assert.equal(isSavedRoutingAttemptReady({...valid,response_checkpoint:{status:503,body:'Unavailable'}}),false);
 assert.equal(isSavedRoutingAttemptReady({...valid,response_checkpoint:{status:400,body:'Rejected'}}),false);
});

test('all saved routing ordinals must settle before automatic replay',async()=>{
 const identity={ownerId:'owner',actorId:'actor',chatId:'chat',requestId:'original'};
 const receipt=(ordinal:number)=>({
  owner_id:identity.ownerId,actor_id:identity.actorId,chat_id:identity.chatId,request_id:identity.requestId,
  state:'settled',response_checkpoint:{status:200,body:'saved-result-'+ordinal},
  actual_microusd:'9320',cancelled_by_owner_at:null,
 });
 let requested:number[]=[];
 const ready=await verifiedLateRoutingRecoveryReady(identity,async ordinal=>{
  requested.push(ordinal);return ordinal===0?receipt(ordinal):null;
 });
 assert.equal(ready,true);
 assert.deepEqual(requested,[0,1]);
 const unresolved=await verifiedLateRoutingRecoveryReady(identity,async ordinal=>
  ordinal===0?receipt(0):ordinal===1?{...receipt(1),state:'uncertain'}:null);
 assert.equal(unresolved,false,'a settled first attempt cannot hide an uncertain correction');
 const mismatched=await verifiedLateRoutingRecoveryReady(identity,async ordinal=>
  ordinal===0?{...receipt(0),actor_id:'wrong-actor'}:null);
 assert.equal(mismatched,false,'cross-actor checkpoint cannot authorize recovery');
 const missing=await verifiedLateRoutingRecoveryReady(identity,async()=>null);
 assert.equal(missing,false);
 const exhausted=await verifiedLateRoutingRecoveryReady(identity,async ordinal=>receipt(ordinal));
 assert.equal(exhausted,false,'unbounded unknown correction attempts fail closed');
});

test('late receipt automatically resumes exactly one original request after confirmed settlement',async()=>{
 const events:string[]=[];
 let checks=0;
 const response=await recoverLateRoutingResponse({
  readStatus:async()=>{
   events.push('check');
   return {workflowStatus:'paused',status:'failed',routingRecoveryReady:++checks>=3};
  },
  resumeOriginal:async()=>{events.push('resume-original');return new Response('saved request replay');},
  wait:async()=>{events.push('wait');},
  cancelled:()=>false,
  maxChecks:5,
 });
 assert.equal(await response?.text(),'saved request replay');
 assert.deepEqual(events,['check','wait','check','wait','check','resume-original']);
});

test('uncertain or missing receipt never authorizes a duplicate generation',async()=>{
 let resumes=0,checks=0;
 const response=await recoverLateRoutingResponse({
  readStatus:async()=>{checks++;return {workflowStatus:'paused',status:'failed',routingRecoveryReady:false};},
  resumeOriginal:async()=>{resumes++;return new Response('should not happen');},
  wait:async()=>undefined,
  cancelled:()=>false,maxChecks:3,
 });
 assert.equal(response,null);assert.equal(checks,3);assert.equal(resumes,0);
});

test('completed, missing, or unauthorized status cannot trigger a new provider call',async()=>{
 for(const status of [null,{workflowStatus:'completed',routingRecoveryReady:true},
  {workflowStatus:'running',routingRecoveryReady:false}]){
  let resumes=0;
  const result=await recoverLateRoutingResponse({
   readStatus:async()=>status,
   resumeOriginal:async()=>{resumes++;return new Response('bad');},
   wait:async()=>assert.fail('unexpected wait'),
   cancelled:()=>false,maxChecks:2,
  });
  assert.equal(result,null);assert.equal(resumes,0);
 }
});

test('cancelled browser recovery never resumes its paused workflow',async()=>{
 let cancelled=false,resumes=0;
 const result=await recoverLateRoutingResponse({
  readStatus:async()=>({workflowStatus:'paused',routingRecoveryReady:false}),
  resumeOriginal:async()=>{resumes++;return new Response('bad');},
  wait:async()=>{cancelled=true;},
  cancelled:()=>cancelled,maxChecks:5,
 });
 assert.equal(result,null);assert.equal(resumes,0);
});
