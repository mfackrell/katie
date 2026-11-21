import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Disposable PostgreSQL SAVEPOINT: never accesses the live project or provider.
export async function assertMission79OneRetryNative(db,other,{project,owner,missionId,assignmentId}){
 const rejection={detail:'Project Director commissions Functional Directors only',
  managementCommandRejection:{code:'director_appointment',action:'appoint',
  reason:'Project Director commissions Functional Directors only',
  position:1,priorAppointments:0,targets:[]}};
 const requestId='804249c2-0782-4075-8072-bb5f38d32f6a';
 const retrySha='9'.repeat(40),deployment='dpl_NativeRetryMission79';
 const rejected=async(fn,pattern)=>{
  await db.query('savepoint retry_rejected');
  try{await assert.rejects(fn(),pattern);}
  finally{await db.query('rollback to savepoint retry_rejected');await db.query('release savepoint retry_rejected');}
 };
 await db.query('savepoint original_mission79_retry_test');
 try{
  const start=(await db.query('select j.*,m.calls from mission_assignments j join agent_missions m on m.id=j.mission_id where j.id=$1',[assignmentId])).rows[0];
  assert.equal(start.status,'running');assert.equal(start.attempts,1);assert.equal(start.calls,0);
  const gate=(await db.query('select * from project_retest_production_release_gate where project_id=$1',[project])).rows[0];
  assert.equal(gate.state,'active');
  // The disposable fixture's service_role intentionally has no direct
  // provider-request table SELECT privilege. Query audit history as fixture
  // PostgreSQL owner; SQL service-role APIs still enforce their own ACLs.
  await db.query('reset role');
  assert.equal((await db.query("select count(*)::int n from project_provider_requests where assignment_id=$1 and operation='inference'",[assignmentId])).rows[0].n,0);
  await db.query("update mission_assignments set status='failed',result=$2,detail=$3,lease=null,lease_until=null where id=$1",[assignmentId,rejection,rejection.detail]);
  await db.query("update agent_missions set status='blocked',calls=1,detail=$2 where id=$1",[missionId,rejection.detail]);
  await db.query("update work_projects set status='blocked',lease=null,lease_until=null,detail=$2 where id=$1",[project,rejection.detail]);
  await db.query("insert into project_provider_requests(id,project_id,mission_id,assignment_id,worker_id,execution_attempt,operation,request_hash,provider_receipt,resolved_at) values($1,$2,$3,$4,$5,$6,'inference',$7,'fixture-resolved',clock_timestamp())",
   [requestId,project,missionId,assignmentId,start.agent_id,'366cee0b-283b-47d6-99b5-afe90ce0baf8','f'.repeat(64)]);
  // Release operator RPC is postgres-only, by design. The synthetic
  // release transition must use fixture DB owner, never service_role.
  await db.query('reset role');
  assert.equal((await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5) r',
   [project,gate.release_sha,gate.deployment_id,'closed',gate.generation])).rows[0].r.state,'closed');
  assert.equal((await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5) r',
   [project,retrySha,deployment,'active',gate.generation+1])).rows[0].r.state,'active');
  await db.query('set role service_role');
  const generation=gate.generation+2;
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',
   [project,retrySha,generation,deployment])).rows[0].ok,false,'Failed original is not automatically retried');
  const offer=(await db.query('select project_org_mission79_retry_offer($1,$2,$3) r',
   [owner,project,retrySha])).rows[0].r;
  assert.equal(offer.stage,'approve_retry');assert.equal(offer.releaseGeneration,generation);
  assert.equal(offer.originalAttempts,1);assert.equal(offer.originalCalls,1);
  assert.equal(offer.historicalMissions,79);assert.equal(offer.maxMissions,96);
  assert.equal(offer.tokenAllowance,600000);assert.equal(offer.nodeCount,13);
  const consent=randomUUID();
  const args=[owner,project,retrySha,missionId,assignmentId,consent,offer.cutoff,
   offer.stateHash,generation,deployment];
  const sql='select project_org_mission79_retry_authorize($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r';
  await rejected(()=>db.query(sql,[randomUUID(),...args.slice(1)]),/owner|project|release|authority/i);
  await rejected(()=>db.query(sql,[...args.slice(0,8),generation+1,deployment]),/preflight|changed/i);
  await rejected(()=>db.query(sql,[...args.slice(0,6),new Date(Date.parse(offer.cutoff)-60000),...args.slice(7)]),/preflight|changed/i);
  await rejected(()=>db.query(sql,[...args.slice(0,7),'a'.repeat(64),...args.slice(8)]),/preflight|changed/i);
  await rejected(()=>db.query(sql,[...args.slice(0,9),'dpl_OtherDeployment']),/preflight|changed/i);
  const result=(await db.query(sql,args)).rows[0].r;
  assert.equal(result.stage,'authorized');assert.equal(result.existing,false);
  assert.equal(result.authorizationId,consent);assert.equal(result.originalAttempts,1);
  await rejected(()=>db.query(sql,args),/already consumed|preflight|eligible/i);
  await rejected(()=>db.query('update project_mission79_retry_receipts set cutoff=clock_timestamp() where project_id=$1',[project]),/immutable|permission|update/i);
  await db.query('reset role');
  const snap=(await db.query('select prior_rejection,prior_attempts,prior_calls,prior_provider_request_id from project_mission79_retry_receipts where project_id=$1',[project])).rows[0];
  await db.query('set role service_role');
  assert.deepEqual(snap.prior_rejection,rejection);
  assert.equal(snap.prior_attempts,1);assert.equal(snap.prior_calls,1);
  assert.equal(snap.prior_provider_request_id,requestId);
  const q=(await db.query('select j.status,j.attempts,j.result,m.calls from mission_assignments j join agent_missions m on m.id=j.mission_id where j.id=$1',[assignmentId])).rows[0];
  assert.equal(q.status,'queued');assert.equal(q.attempts,1);assert.equal(q.calls,1);
  assert.deepEqual(q.result,rejection);
  for(const [sha,gen,dep] of [
   ['8'.repeat(40),generation,deployment],[retrySha,generation+1,deployment],
   [retrySha,generation,'dpl_OtherDeployment']
  ])assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,sha,gen,dep])).rows[0].ok,false);
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',
   [project,retrySha,generation,deployment])).rows[0].ok,true);
  const claimed=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',
   [retrySha,generation,deployment])).rows[0].c;
  assert.equal(claimed?.job?.id,assignmentId,'Normal global-lock claim must lease the same original assignment');
  assert.equal(claimed.job.attempts,2);
  assert.equal((await db.query('select project_org_mission79_retry_execution_authorized($1,$2,$3,$4) ok',
   [assignmentId,claimed.job.lease,retrySha,deployment])).rows[0].ok,true);
  assert.equal((await db.query('select project_org_mission79_retry_execution_authorized($1,$2,$3,$4) ok',
   [assignmentId,randomUUID(),retrySha,deployment])).rows[0].ok,false);
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',
   [project,retrySha,generation,deployment])).rows[0].ok,false,'Third claim prohibited');
  const extra=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',
   [retrySha,generation,deployment])).rows[0].c;
  assert.notEqual(extra?.job?.id,assignmentId,'No second simultaneous worker lease');
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,79);
  assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
  console.log('MISSION79_SINGLE_RETRY_NATIVE_PASS: owner, replay, release, cutoff, immutable prior failure, one scheduler lease and no third claim');
 } finally{
  await db.query('rollback to savepoint original_mission79_retry_test');
  await db.query('release savepoint original_mission79_retry_test');
 }
}
