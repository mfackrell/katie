import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

// Disposable native PostgreSQL16 source-bound fixture. No production writes,
// owner approval, provider call, or real mission is fabricated by this test.
export async function assertOriginalRecoveryNative(db,{project,m82,j82,owner,release,generation,deployment}){
 const M83='2289146a-5728-40e7-bc05-79c5c0bed12d';
 const J83='95118a8e-8db5-465c-a8d7-98e35631ba30';
 const M84='18819669-d4cf-4010-a455-19f5bcbf93cb';
 const J84='bd8de51d-0195-4c5f-9c88-9dc39e228636';
 const errorDetail='Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.';
 const rejected={detail:errorDetail,diagnostic:{stage:'work',errorType:'Error',acceptedIssue:false}};
 const fixedDeadline='2026-11-22T14:00:00Z';
 const candidateDeadline=new Date(Date.now()+4*3600_000).toISOString();
 const predicate='select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok';
 const get=async sql=>(await db.query(sql)).rows[0];
 await db.query('savepoint original_window_native');
 try{
  await db.query('reset role');
  const root=(await db.query("select n.*,a.config from project_organization_nodes n join managed_agents a on a.id=n.agent_id where n.project_id=$1 and n.kind='project_director'",[project])).rows[0];
  const qa=(await db.query("select n.*,a.config from project_organization_nodes n join managed_agents a on a.id=n.agent_id where n.project_id=$1 and n.area='independent_qa' and n.management_level='functional_director'",[project])).rows[0];
  const m82r=(await db.query('select to_jsonb(m) r from agent_missions m where id=$1',[m82])).rows[0].r;
  const j82r=(await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[j82])).rows[0].r;
  assert.ok(root?.id&&qa?.id);
  const futureTime=new Date(Date.now()-8*60_000),t82=new Date(futureTime.getTime()),t83=new Date(futureTime.getTime()+60_000),
    tException=new Date(futureTime.getTime()+120_000),t84=new Date(futureTime.getTime()+180_000);
  const d82=randomUUID();
  await db.query('update agent_missions set status=$2,calls=1,created_at=$3,updated_at=$3,result=$4 where id=$1',[m82,'completed',t82,'Management decisions committed']);
  await db.query('update mission_assignments set status=$2,lease=null,lease_until=null,result=$3 where id=$1',[j82,'completed',{output:'Management decision recorded',decisionId:d82}]);
  await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,$5)",[d82,project,root.id,j82,new Date(t82.getTime()+1000)]);
  const m83={...m82r,id:M83,project_id:project,status:'blocked',calls:0,actual_tokens:0,detail:errorDetail,result:null,
   created_at:t83.toISOString(),updated_at:t83.toISOString(),project_kind:'management',
   project_evidence:{...m82r.project_evidence,organizationNodeId:qa.id,previousMissionId:null},
   team:[{id:qa.agent_id,config:qa.config}]};
  await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[m83]);
  await db.query('update work_projects set active_mission_id=$2 where id=$1',[project,M83]);
  const j83={...j82r,id:J83,mission_id:M83,agent_id:qa.agent_id,status:'failed',attempts:1,lease:null,lease_until:null,
   heartbeat_at:null,detail:errorDetail,result:rejected,payload:{organizationNodeId:qa.id},role:'work',job_key:'plan',
   created_at:'1800-01-01T00:00:07Z',available_at:'1800-01-01T00:00:07Z',updated_at:t83.toISOString()};
  await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[j83]);
  await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[J83,qa.id]);
  await db.query("insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail,status,created_at) values($1,$2,$3,'objective','Management session failed twice; saved decisions and charges retained.','open',$4)",[project,qa.id,root.id,tException]);
  await db.query('update project_organization_nodes set decision_needed=(id=$1) where id in ($1,$2)',[root.id,qa.id]);
  const m84={...m82r,id:M84,project_id:project,status:'blocked',calls:0,actual_tokens:0,detail:null,result:null,
   created_at:t84.toISOString(),updated_at:t84.toISOString(),project_kind:'management',
   project_evidence:{...m82r.project_evidence,organizationNodeId:root.id,previousMissionId:null},
   team:[{id:root.agent_id,config:root.config}]};
  await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[m84]);
  await db.query('update work_projects set active_mission_id=$2 where id=$1',[project,M84]);
  const j84={...j82r,id:J84,mission_id:M84,agent_id:root.agent_id,status:'queued',attempts:0,lease:null,
   lease_until:null,heartbeat_at:null,result:null,detail:null,payload:{organizationNodeId:root.id},
   role:'work',job_key:'plan',created_at:'1800-01-01T00:00:08Z',
   available_at:'1800-01-01T00:00:08Z',updated_at:t84.toISOString()};
  await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[j84]);
  await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[J84,root.id]);
  // Normal unchanged 45-minute watchdog, first baseline signature then timeout.
  const firstLease=randomUUID();
  await db.query("update work_projects set status='running',lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,firstLease]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) ok",[project,firstLease])).rows[0].ok,true);
  await db.query('reset role');
  const secondLease=randomUUID();
  await db.query("update work_projects set progress_since=clock_timestamp()-interval '46 minutes',lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,secondLease]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) ok",[project,secondLease])).rows[0].ok,true);
  assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'blocked');
  const saved83=(await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[J83])).rows[0].r;
  const saved82=(await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[j82])).rows[0].r;
  await db.query('reset role');
  const olda=(await db.query('select window_id,deadline from project_provider_execution where project_id=$1',[project])).rows[0];
  // This is a DISPOSABLE fixture only. Create historical EXPIRED timestamp
  // and retain the immutable source, using disabled triggers to emulate
  // a period that actually elapsed outside this single rollback transaction.
  await db.query("set session_replication_role='replica'");
  try{
   await db.query('update project_execution_windows set cutoff=$2 where id=$1',[olda.window_id,fixedDeadline]);
   await db.query('update project_provider_execution set deadline=$2 where project_id=$1',[project,fixedDeadline]);
   await db.query('update work_projects set deadline=$2 where id=$1',[project,fixedDeadline]);
   await db.query('update project_organization_nodes set deadline=$2 where project_id=$1',[project,fixedDeadline]);
   await db.query('update agent_missions set deadline=$2 where id in($1,$3)',[M83,fixedDeadline,M84]);
  }finally{await db.query("set session_replication_role='origin'");}
  const originalBlocked=(await db.query('select status,deadline,updated_at from work_projects where id=$1',[project])).rows[0];
  const origEvent=(await db.query("select e.id,e.created_at from project_events e where e.project_id=$1 and e.event='block' order by e.created_at desc limit 1",[project])).rows[0];
  assert.ok(origEvent?.id);
  // Preserve the original block event's join to p.updated_at exactly.
  await db.query('update work_projects set updated_at=$2 where id=$1',[project,origEvent.created_at]);
  await db.query('set role service_role');
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,84);
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,false);
  assert.equal((await db.query("select count(*)::int n from project_provider_requests where project_id=$1 and resolved_at is null",[project])).rows[0].n,0);
  // Install only in the local fixture; never call these new functions in live
  // Supabase until reviewed and deployed under the guarded protocol.
  await db.query('reset role');
  const migration=readFileSync('supabase/migrations/20261123140500_original_project_owner_window_recovery.sql','utf8')
   .replace(/^([\s\S]*?)BEGIN;\s*/,'').replace(/\s*COMMIT;\s*$/,'');
  await db.query(migration);
  await db.query('set role service_role');
  const offer=(await db.query('select project_org_original_execution_recovery_offer($1,$2,$3) offer',[owner,project,release])).rows[0].offer;
  assert.equal(offer.stage,'authorize');assert.equal(offer.historicalMissions,84);
  assert.equal(offer.missionId,M84);assert.equal(offer.assignmentId,J84);
  const auth=randomUUID();
  const args=[owner,project,release,generation,deployment,auth,offer.stateHash,candidateDeadline,3,4,0];
  const recover='select project_org_original_execution_recover($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r';
  const denied=async(values,pattern)=>{
   await db.query('savepoint original_recovery_negative');
   try{await assert.rejects(db.query(recover,values),pattern);}
   finally{await db.query('rollback to savepoint original_recovery_negative');await db.query('release savepoint original_recovery_negative');}
  };
  await denied([randomUUID(),...args.slice(1)],/owner|authorization|project|state/i);
  await denied([...args.slice(0,6),'e'.repeat(64),...args.slice(7)],/owner|state|changed/i);
  await denied([...args.slice(0,3),generation+1,...args.slice(4)],/owner|release|changed/i);
  await denied([...args.slice(0,7),'2026-11-22T14:00:00Z',...args.slice(8)],/cutoff|owner|approval/i);
  await denied([...args.slice(0,8),13,4,0],/cutoff|owner|approval/i);
  assert.equal((await db.query('select count(*)::int n from project_original_execution_recovery_receipts where project_id=$1',[project])).rows[0].n,0);
  const signed=(await db.query(recover,args)).rows[0].r;
  assert.equal(signed.stage,'recovered');assert.equal(signed.authorizationId,auth);
  assert.equal(signed.authorizedTotalMissions,87);assert.equal(signed.approvedClaims,4);
  await denied(args,/approval|authorization|changed|already|owner/i);
  assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'running');
  assert.equal((await db.query('select attempts from mission_assignments where id=$1',[J84])).rows[0].attempts,0);
  assert.equal((await db.query('select status from agent_missions where id=$1',[M83])).rows[0].status,'blocked');
  assert.deepEqual((await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[J83])).rows[0].r,saved83);
  assert.deepEqual((await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[j82])).rows[0].r,saved82);
  assert.ok(Date.now()-Date.parse((await db.query('select progress_since from work_projects where id=$1',[project])).rows[0].progress_since)<120000);
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,true);
  for(const [sha,epoch,dep] of [['f'.repeat(40),generation,deployment],[release,generation+1,deployment],[release,generation,'dpl_Wrong']])
   assert.equal((await db.query(predicate,[project,sha,epoch,dep])).rows[0].ok,false);
  // The same native fenced global scheduler claims original saved M84 ONCE.
  const first=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.equal(first?.job?.id,J84);assert.equal(first.job.attempts,1);assert.ok(first.job.lease);
  assert.notEqual((await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c?.job?.id,J84);
  // A completed management decision is simulated only in this rollback
  // transaction, then the REAL project scheduler creates a next mission.
  for(let ordinal=1;ordinal<=2;ordinal++){
   const prior=ordinal===1?M84:(await db.query('select active_mission_id id from work_projects where id=$1',[project])).rows[0].id;
   const job=(await db.query('select id from mission_assignments where mission_id=$1',[prior])).rows[0].id;
   const decision=randomUUID();
   await db.query('reset role');
   await db.query('update agent_missions set status=$2,calls=1 where id=$1',[prior,'completed']);
   await db.query('update mission_assignments set status=$2,result=$3,lease=null,lease_until=null where id=$1',[job,'completed',{output:'Management decision recorded',decisionId:decision}]);
   await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,clock_timestamp())",
    [decision,project,root.id,job]);
   // The original root owns unresolved subordinate exceptions; the existing
   // hierarchy scheduler, not this fixture, must now commission its next node.
   const lease=randomUUID();
   await db.query('update work_projects set lease=$2,lease_until=clock_timestamp()+interval \'3 minutes\' where id=$1',[project,lease]);
   await db.query('set role service_role');
   const created=(await db.query('select project_org_schedule($1,$2) r',[project,lease])).rows[0].r;
   assert.ok(created?.missionId,'Original hierarchy scheduler must commission a new management mission');
   assert.notEqual(created.missionId,prior);
   const current=(await db.query('select id from agent_missions where id=$1 and project_id=$2',[created.missionId,project])).rows[0];
   assert.ok(current?.id);
   assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,true,
    'Generalized owner authority admits the next naturally scheduled management assignment');
   const acquired=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
   assert.equal(acquired?.mission?.id,created.missionId);
   assert.equal(acquired.job.attempts,1);
   assert.ok(acquired.job.lease);
   assert.notEqual((await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c?.job?.id,acquired.job.id);
  }
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,86);
  assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
  assert.equal((await db.query('select max_missions,token_allowance from work_projects where id=$1',[project])).rows[0].max_missions,96);
  console.log('ORIGINAL_WINDOW_NATIVE_PASS: 84 blocked/expired, exact owner receipt, new deadline and caps, M83 immutable, actual watchdog, three successive native claims M84–86, no duplicate inference');
 }finally{
  await db.query('rollback to savepoint original_window_native');
  await db.query('release savepoint original_window_native');
  await db.query('set role service_role');
 }
}
