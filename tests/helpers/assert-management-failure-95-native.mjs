import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const OVERFLOW='Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.';
const BLOCKED='Project management cannot achieve its objective within bounded retry authority';

export async function assertManagementFailure95Native(db,{project,owner,release,generation,deployment,root,sourceMission,sourceAssignment}){
 await db.query('savepoint management_retest95');
 try{
  await db.query('reset role');
  const prior=(await db.query('select * from project_context_retest_receipts where project_id=$1',[project])).rows[0];
  assert(prior?.authorization_id,'Existing Mission90 owner receipt remains distinct');
  const provider=(await db.query('select * from project_provider_execution where project_id=$1',[project])).rows[0];
  const oldMission=(await db.query('select to_jsonb(m) m from agent_missions m where id=$1',[sourceMission])).rows[0].m;
  const oldJob=(await db.query('select to_jsonb(j) j from mission_assignments j where id=$1',[sourceAssignment])).rows[0].j;
  assert.equal(oldMission.project_kind,'management');
  assert.equal(oldJob.attempts,2);
  const outcome=randomUUID();
  await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,clock_timestamp())",[outcome,project,root.id,sourceAssignment]);
  await db.query("update agent_missions set status='completed',calls=1,result='Management decisions committed' where id=$1",[sourceMission]);
  await db.query("update mission_assignments set status='completed',lease=null,lease_until=null,result=$2 where id=$1",[sourceAssignment,{output:'Management decision recorded',decisionId:outcome}]);
  let latest;
  for(let index=91;index<=95;index++){
   const mission=randomUUID(),assignment=randomUUID(),decision=randomUUID(),blocked=index===95;
   const stamp=new Date(Date.now()+index*1000).toISOString();
   const m={...oldMission,id:mission,status:blocked?'blocked':'completed',calls:blocked?0:1,
    actual_tokens:0,reserved_tokens:0,result:blocked?null:'Management decisions committed',
    detail:blocked?OVERFLOW:null,created_at:stamp,updated_at:stamp,deadline:prior.cutoff,
    project_evidence:{...oldMission.project_evidence,organizationNodeId:root.id,previousMissionId:null,
     providerContinuationWindow:provider.window_id,
     providerContinuationRelease:provider.continuation_release_sha,
     providerContinuationDecision:provider.continuation_decision_id},
    team:[{id:root.agent_id,config:root.config}]};
   const j={...oldJob,id:assignment,mission_id:mission,status:blocked?'failed':'completed',
    attempts:1,lease:null,lease_until:null,heartbeat_at:null,
    result:blocked?{detail:OVERFLOW,diagnostic:{stage:'work',errorType:'Error',acceptedIssue:false}}:{output:'Management decision recorded',decisionId:decision},
    detail:blocked?OVERFLOW:null,role:'work',job_key:'plan',agent_id:root.agent_id,
    payload:{organizationNodeId:root.id},created_at:'1799-01-01T00:00:00Z',
    available_at:'1800-01-01T00:00:00Z',updated_at:stamp};
   await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[m]);
   await db.query('update work_projects set active_mission_id=$2 where id=$1',[project,mission]);
   await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[j]);
   await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[assignment,root.id]);
   if(!blocked)await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,$5)",[decision,project,root.id,assignment,stamp]);
   latest={mission,assignment};
  }
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,95);
  await db.query('update project_organization_nodes set decision_needed=true where id=$1',[root.id]);
  await db.query("update work_projects set status='blocked',detail=$2,active_mission_id=$3,lease=null,lease_until=null,progress_since=clock_timestamp()-interval '1 minute' where id=$1",[project,BLOCKED,latest.mission]);
  const before=(await db.query('select to_jsonb(j) j from mission_assignments j where id=$1',[latest.assignment])).rows[0].j;
  const originalReceipt=(await db.query('select md5(to_jsonb(r)::text) h from project_context_retest_receipts r where project_id=$1',[project])).rows[0].h;
  const migration=readFileSync('supabase/migrations/20261124161000_management_failure_retest.sql','utf8')
   .replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'')
   .replace(/ IF \(SELECT md5\(prosrc\)[\s\S]*?THEN RAISE EXCEPTION 'Unexpected installed exact-release admission source'; END IF;/,'');
  assert.doesNotMatch(migration,/Unexpected installed exact-release admission source/);
  await db.query(migration);
  await db.query('set role service_role');
  assert.equal((await db.query('select project_org_management_failure_retest_claim_authorized($1,$2,$3,$4) ok',[project,release,generation,deployment])).rows[0].ok,false);
  const offer=(await db.query('select project_org_management_failure_retest_offer($1,$2,$3) o',[owner,project,release])).rows[0].o;
  assert.equal(offer.stage,'authorize');assert.equal(offer.historicalMissions,95);
  assert.equal(offer.missionId,latest.mission);assert.equal(offer.assignmentId,latest.assignment);
  assert.equal(offer.originalCalls,0);assert.equal(offer.originalAttempts,1);
  const auth=randomUUID(),args=[owner,project,release,generation,deployment,latest.mission,latest.assignment,auth,offer.stateHash,'b'.repeat(64),47152];
  const approval='select project_org_management_failure_retest_authorize($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r';
  const deny=async(values)=>{
   await db.query('savepoint management_denied');
   try{await assert.rejects(db.query(approval,values));}
   finally{await db.query('rollback to savepoint management_denied');await db.query('release savepoint management_denied');}
  };
  await deny([randomUUID(),...args.slice(1)]);
  await deny(args.map((v,i)=>i===2?'f'.repeat(40):v));
  await deny(args.map((v,i)=>i===8?'e'.repeat(64):v));
  await deny(args.map((v,i)=>i===10?48001:v));
  const authorized=(await db.query(approval,args)).rows[0].r;
  assert.equal(authorized.stage,'authorized');assert.equal(authorized.originalAttempts,1);
  await deny(args);
  await db.query('reset role');
  const receipt=(await db.query('select * from project_management_failure_retest_receipts where project_id=$1',[project])).rows[0];
  assert.equal(receipt.source_assignment_id,latest.assignment);
  assert.deepEqual(receipt.original_assignment_result,before.result);
  assert.equal(receipt.original_assignment_detail,before.detail);
  assert.equal((await db.query('select md5(to_jsonb(r)::text) h from project_context_retest_receipts r where project_id=$1',[project])).rows[0].h,originalReceipt);
  assert.equal((await db.query('select attempts from mission_assignments where id=$1',[latest.assignment])).rows[0].attempts,1);
  assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'running');
  await db.query('set role service_role');
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation,deployment])).rows[0].ok,true);
  await db.query('reset role');
  await db.query("update mission_assignments set available_at=clock_timestamp()+interval '20 minutes',lease_until=clock_timestamp()-interval '1 second' where id<>$1 and status='running' and lease_until>clock_timestamp()",[latest.assignment]);
  await db.query("update mission_assignments set available_at=clock_timestamp()+interval '20 minutes' where id<>$1 and status in ('queued','waiting_external') and available_at<=clock_timestamp()",[latest.assignment]);
  await db.query('set role service_role');
  const claimed=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) v',[release,generation,deployment])).rows[0].v;
  assert.equal(claimed?.job?.id,latest.assignment);
  assert.equal(claimed.job.attempts,2);
  assert.ok(claimed.job.lease);
  assert.notEqual((await db.query('select claim_mission_work_release_epoch($1,$2,$3) v',[release,generation,deployment])).rows[0].v?.job?.id,latest.assignment);
  console.log('MANAGEMENT95_SIGNED_RETEST_NATIVE_PASS: 95/96 history, distinct owner approval, no duplicate claims, one saved assignment lease');
 }finally{
  await db.query('rollback to savepoint management_retest95');
  await db.query('release savepoint management_retest95');
  await db.query('reset role');
 }
}
