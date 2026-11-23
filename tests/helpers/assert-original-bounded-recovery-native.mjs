import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

// The original M79→M82 fixture is authoritative. This nested SAVEPOINT adds
// 83/84 only in a temporary native database: no production provider dispatch.
export async function assertOriginalBoundedRecoveryNative(db,{project,owner,release,generation,deployment,m82,j82}){
 const M83='2289146a-5728-40e7-bc05-79c5c0bed12d';
 const J83='95118a8e-8db5-465c-a8d7-98e35631ba30';
 const M84='18819669-d4cf-4010-a455-19f5bcbf93cb';
 const J84='bd8de51d-0195-4c5f-9c88-9dc39e228636';
 const queryClaim='select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) allowed';
 const code=readFileSync('supabase/migrations/20261123145500_original_project_bounded_recovery.sql','utf8')
  .replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
 await db.query('savepoint original_84_recovery');
 try{
  await db.query('reset role');
  const priorM=(await db.query('select to_jsonb(m) data from agent_missions m where id=$1',[m82])).rows[0].data;
  const priorJ=(await db.query('select to_jsonb(j) data from mission_assignments j where id=$1',[j82])).rows[0].data;
  const originalProject=(await db.query('select deadline from work_projects where id=$1',[project])).rows[0];
  const originalAuthority=(await db.query('select * from project_provider_execution where project_id=$1',[project])).rows[0];
  const root=(await db.query("select n.id,n.agent_id,a.config from project_organization_nodes n join managed_agents a on a.id=n.agent_id where n.project_id=$1 and n.kind='project_director'",[project])).rows[0];
  const qa=(await db.query("select n.id,n.agent_id,a.config from project_organization_nodes n join managed_agents a on a.id=n.agent_id where n.project_id=$1 and n.area='independent_qa' and n.management_level='functional_director'",[project])).rows[0];
  assert.ok(root?.id&&qa?.id,'Existing original Project Director and independent QA required');
  const now=Date.now(),t82=new Date(now-240000),tD=new Date(now-180000),
   t83=new Date(now-120000),tE=new Date(now-60000),t84=new Date(now-30000);
  // The prior genuine M82 claim in the native fixture is settled here ONLY.
  const accepted=randomUUID();
  await db.query('update agent_missions set status=\'completed\',calls=1,created_at=$2 where id=$1',[m82,t82]);
  await db.query("update mission_assignments set status='completed',lease=null,lease_until=null,result=$2 where id=$1",
   [j82,{output:'Management decision recorded',decisionId:accepted}]);
  await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,$5)",
   [accepted,project,root.id,j82,tD]);
  const failedText='Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.';
  const m83={...priorM,id:M83,status:'blocked',calls:0,detail:failedText,actual_tokens:0,
   result:null,created_at:t83.toISOString(),updated_at:t83.toISOString(),
   project_evidence:{...priorM.project_evidence,organizationNodeId:qa.id,previousMissionId:null},
   team:[{id:qa.agent_id,config:qa.config}]};
  await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[m83]);
  await db.query('update work_projects set active_mission_id=$2 where id=$1',[project,M83]);
  const j83={...priorJ,id:J83,mission_id:M83,agent_id:qa.agent_id,status:'failed',
   attempts:1,lease:null,lease_until:null,heartbeat_at:null,result:{detail:failedText,
    diagnostic:{stage:'work',errorType:'Error',acceptedIssue:false}},
   detail:failedText,payload:{organizationNodeId:qa.id},created_at:'1800-01-01T00:00:04Z',
   updated_at:t83.toISOString(),available_at:'1800-01-01T00:00:04Z'};
  await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[j83]);
  await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[J83,qa.id]);
  await db.query("insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail,status,created_at) values($1,$2,$3,'objective','Management session failed twice; saved decisions and charges retained.','open',$4)",[project,qa.id,root.id,tE]);
  await db.query('update project_organization_nodes set decision_needed=true where id=$1',[root.id]);
  const m84={...priorM,id:M84,status:'running',calls:0,result:null,detail:null,actual_tokens:0,
   created_at:t84.toISOString(),updated_at:t84.toISOString(),
   project_evidence:{...priorM.project_evidence,organizationNodeId:root.id,previousMissionId:null},
   team:[{id:root.agent_id,config:root.config}]};
  await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[m84]);
  await db.query("update work_projects set active_mission_id=$2,status='running' where id=$1",[project,M84]);
  const j84={...priorJ,id:J84,mission_id:M84,agent_id:root.agent_id,status:'queued',
   attempts:0,lease:null,lease_until:null,heartbeat_at:null,result:null,detail:null,
   payload:{organizationNodeId:root.id},created_at:'1800-01-01T00:00:05Z',
   updated_at:t84.toISOString(),available_at:'1800-01-01T00:00:05Z'};
  await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[j84]);
  await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[J84,root.id]);
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,84);
  // Original watchdog must first record the new progress signature, then
  // a second *unchanged* 45-minute inactivity tick blocks the parent.
  const initialLease=randomUUID();
  await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,initialLease]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) ok",[project,initialLease])).rows[0].ok,true);
  const projectLease=randomUUID();
  await db.query('reset role');
  await db.query("update work_projects set progress_since=clock_timestamp()-interval '46 minutes',lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,projectLease]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) ok",[project,projectLease])).rows[0].ok,true);
  assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'blocked');
  // Model the ALREADY-EXPIRED historical owner cutoff under a disposable
  // SAVEPOINT. No new owner consent is fabricated by this fixture.
  await db.query('reset role');
  const expired=new Date(now-3600000),oldStart=new Date(now-7200000),priorWindow=randomUUID();
  // Historical-state SETUP only: source fixture began with a FUTURE cutoff.
  // Construct an actual expired valid window (prior_cutoff < cutoff), then
  // temporarily bypass only the node immutable guard to model already-expired
  // historical node deadlines. Restore all triggers BEFORE owner approval tests.
  await db.query("insert into project_execution_windows(id,project_id,owner_id,release_sha,decision_id,prior_cutoff,cutoff,prior_release_sha) values($1,$2,$3,$4,$5,$6,$7,$4)",
   [priorWindow,project,owner,originalAuthority.continuation_release_sha,
    originalAuthority.continuation_decision_id,oldStart,expired]);
  await db.query('update project_provider_execution set window_id=$2,deadline=$3 where project_id=$1',[project,priorWindow,expired]);
  await db.query('update work_projects set deadline=$2 where id=$1',[project,expired]);
  await db.query('alter table project_organization_nodes disable trigger project_org_immutable');
  try{
   for(const row of (await db.query('select * from project_organization_nodes where project_id=$1 order by depth,id',[project])).rows)
    await db.query('update project_organization_nodes set deadline=$2 where id=$1',[row.id,expired]);
  }finally{await db.query('alter table project_organization_nodes enable trigger project_org_immutable');}
  await db.query("update agent_missions set deadline=$2,status='blocked' where id=$1",[M84,expired]);
  await db.query("update agent_missions set deadline=$2 where id=$1",[M83,expired]);
  const blockEvent=(await db.query("select id,created_at from project_events where project_id=$1 and event='block' order by created_at desc limit 1",[project])).rows[0];
  await db.query('update work_projects set updated_at=$2 where id=$1',[project,blockEvent.created_at]);
  await db.query('set role service_role');
  assert.equal((await db.query(queryClaim,[project,release,generation,deployment])).rows[0].allowed,false,
   'Expired original window does not authorize a provider call');
  await db.query('reset role');
  await db.query(code);
  await db.query('set role service_role');
  const diagnostics=(await db.query(
   "select p.status,p.phase,p.organization_version,p.deadline,p.updated_at,p.active_mission_id,"+
   "(select count(*)::int from project_organization_nodes where project_id=p.id and status='active' and deadline=p.deadline) nodes,"+
   "(select count(*)::int from project_work_packages where project_id=p.id) packages,"+
   "(select count(*)::int from agent_missions where project_id=p.id) missions,"+
   "(select jsonb_build_object('id',e.id,'created',e.created_at,'action',e.data->'impediment'->>'minimumAction') from project_events e where e.project_id=p.id and e.event='block' and e.created_at=p.updated_at limit 1) event,"+
   "(select jsonb_build_object('status',m.status,'calls',m.calls,'deadline',m.deadline) from agent_missions m where m.id=$2) m84,"+
   "(select jsonb_build_object('status',j.status,'attempts',j.attempts,'result',j.result,'lease',j.lease,'lease_until',j.lease_until) from mission_assignments j where j.id=$3) j84,"+
   "(select jsonb_build_object('status',m.status,'calls',m.calls,'deadline',m.deadline) from agent_missions m where m.id=$4) m83,"+
   "(select jsonb_build_object('status',j.status,'attempts',j.attempts,'result',j.result) from mission_assignments j where j.id=$5) j83,"+
   "(select count(*)::int from project_organization_exceptions ex join project_organization_nodes qa on qa.id=ex.origin_id where ex.project_id=p.id and ex.owner_id=$6 and qa.id=$7 and qa.parent_id=$6 and ex.status='open' and ex.reason='objective' and ex.created_at>(select created_at from agent_missions where id=$4) and ex.created_at<(select created_at from agent_missions where id=$2)) valid_escalations,"+
   "(select jsonb_build_object('window',a.window_id,'deadline',a.deadline,'window_cutoff',w.cutoff,'owner',a.owner_id) from project_provider_execution a join project_execution_windows w on w.id=a.window_id where a.project_id=p.id) authority"+
   " from work_projects p where p.id=$1",
   [project,M84,J84,M83,J83,root.id,qa.id])).rows[0];
  console.log('ORIGINAL_84_OFFER_DIAGNOSTIC '+JSON.stringify(diagnostics));
  const offer=(await db.query('select project_org_original_recovery_offer($1,$2,$3) offer',[owner,project,release])).rows[0].offer;
  assert.equal(offer.stage,'authorize');assert.equal(offer.historicalMissions,84);
  assert.equal(offer.missionId,M84);assert.equal(offer.assignmentId,J84);
  const auth=randomUUID(),cutoff=new Date(Date.now()+4*3600000);
  const approval=[owner,project,release,generation,deployment,auth,cutoff,96,600000,1,0,offer.stateHash];
  const invoke='select project_org_original_window_authorize($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) result';
  const denied=async(values,pattern)=>{
   await db.query('savepoint original_84_negative');
   try{await assert.rejects(db.query(invoke,values),pattern);}
   finally{await db.query('rollback to savepoint original_84_negative');await db.query('release savepoint original_84_negative');}
  };
  await denied([randomUUID(),...approval.slice(1)],/owner|scope|original/i);
  await denied([...approval.slice(0,3),generation+1,...approval.slice(4)],/owner|scope|terms|original/i);
  await denied([...approval.slice(0,11),'f'.repeat(64)],/owner|scope|terms|original/i);
  await denied([...approval.slice(0,8),700000,...approval.slice(9)],/owner|scope|terms|original/i);
  const result=(await db.query(invoke,approval)).rows[0].result;
  assert.equal(result.stage,'recovered');assert.equal(result.existing,false);
  assert.equal(result.authorizationId,auth);assert.equal(result.currentAttempts,0);
  assert.equal(result.missionCeiling,96);assert.equal(result.tokenAllowance,600000);
  await denied(approval,/original|owner|terms|required/i);
  const active=(await db.query('select status,progress_since,deadline from work_projects where id=$1',[project])).rows[0];
  assert.equal(active.status,'running');assert.equal(Date.parse(active.deadline),cutoff.getTime());
  assert.ok(Date.now()-Date.parse(active.progress_since)<150000,'Owner recovery refreshes unchanged 45-minute watchdog');
  assert.equal((await db.query(queryClaim,[project,release,generation,deployment])).rows[0].allowed,true);
  const first=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.equal(first?.job?.id,J84,'Native scheduler must lease original unclaimed M84');
  assert.equal(first.job.attempts,1);assert.ok(first.job.lease);
  assert.notEqual((await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c?.job?.id,J84);
  // Only in this rollback fixture: accepted M84 response allows the SAME
  // existing hierarchy scheduler to commission M85; no synthetic paid call.
  await db.query('reset role');
  const d84=randomUUID();
  await db.query("update mission_assignments set status='completed',lease=null,lease_until=null,result=$2 where id=$1",
   [J84,{output:'Management decision recorded',decisionId:d84}]);
  await db.query("update agent_missions set status='completed',calls=1 where id=$1",[M84]);
  await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,clock_timestamp())",
   [d84,project,root.id,J84]);
  await db.query('update project_organization_nodes set decision_needed=true where id=$1',[root.id]);
  const lease4=randomUUID();
  await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,lease4]);
  await db.query('set role service_role');
  const next=(await db.query('select project_org_schedule($1,$2) r',[project,lease4])).rows[0].r;
  assert.ok(next?.missionId,'Existing organization scheduler must commission a successor');
  const nextJob=(await db.query('select j.id,j.status,j.attempts,m.status mission_status from mission_assignments j join agent_missions m on m.id=j.mission_id where m.id=$1',[next.missionId])).rows[0];
  assert.equal(nextJob.status,'queued');assert.equal(nextJob.attempts,0);
  assert.equal((await db.query(queryClaim,[project,release,generation,deployment])).rows[0].allowed,true,
   'Same general authorization admits next organically scheduled mission');
  const second=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.equal(second?.job?.id,nextJob.id,'Second real SQL scheduler claim');
  assert.equal(second.job.attempts,1);assert.ok(second.job.lease);
  assert.notEqual((await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c?.job?.id,nextJob.id);
  assert.equal((await db.query('select status from agent_missions where id=$1',[M83])).rows[0].status,'blocked');
  assert.equal((await db.query('select attempts from mission_assignments where id=$1',[J83])).rows[0].attempts,1);
  assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
  console.log('ORIGINAL_84_RECOVERY_NATIVE_PASS: expired owner window denial, signed restored original M84, 45min watchdog, original failure immutable, first and second natural scheduler claims');
 }finally{
  await db.query('rollback to savepoint original_84_recovery');
  await db.query('release savepoint original_84_recovery');
  await db.query('reset role');
 }
}
