import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPausedChatWorkflow } from '../lib/chat/paused-workflow-recovery';

test('paused durable workflow overrides stale processing receipt', () => {
 const result=classifyPausedChatWorkflow('processing',{status:'paused',error:null});
 assert.equal(result?.status,'paused');
 if (result?.status !== 'paused') throw Error('Expected a saved accounting pause');
 assert.equal(result.waitingForRunpod,false);
 assert.match(result.error,/Status \/ Usage/);
 assert.match(result.error,/Do not resend/i);
});

test('accepted RunPod jobs remain processing until recoverable output exists', () => {
 const result=classifyPausedChatWorkflow('processing',{status:'paused',error:'standalone_runpod_in_progress'});
 assert.deepEqual(result,{status:'processing',waitingForRunpod:true});
});

test('active, completed and failed workflows are never mistaken for paused', () => {
 for(const status of ['running','completed','failed','pending']){
   assert.equal(classifyPausedChatWorkflow('processing',{status,error:null}),null);
 }
 assert.equal(classifyPausedChatWorkflow('completed',{status:'paused',error:null}),null);
 assert.equal(classifyPausedChatWorkflow('processing',null),null);
});
