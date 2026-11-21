import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

// Isolated native PostgreSQL 16 SAVEPOINT, nested in the verified original
// Mission79 owner/claim fixture. No production or model-provider calls.
export async function assertMission80WatchdogNative(db,{
 project,missionId,assignmentId,release,generation,deployment,
 m80,j80,owner,decisionId
}){
 const newSql=readFileSync('supabase/migrations/20261121185000_mission80_owner_watchdog_continuity.sql','utf8')
  .replace(/^\s*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
 const predicate='select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok';
 const denied=async(fn,pattern)=>{
  await db.query('savepoint mission80_negative');
  try{await assert.rejects(fn(),pattern);}
  finally{
   await db.query('rollback to savepoint mission80_negative');
   await db.query('release savepoint mission80_negative');
  }
 };
 await db.query('savepoint mission80_watchdog_native');
 try{
  await db.query('reset role');
  // Existing first-stage original M80 predicate already returned TRUE.
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,true);
  const old79=(await db.query('select to_jsonb(j) as receipt from mission_assignments j where id=$1',[assignmentId])).rows[0].receipt;
  const old79m=(await db.query('select status,calls from agent_missions where id=$1',[missionId])).rows[0];
  assert.equal(old79.status,'completed');assert.equal(old79.attempts,2);
  const oldReceipt=(await db.query('select to_jsonb(r) receipt from project_mission79_watchdog_recovery_receipts r where project_id=$1',[project])).rows[0].receipt;
  await db.query(newSql);
  await db.query('set role service_role');
  const dynamicEligible=(await db.query(predicate,[project,release,generation,deployment])).rows[0].ok;
  if(!dynamicEligible){
   await db.query('reset role');
   const diagnostic=(await db.query(`select
    p.status project_status,p.phase,p.deadline,p.active_mission_id,
    p.approval_hash=p.approved_hash scope_hash_ok,
    p.max_missions,p.token_allowance,
    m.id mission_id,m.status mission_status,m.calls,m.created_at,m.deadline mission_deadline,
    m.project_kind,m.project_evidence,
    n.id node_id,n.status node_status,n.kind,n.management_level,n.deadline node_deadline,
    n.deadline=p.deadline node_deadline_ok,
    (select count(*) from agent_missions x where x.project_id=p.id) missions,
    (select count(*) from mission_assignments x where x.mission_id=m.id) jobs,
    (select count(*) from project_organization_assignments oa where oa.assignment_id=j.id and oa.node_id=n.id) org_assignments,
    (select max(prior.created_at) from agent_missions prior where prior.project_id=p.id and prior.created_at<m.created_at) prev_at,
    (select count(*) from agent_missions prev join mission_assignments pj on pj.mission_id=prev.id
      join project_organization_decisions pd on pd.assignment_id=pj.id and pd.id::text=pj.result->>'decisionId'
      where prev.project_id=p.id and prev.status='completed' and pj.status='completed'
       and prev.created_at=(select max(prior.created_at) from agent_missions prior where prior.project_id=p.id and prior.created_at<m.created_at)) predecessor,
    project_org_retest_exact_scope_grants(p.id) exact_scope,
    project_org_retest_original_owner_lineage(p.id) owner_lineage,
    project_provider_continued(p.id) continued,
    project_provider_continued_assignment(j.id) membership
    from work_projects p join agent_missions m on m.id=p.active_mission_id
    join mission_assignments j on j.mission_id=m.id
    join project_organization_nodes n on n.id::text=m.project_evidence->>'organizationNodeId'
    where p.id=$1`,[project])).rows[0];
   console.log('MISSION80_BOUNDED_RELEASE_DIAGNOSTIC '+JSON.stringify(diagnostic));
   await db.query('set role service_role');
  }
  assert.equal(dynamicEligible,true,'General authorized management contract admits original queued M80');
  assert.equal((await db.query(predicate,[project,'f'.repeat(40),generation,deployment])).rows[0].ok,false);
  assert.equal((await db.query(predicate,[project,release,generation+1,deployment])).rows[0].ok,false);
  assert.equal((await db.query(predicate,[project,release,generation,'dpl_WrongRelease'])).rows[0].ok,false);

  // The actual 45-minute watchdog sees a newly active management mission.
  // First tick sets its new real signature, not an artificial heartbeat.
  const firstLease=randomUUID();
  await db.query('reset role');
  await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,firstLease]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) v",[project,firstLease])).rows[0].v,true);
  const secondLease=randomUUID();
  await db.query('reset role');
  await db.query("update work_projects set progress_since=clock_timestamp()-interval '46 minutes',lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,secondLease]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) v",[project,secondLease])).rows[0].v,true);
  const blocked=(await db.query('select status,detail from work_projects where id=$1',[project])).rows[0];
  assert.equal(blocked.status,'blocked');
  assert.match(blocked.detail,/No new completed artifact or external execution transition for 00:45:00/);

  // The accepted test fixture runs multiple logical owner/cron transactions
  // inside one rollback transaction; now() is frozen. Materialize their
  // committed ordering using clock_timestamp only in this disposable fixture.
  await db.query('reset role');
  const w=(await db.query('select authorized_at from project_mission79_watchdog_recovery_receipts where project_id=$1',[project])).rows[0];
  const stamps=(await db.query("select clock_timestamp() blocked_at")).rows[0];
  const t0=new Date(w.authorized_at).getTime();
  const tb=new Date(stamps.blocked_at).getTime();
  assert.ok(tb>t0+3,'Actual test must preserve owner -> decision -> M80 -> watchdog order');
  await db.query('update project_organization_decisions set created_at=$2 where id=$1',
   [decisionId,new Date(t0+1)]);
  await db.query('update agent_missions set created_at=$2 where id=$1',[m80,new Date(t0+2)]);
  await db.query("update project_events set created_at=$2 where id=(select e.id from project_events e where e.project_id=$1 and e.event='block' and e.data->'impediment'->>'minimumAction' like '%ce8dcc30-e316-49e7-934d-6add6c14a697%' order by e.created_at desc,e.id desc limit 1)",[project,stamps.blocked_at]);
  await db.query("update work_projects set updated_at=$2 where id=$1",[project,stamps.blocked_at]);
  await db.query('set role service_role');
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,false,'BLOCKED parent cannot claim');
  const offer=(await db.query('select project_org_mission80_watchdog_offer($1,$2,$3) offer',[owner,project,release])).rows[0].offer;
  assert.equal(offer.stage,'recover_watchdog');assert.equal(offer.missionId,m80);
  assert.equal(offer.assignmentId,j80);assert.equal(offer.currentAttempts,0);
  assert.equal(offer.historicalMissions,80);assert.equal(offer.nodeCount,13);
  const authorization=randomUUID();
  const args=[owner,project,release,m80,j80,authorization,offer.cutoff,offer.stateHash,generation,deployment];
  const sql='select project_org_mission80_watchdog_recover($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result';
  await denied(()=>db.query(sql,[randomUUID(),...args.slice(1)]),/owner|lineage|changed/i);
  await denied(()=>db.query(sql,[...args.slice(0,8),generation+1,deployment]),/preflight|changed/i);
  await denied(()=>db.query(sql,[...args.slice(0,7),'f'.repeat(64),...args.slice(8)]),/preflight|changed/i);
  await denied(()=>db.query(sql,[...args.slice(0,9),'dpl_WrongRelease']),/preflight|changed/i);
  const approved=(await db.query(sql,args)).rows[0].result;
  assert.equal(approved.stage,'recovered');assert.equal(approved.existing,false);
  assert.equal(approved.authorizationId,authorization);
  await denied(()=>db.query(sql,args),/preflight|changed|consumed/i);
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,true,
   'Same original M80 now runnable after exact signed recovery');

  const active=(await db.query('select status,progress_since from work_projects where id=$1',[project])).rows[0];
  assert.equal(active.status,'running');
  assert.ok(Date.now()-new Date(active.progress_since).getTime()<150000,'Recovery refreshes watchdog on the real clock');
  const pending=(await db.query('select status,attempts,lease from mission_assignments where id=$1',[j80])).rows[0];
  assert.equal(pending.status,'queued');assert.equal(pending.attempts,0);assert.equal(pending.lease,null);
  // Immediate stale watchdog pass cannot reblock the project after a real
  // recovery transition. Project completion itself is still controlled.
  const thirdLease=randomUUID();
  await db.query('reset role');
  await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,thirdLease]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) v",[project,thirdLease])).rows[0].v,true);
  assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'running');

  // The production scheduler, NOT this test helper, is the only paid claim.
  // This local fixture calls the real PostgreSQL leasing routine; never provider.
  const claim=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.equal(claim?.job?.id,j80,'Normal scheduler leases only the saved M80 assignment');
  assert.equal(claim.job.attempts,1);assert.ok(claim.job.lease);
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,false,
   'Already-claimed M80 cannot get duplicate initial permission');
  const replay=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.notEqual(replay?.job?.id,j80,'No duplicate M80 claim');

  // Simulate a valid management result only in this rollback-only fixture.
  // A naturally generated M81 in production must be observed, not fabricated.
  await db.query('reset role');
  const n80=(await db.query('select to_jsonb(m) r from agent_missions m where id=$1',[m80])).rows[0].r;
  const j80Row=(await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[j80])).rows[0].r;
  const nextDecision=randomUUID();
  await db.query("update agent_missions set status='completed',calls=1,result='Management decisions committed' where id=$1",[m80]);
  await db.query("update mission_assignments set status='completed',lease=null,lease_until=null,result=$2 where id=$1",[j80,{output:'Management decision recorded',decisionId:nextDecision}]);
  await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values ($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,clock_timestamp())",
   [nextDecision,project,n80.project_evidence.organizationNodeId,j80]);
  const successor=randomUUID(),successorJob=randomUUID();
  const sm={...n80,id:successor,status:'running',calls:0,actual_tokens:0,
   result:null,detail:null,created_at:new Date(Date.now()+3000).toISOString(),
   updated_at:new Date(Date.now()+3000).toISOString()};
  await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[sm]);
  await db.query('update work_projects set active_mission_id=$2,progress_since=clock_timestamp(),status=\'running\' where id=$1',[project,successor]);
  const next={...j80Row,id:successorJob,mission_id:successor,status:'queued',attempts:0,
   lease:null,lease_until:null,result:null,detail:null,heartbeat_at:null,
   created_at:'1800-01-01T00:00:01Z',available_at:'1800-01-01T00:00:01Z',
   updated_at:new Date().toISOString()};
  await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[next]);
  await db.query(`insert into project_organization_assignments
   (assignment_id,node_id,contract_hash)
   select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex')
   from project_organization_nodes n
   where n.id::text=$2`,[successorJob,sm.project_evidence.organizationNodeId]);
  assert.equal((await db.query('select count(*)::int n from project_organization_assignments where assignment_id=$1',[successorJob])).rows[0].n,1);

  await db.query('set role service_role');
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,81);
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,true,
   'Legitimate subsequent management mission receives its OWN bounded claim approval');
  const nextClaim=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.equal(nextClaim?.job?.id,successorJob,'Ordinary global scheduler admits the next authorized management assignment');
  assert.equal(nextClaim.job.attempts,1);
  const noRepeat=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.notEqual(noRepeat?.job?.id,successorJob);
  await db.query('reset role');
  const protected79=(await db.query('select to_jsonb(j) as receipt from mission_assignments j where id=$1',[assignmentId])).rows[0].receipt;
  assert.deepEqual(protected79,old79,'Completed 79th mission attempt immutable during both successor claims');
  assert.deepEqual((await db.query('select status,calls from agent_missions where id=$1',[missionId])).rows[0],old79m);
  assert.deepEqual((await db.query('select to_jsonb(r) receipt from project_mission79_watchdog_recovery_receipts r where project_id=$1',[project])).rows[0].receipt,oldReceipt);
  assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
  const cap=(await db.query('select max_missions,token_allowance from work_projects where id=$1',[project])).rows[0];
  assert.equal(cap.max_missions,96);assert.equal(cap.token_allowance,600000);
  console.log('MISSION80_WATCHDOG_AND_SUCCESSOR_NATIVE_PASS: original block, release-bound owner receipt, fresh 45m clock, one M80 lease, next management lease, no replay, historical and scope integrity');
 }finally{
  await db.query('rollback to savepoint mission80_watchdog_native');
  await db.query('release savepoint mission80_watchdog_native');
  await db.query('set role service_role');
 }
}
