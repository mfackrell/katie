import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const OVERFLOW='Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.';
const BLOCKED='Project management cannot achieve its objective within bounded retry authority';

export async function assertContext90RetestNative(db,{
 project,owner,release,generation,deployment,root,finalNext,finish
}){
 await db.query('savepoint owner_context_90');
 try{
  // Preserve the original 84 recovery, its two genuine scheduler successors,
  // and their accepted evidence. All additional fixture rows are disposable.
  await finish(finalNext.mission_id,finalNext.id,finalNext.project_evidence.organizationNodeId);
  await db.query('reset role');
  const base=(await db.query('select to_jsonb(m) source from agent_missions m where m.id=$1',[finalNext.mission_id])).rows[0].source;
  const baseJob=(await db.query('select to_jsonb(j) source from mission_assignments j where j.id=$1',[finalNext.id])).rows[0].source;
  const sourceCount=(await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n;
  assert(sourceCount<90&&sourceCount>=85,'Expected original native mission chain before current-context fixture');
  const firstReal=(await db.query('select * from project_bounded_recovery_receipts where project_id=$1',[project])).rows[0];
  assert.ok(firstReal?.authorization_id,'The original owner window must exist before another retest');
  const provider=(await db.query('select * from project_provider_execution where project_id=$1',[project])).rows[0];
  assert.equal(provider.window_id,firstReal.window_id);
  let selected=null;
  for(let ordinal=sourceCount;ordinal<90;ordinal++){
   const latest=ordinal===89,mission=randomUUID(),assignment=randomUUID(),decision=randomUUID();
   const timestamp=new Date(Date.now()+(ordinal-sourceCount+2)*1000).toISOString();
   const m={...base,id:mission,project_kind:'management',team:[{id:root.agent_id,config:root.config}],status:latest?'blocked':'completed',
    calls:latest?0:1,actual_tokens:0,reserved_tokens:0,result:latest?null:'Management decisions committed',
    detail:latest?OVERFLOW:null,deadline:firstReal.cutoff,
    created_at:timestamp,updated_at:timestamp,
    project_evidence:{...base.project_evidence,previousMissionId:null,
     organizationNodeId:root.id,
     providerContinuationWindow:provider.window_id,
     providerContinuationRelease:provider.continuation_release_sha,
     providerContinuationDecision:provider.continuation_decision_id}};
   const j={...baseJob,id:assignment,mission_id:mission,
    status:latest?'failed':'completed',attempts:1,lease:null,lease_until:null,
    heartbeat_at:null,agent_id:root.agent_id,role:'work',job_key:'plan',
    result:latest?{detail:OVERFLOW,diagnostic:{stage:'work',errorType:'Error',acceptedIssue:false}}:
       {output:'Management decision recorded',decisionId:decision},
    detail:latest?OVERFLOW:null,payload:{organizationNodeId:root.id},
    available_at:'1800-01-01T00:00:04Z',created_at:latest?'1799-01-01T00:00:00Z':'1800-01-01T00:00:01Z',
    updated_at:timestamp};
   await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[m]);
   // The existing management-agent guard only admits an authentic active
   // management mission. Real scheduling installs this binding before the job.
   await db.query('update work_projects set active_mission_id=$2 where id=$1',[project,mission]);
   await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[j]);
   await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[assignment,root.id]);
   if(!latest)await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,$5)",[decision,project,root.id,assignment,timestamp]);
   else selected={mission,assignment,original:JSON.parse(JSON.stringify(j)),time:timestamp};
  }
  assert.ok(selected);
  await db.query('update project_organization_nodes set decision_needed=true where id=$1',[root.id]);
  await db.query("update work_projects set status='blocked',detail=$3,active_mission_id=$2,lease=null,lease_until=null,progress_since=clock_timestamp()-interval '5 minutes',updated_at=clock_timestamp() where id=$1",[project,selected.mission,BLOCKED]);
  await db.query("insert into project_events(project_id,event,data) values($1,'block',$2)",[project,{detail:BLOCKED,sourceMissionId:selected.mission}]);
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,90);
  const baseline=(await db.query('select to_jsonb(j) value from mission_assignments j where j.id=$1',[selected.assignment])).rows[0].value;
  // Only the baseline MD5 guard is removed in disposable PostgreSQL:
  // earlier fixture substitutions of the original owner changed function text.
  // The exact production migration retains its strict MD5 preimage guard.
  const script=readFileSync('supabase/migrations/20261123230000_management_context_one_retest.sql','utf8')
   .replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'')
   .replace(/\s*COMMIT;\s*$/i,'')
   .replace(/ IF \(SELECT md5\(prosrc\)[\s\S]*?THEN RAISE EXCEPTION 'Unexpected installed exact-release worker admission definition'; END IF;/,'');
  assert.doesNotMatch(script,/Unexpected installed exact-release worker admission definition/);
  await db.query(script);
  await db.query('set role service_role');
  assert.equal((await db.query('select project_org_context_retest_claim_authorized($1,$2,$3,$4) ok',[project,release,generation,deployment])).rows[0].ok,false);
  const offer=(await db.query('select project_org_context_retest_offer($1,$2,$3) offer',[owner,project,release])).rows[0].offer;
  assert.equal(offer.stage,'authorize');assert.equal(offer.historicalMissions,90);
  assert.equal(offer.missionId,selected.mission);assert.equal(offer.assignmentId,selected.assignment);
  assert.equal(offer.originalAttempts,1);assert.equal(offer.originalCalls,0);
  assert.equal(offer.maxMissions,96);assert.equal(offer.tokenAllowance,600000);
  const authorization=randomUUID(),contextHash='b'.repeat(64),contextChars=43725;
  const args=[owner,project,release,generation,deployment,selected.mission,selected.assignment,authorization,offer.stateHash,contextHash,contextChars];
  const approval='select project_org_context_retest_authorize($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result';
  const denied=async(change)=>{
    await db.query('savepoint ctx_neg');
    try{await assert.rejects(db.query(approval,change));}
    finally{await db.query('rollback to savepoint ctx_neg');await db.query('release savepoint ctx_neg');}
  };
  await denied([randomUUID(),...args.slice(1)]);
  await denied(args.map((x,i)=>i===2?'f'.repeat(40):x));
  await denied(args.map((x,i)=>i===8?'c'.repeat(64):x));
  await denied(args.map((x,i)=>i===10?48001:x));
  await db.query('reset role'); // Secret receipt is inaccessible to service_role by design.
  assert.equal((await db.query('select count(*)::int n from project_context_retest_receipts where project_id=$1',[project])).rows[0].n,0);
  const previousProgress=(await db.query('select progress_since from work_projects where id=$1',[project])).rows[0].progress_since;
  await db.query('set role service_role');
  const approved=(await db.query(approval,args)).rows[0].result;
  assert.equal(approved.stage,'authorized');
  assert.equal(approved.historicalMissions,90);
  assert.equal(approved.originalAttempts,1);
  await db.query('reset role'); // Read immutable private receipt only as the fixture DBA.
  const approvedRow=(await db.query('select * from project_context_retest_receipts where project_id=$1',[project])).rows[0];
  assert.equal(approvedRow.source_assignment_id,selected.assignment);
  assert.deepEqual(approvedRow.original_assignment_result,baseline.result);
  assert.equal(approvedRow.original_assignment_detail,baseline.detail);
  assert.equal(approvedRow.prior_attempts,1);
  assert.equal((await db.query('select attempts from mission_assignments where id=$1',[selected.assignment])).rows[0].attempts,1);
  const projectState=(await db.query('select status,progress_since from work_projects where id=$1',[project])).rows[0];
  assert.equal(projectState.status,'running');
  assert(projectState.progress_since>previousProgress);
  await db.query('set role service_role');
  await denied(args);
  await db.query('reset role');
  assert.equal((await db.query('select count(*)::int n from project_context_retest_receipts where project_id=$1',[project])).rows[0].n,1);
  await db.query('set role service_role');
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation,deployment])).rows[0].ok,true);
  await db.query('reset role');
  // Fixture-only queue prioritization: earlier synthetic queued workers must
  // not hide the verified original claimant. No production scheduler mutation.
  await db.query("update mission_assignments set available_at=clock_timestamp()+interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id<>$1 and status='running' and lease_until>clock_timestamp()",[selected.assignment]);
  await db.query("update mission_assignments set available_at=clock_timestamp()+interval '15 minutes' where id<>$1 and status in ('queued','waiting_external') and available_at<=clock_timestamp()",[selected.assignment]);
  await db.query('set role service_role');
  const claim=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) claim',[release,generation,deployment])).rows[0].claim;
  assert.equal(claim?.job?.id,selected.assignment,'Unchanged global scheduler must lease actual original retry');
  assert.equal(claim.job.attempts,2,'Exactly one additional attempt');
  assert.ok(claim.job.lease);
  assert.notEqual((await db.query('select claim_mission_work_release_epoch($1,$2,$3) claim',[release,generation,deployment])).rows[0].claim?.job?.id,selected.assignment);
  console.log('MISSION_CONTEXT90_NATIVE_PASS: 90/96 immutable history, owner/window/release negatives, one signed receipt, watchdog refresh, global scheduler one lease at attempts2');
  if(process.env.KATIE_TEST_FOLLOWUP_M95==='1'){
   const {assertFollowupManagementNative}=await import('./assert-management-followup-native.mjs');
   await assertFollowupManagementNative(db,{project,owner,release,generation,deployment,
    firstMission:selected.mission,firstAssignment:selected.assignment});
  }
 } finally {
  await db.query('rollback to savepoint owner_context_90');
  await db.query('release savepoint owner_context_90');
  await db.query('reset role');
 }
}
