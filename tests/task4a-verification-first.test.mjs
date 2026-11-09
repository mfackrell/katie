import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createTask4aVerificationFirstCapability,task4aVerificationFirstTree,validateRecoveryRecords} from '../scripts/benchmark/native-wip-recovery.mjs';
import {executeNativeDevelopmentLifecycle} from '../scripts/benchmark/native-development-lifecycle.mjs';
const record=JSON.parse(readFileSync(new URL('./fixtures/task4a-verification-first.json',import.meta.url)));
const restored=()=>({verification:'unverified',phase:record.phase,checkpointSha:record.checkpointSha,completedCheckpointSha:record.completedCheckpointSha,reviewFindings:record.reviewFindings,checkpointEvidence:structuredClone(record.lastCompleted),lastCompleted:structuredClone(record.lastCompleted)});
function scenario(overrides={}){
 const recovery=restored(),events=[],snapshots=[];
 const options={recovery,verificationFirstCapability:createTask4aVerificationFirstCapability(record,recovery),
  commitCandidate:async()=>{events.push('commit');return 'a'.repeat(40);},candidateIdentity:()=>record.sourceTreeSha,
  verifyCandidate:async head=>{events.push('verify');return {head,passed:true};},
  runPhase:async(phase,_findings,binding)=>{events.push(phase);assert.notEqual(phase,'implementation');return {verdict:'pass',findings:'independent review',reviewedHeadSha:binding.candidateHead};},
  onCompleted:value=>snapshots.push(structuredClone(value)),...overrides};
 return {options,events,snapshots};
}
test('exact restored Task 4A candidate commits and verifies before two mandatory independent reviews; zero implementation requests',async()=>{
 const s=scenario();const r=await executeNativeDevelopmentLifecycle(s.options);
 assert.deepEqual(s.events,['commit','verify','review','final-review']);assert.equal(r.repairPerformed,false);
 assert.equal(r.candidateHead,'a'.repeat(40));assert.equal(r.review.phase,'review');assert.equal(r.finalReview.phase,'final-review');
 assert.equal(s.options.recovery.verification,'unverified');assert.equal(s.options.recovery.lastCompleted.review,undefined);
});
for(const kind of ['deterministic','infrastructure'])test(`${kind} verification failure cannot review or complete`,async()=>{
 const s=scenario({verifyCandidate:async()=>({passed:false,kind,detail:'blocked verifier'})});
 await assert.rejects(executeNativeDevelopmentLifecycle(s.options),/RECOVERY_VERIFICATION_FAILED/);
 assert.deepEqual(s.events,['commit']);assert.equal(s.snapshots.at(-1).verification.pending,true);assert.ok(s.snapshots.every(x=>!x.lastVerifiedCandidate&&x.adaptiveRepair.nextAction!=='complete'));
});
test('scope commit failure and changed restored source tree stop before verifier or provider',async()=>{
 for(const overrides of [{commitCandidate:()=>{throw Error('scope denied');}},{candidateIdentity:()=> 'b'.repeat(40)}]){
  const s=scenario(overrides);await assert.rejects(executeNativeDevelopmentLifecycle(s.options),/scope denied|TREE_MISMATCH/);
  assert.ok(s.events.every(x=>x==='commit'));
 }
});
test('missing, forged, cloned, and mutated restoration capabilities fail closed',async()=>{
 for(const mutate of [s=>{delete s.options.verificationFirstCapability;},s=>{s.options.verificationFirstCapability={};},s=>{s.options.recovery=structuredClone(s.options.recovery);},s=>{s.options.recovery.lastCompleted.review={verdict:'pass'};}]){
  const s=scenario();mutate(s);await assert.rejects(executeNativeDevelopmentLifecycle(s.options),/trusted restoration capability/);assert.deepEqual(s.events,[]);
 }
});
test('foreign task, grant, run, scope, receipt, tree and promoted WIP cannot obtain verification-first evidence',()=>{
 for(const field of ['taskId','projectId','approvalId','grantId','executionEpoch','runId','runAttempt','ref','sourceTreeSha','originalBaselineSha','baseSha','completedCheckpointSha','approvedScopeHash','approvedScope','lastCompleted','authorityKind','trialId','version','phase','verification','reviewFindings']){
  const changed=structuredClone(record);changed[field]='tampered';assert.throws(()=>createTask4aVerificationFirstCapability(changed,restored()),/verification-first/);
 }
 assert.throws(()=>createTask4aVerificationFirstCapability(record,null),/restored evidence/);
});
test('ordinary development and other recovered checkpoints retain implementation behavior',async()=>{
 assert.equal(createTask4aVerificationFirstCapability(null,null),null);
 const other={...record,checkpointSha:'f'.repeat(40)};assert.equal(createTask4aVerificationFirstCapability(other,restored()),null);
 for(const recovery of [null,{phase:'implementation',checkpointSha:other.checkpointSha}]){
  const phases=[];await executeNativeDevelopmentLifecycle({recovery,commitCandidate:()=> 'a'.repeat(40),verifyCandidate:()=>({passed:true}),runPhase:async(phase,_f,b)=>{phases.push(phase);return {verdict:'pass',findings:'reviewed',reviewedHeadSha:b?.candidateHead};}});
  assert.deepEqual(phases,['implementation','review','final-review']);
 }
});
for(const denied of ['expired authority','exhausted financial capacity'])test(`${denied} still denies independent review; no completion`,async()=>{
 const s=scenario({runPhase:async()=>{throw Error(denied);}});await assert.rejects(executeNativeDevelopmentLifecycle(s.options),new RegExp(denied));
 assert.deepEqual(s.events,['commit','verify']);assert.ok(s.snapshots.every(x=>x.adaptiveRepair.nextAction!=='complete'));
});
test('neither missing nor wrong-head independent review can complete',async()=>{
 for(const result of [null,{verdict:'pass',findings:'reviewed',reviewedHeadSha:'b'.repeat(40)}]){
  const s=scenario({runPhase:async()=>result});await assert.rejects(executeNativeDevelopmentLifecycle(s.options),/REVIEW_INVALID|REVIEW_CANDIDATE_MISMATCH/);
 }
});
test('genuine independent findings retain bounded repair and fresh verification/review',async()=>{
 let reviews=0;const s=scenario({runPhase:async(phase,_f,b)=>{s.events.push(phase);return {verdict:reviews++===0?'changes_requested':'pass',findings:'Correct demonstrated defect',reviewedHeadSha:b?.candidateHead};}});
 await executeNativeDevelopmentLifecycle(s.options);assert.deepEqual(s.events,['commit','verify','review','repair','commit','verify','final-review']);
});
test('trusted host creates capability only after authenticated restoration; existing grant and spending gates remain',async()=>{
 const host=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
 const auth=host.indexOf('await validateRecoveryRecords({completedEvidence,record'),prepare=host.indexOf('recoveryPlan=prepareRecovery({completedEvidence'),restore=host.indexOf('const recovery=recoveryPlan?.restore()??null;'),mint=host.indexOf('const verificationFirstCapability='),forecast=host.indexOf('await forecastCapacity(verificationFirstCapability?'),grant=host.indexOf("'developer_issue_execution_grant'");
 assert.ok(auth<prepare&&prepare<restore&&restore<mint&&mint<forecast&&forecast<grant);
 const block=host.slice(restore,host.indexOf('let capacityRecovery=recovery;',restore));
 for(const fails of [false,true]){
  const calls=[];const context={approval:{developer_authority:{task4aFinalSuccessor:true}},denied:reason=>{throw Error(reason);},recoveryPlan:{record,restore(){calls.push('restore');if(fails)throw Error('source authentication failed');return restored();}},createTask4aVerificationFirstCapability(r,w){calls.push('capability');return createTask4aVerificationFirstCapability(r,w);}};
  if(fails)assert.throws(()=>vm.runInNewContext(block,context),/authentication failed/);else vm.runInNewContext(block,context);
  assert.deepEqual(calls,fails?['restore']:['restore','capability']);
 }
 assert.match(host,/capacityCompletedStages=new Set\(recovery\?\.phase==='repair'\?\['implementation','initial_review'\]:verificationFirstCapability\?\['implementation'\]:\[\]\)/);
 assert.equal(task4aVerificationFirstTree(null,null),null);
});

test('failed verification checkpoint authenticates and resumes deterministic verification without implementation',async()=>{
 const s=scenario({verifyCandidate:async()=>({passed:false,detail:'deterministic failure'})});
 await assert.rejects(executeNativeDevelopmentLifecycle(s.options),/RECOVERY_VERIFICATION_FAILED/);
 const last={...s.snapshots.at(-1),checkpointSha:'a'.repeat(40),modelCall:record.lastCompleted.modelCall};
 const next={...record,version:2,phase:'review',checkpointSha:'b'.repeat(40),completedCheckpointSha:last.checkpointSha,lastCompleted:last};
 const context={projectId:record.projectId,baselineSha:record.originalBaselineSha,baseSha:record.baseSha,allowedPaths:record.approvedScope.allowedPaths,contractHash:record.approvedScope.contractHash};
 const rows={mission_assignments:{mission_id:'mission'},project_runs:{project_id:record.projectId,binding:{...context,scopeHash:record.approvedScopeHash}},
  benchmark_native_spending_approvals:{id:record.approvalId,task_id:record.taskId,project_id:record.projectId,trial_id:null,account_id:'account',consumed_at:'retained',actor_id:'owner',protocol_digest:'protocol',model:'pinned',developer_authority:{version:'ordinary-developer-v1'}},
  benchmark_execution_grants:{id:record.grantId,mission_assignment_id:record.taskId,project_id:record.projectId,trial_id:null,account_id:'account',execution_epoch:3,owner_actor_id:'owner',repository:'mfackrell/katie',protocol_digest:'protocol',model:'pinned',developer_approval_id:record.approvalId},
  benchmark_budget_calls:{account_id:'account',request_key:last.modelCall.requestKey,legacy_mission_call_id:last.modelCall.requestKey,actual_tokens:13046,state:'settled'},
  mission_calls:{id:last.modelCall.requestKey,job_id:record.taskId,lease:record.grantId}};
 const input={record:next,task:{id:record.taskId,repository_full_name:'mfackrell/katie'},context,project:{id:record.projectId,approved_hash:record.approvedScopeHash,approval_hash:record.approvedScopeHash,active_mission_id:'mission'},trialId:null,authorityKind:'ordinary-developer',accountId:'account',readOne:async table=>rows[table]};
 await validateRecoveryRecords(input);
 const calls=[];await executeNativeDevelopmentLifecycle({recovery:{phase:'review',checkpointSha:next.checkpointSha,completedCheckpointSha:next.completedCheckpointSha,lastCompleted:last},commitCandidate:()=>assert.fail('no implementation'),verifyCandidate:async()=>{calls.push('verify');return {passed:true};},runPhase:async(phase,_f,b)=>{calls.push(phase);return {verdict:'pass',findings:'independent',reviewedHeadSha:b.candidateHead};}});
 assert.deepEqual(calls,['verify','review','final-review']);
 delete last.verification.pending;await assert.rejects(validateRecoveryRecords(input),/pending verification evidence missing/);
});
