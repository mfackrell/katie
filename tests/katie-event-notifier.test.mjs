import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReceipt, classifyAgentResult, classifyReleaseRuns, agentNotice, releaseNotice} from '../scripts/katie-event-notifier.mjs';

const original={version:1,repository:'mfackrell/katie',run_id:1,issue_number:424,pr_url:'https://github.com/mfackrell/katie/pull/426',outcome:'READY'};
test('validates completion receipt provenance and refuses arbitrary URLs',()=>{
  assert.equal(validateReceipt(original,{repository:'mfackrell/katie',runId:1}).issue_number,424);
  for(const x of [{...original,run_id:2},{...original,repository:'other/repo'}, {...original,issue_number:0},
    {...original,issue_number:'424'}, {...original,outcome:'MERGE'}, {...original,pr_url:'https://github.com/other/repo/pull/426'},
    {...original,pr_url:'javascript:alert(1)'}]) {
    assert.throws(()=>validateReceipt(x,{repository:'mfackrell/katie',runId:1}), /Invalid/);
  }
  assert.equal(validateReceipt({...original,pr_url:null},{repository:'mfackrell/katie',runId:1}).pr_url,null);
});
test('workflow conclusion and verdict both gate READY',()=>{
  assert.equal(classifyAgentResult(original,'success'),'READY');
  assert.equal(classifyAgentResult(original,'failure'),'BLOCKED');
  assert.equal(classifyAgentResult({...original,outcome:'BLOCKED'},'success'),'BLOCKED');
});
const w=(name,conclusion,status='completed',sha='a'.repeat(40),date='2026-10-13T16:00:00Z')=>
  ({name,conclusion,status,head_sha:sha,head_branch:'main',event:'push',created_at:date,id:name==='ci'?9:10});
test('main release update requires both workflows complete on the exact SHA',()=>{
  const sha='a'.repeat(40);
  assert.equal(classifyReleaseRuns([w('ci','success')],sha),null);
  assert.equal(classifyReleaseRuns([w('ci','success'),w('migrate-and-deploy',null,'in_progress')],sha),null);
  assert.equal(classifyReleaseRuns([w('ci','success'),w('migrate-and-deploy','success','completed','b'.repeat(40))],sha),null);
  assert.equal(classifyReleaseRuns([w('ci','success'),w('migrate-and-deploy','success')],sha).status,'PASSED');
  assert.equal(classifyReleaseRuns([w('ci','failure'),w('migrate-and-deploy','success')],sha).status,'BLOCKED');
});
test('newest matching run governs, ignoring PR workflow results',()=>{
  const sha='a'.repeat(40);
  const old=w('ci','failure','completed',sha,'2026-10-12T16:00:00Z');
  const latest=w('ci','success','completed',sha,'2026-10-13T16:00:00Z');
  assert.equal(classifyReleaseRuns([old,latest,w('migrate-and-deploy','success')],sha).status,'PASSED');
  assert.equal(classifyReleaseRuns([{...latest,event:'pull_request'},w('migrate-and-deploy','success')],sha),null);
});
test('alerts provide deduplication markers and honest deployment boundaries',()=>{
  const agent=agentNotice({owner:'mfackrell',issue:424,runId:1,attempt:1,result:'BLOCKED',
    pr:original.pr_url,conclusion:'success',reviewFindings:['Missing batch regression']});
  assert.match(agent,/katie-agent-notice:1:1/);
  assert.match(agent,/@mfackrell/);
  assert.match(agent,/Missing batch regression/);
  assert.match(agent,/No automatic merge or production deployment/);
  const result=classifyReleaseRuns([w('ci','success'),w('migrate-and-deploy','success')],'a'.repeat(40));
  const release=releaseNotice({owner:'mfackrell',sha:'a'.repeat(40),result,repo:'mfackrell/katie'});
  assert.match(release,/katie-release-notice:/);
  assert.match(release,/Vercel production readiness has not been verified/);
});
