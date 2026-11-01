import test from 'node:test';
import assert from 'node:assert/strict';
import {lifecycleProposalFromSnapshot} from '../scripts/benchmark/lifecycle-owner-proposal.mjs';
export function partialMoneyFixture(){
 const now=Date.parse('2026-11-01T00:00:00Z'),binding={taskId:'synthetic-task',projectId:'synthetic-project',baselineSha:'b'.repeat(40),scopeHash:'a'.repeat(64),contractHash:'c'.repeat(64)};
 const snapshot={binding,model:'gpt-5.3-codex',snapshotHash:'d'.repeat(64),originalWindowSeconds:3600,scope:{allowedPaths:['app/pilot/']},acceptance:{path:'/pilot'},snapshot:{calls:[]},exposureMicrousd:'0',pricing:{status:'verified',source:'synthetic pinned price',serviceTier:'default',verifiedAt:now-1000,inputUsdPerMillion:'2.5',outputUsdPerMillion:'14'},position:{cumulativeTokens:1000000,developmentTokens:900000,accountEncumberedTokens:0,developmentEncumberedTokens:0,completionTokens:60000,assessmentTokens:60000,developmentCalls:100,developmentConsumedCalls:12,completionCalls:4,assessmentCalls:10,assessmentConsumedCalls:0,expiresAt:now+3600000,committedMicrousd:'0',outstandingMicrousd:'0',ceilingMicrousd:'1'}};
 const record={taskId:binding.taskId,projectId:binding.projectId,originalBaselineSha:binding.baselineSha,approvedScopeHash:binding.scopeHash,approvedScope:{contractHash:binding.contractHash},checkpointSha:'e'.repeat(40),phase:'repair'},observations=[];
 for(const stage of ['repair','final_review'])for(let i=0;i<3;i++){
  const operationIds=[stage+i+'a',stage+i+'b'];snapshot.snapshot.calls.push(...operationIds.map(id=>({id,state:'settled',model:snapshot.model,provider_usage:{input_tokens:1000,output_tokens:1000}})));
  observations.push({id:stage+i,stage,source:'verified_phase_receipts',cohort:binding.scopeHash,binding:{projectId:binding.projectId,scopeHash:binding.scopeHash},completed:true,calls:2,inputTokens:2000,outputTokens:2000,seconds:10,operationIds});
 }
 return {now,snapshot,record,observations};
}
test('actual owner adapter retains known monetary shortage while total lifecycle cost stays unknown',()=>{
 const result=lifecycleProposalFromSnapshot(partialMoneyFixture());
 assert.equal(result.state,'awaiting_owner_approval');assert.deepEqual(result.assessment.shortages,['money']);
 assert.equal(result.assessment.dimensions.money.projectedRemaining,null);assert.equal(result.assessment.dimensions.money.knownProjectedRemaining,'66000');
 assert.equal(result.proposal.proposed.ceilingMicrousd,'66000');assert.equal(result.proposal.conservativeIncrementalMicrousd,null);
 assert.equal(result.proposal.knownEstimatedIncrementalMicrousd,'66000');
 assert.deepEqual(result.proposal.unestimatedCostStages,['do_completion','assessment','browser_delivery']);
 assert.ok(result.proposal.uncertainties.includes('monetary_amendment_covers_only_known_estimated_stages_not_total_completion_cost'));
});
test('known subtotal never fabricates complete cost, absent pricing or unknown exposure',()=>{
 const f=partialMoneyFixture();f.snapshot.position.ceilingMicrousd='66000';assert.equal(lifecycleProposalFromSnapshot(f).state,'not_required');
 f.snapshot.position.ceilingMicrousd='1';f.snapshot.pricing.status='unverified';let r=lifecycleProposalFromSnapshot(f);assert.equal(r.state,'not_required');assert.equal(r.assessment.dimensions.money.knownProjectedRemaining,'0');assert.equal(r.assessment.dimensions.money.projectedRemaining,null);
 f.snapshot.pricing.status='verified';f.snapshot.exposureMicrousd=null;r=lifecycleProposalFromSnapshot(f);assert.equal(r.state,'not_required');assert.equal(r.assessment.dimensions.money.authorizedRemaining,null);
});
test('partial monetary ceiling preserves exact committed and outstanding exposure and immutable consent',()=>{
 const f=partialMoneyFixture();f.snapshot.position.committedMicrousd='5.123';f.snapshot.position.outstandingMicrousd='7.456';f.snapshot.position.ceilingMicrousd='13.579';f.snapshot.exposureMicrousd='12.579';
 const r=lifecycleProposalFromSnapshot(f);assert.equal(r.proposal.proposed.ceilingMicrousd,'66012.579');assert.equal(r.proposal.current.outstandingMicrousd,'7.456');
 const prior=r.proposal.id;f.snapshot.position.outstandingMicrousd='8.456';assert.equal(r.proposal.id,prior);assert.equal(r.proposal.current.outstandingMicrousd,'7.456');
});
