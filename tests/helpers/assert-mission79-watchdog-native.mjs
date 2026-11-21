import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Synthetic disposable 79-mission Postgres fixture, never live production.
// This executes the actual project completion watchdog, owner recovery RPC,
// and global lease claimer in one rollback-only SAVEPOINT.
export async function assertMission79WatchdogNative(db,{project,owner,missionId,assignmentId,retrySha,generation,deployment,oldRetryAuthorization}){
 const blockedDetail='No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.';
 const nextSha='7'.repeat(40),nextDeployment='dpl_WatchdogRecovered79',consent=randomUUID();
 const denied=async(fn,pattern)=>{
  await db.query('savepoint watchdog_denied');
  try{await assert.rejects(fn(),pattern);}
  finally{await db.query('rollback to savepoint watchdog_denied');await db.query('release savepoint watchdog_denied');}
 };
 await db.query('savepoint watchdog_recovery_trial');
 try{
  // The original, first owner-approved retry has just been queued.
  let p=(await db.query('select status,progress_since from work_projects where id=$1',[project])).rows[0];
  assert.equal(p.status,'running');
  assert.ok(Date.now()-new Date(p.progress_since).getTime()<180000,'The updated initial retry approval must refresh its watchdog clock');

  // Seed the real watchdog's signature, then simulate an unchanged 46-minute
  // inactivity interval and its legitimate wait->blocked transition.
  await db.query('reset role');
  const firstLease=randomUUID();
  await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,firstLease]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) ok",[project,firstLease])).rows[0].ok,true);
  await db.query('reset role');
  const secondLease=randomUUID();
  await db.query("update work_projects set progress_since=clock_timestamp()-interval '46 minutes',lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,secondLease]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) ok",[project,secondLease])).rows[0].ok,true);
  p=(await db.query('select status,detail,progress_since from work_projects where id=$1',[project])).rows[0];
  assert.equal(p.status,'blocked','The unchanged 45-minute watchdog must still block stale development');
  assert.equal(p.detail,blockedDetail);
  // The native fixture runs owner approval and watchdog in ONE outer
  // rollback-only transaction. project_events.created_at defaults to now()
  // (the transaction start), whereas the owner receipt uses clock_timestamp().
  // Production uses separate committed HTTP/cron transactions. Mirror that
  // real chronology by appending the identical observed watchdog event with
  // its actual statement timestamp in this disposable fixture only.
  await db.query('reset role');
  await db.query(`insert into project_events(project_id,event,data,created_at)
   select project_id,event,data,clock_timestamp()
   from project_events where project_id=$1 and event='block'
   order by id desc limit 1`,[project]);
  await db.query('set role service_role');

  // Owner's FIRST immutable retry receipt remains spent and bound to the OLD
  // release: no implicit authorization on the newly deployed corrected SHA.
  await db.query('reset role');
  assert.equal((await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5) r',[project,retrySha,deployment,'closed',generation])).rows[0].r.state,'closed');
  assert.equal((await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5) r',[project,nextSha,nextDeployment,'active',generation+1])).rows[0].r.state,'active');
  await db.query('set role service_role');
  const nextGeneration=generation+2;
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,nextSha,nextGeneration,nextDeployment])).rows[0].ok,false);
  const offer=(await db.query('select project_org_mission79_watchdog_offer($1,$2,$3) r',[owner,project,nextSha])).rows[0].r;
  assert.equal(offer.stage,'recover_watchdog');
  assert.equal(offer.priorAuthorizationId,oldRetryAuthorization);
  assert.equal(offer.releaseGeneration,nextGeneration);
  assert.equal(offer.missionId,missionId);assert.equal(offer.assignmentId,assignmentId);
  assert.equal(offer.originalAttempts,1);assert.equal(offer.originalCalls,1);
  assert.equal(offer.cutoff!==null,true);
  const args=[owner,project,nextSha,missionId,assignmentId,consent,
   oldRetryAuthorization,offer.cutoff,offer.stateHash,nextGeneration,nextDeployment];
  const call=()=>db.query('select project_org_mission79_watchdog_recover($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r',args);
  await denied(()=>db.query('select project_org_mission79_watchdog_recover($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r',[randomUUID(),...args.slice(1)]),/owner|authority|changed/i);
  await denied(()=>db.query('select project_org_mission79_watchdog_recover($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r',[...args.slice(0,9),nextGeneration+1,nextDeployment]),/preflight|changed/i);
  await denied(()=>db.query('select project_org_mission79_watchdog_recover($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r',[...args.slice(0,8),'f'.repeat(64),...args.slice(9)]),/preflight|changed/i);
  await denied(()=>db.query('select project_org_mission79_watchdog_recover($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r',[...args.slice(0,10),'dpl_Stale']),/preflight|changed/i);
  const approved=(await call()).rows[0].r;
  assert.equal(approved.stage,'recovered');assert.equal(approved.existing,false);
  assert.equal(approved.priorAuthorizationId,oldRetryAuthorization);
  await denied(call,/already|preflight|changed|present/i);
  await db.query('reset role');
  const ledger=(await db.query('select authorization_id,original_retry_authorization_id,release_sha,release_generation from project_mission79_watchdog_recovery_receipts where project_id=$1',[project])).rows;
  assert.equal(ledger.length,1);assert.equal(ledger[0].original_retry_authorization_id,oldRetryAuthorization);
  assert.equal(ledger[0].release_sha,nextSha);assert.equal(Number(ledger[0].release_generation),nextGeneration);
  const old=(await db.query('select authorization_id,release_sha,release_generation from project_mission79_retry_receipts where project_id=$1',[project])).rows[0];
  assert.equal(old.authorization_id,oldRetryAuthorization);assert.equal(old.release_sha,retrySha);
  await db.query('set role service_role');
  const healthy=(await db.query('select status,progress_since,deadline from work_projects where id=$1',[project])).rows[0];
  assert.equal(healthy.status,'running');
  assert.ok(Date.now()-new Date(healthy.progress_since).getTime()<180000,'Owner recovery must refresh stale watchdog time');
  const job=(await db.query('select status,attempts,result from mission_assignments where id=$1',[assignmentId])).rows[0];
  assert.equal(job.status,'queued');assert.equal(job.attempts,1);
  assert.equal(job.result.managementCommandRejection.code,'director_appointment');
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,nextSha,nextGeneration,nextDeployment])).rows[0].ok,true);

  // The normal, global-locked, release-generation-fenced scheduler still has
  // the exclusive right to lease attempt two. No synthetic provider execution.
  await db.query('reset role');
  await db.query("update mission_assignments set created_at='1800-01-01T00:00:00Z',available_at=now() where id=$1",[assignmentId]);
  await db.query('set role service_role');
  const claimed=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[nextSha,nextGeneration,nextDeployment])).rows[0].c;
  assert.equal(claimed?.job?.id,assignmentId);
  assert.equal(claimed.job.attempts,2);
  const claimedReceipt=(await db.query('select project_org_mission79_watchdog_offer($1,$2,$3) r',[owner,project,nextSha])).rows[0].r;
  assert.equal(claimedReceipt.stage,'claimed','Owner can still read immutable authorization after worker claim');
  assert.equal(claimedReceipt.authorizationId,consent);
  assert.equal((await db.query('select project_org_mission79_retry_execution_authorized($1,$2,$3,$4) ok',[assignmentId,claimed.job.lease,nextSha,nextDeployment])).rows[0].ok,true);
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,nextSha,nextGeneration,nextDeployment])).rows[0].ok,false,'No third attempt');
  const other=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[nextSha,nextGeneration,nextDeployment])).rows[0].c;
  assert.notEqual(other?.job?.id,assignmentId,'Same worker cannot get two leases');
  if(process.env.KATIE_TEST_MISSION80_CONTINUATION==='1'){
   const {assertMission80ReleaseNative}=await import('./assert-mission80-release-native.mjs');
   await assertMission80ReleaseNative(db,{project,missionId,assignmentId,
    release:nextSha,generation:nextGeneration,deployment:nextDeployment});
  }
  console.log('MISSION79_WATCHDOG_RACE_NATIVE_PASS: stale watchdog block, owner recovery, new release, one actual lease, zero third attempts');
 }finally{
  await db.query('rollback to savepoint watchdog_recovery_trial');
  await db.query('release savepoint watchdog_recovery_trial');
  await db.query('set role service_role');
 }
}
