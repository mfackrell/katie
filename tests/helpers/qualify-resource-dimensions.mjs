// Independent isolated PostgreSQL dimensions. These use explicitly synthetic
// phase observations backed by real settled ledger rows, not real model quality.
// The integrated host scenario separately authenticates durable Git evidence.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {assertOrdinaryAuthority} from './assert-ordinary-authority.mjs';
import {lifecycleProposalFromSnapshot} from '../../scripts/benchmark/lifecycle-owner-proposal.mjs';
export async function qualifyResourceDimensions(db,rival){
 const results=[];
 for(const p of (await db.query("select id,actor_id,chat_id from work_projects where status in ('running','blocked','awaiting_approval','awaiting_input','paused')")).rows)await db.query("select control_work_project($1,$2,$3,'stop')",[p.id,p.actor_id,p.chat_id]);
 for(const dimension of ['tokens','money','expiration']){
  const limits={cumulativeTokens:dimension==='tokens'?150000:180000,developmentTokens:dimension==='tokens'?90000:120000,developmentCalls:100,completionTokens:60000,completionCalls:4,assessmentTokens:60000,assessmentCalls:4,perCallMicrousd:100000,ceilingMicrousd:dimension==='money'?220000:2000000,durationSeconds:dimension==='expiration'?60:3600};
  await assertOrdinaryAuthority(db,rival,{schemaReady:true,limits,initialLifecycle:async(ids,original)=>{
   const release=original.release_sha,digest=randomBytes(32).toString('hex');
   assert.equal((await db.query('select developer_claim_dispatch($1,$2) ok',[original.approval_id,release])).rows[0].ok,true);
   const grant=(await db.query('select developer_issue_execution_grant($1,$2,$3,$4) g',[original.approval_id,ids.task,digest,release])).rows[0].g;
   const reserve=(connection,token,epoch,tokens)=>connection.query('select developer_native_reserve($1,$2,$3,$4,$5,$6) id',[token,ids.project,epoch,randomUUID(),'gpt-5.3-codex',tokens]);
   const calls=[];
   for(let i=0;i<12;i++){
    const call=(await reserve(db,digest,grant.executionEpoch,2000)).rows[0].id;calls.push(call);
    const linked=(await db.query('select legacy_mission_call_id id from benchmark_budget_calls where id=$1',[call])).rows[0].id;
    await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-dimension-'+call,{input_tokens:1000,output_tokens:1000,total_tokens:2000}]);
   }
   if(dimension==='money'){
    const settled=(await db.query('select benchmark_lifecycle_snapshot($1) s',[ids.task])).rows[0].s;
    await db.query('begin');const uncertain=(await reserve(db,digest,grant.executionEpoch,100)).rows[0].id;
    const held=(await db.query('select benchmark_lifecycle_snapshot($1) s',[ids.task])).rows[0].s;
    assert.ok(Number(held.exposureMicrousd)>Number(settled.exposureMicrousd));
    assert.ok(held.snapshot.calls.some(c=>c.id===uncertain&&c.state!=='settled'));
    assert.ok(Number(held.position.outstandingMicrousd)>0,'Outstanding work is never zero exposure');
    const operation=held.snapshot.calls.find(c=>c.id===uncertain);
    await db.query('savepoint duplicate_uncertain');
    await assert.rejects(db.query('select developer_native_reserve($1,$2,$3,$4,$5,$6)',[digest,ids.project,grant.executionEpoch,operation.request_key,'gpt-5.3-codex',100]),/duplicate key/);
    await db.query('rollback to savepoint duplicate_uncertain');
    const retained=(await db.query('select benchmark_lifecycle_snapshot($1) s',[ids.task])).rows[0].s;
    assert.deepEqual(retained.snapshot.calls,held.snapshot.calls);assert.deepEqual(retained.snapshot.exposures,held.snapshot.exposures);

    await db.query('rollback');
    await db.query('begin');await db.query("update model_registry set pricing_status='unknown' where provider_name='openai' and model_id='gpt-5.3-codex'");
    await db.query('savepoint unpriced_admission');await assert.rejects(reserve(db,digest,grant.executionEpoch,100),/price|pricing/i);await db.query('rollback to savepoint unpriced_admission');
    const unpriced=(await db.query('select benchmark_lifecycle_snapshot($1) s',[ids.task])).rows[0].s;assert.deepEqual(unpriced.snapshot.exposures,settled.snapshot.exposures);
    await db.query('rollback');
   }
   if(dimension==='tokens')await assert.rejects(reserve(db,digest,grant.executionEpoch,7000),/capacity|protected completion/i);
   if(dimension==='money')await assert.rejects(reserve(db,digest,grant.executionEpoch,4000),/ceiling|exposure/i);
   // Synthetic terminal receipt/checkpoint for the SQL transaction boundary only.
   await db.query("update agent_tasks set status='blocked',external=external||jsonb_build_object('issueNumber',829,'receipt',jsonb_build_object('outcome','BLOCKED','run_id',131)) where id=$1",[ids.task]);
   const snapshot=async()=>(await db.query('select benchmark_lifecycle_snapshot($1) s',[ids.task])).rows[0].s;
   const observations=['repair','final_review'].flatMap((stage,k)=>[0,1,2].map(i=>({id:stage+i,stage,source:'verified_phase_receipts',cohort:ids.scopeHash,binding:{projectId:ids.project,scopeHash:ids.scopeHash},completed:true,calls:2,inputTokens:2000,outputTokens:2000,seconds:10,operationIds:calls.slice(k*6+i*2,k*6+i*2+2)})));
   if(dimension==='expiration')await db.query('select pg_sleep(greatest(0,extract(epoch from deadline-clock_timestamp()))+0.05) from benchmark_native_spending_approvals where id=$1',[original.approval_id]);
   if(dimension==='expiration')await assert.rejects(reserve(db,digest,grant.executionEpoch,1),/Ordinary native admission denied/i);
   const current=await snapshot(),record={taskId:ids.task,projectId:ids.project,originalBaselineSha:current.binding.baselineSha,approvedScopeHash:ids.scopeHash,approvedScope:{contractHash:current.binding.contractHash},checkpointSha:'d'.repeat(40),phase:'repair'};
   const planned=lifecycleProposalFromSnapshot({snapshot:current,record,observations});
   assert.equal(planned.state,'awaiting_owner_approval',JSON.stringify(planned));assert.ok(planned.assessment.shortages.includes(dimension==='tokens'?'nativeTokens':dimension==='money'?'money':'executionAuthority'));
   assert.equal(planned.proposal.additions.nativeCalls,0,'Available calls must not be misclassified');
   if(dimension==='money'){assert.equal(planned.proposal.conservativeIncrementalMicrousd,null);assert.equal(planned.proposal.knownEstimatedIncrementalMicrousd,'63000');assert.equal(planned.proposal.proposed.ceilingMicrousd,'252000');}
   if(dimension==='tokens')assert.equal(planned.proposal.additions.tokens,2000);
   const checkpoint={...record,scopeHash:ids.scopeHash,runId:'131',approvalId:original.approval_id,grantId:grant.grantId,releaseSha:release};
   const offer=(await db.query('select benchmark_lifecycle_offer($1,$2,$3) o',[ids.task,planned.proposal,checkpoint])).rows[0].o;
   const approved=(await db.query('select benchmark_lifecycle_decide($1,$2,$3,$4,$5) d',[ids.owner,ids.task,offer.id,'approved',release])).rows[0].d;
   assert.deepEqual((await snapshot()).snapshot.calls,current.snapshot.calls);assert.deepEqual((await snapshot()).snapshot.exposures,current.snapshot.exposures);
   assert.equal((await db.query('select developer_claim_dispatch($1,$2) ok',[approved.approvalId,release])).rows[0].ok,true);
   const nextDigest=randomBytes(32).toString('hex'),next=(await db.query('select developer_issue_execution_grant($1,$2,$3,$4) g',[approved.approvalId,ids.task,nextDigest,release])).rows[0].g;
   await assert.rejects(reserve(db,digest,grant.executionEpoch,1),/unauthorized|expired|Ordinary native admission denied/i);
   const usable=(await reserve(db,nextDigest,next.executionEpoch,dimension==='tokens'?7000:4000)).rows[0].id;
   const linked=(await db.query('select legacy_mission_call_id id from benchmark_budget_calls where id=$1',[usable])).rows[0].id;
   await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-amended-dimension-'+usable,{input_tokens:1000,output_tokens:1000,total_tokens:2000}]);
   const project=(await db.query('select actor_id,chat_id from work_projects where id=$1',[ids.project])).rows[0];await db.query("select control_work_project($1,$2,$3,'stop')",[ids.project,project.actor_id,project.chat_id]);
   results.push({dimension,taskId:ids.task,proposal:planned.proposal,approvalId:approved.approvalId,grantId:next.grantId,admittedCall:usable,historicalCallsPreserved:12,syntheticCheckpoint:true});
  }});
 }
 return results;
}
