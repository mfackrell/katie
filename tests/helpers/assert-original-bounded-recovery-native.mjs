import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const M83='2289146a-5728-40e7-bc05-79c5c0bed12d';
const J83='95118a8e-8db5-465c-a8d7-98e35631ba30';
const M84='18819669-d4cf-4010-a455-19f5bcbf93cb';
const J84='bd8de51d-0195-4c5f-9c88-9dc39e228636';
const historical='Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.';
const expired='2026-11-22T14:00:00Z';
const originalScope='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';

// Nested in the accepted M79 -> M80 -> M81 -> M82 native transaction.
// This helper uses only disposable, rollback-only synthetic rows. Actual
// production Mission83/Mission84 histories are NEVER mutated or retried.
export async function assertOriginalBoundedRecoveryNative(db,{
 project,m82,j82,owner,release,generation,deployment
}){
 await db.query('savepoint original_84_recovery');
 try{
  await db.query('reset role');
  const prior=(await db.query('select to_jsonb(p) data from work_projects p where id=$1',[project])).rows[0].data;
  const m82row=(await db.query('select to_jsonb(m) data from agent_missions m where id=$1',[m82])).rows[0].data;
  const j82row=(await db.query('select to_jsonb(j) data from mission_assignments j where id=$1',[j82])).rows[0].data;
  const provider=(await db.query('select * from project_provider_execution where project_id=$1',[project])).rows[0];
  const root=(await db.query("select n.id,n.agent_id,a.config from project_organization_nodes n join managed_agents a on a.id=n.agent_id where n.project_id=$1 and n.kind='project_director'",[project])).rows[0];
  const qa=(await db.query("select n.id,n.agent_id,a.config from project_organization_nodes n join managed_agents a on a.id=n.agent_id where n.project_id=$1 and n.area='independent_qa' and n.management_level='functional_director'",[project])).rows[0];
  assert.ok(prior&&root&&qa&&provider&&m82row&&j82row);
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,82);

  // Simulate exactly the saved accepted M82 followed by original M83's
  // zero-provider, single pre-inference rejection; not a paid mock result.
  // The fixture's earlier M82 used test-only future timestamps. Place the
  // accepted M82 and its two historical successors in verified clock order
  // BEFORE owner authorization; original production records are untouched.
  const stamp=Date.now()-30000;
  const acceptedM82=new Date(stamp-10000);
  const decision82=randomUUID();
  await db.query("update agent_missions set status='completed',calls=1,result='Management decisions committed',created_at=$2 where id=$1",[m82,acceptedM82]);
  await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,$5)",[decision82,project,root.id,j82,new Date(stamp-5000)]);
  await db.query("update mission_assignments set status='completed',lease=null,lease_until=null,result=$2 where id=$1",[j82,{output:'Management decision recorded',decisionId:decision82}]);
  const m83={
   ...m82row,id:M83,status:'blocked',calls:0,actual_tokens:0,reserved_tokens:0,
   result:null,detail:historical,deadline:expired,
   created_at:new Date(stamp).toISOString(),updated_at:new Date(stamp).toISOString(),
   project_evidence:{previousMissionId:null,organizationNodeId:qa.id,
    providerContinuationWindow:provider.window_id,
    providerContinuationDecision:provider.continuation_decision_id,
    providerContinuationRelease:provider.continuation_release_sha},
   team:[{id:qa.agent_id,config:qa.config}]};
  await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[m83]);
  await db.query("update work_projects set active_mission_id=$2 where id=$1",[project,M83]);
  const j83={...j82row,id:J83,mission_id:M83,status:'failed',attempts:1,
   lease:null,lease_until:null,heartbeat_at:null,agent_id:qa.agent_id,
   result:{detail:historical,diagnostic:{stage:'work',errorType:'Error',acceptedIssue:false}},
   detail:historical,payload:{organizationNodeId:qa.id},
   created_at:'1800-01-01T00:00:04Z',available_at:'1800-01-01T00:00:04Z',
   updated_at:new Date(stamp+1000).toISOString()};
  await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[j83]);
  await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[J83,qa.id]);
  const m84={...m82row,id:M84,status:'blocked',calls:0,actual_tokens:0,reserved_tokens:0,
   result:null,detail:null,deadline:expired,
   created_at:new Date(stamp+2000).toISOString(),updated_at:new Date(stamp+2000).toISOString(),
   project_evidence:{previousMissionId:null,organizationNodeId:root.id,
    providerContinuationWindow:null,
    providerContinuationDecision:provider.continuation_decision_id,
    providerContinuationRelease:provider.continuation_release_sha},
   team:[{id:root.agent_id,config:root.config}]};
  await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[m84]);
  await db.query("update work_projects set active_mission_id=$2 where id=$1",[project,M84]);
  const j84={...j82row,id:J84,mission_id:M84,status:'queued',attempts:0,lease:null,
   lease_until:null,heartbeat_at:null,agent_id:root.agent_id,result:null,detail:null,
   payload:{organizationNodeId:root.id},created_at:'1800-01-01T00:00:05Z',
   available_at:'1800-01-01T00:00:05Z',updated_at:new Date(stamp+2000).toISOString()};
  await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[j84]);
  await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[J84,root.id]);
  await db.query("update project_organization_nodes set decision_needed=true where id=$1",[root.id]);

  // To test an actually EXPIRED prior window on the real current system clock,
  // create a fixture-only chain of legitimate source-preserving deadline
  // amendment rows. No old production window or accepted decision is edited.
  const oldWindow=randomUUID();
  // Seed an already-expired historical window in this disposable fixture.
  // Native fixture construction initially built a future window, so the
  // immutable node deadline guard is disabled ONLY while transplanting this
  // synthetic past checkpoint. Re-enable before testing the actual owner RPC.
  // No production trigger/permission is modified by the migration itself.
  await db.query("insert into project_execution_windows(id,project_id,owner_id,release_sha,decision_id,prior_cutoff,cutoff,prior_release_sha) values($1,$2,$3,$4,$5,$6,$7,$4)",
   [oldWindow,project,owner,provider.continuation_release_sha,provider.continuation_decision_id,'2026-11-21T14:00:00Z',expired]);
  await db.query('alter table project_organization_nodes disable trigger project_org_immutable');
  await db.query('update project_organization_nodes set deadline=$2 where project_id=$1',[project,expired]);
  await db.query('alter table project_organization_nodes enable trigger project_org_immutable');
  assert.equal((await db.query("select count(*)::int n from pg_trigger where tgrelid='project_organization_nodes'::regclass and tgname='project_org_immutable' and tgenabled='O'")).rows[0].n,1,
   'Immutable hierarchy guard restored before signed owner recovery');
  await db.query('update project_provider_execution set deadline=$2,window_id=$3 where project_id=$1',[project,expired,oldWindow]);
  await db.query("update work_projects set deadline=$2,status='blocked',lease=null,lease_until=null,progress_since=clock_timestamp()-interval '46 minutes',detail=$3 where id=$1",
   [project,expired,'No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.']);
  await db.query("update agent_missions set project_evidence=jsonb_set(project_evidence,'{providerContinuationWindow}',$2::jsonb) where id in ($1,$3)",
   [M83,JSON.stringify(oldWindow),M84]);
  // Match the original project scheduler's immutable pre-recovery mission
  // source, not a fabricated release admission.
  const ev=(await db.query("insert into project_events(project_id,event,data) values($1,'block',$2) returning id,created_at",
   [project,{detail:'No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.',
    impediment:{kind:'blocked',step:'development',minimumAction:'Restore the stalled worker or external workflow for saved mission '+M84+', then resume within the existing authorization.'}}])).rows[0];
  await db.query('update work_projects set updated_at=$2 where id=$1',[project,ev.created_at]);

  const original83=(await db.query('select to_jsonb(m) m,to_jsonb(j) j from agent_missions m join mission_assignments j on j.mission_id=m.id where m.id=$1',[M83])).rows[0];
  await db.query('set role service_role');
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation,deployment])).rows[0].ok,false,'Expired old authorization remains denied');
  // The trusted fixture uses random UUIDs for the authenticated owner,
  // original Project Director node and manager agent. Substitute ONLY these
  // literal fixture identities; the actual production migration stays frozen
  // to the verified original UUIDs, unchanged in Git.
  const migration=readFileSync('supabase/migrations/20261123180500_original_project_bounded_recovery.sql','utf8')
   .replaceAll('04ed6c05-a586-4a56-ba81-1b50e378746b',owner)
   .replaceAll('c486ade1-2a9c-4cd5-a80b-90c032e4e03e',root.id)
   .replaceAll('c10c9dc2-d69a-46fe-9129-866fa7f5faa6',root.agent_id)
   .replaceAll('2b04302e-8815-4c61-89aa-e35b9baffa82',oldWindow)
   .replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
  await db.query('reset role');
  await db.query(migration);
  await db.query('set role service_role');

  const preflight=(await db.query(`select
   p.status,p.deadline,p.updated_at,p.progress_since,p.active_mission_id,
   a.window_id,a.deadline as provider_deadline,a.approved_scope,
   w.id as prior_window,w.cutoff as prior_cutoff,w.release_sha as prior_release,
   m84.id as mission84,m84.status as mission84_status,m84.deadline as mission84_deadline,
   m84.created_at as mission84_created,m83.created_at as mission83_created,
   j84.status as job84_status,j84.attempts as job84_attempts,j84.available_at,
   (select count(*) from agent_missions x where x.project_id=p.id) as mission_count,
   (select count(*) from mission_assignments x where x.mission_id=m84.id) as assignment_count,
   (select count(*) from project_organization_nodes n where n.project_id=p.id and n.status='active' and n.deadline=p.deadline) as current_nodes,
   (select count(*) from project_work_packages x where x.project_id=p.id) as package_count,
   (select count(*) from project_events e where e.project_id=p.id and e.event='block'
     and e.created_at=p.updated_at and e.data->'impediment'->>'minimumAction' like '%18819669-d4cf-4010-a455-19f5bcbf93cb%') as block_events,
   project_provider_continued(p.id) as continued,
   project_org_retest_original_owner_lineage(p.id) as owner_lineage,
   project_org_retest_exact_scope_grants(p.id) as original_scope,
   project_provider_request_pending(p.id) as pending,
   (select coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0) from agent_missions x where x.project_id=p.id) as spent
   from work_projects p join project_provider_execution a on a.project_id=p.id
   join project_execution_windows w on w.id=a.window_id
   join agent_missions m84 on m84.id=$2
   join mission_assignments j84 on j84.mission_id=m84.id
   join agent_missions m83 on m83.id=$3
   where p.id=$1`,[project,M84,M83])).rows[0];
  console.log('ORIGINAL_84_NATIVE_PREFLIGHT '+JSON.stringify(preflight));
  const offer=(await db.query('select project_org_bounded_recovery_offer($1,$2,$3) offer',[owner,project,release])).rows[0].offer;
  assert.equal(offer.stage,'authorize');
  assert.equal(offer.historicalMissions,84);assert.equal(offer.remainingMissions,12);
  assert.equal(offer.maxMissions,96);assert.equal(offer.tokenAllowance,600000);
  assert.equal(offer.additionalPaidRetries,0);
  assert.equal((await db.query('select project_org_bounded_recovery_window_valid($1) ok',[project])).rows[0].ok,false);
  const authorization=randomUUID();
  const newCutoff=new Date(Date.now()+24*3600000).toISOString();
  const args=[owner,project,release,generation,deployment,authorization,newCutoff,offer.stateHash,M84,J84,96,600000,0];
  const sql='select project_org_bounded_recovery_authorize($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) result';
  const reject=async(values)=>{
   await db.query('savepoint bounded_negative');
   try{await assert.rejects(db.query(sql,values));}
   finally{await db.query('rollback to savepoint bounded_negative');await db.query('release savepoint bounded_negative');}
  };
  await reject([randomUUID(),...args.slice(1)]);
  await reject([...args.slice(0,3),generation+1,...args.slice(4)]);
  await reject([...args.slice(0,7),'f'.repeat(64),...args.slice(8)]);
  await reject([...args.slice(0,11),600001,0]);
  await reject([...args.slice(0,12),1]);
  const approved=(await db.query(sql,args)).rows[0].result;
  assert.equal(approved.stage,'recovered');assert.equal(approved.authorizationId,authorization);
  await reject(args);
  const restored=(await db.query('select status,deadline,progress_since,active_mission_id from work_projects where id=$1',[project])).rows[0];
  assert.equal(restored.status,'running');assert.equal(new Date(restored.deadline).toISOString(),newCutoff);
  assert.equal(restored.active_mission_id,M84);
  assert.ok(Date.now()-Date.parse(restored.progress_since)<150000);
  assert.equal((await db.query('select project_org_bounded_recovery_window_valid($1) ok',[project])).rows[0].ok,true);
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation,deployment])).rows[0].ok,true);
  assert.equal((await db.query('select count(*)::int n from project_organization_contract_changes where project_id=$1 and window_id=$2',[project,authorization])).rows[0].n,13);

  // Ordinary 45-minute watchdog must not immediately re-block a genuinely
  // new owner-approved parent transition; no threshold is altered.
  const lease=randomUUID();
  await db.query('reset role');
  await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,lease]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) ok",[project,lease])).rows[0].ok,true);
  assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'running');
  const claimed=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.equal(claimed?.job?.id,J84,'Existing GLOBAL scheduler claims original M84 exactly once');
  assert.equal(claimed.job.attempts,1);assert.ok(claimed.job.lease);
  assert.notEqual((await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c?.job?.id,J84);

  // Native continuation after one accepted management decision: only the
  // fixture is allowed to synthesize a completed provider outcome.
  const finish=async(mission,job,node)=>{
   await db.query('reset role');
   const decision=randomUUID();
   await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,clock_timestamp())",
    [decision,project,node,job]);
   await db.query("update agent_missions set status='completed',calls=1,result='Management decisions committed' where id=$1",[mission]);
   await db.query("update mission_assignments set status='completed',lease=null,lease_until=null,result=$2 where id=$1",[job,{output:'Management decision recorded',decisionId:decision}]);
   await db.query('set role service_role');
  };
  const schedule=async()=>{
   const lease=randomUUID();
   await db.query('reset role');
   await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,lease]);
   await db.query('set role service_role');
   const result=(await db.query('select project_org_schedule($1,$2) v',[project,lease])).rows[0].v;
   assert.ok(result?.missionId,'Original hierarchy must schedule a successor');
   const row=(await db.query('select j.id,m.id mission_id,m.status,m.project_evidence from mission_assignments j join agent_missions m on m.id=j.mission_id where m.id=$1',[result.missionId])).rows[0];
   assert.ok(row?.id);return row;
  };
  await finish(M84,J84,root.id);
  const next=await schedule();
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation,deployment])).rows[0].ok,true);
  const nextClaim=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.equal(nextClaim?.job?.id,next.id,'First naturally scheduled downstream mission receives its own validated authority');
  await finish(next.mission_id,next.id,next.project_evidence.organizationNodeId);
  const finalNext=await schedule();
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation,deployment])).rows[0].ok,true);
  const secondClaim=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.equal(secondClaim?.job?.id,finalNext.id,'Second successive normal scheduler transition has valid source-bound authority');
  assert.notEqual((await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c?.job?.id,finalNext.id);
  await db.query('reset role');
  const historicalAfter=(await db.query('select to_jsonb(m) m,to_jsonb(j) j from agent_missions m join mission_assignments j on j.mission_id=m.id where m.id=$1',[M83])).rows[0];
  assert.deepEqual(historicalAfter,original83,'M83 original failed mission/result/attempts immutable across owner renewal and two new scheduler claims');
  const quotas=(await db.query('select max_missions,token_allowance from work_projects where id=$1',[project])).rows[0];
  assert.deepEqual(quotas,{max_missions:96,token_allowance:600000});
  assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
  console.log('ORIGINAL_84_BOUNDED_NATIVE_PASS: expired denial, authenticated owner cutoff, preserved M83, original M84 single lease, refreshed watchdog, two subsequent real scheduler claims');
 }finally{
  await db.query('rollback to savepoint original_84_recovery');
  await db.query('release savepoint original_84_recovery');
  await db.query('reset role');
 }
}
