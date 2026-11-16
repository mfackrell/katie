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
