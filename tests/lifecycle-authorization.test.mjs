import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './lifecycle-capacity.test.mjs';
import {assessLifecycleCapacity} from '../lib/projects/lifecycle-capacity.mjs';
import {proposeLifecycleAmendment,proposalDigest,readableDollars} from '../lib/projects/lifecycle-authorization.mjs';

function setup(change=()=>{}) {
 const input=fixture();input.authorization.calls.developmentLimit=100;
 input.progress={...input.progress,source:'authenticated_recovery',phase:'repair',
  checkpointSha:'d'.repeat(40),completedStages:['implementation','initial_review']};
 change(input);
 const a=input.authorization;
 const current={binding:input.binding,checkpointSha:input.progress.checkpointSha,
  snapshotHash:'e'.repeat(64),scope:{request:'Finish original authorized task'},acceptance:['Original frozen requirements'],
  originalWindowSeconds:14400,proposalExpiresAt:input.observedAt+3600000,grantRenewable:true,
  position:{cumulativeTokens:a.tokens.cumulativeLimit,developmentTokens:a.tokens.developmentLimit,
   developmentCalls:a.calls.developmentLimit,assessmentCalls:a.calls.assessmentLimit,
   completionTokens:a.tokens.completionReserveRemaining,completionCalls:a.calls.completionReserveRemaining,
   assessmentTokens:a.tokens.assessmentReserveRemaining,accountEncumberedTokens:a.tokens.accountEncumbered,
   developmentEncumberedTokens:a.tokens.developmentEncumbered,developmentConsumedCalls:a.calls.developmentConsumed,
   assessmentConsumedCalls:a.calls.assessmentConsumed,committedMicrousd:'5000000',
   outstandingMicrousd:'657365',ceilingMicrousd:a.money.ceilingMicrousd,expiresAt:a.deadline}};
 return {assessment:assessLifecycleCapacity(input),current,now:input.observedAt};
}
test('adequate task creates no proposal or authority',()=>{
 const args=setup(),before=structuredClone(args);
 assert.deepEqual(proposeLifecycleAmendment(args),{state:'not_required',proposal:null});assert.deepEqual(args,before);
});
test('historical eleven native calls and four protected calls propose native additions without borrowing reserves',()=>{
 const args=setup(f=>{f.authorization.calls.developmentLimit=15;f.authorization.calls.developmentConsumed=11;});
 const before=structuredClone(args),result=proposeLifecycleAmendment(args),p=result.proposal;
 assert.equal(result.state,'awaiting_owner_approval');assert.equal(p.additions.nativeCalls,8);
 assert.equal(p.proposed.developmentCalls,23);assert.equal(p.proposed.completionCalls,4);
 assert.equal(p.proposed.completionTokens,60000);assert.equal(p.proposed.assessmentTokens,60000);
 assert.deepEqual(p.completed,['implementation','initial_review']);assert.equal(p.guaranteedCompletion,false);
 assert.deepEqual(args,before);assert.equal(p.kind,'proposal_not_authorization');
 assert.equal(p.id,proposeLifecycleAmendment(args).proposal.id);
});
test('tokens, calls and dollars are independent and simultaneous shortages consolidate',()=>{
 const args=setup(f=>{f.authorization.calls.developmentLimit=21;
  f.authorization.tokens.developmentEncumbered=388278;
  f.authorization.money.exposureMicrousd='9999999';});
 args.current.position.committedMicrousd='9900000';args.current.position.outstandingMicrousd='99999';
 const p=proposeLifecycleAmendment(args).proposal;
 assert.ok(p.additions.nativeCalls>0);assert.ok(p.additions.developmentTokens>0);
 assert.ok(BigInt(p.proposed.ceilingMicrousd)>10000000n);
 assert.equal(BigInt(p.proposed.ceilingMicrousd),9999999n+BigInt(p.conservativeIncrementalMicrousd));
 assert.ok(BigInt(p.estimatedIncrementalMicrousd)<BigInt(p.proposed.ceilingMicrousd));
});
test('expired window proposes renewal without starting a clock or changing historical expiration',()=>{
 const args=setup(f=>{f.authorization.deadline=f.observedAt-1;f.authorization.live=false;});
 const p=proposeLifecycleAmendment(args).proposal;
 assert.equal(p.proposed.durationSeconds,14400);assert.equal(p.proposed.windowStartsAt,'authenticated_commit');
 assert.equal(p.proposed.expiresAt,null);assert.equal(p.current.expiresAt,args.now-1);
});
test('unknown duration uses disclosed prior owner window and does not invent a forecast',()=>{
 const args=setup(f=>{f.authorization.deadline=f.observedAt-1;f.observations=[];});
 const p=proposeLifecycleAmendment(args).proposal;
 assert.equal(p.proposed.durationSeconds,14400);assert.equal(p.estimatedIncrementalMicrousd,null);
 assert.ok(p.uncertainties.includes('continuation_window_reuses_prior_owner_window_duration_estimate_unknown'));
});
test('minimum-only shortage is explicitly uncertain',()=>{
 const args=setup(f=>{f.observations=[];f.authorization.calls.developmentLimit=15;f.authorization.calls.developmentConsumed=11;});
 const p=proposeLifecycleAmendment(args).proposal;
 assert.equal(p.additions.nativeCalls,2);assert.ok(p.uncertainties.includes('nativeCalls:minimum_only_amendment'));
 assert.equal(p.conservativeIncrementalMicrousd,null);
});
test('unknown assessment call capacity is retained without inventing or granting calls',()=>{
 const args=setup(f=>{f.authorization.calls.assessmentLimit=null;f.authorization.calls.assessmentConsumed=null;
  f.authorization.calls.developmentLimit=15;});
 const p=proposeLifecycleAmendment(args).proposal;
 assert.equal(p.proposed.assessmentCalls,null);assert.equal(p.additions.assessmentCalls,0);
});
test('shared account shortage increases only the required cumulative headroom',()=>{
 const args=setup(f=>{f.authorization.tokens.accountEncumbered=505000;});
 const p=proposeLifecycleAmendment(args).proposal;
 assert.equal(p.proposed.cumulativeTokens,627640);assert.equal(p.additions.tokens,2640);
 assert.equal(p.proposed.developmentTokens,args.current.position.developmentTokens);
 assert.equal(p.additions.developmentTokens,0);
});
test('proposal cannot be changed through input references after hashing',()=>{
 const args=setup(f=>{f.authorization.calls.developmentLimit=15;});
 const p=proposeLifecycleAmendment(args).proposal;
 args.current.position.ceilingMicrousd='900000000';args.current.scope.request='Different work';
 assert.equal(p.current.ceilingMicrousd,'10000000');assert.equal(p.scope.request,'Finish original authorized task');
 assert.throws(()=>{p.current.ceilingMicrousd='900000000';},TypeError);
});
test('increasing completion reserve within existing call ceiling does not report negative native additions',()=>{
 const args=setup(f=>{f.authorization.calls.completionReserveRemaining=2;});
 const p=proposeLifecycleAmendment(args).proposal;
 assert.equal(p.proposed.developmentCalls,100);assert.equal(p.proposed.completionCalls,4);
 assert.equal(p.additions.nativeCalls,0);assert.equal(p.additions.completionCalls,2);
});
test('revocation, freeze and authoritative denials cannot be converted into owner proposals',()=>{
 for(const patch of [{revoked:true},{frozen:true},{admissionDenial:'scope_changed'}]){
  const args=setup(f=>{f.authorization.calls.developmentLimit=15;});Object.assign(args.current,patch);
  assert.equal(proposeLifecycleAmendment(args).state,'admission_denied');
 }
});
test('changed binding, checkpoint, absent accounting and expired proposal fail closed',()=>{
 for(const edit of [a=>a.current.binding={...a.current.binding,taskId:'wrong'},a=>a.current.checkpointSha='f'.repeat(40),
  a=>a.current.position.outstandingMicrousd=null,a=>a.current.proposalExpiresAt=a.now,
  a=>a.now+=60001]){
  const args=setup(f=>{f.authorization.calls.developmentLimit=15;});edit(args);
  assert.equal(proposeLifecycleAmendment(args).state,'evidence_required');
 }
});
test('material snapshot or workload change yields a distinct immutable proposal',()=>{
 const args=setup(f=>{f.authorization.calls.developmentLimit=15;});
 const original=proposeLifecycleAmendment(args).proposal;
 args.current.snapshotHash='f'.repeat(64);assert.notEqual(proposeLifecycleAmendment(args).proposal.id,original.id);
 assert.equal(proposalDigest({b:2,a:1}),proposalDigest({a:1,b:2}));
});
test('money stays precise in proposal and display rounds to cents',()=>{
 const args=setup(f=>{f.authorization.calls.developmentLimit=15;});
 args.current.position.outstandingMicrousd='657365.123456789012';
 assert.equal(proposeLifecycleAmendment(args).proposal.current.outstandingMicrousd,'657365.123456789012');
 assert.equal(readableDollars('5657365.123456789012'),'$5.66');
 assert.equal(readableDollars('9999999'),'$10.00');assert.equal(readableDollars(null),'Unknown');
});
