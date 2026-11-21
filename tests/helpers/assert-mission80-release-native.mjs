import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

// Genuine disposable PostgreSQL 16 fixture, nested under the original
// owner-authorized Mission79 recovery test's rollback-only savepoint.
// No production data or paid model calls are made here.
export async function assertMission80ReleaseNative(db,{project,missionId,assignmentId,release,generation,deployment}){
 const M80='ce8dcc30-e316-49e7-934d-6add6c14a697';
 const J80='3d118a6c-d121-4d65-8c6e-ed5620660b82';
 const predicate='select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok';
 await db.query('savepoint mission80_native');
 try {
  await db.query('reset role');
  const oldMission=(await db.query('select to_jsonb(m) data from agent_missions m where id=$1',[missionId])).rows[0].data;
  const oldJob=(await db.query('select to_jsonb(j) data from mission_assignments j where id=$1',[assignmentId])).rows[0].data;
  const qa=(await db.query(`select n.id,n.agent_id,a.config from project_organization_nodes n
   join managed_agents a on a.id=n.agent_id where n.project_id=$1
   and n.area='independent_qa' and n.management_level='functional_director'
   and n.status='active'`,[project])).rows[0];
  const authority=(await db.query('select * from project_provider_execution where project_id=$1',[project])).rows[0];
  assert.ok(qa?.agent_id&&authority?.window_id,'Original owner-approved QA director must exist');
  const decision=randomUUID();
  // Simulate the actually observed completed attempt-two management result.
  // This is fixture setup, NOT fabricated production inference.
  await db.query(`insert into project_organization_decisions
   (id,project_id,node_id,assignment_id,decision,created_at)
   values($1,$2,$3,$4,'[{"action":"ready"}]'::jsonb,clock_timestamp()+interval '1 second')`,
   [decision,project,oldMission.project_evidence.organizationNodeId,assignmentId]);
  await db.query("update agent_missions set status='completed',calls=2,result='Management decisions committed' where id=$1",[missionId]);
  await db.query("update mission_assignments set status='completed',lease=null,lease_until=null,result=$2 where id=$1",
   [assignmentId,{output:'Management decision recorded',decisionId:decision}]);
  const successor={
   ...oldMission,id:M80,status:'running',calls:0,actual_tokens:0,
   result:null,detail:null,created_at:new Date(Date.now()+2000).toISOString(),
   updated_at:new Date(Date.now()+2000).toISOString(),
   project_kind:'management',
   team:[{id:qa.agent_id,config:qa.config}],
   project_evidence:{
    previousMissionId:null,organizationNodeId:qa.id,
    providerContinuationWindow:authority.window_id,
    providerContinuationDecision:authority.continuation_decision_id,
    providerContinuationRelease:authority.continuation_release_sha
   }
  };
  await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[successor]);
  const job={
   ...oldJob,id:J80,mission_id:M80,agent_id:qa.agent_id,status:'queued',
   attempts:0,lease:null,lease_until:null,heartbeat_at:null,result:null,detail:null,
   payload:{organizationNodeId:qa.id},created_at:'1800-01-01T00:00:00Z',
   updated_at:new Date().toISOString(),available_at:'1800-01-01T00:00:00Z'
  };
  // Genuine project scheduler marks the successor active before inserting the
  // management assignment; mirror that order to satisfy the existing hierarchy guard.
  await db.query('update work_projects set active_mission_id=$2,status=\'running\' where id=$1',[project,M80]);
  await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[job]);
  await db.query('set role service_role');
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,false,
   'Original 79-only release predicate MUST reject the completed Mission79 plus queued Mission80 fixture');
  assert.equal((await db.query('select project_provider_continued_assignment($1) ok',[J80])).rows[0].ok,true);
  await db.query('reset role');
  const migration=readFileSync('supabase/migrations/20261121181500_mission80_release_continuation.sql','utf8')
   .replace(/^\s*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
  await db.query(migration);
  await db.query('set role service_role');
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,true,
   'Original approved project continuation must admit ONLY exact successor under current gate');
  for(const [sha,gen,dep] of [
   ['f'.repeat(40),generation,deployment],
   [release,generation+1,deployment],
   [release,generation,'dpl_WrongIdentity']
  ])assert.equal((await db.query(predicate,[project,sha,gen,dep])).rows[0].ok,false,
   'Wrong release SHA, epoch, or deployment must fail closed');
  const rejectedMutation=async(update)=>{
   await db.query('savepoint mission80_invalid');
   try{
    await db.query('reset role');
    let immutableDenial=null;
    try{await db.query(update);}
    catch(e){immutableDenial=e;}
    if(immutableDenial){
     // Existing immutable source controls may reject mutation before the new
     // release predicate is evaluated. That is the stronger fail-closed case.
     assert.match(immutableDenial.message,/immutable|deadline|owner-approved scope|not allowed/i);
    }else{
     await db.query('set role service_role');
     assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,false);
    }
   }finally{
    await db.query('rollback to savepoint mission80_invalid');
    await db.query('release savepoint mission80_invalid');
    await db.query('set role service_role');
   }
  };
  await rejectedMutation("update agent_missions set project_evidence=project_evidence||'{\"providerContinuationDecision\":\"00000000-0000-0000-0000-000000000000\"}'::jsonb where id='"+M80+"'");
  await rejectedMutation("update work_projects set deadline=clock_timestamp()-interval '1 minute' where id='"+project+"'");
  await rejectedMutation("update work_projects set active_mission_id='"+missionId+"' where id='"+project+"'");
  await rejectedMutation("update mission_assignments set attempts=1 where id='"+J80+"'");
  await db.query('reset role');
  const before=(await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[assignmentId])).rows[0].r;
  const original=(await db.query('select status,calls from agent_missions where id=$1',[missionId])).rows[0];
  assert.deepEqual(original,{status:'completed',calls:2});
  assert.equal(before.status,'completed');assert.equal(before.attempts,2);
  await db.query('set role service_role');
  const claimed=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.equal(claimed?.job?.id,J80,'Only normal scheduler claims original Mission80 assignment');
  assert.equal(claimed?.job?.attempts,1);assert.ok(claimed?.job?.lease);
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,false,
   'Single queued assignment cannot confer reusable claim authority');
  const again=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.notEqual(again?.job?.id,J80,'No duplicate claim after first lease');
  await db.query('reset role');
  const after=(await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[assignmentId])).rows[0].r;
  assert.deepEqual(after,before,'Completed Mission79 receipt and assignment never mutate during Mission80 claim');
  const summary=(await db.query('select max_missions,token_allowance from work_projects where id=$1',[project])).rows[0];
  assert.equal(summary.max_missions,96);assert.equal(summary.token_allowance,600000);
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,80);
  console.log('MISSION80_NATIVE_PASS: original 79-only rejection, bounded owner lineage, exact active release, real scheduler lease once, no retry, no scope or resource change');
 }finally{
  await db.query('rollback to savepoint mission80_native');
  await db.query('release savepoint mission80_native');
  await db.query('set role service_role');
 }
}
