import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function assertCommissioningExceptionRecovery(db,{project,s,decide}){
 await db.query('savepoint stranded_commissioning');
 const reject=async(fn,pattern)=>{
  await db.query('savepoint rejected_recovery');
  try{await assert.rejects(fn(),pattern);}finally{await db.query('rollback to savepoint rejected_recovery');await db.query('release savepoint rejected_recovery');}
 };
 try{
  await db.query('reset role');
  await db.query("insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail) values($1,$2,$2,'objective','Synthetic rejected SMART commissioning')",[project,s.node]);
  await db.query('set role service_role');
  await reject(()=>decide(s,[{action:'ready'}]),/Ready-only response cannot abandon/);
  await reject(()=>db.query('select project_org_decide_before_exception_recovery($1,$2,$3)',[s.job,s.lease,JSON.stringify([{action:'ready'}])]),/permission denied/);
  await db.query('reset role');
  // Reproduce the saved production shape with the actual predecessor function.
  await db.query('select project_org_decide_before_exception_recovery($1,$2,$3)',[s.job,s.lease,JSON.stringify([{action:'ready'}])]);
  await db.query('update project_organization_nodes set decision_needed=false where project_id=$1',[project]);
  // Fixture sessions share one transaction timestamp. Preserve real chronological
  // ordering explicitly; all synthetic setup is rolled back below.
  await db.query("update agent_missions set created_at=now()-interval '1 hour' where project_id=$1",[project]);
  await db.query("update agent_missions set created_at=now()-interval '1 second' where id=$1",[s.mission]);
  const lease=randomUUID();
  await db.query("update work_projects set lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[project,lease]);
  const frozen=async()=>({
   project:(await db.query('select id,objective,team,spec,approved_hash,approval_hash,max_missions,token_allowance,deadline from work_projects where id=$1',[project])).rows[0],
   nodes:(await db.query("select to_jsonb(n)-'decision_needed' r from project_organization_nodes n where project_id=$1 order by id",[project])).rows,
   decisions:(await db.query('select * from project_organization_decisions where project_id=$1 order by id',[project])).rows,
   exceptions:(await db.query('select * from project_organization_exceptions where project_id=$1 order by id',[project])).rows,
   missions:(await db.query('select * from agent_missions where project_id=$1 order by id',[project])).rows,
  });
  const before=await frozen();
  const databaseState=async()=>{
   const state={};
   for(const {tablename} of (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows){
    state[tablename]=(await db.query('select to_jsonb(t) r from public."'+tablename.replaceAll('"','""')+'" t order by to_jsonb(t)::text')).rows;
   }
   return state;
  };
  const old=(await db.query('select project_org_schedule_before_exception_recovery($1,$2) r',[project,lease])).rows[0].r;
  assert.equal(old.detail,'Functional Director must commission the next approved coding package.');
  assert.deepEqual(await frozen(),before);
  console.log('COMMISSIONING_STRANDED_BEFORE: predecessor leaves saved ready/open-exception state waiting with no mission');
  await db.query('set role service_role');
  await reject(()=>db.query('select project_org_schedule($1,$2)',[project,randomUUID()]),/Project lease required/);
  await reject(()=>db.query('select project_org_schedule($1,$2)',[project,null]),/Project lease required/);
  await reject(()=>db.query('select project_org_schedule_before_exception_recovery($1,$2)',[project,lease]),/permission denied/);
  for(const scenario of ['paused','expired','resolved','later-exception','latest-failed','mission-cap']){
   await db.query('savepoint recovery_negative');await db.query('reset role');
   if(scenario==='paused')await db.query("update work_projects set status='blocked' where id=$1",[project]);
   if(scenario==='expired'){
    // Time-bound fixture setup only. All triggers are restored before RPCs.
    await db.query("set local session_replication_role='replica'");
    await db.query("update work_projects set deadline=now()-interval '1 second' where id=$1",[project]);
    await db.query("set local session_replication_role='origin'");
   }
   if(scenario==='resolved')await db.query("update project_organization_exceptions set status='resolved' where project_id=$1 and owner_id=$2",[project,s.node]);
   if(scenario==='later-exception')await db.query("update project_organization_exceptions set created_at=now()+interval '1 second' where project_id=$1 and owner_id=$2",[project,s.node]);
   if(scenario==='latest-failed'){
    await db.query("set local session_replication_role='replica'");
    await db.query("update mission_assignments set status='failed' where id=$1",[s.job]);
    await db.query("set local session_replication_role='origin'");
   }
   if(scenario==='mission-cap')await db.query('update work_projects set max_missions=(select count(*) from agent_missions where project_id=$1) where id=$1',[project]);
   await db.query('set role service_role');
   if(['paused','expired'].includes(scenario))await reject(()=>db.query('select project_org_schedule($1,$2)',[project,lease]),/Project lease required/);
   else{
    const r=(await db.query('select project_org_schedule($1,$2) r',[project,lease])).rows[0].r;
    assert.equal(r.missionId,undefined,scenario);
    if(scenario==='mission-cap')assert.match(r.blocked,/mission limit/);else assert.equal(r.waiting,true,scenario);
   }
   assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,before.missions.length,scenario);
   await db.query('rollback to savepoint recovery_negative');await db.query('release savepoint recovery_negative');
  }

  // Independent QA: additional coherent saved-ready exclusions.
  for(const scenario of ['actually-paused','expired-lease','null-lease-until','wrong-phase','inactive-node','expired-node','missing-decision','mixed-decision','foreign-exception-owner','mission-not-completed','newer-failed-assignment','invalid-release-membership','invalid-window-membership']){
   await db.query('savepoint qa_recovery_negative');await db.query('reset role');
   await db.query("set local session_replication_role='replica'");
   if(scenario==='actually-paused')await db.query("update work_projects set status='paused' where id=$1",[project]);
   if(scenario==='expired-lease')await db.query("update work_projects set lease_until=now()-interval '1 second' where id=$1",[project]);
   if(scenario==='null-lease-until')await db.query('update work_projects set lease_until=null where id=$1',[project]);
   if(scenario==='wrong-phase')await db.query("update work_projects set phase='research' where id=$1",[project]);
   if(scenario==='inactive-node')await db.query("update project_organization_nodes set status='accepted' where id=$1",[s.node]);
   if(scenario==='expired-node')await db.query("update project_organization_nodes set deadline=now()-interval '1 second' where id=$1",[s.node]);
   if(scenario==='missing-decision')await db.query('delete from project_organization_decisions where assignment_id=$1',[s.job]);
   if(scenario==='mixed-decision')await db.query("update project_organization_decisions set decision='[{\"action\":\"ready\"},{\"action\":\"plan\"}]' where assignment_id=$1",[s.job]);
   if(scenario==='foreign-exception-owner')await db.query("update project_organization_exceptions set owner_id=(select parent_id from project_organization_nodes where id=$2) where project_id=$1 and owner_id=$2",[project,s.node]);
   if(scenario==='mission-not-completed')await db.query("update agent_missions set status='blocked' where id=$1",[s.mission]);
   if(scenario==='invalid-release-membership')await db.query("update project_provider_execution set continuation_release_sha=repeat('f',40) where project_id=$1",[project]);
   if(scenario==='invalid-window-membership')await db.query('update project_provider_execution set window_id=$2 where project_id=$1',[project,randomUUID()]);
   if(scenario==='newer-failed-assignment'){
    const mid=randomUUID(),jid=randomUUID();
    await db.query("insert into agent_missions select (jsonb_populate_record(null::agent_missions,to_jsonb(m)||jsonb_build_object('id',$2::uuid,'status','blocked','created_at',now()+interval '1 second'))).* from agent_missions m where id=$1",[s.mission,mid]);
    await db.query("insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,to_jsonb(j)||jsonb_build_object('id',$2::uuid,'mission_id',$3::uuid,'status','failed','lease',null,'lease_until',null,'created_at',now()+interval '1 second'))).* from mission_assignments j where id=$1",[s.job,jid,mid]);
    await db.query("insert into project_organization_assignments select $2,node_id,contract_hash,now()+interval '1 second' from project_organization_assignments where assignment_id=$1",[s.job,jid]);
   }
   await db.query("set local session_replication_role='origin'");await db.query('set role service_role');
   const count=(await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n;
   const invalidMembership=scenario==='invalid-release-membership'||scenario==='invalid-window-membership';
   let membershipState;
   if(invalidMembership){
    await db.query('reset role');
    const authority=(await db.query('select project_provider_continued(a.project_id) continued,project_org_window_authorized(a.project_id,a.owner_id,a.continuation_release_sha,a.continuation_decision_id,a.deadline) authorized from project_provider_execution a where a.project_id=$1',[project])).rows[0];
    assert.deepEqual(authority,{continued:false,authorized:false},scenario);
    membershipState=await databaseState();await db.query('set role service_role');
   }
   await db.query('savepoint qa_call');let outcome;
   try{outcome=(await db.query('select project_org_schedule($1,$2) r',[project,lease])).rows[0].r;}
   catch(e){await db.query('rollback to savepoint qa_call');assert.match(e.message,/lease|required|authority|window|phase|expired/i,scenario);}
   await db.query('release savepoint qa_call');
   assert.equal(outcome?.missionId,undefined,scenario+': no recovery mission');
   assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,count,scenario);
   if(invalidMembership){
    await db.query('reset role');assert.deepEqual(await databaseState(),membershipState,scenario+': zero mutation across every public table');await db.query('set role service_role');
    console.log('COMMISSIONING_INVALID_AUTHORITY_ZERO_MUTATION_PASS: '+scenario);
   }
   await db.query('rollback to savepoint qa_recovery_negative');await db.query('release savepoint qa_recovery_negative');
   console.log('INDEPENDENT_QA_SAVED_READY_NEGATIVE_PASS: '+scenario);
  }
  // Provider authority is applicable only to provider-controlled projects.
  // An ordinary project's saved-ready recovery must still schedule normally.
  await db.query('savepoint ordinary_recovery');await db.query('reset role');
  const ordinaryAuthority=(await db.query('select owner_id,objective_hash from project_provider_execution where project_id=$1',[project])).rows[0];
  await db.query("set local session_replication_role='replica'");
  await db.query('delete from project_provider_execution where project_id=$1',[project]);
  await db.query("set local session_replication_role='origin'");await db.query('set role service_role');
  assert.equal((await db.query('select project_provider_continued($1) continued',[project])).rows[0].continued,false);
  const unauthorizedOrdinary=(await db.query('select project_org_schedule($1,$2) r',[project,lease])).rows[0].r;
  assert.equal(unauthorizedOrdinary.detail,'Project financial authority is required before management inference');
  assert.deepEqual(await frozen(),before,'Ordinary financial authorization remains mandatory');
  await db.query('select project_org_authorize($1,$2,$3,10000000,1000000,false)',[ordinaryAuthority.owner_id,project,ordinaryAuthority.objective_hash]);
  const ordinary=(await db.query('select project_org_schedule($1,$2) r',[project,lease])).rows[0].r;
  assert.equal(ordinary.nodeId,s.node,JSON.stringify(ordinary));assert.ok(ordinary.missionId);
  const ordinaryAfter=await frozen();ordinaryAfter.missions=ordinaryAfter.missions.filter(m=>m.id!==ordinary.missionId);
  assert.deepEqual(ordinaryAfter,before,'Ordinary recovery preserves the same contracts, history, scope and caps');
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,before.missions.length+1);
  await db.query('rollback to savepoint ordinary_recovery');await db.query('release savepoint ordinary_recovery');
  assert.deepEqual(await frozen(),before);
  console.log('COMMISSIONING_ORDINARY_RECOVERY_PASS: no provider authority required for ordinary project; one bounded mission; rollback preserves all history');
  for(const role of ['anon','authenticated']){
   await db.query('reset role');await db.query('set role '+role);
   await reject(()=>db.query('select project_org_schedule($1,$2)',[project,lease]),/permission denied/);
   await reject(()=>db.query('select project_org_decide($1,$2,$3)',[s.job,s.lease,'[]']),/permission denied/);
  }
  await db.query('reset role');await db.query('set role service_role');
  await db.query('savepoint recovery_atomicity');
  assert.ok((await db.query('select project_org_schedule($1,$2) r',[project,lease])).rows[0].r.missionId);
  await db.query('rollback to savepoint recovery_atomicity');await db.query('release savepoint recovery_atomicity');
  assert.deepEqual(await frozen(),before,'Rolled-back recovery retains no mission or history changes');
  assert.equal((await db.query('select count(*)::int n from project_organization_nodes where project_id=$1 and decision_needed',[project])).rows[0].n,0);
  const recovered=(await db.query('select project_org_schedule($1,$2) r',[project,lease])).rows[0].r;
  assert.equal(recovered.nodeId,s.node);assert.ok(recovered.missionId);
  const after=await frozen();after.missions=after.missions.filter(m=>m.id!==recovered.missionId);
  assert.deepEqual(after,before,'Normal recovery preserves all historical rows, contracts, project identity, scope and caps');
  const replay=(await db.query('select project_org_schedule($1,$2) r',[project,lease])).rows[0].r;
  assert.equal(replay.waiting,true);assert.equal(replay.missionId,undefined);
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,before.missions.length+1);
  assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
  console.log('COMMISSIONING_EXCEPTION_RECOVERY_PASS: one normal management mission; replay, stale lease, paused, expired, resolved, later exception, latest failure, mission cap and public ACL protections; history preserved; no worker dispatch');
 }finally{await db.query('rollback to savepoint stranded_commissioning');await db.query('release savepoint stranded_commissioning');await db.query('set role service_role');}
}
