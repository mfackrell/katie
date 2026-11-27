import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProviderFinalReviewHistory as validate} from '../scripts/benchmark/provider-execution-recovery.mjs';

function fixture(){
 const candidate='a'.repeat(40),checkpoint='b'.repeat(40),tree='c'.repeat(40),baseline='d'.repeat(40),scope='a'.repeat(64),contract='b'.repeat(64);
 const task={id:'task',repository_full_name:'owner/repo',external:{issueNumber:123,receipt:{repository:'owner/repo',issue_number:123,run_id:1234,outcome:'BLOCKED'}}};
 const project={id:'project',approved_hash:scope,approval_hash:scope};
 const context={projectId:project.id,baseSha:baseline,baselineSha:baseline,allowedPaths:['app/game.ts'],cumulativePaths:['app/'],contractHash:contract};
 const assignment={id:task.id,mission_id:'mission',agent_id:'worker',role:'development'};
 const run={mission_id:assignment.mission_id,project_id:project.id,kind:'development',binding:{...context,scopeHash:scope}};
 const record={version:2,kind:'native-unverified-wip',verification:'unverified',authorityKind:'provider-execution',trialId:null,phase:'final-review',checkpointSha:checkpoint,completedCheckpointSha:candidate,sourceTreeSha:tree,taskId:task.id,projectId:project.id,originalBaselineSha:baseline,baseSha:baseline,approvedScopeHash:scope,approvedScope:{hash:scope,allowedPaths:context.allowedPaths,contractHash:contract},runId:'1234'};
 const review={phase:'review',verdict:'pass',reviewedHeadSha:candidate,findings:'No findings'};
 const completedEvidence={checkpointSha:candidate,phase:'review',verification:{head:candidate,passed:true},initialReview:{...review},review:{...review},repairPerformed:false,repairVerification:null,reviewRepair:null,adaptiveRepair:{version:2,nextAction:'final-review',candidateHead:candidate,iteration:0,pendingRepair:null}};
 const diagnostics={wipCheckpoint:record,completed:false,taskId:task.id,runId:record.runId,failure:'NATIVE_HOST_DENIED: native final-review failed; evidence retained',phases:[{phase:'implementation',outcome:{code:0,signal:null},terminalEvent:'turn.completed'},{phase:'review',outcome:{code:0,signal:null},terminalEvent:'turn.completed'},{phase:'final-review',outcome:{code:1,signal:null},terminalEvent:'turn.failed'}],providerUsage:{responses:12,receipts:[],observedTokens:120,unknownUsage:0}};
 const requests=[];
 for(let i=0;i<12;i++){
  const response='response-'+i,requestHash=i.toString(16).padStart(64,'0');
  diagnostics.providerUsage.receipts.push({providerRequestId:response,actualTokens:10});
  for(let j=0;j<2;j++){
   const n=2*i+j;
   requests.push({id:'request-'+n,project_id:project.id,mission_id:assignment.mission_id,assignment_id:task.id,worker_id:assignment.agent_id,execution_attempt:record.runId,operation:j?'inference':'input-count',provider_receipt:j?response:'input-token-count',request_hash:requestHash,started_at:new Date(1000+20*n).toISOString(),resolved_at:new Date(1010+20*n).toISOString()});
  }
 }
 return {record,diagnostics,completedEvidence,task,project,context,assignment,run,dispatch:{task_id:task.id,run_id:record.runId},requests,proof:{priorRunId:record.runId,checkpointSha:checkpoint,candidateSha:candidate,sourceTreeSha:tree}};
}

test('exhausted native run retains verified source and initial review, not final acceptance',()=>{
 const input=fixture(), before=structuredClone(input);
 assert.equal(validate(input).adaptiveRepair.nextAction,'final-review');
 assert.deepEqual(input,before);
});

const mutations={
 'different candidate':x=>x.proof.candidateSha='f'.repeat(40),
 'unsettled request':x=>x.requests[0].resolved_at=null,
 'foreign response':x=>x.requests[1].provider_receipt='foreign',
 'changed request hash':x=>x.requests[1].request_hash='f'.repeat(64),
 'different run':x=>x.requests[1].execution_attempt='unrelated',
 'missing request':x=>x.requests.pop(),
 'implementation restart':x=>x.completedEvidence.adaptiveRepair.nextAction='implementation',
 'different reviewed SHA':x=>x.completedEvidence.review.reviewedHeadSha='e'.repeat(40),
 'completed diagnostics':x=>x.diagnostics.completed=true,
 'changed contract':x=>x.run.binding.contractHash='e'.repeat(64),
 'different dispatch':x=>x.dispatch.run_id='unrelated',
 'non-blocked receipt':x=>x.task.external.receipt.outcome='READY',
};
for(const [name,mutate] of Object.entries(mutations))test('rejects '+name,()=>{
 const input=fixture();mutate(input);assert.throws(()=>validate(input),/NATIVE_PROVIDER_RECOVERY_DENIED/);
});
