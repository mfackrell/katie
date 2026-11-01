import test from 'node:test';
import assert from 'node:assert/strict';
import {lifecycleProposalFromSnapshot} from '../scripts/benchmark/lifecycle-owner-proposal.mjs';
import {partialMoneyFixture} from './fixtures/lifecycle-partial-money.mjs';
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

test('authenticated failed ordinary attempt offers grant renewal without inventing resource increases',()=>{
 const f=partialMoneyFixture();f.snapshot.position.ceilingMicrousd='2000000';
 const {snapshot,record}=f,b=snapshot.binding;
 Object.assign(snapshot,{authorityKind:'ordinary-developer',approvalId:'approval',grantRenewable:true});
 Object.assign(record,{approvalId:'approval',grantId:'grant',runId:'131'});
 Object.assign(snapshot.snapshot,{approval:{id:'approval',consumed_at:'2026-11-01'},task:{id:b.taskId,status:'blocked',external:{receipt:{outcome:'BLOCKED',run_id:131}}},grants:[{id:'grant',developer_approval_id:'approval',mission_assignment_id:b.taskId}]});
 const plan=lifecycleProposalFromSnapshot(f);assert.equal(plan.state,'awaiting_owner_approval');assert.ok(plan.assessment.shortages.includes('executionAuthority'));
 assert.equal(plan.proposal.additions.nativeCalls,0);assert.equal(plan.proposal.additions.tokens,0);assert.equal(plan.proposal.proposed.ceilingMicrousd,snapshot.position.ceilingMicrousd);
 for(const mutate of [x=>{x.snapshot.snapshot.task.status='dispatching';},x=>{x.record.runId='132';},x=>{x.snapshot.snapshot.approval.consumed_at=null;},x=>{x.snapshot.snapshot.grants=[];}]){
  const copy=structuredClone(f);mutate(copy);assert.equal(lifecycleProposalFromSnapshot(copy).state,'not_required');
 }
});
