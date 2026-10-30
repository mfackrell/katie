import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSavedQwenJobs, type SavedQwenJob, type QwenJobStatus } from '../lib/chat/runpod-still-recovery';

function job(n:number):SavedQwenJob{
  return {owner_id:'owner',actor_id:'actor',chat_id:'chat',request_id:'request-'+n,
    provider_request_id:'accepted-runpod-job-'+n,state:'dispatched'};
}

test('Qwen remains a strict prerequisite: queued and running jobs never advance chat',async()=>{
  let calls=0,checked=0;
  const result=await reconcileSavedQwenJobs({
    list:async()=>[job(1),job(2)],
    eligible:async()=>true,
    status:async()=>{checked++;return 'waiting';},
    resume:async()=>{calls++;return true;},
  });
  assert.equal(checked,2);assert.equal(calls,0);
  assert.equal(result.waiting,2);assert.equal(result.resumed,0);
});

test('a completed Qwen job resumes exactly the original saved workflow',async()=>{
  const original=job(3),seen:SavedQwenJob[]=[];
  const result=await reconcileSavedQwenJobs({
    list:async()=>[original],
    eligible:async()=>true,
    status:async()=> 'terminal',
    resume:async attempt=>{seen.push(attempt);return true;},
  });
  assert.deepEqual(seen,[original]);assert.equal(result.resumed,1);
});

test('expired accepted job advances only to the saved terminal-error path',async()=>{
  const result=await reconcileSavedQwenJobs({
    list:async()=>[job(4)],eligible:async()=>true,status:async()=> 'expired',
    resume:async()=>false,
  });
  assert.equal(result.resumed,0);assert.equal(result.deferred,1);
});

test('unavailable provider status and ineligible workflow never resume',async()=>{
  let status=0,resumes=0;
  const result=await reconcileSavedQwenJobs({
    list:async()=>[job(5),job(6)],
    eligible:async entry=>entry.request_id==='request-6',
    status:async()=>{status++;return 'unavailable';},
    resume:async()=>{resumes++;return true;},
  });
  assert.equal(status,1);assert.equal(resumes,0);assert.equal(result.deferred,1);
});

test('invalid or missing RunPod job identity is never polled or resent',async()=>{
  let calls=0;
  const malformed={...job(7),provider_request_id:'../wrong-job'};
  const result=await reconcileSavedQwenJobs({
    list:async()=>[malformed],
    eligible:async()=>{calls++;return true;},
    status:async()=>{calls++;return 'terminal';},
    resume:async()=>{calls++;return true;},
  });
  assert.equal(calls,0);assert.equal(result.inspected,0);
});

test('each cron tick bounds completed chat resumes independently of queued jobs',async()=>{
  let resumed=0;
  const result=await reconcileSavedQwenJobs({
    list:async()=>[job(1),job(2),job(3),job(4)],
    eligible:async()=>true,
    status:async()=> 'terminal' as QwenJobStatus,
    resume:async()=>{resumed++;return true;},
  });
  assert.equal(resumed,2);assert.equal(result.resumed,2);assert.equal(result.deferred,2);
});
