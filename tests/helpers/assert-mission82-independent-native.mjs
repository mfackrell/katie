import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

// Isolated native PostgreSQL 16 fixture. The real M79/M80 lineage is built by
// existing tests. M81 and root M82 are synthetic test rows inside SAVEPOINT,
// not production decisions or provider calls.
export async function assertMission82IndependentNative(db,{project,m80,j80,owner,release,generation,deployment}){
 const M81='2d01badf-7d42-4935-93ff-187d7c8d032e';
 const J81='4a79cc8c-11a8-4552-bf24-be581b59dfe9';
 const M82='53f28eed-631a-4e7e-b868-7b36a34be616';
 const J82='0e358d94-6f36-4607-998f-e603646d33de';
 const predicate='select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok';
 const rejection={detail:'Correct SMART fields against the contract schema: smart.parentObjective',managementCommandRejection:{
  code:'smart_contract_fields',action:'assign',position:1,
  reason:'Correct SMART fields against the contract schema: smart.parentObjective',
  targets:[],priorAppointments:0,smartFields:['smart.parentObjective'],
  proposalHash:'23e66ac02e8115571ef09bdb191a6d2543068a2304cbf0cdd8bd5a1237f109f5'}};
 await db.query('savepoint mission82_native');
 try{
  await db.query('reset role');
  const m80row=(await db.query('select to_jsonb(m) r from agent_missions m where id=$1',[m80])).rows[0].r;
  const j80row=(await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[j80])).rows[0].r;
  assert.equal(m80row.status,'completed');assert.equal(j80row.status,'completed');
  const d80=(await db.query('select created_at from project_organization_decisions where assignment_id=$1',[j80])).rows[0];
  assert.ok(d80?.created_at,'Accepted original M80 management decision required');
  const root=(await db.query("select n.id,n.agent_id,a.config from project_organization_nodes n join managed_agents a on a.id=n.agent_id where n.project_id=$1 and n.kind='project_director'",[project])).rows[0];
  const game=(await db.query("select n.id,n.agent_id,a.config from project_organization_nodes n join managed_agents a on a.id=n.agent_id where n.project_id=$1 and n.area='game_delivery' and n.management_level='functional_director'",[project])).rows[0];
  assert.ok(root?.id&&game?.id&&root.id!==game.id,'Original root and Game Delivery director required');
  const t0=Date.parse(d80.created_at),t81=new Date(t0+5000),tE=new Date(t0+6000),
   t82=new Date(t0+7000),tBlock=new Date(t0+8000);
  let oldFailures=(await db.query("select count(*)::int n from agent_missions where project_id=$1 and project_evidence->>'organizationNodeId'=$2 and status in ('blocked','stopped')",[project,game.id])).rows[0].n;
  if(oldFailures<1){
   const candidate=(await db.query("select id from agent_missions where project_id=$1 and project_evidence->>'organizationNodeId'=$2 and id<>$3 order by created_at limit 1",[project,game.id,m80])).rows[0];
   if(candidate){
    await db.query("update agent_missions set status='blocked' where id=$1",[candidate.id]);
    oldFailures=1;
   }
  }
  assert.ok(oldFailures>=1,'The bounded director escalation requires two failures including M81');
  const source={...m80row,id:M81,status:'blocked',calls:1,actual_tokens:0,result:null,
   detail:rejection.detail,created_at:t81.toISOString(),updated_at:t81.toISOString(),
   project_evidence:{...m80row.project_evidence,organizationNodeId:game.id,previousMissionId:null},
   team:[{id:game.agent_id,config:game.config}]};
  await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[source]);
  await db.query('update work_projects set active_mission_id=$2 where id=$1',[project,M81]);
  const badJob={...j80row,id:J81,mission_id:M81,agent_id:game.agent_id,
   status:'failed',attempts:1,lease:null,lease_until:null,heartbeat_at:null,
   result:rejection,detail:rejection.detail,payload:{organizationNodeId:game.id},
   created_at:'1800-01-01T00:00:02Z',updated_at:t81.toISOString(),
   available_at:'1800-01-01T00:00:02Z'};
  await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[badJob]);
  await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[J81,game.id]);
  await db.query("insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail,status,created_at) values($1,$2,$3,'objective','Management session failed twice; saved decisions and charges retained.','open',$4)",[project,game.id,root.id,tE]);
  await db.query('update project_organization_nodes set decision_needed=(id=$1) where id in ($1,$2)',[root.id,game.id]);
  const leader={...m80row,id:M82,status:'running',calls:0,actual_tokens:0,
   detail:null,result:null,created_at:t82.toISOString(),updated_at:t82.toISOString(),
   project_evidence:{...m80row.project_evidence,organizationNodeId:root.id,previousMissionId:null},
   team:[{id:root.agent_id,config:root.config}]};
  await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[leader]);
  await db.query("update work_projects set active_mission_id=$2,status='running' where id=$1",[project,M82]);
  const newJob={...j80row,id:J82,mission_id:M82,agent_id:root.agent_id,
   status:'queued',attempts:0,lease:null,lease_until:null,heartbeat_at:null,result:null,detail:null,
   payload:{organizationNodeId:root.id},created_at:'1800-01-01T00:00:03Z',
   updated_at:t82.toISOString(),available_at:'1800-01-01T00:00:03Z'};
  await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[newJob]);
  await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[J82,root.id]);
  await db.query('set role service_role');
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,82);
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,false,'Original predecessor-success rejects M82 after failed M81');
  await db.query('reset role');
  const patch=readFileSync('supabase/migrations/20261121195500_mission82_independent_continuation.sql','utf8')
   .replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
  await db.query(patch);
  await db.query('set role service_role');
  assert.equal((await db.query('select project_org_mission82_independent_escalation($1) ok',[project])).rows[0].ok,true);
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,true);
  for(const [sha,epoch,dep] of [['f'.repeat(40),generation,deployment],[release,generation+1,deployment],[release,generation,'dpl_WrongRelease']])
   assert.equal((await db.query(predicate,[project,sha,epoch,dep])).rows[0].ok,false);
  const invalid=async(sql)=>{
   await db.query('savepoint mission82_negative');
   try{
    await db.query('reset role');
    let immutableDenial=null;
    try{await db.query(sql);}catch(error){immutableDenial=error;}
    if(immutableDenial){
     // Existing management/hierarchy guards can reject historical mutation
     // before the new release predicate runs; this is stronger fail-closed.
     assert.match(immutableDenial.message,/Management agents cannot execute technical assignments|immutable|not allowed|cannot change|permission denied/i);
    }else{
     await db.query('set role service_role');
     assert.equal((await db.query('select project_org_mission82_independent_escalation($1) ok',[project])).rows[0].ok,false);
    }
   }finally{
    await db.query('rollback to savepoint mission82_negative');
    await db.query('release savepoint mission82_negative');
    await db.query('set role service_role');
   }
  };
  await invalid("delete from project_organization_exceptions where project_id='"+project+"' and origin_id='"+game.id+"' and owner_id='"+root.id+"' and reason='objective' and detail='Management session failed twice; saved decisions and charges retained.'");
  await invalid("update mission_assignments set result='{}'::jsonb where id='"+J81+"'");
  await invalid("update mission_assignments set attempts=1 where id='"+J82+"'");
  const badSnapshot=(await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[J81])).rows[0].r;
  const goodSnapshot=(await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[j80])).rows[0].r;
  // Exercise the original 45-minute project watchdog and its locked transition.
  const lease1=randomUUID();
  await db.query('reset role');
  await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,lease1]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) ok",[project,lease1])).rows[0].ok,true);
  const lease2=randomUUID();
  await db.query('reset role');
  await db.query("update work_projects set progress_since=clock_timestamp()-interval '46 minutes',lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,lease2]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) ok",[project,lease2])).rows[0].ok,true);
  assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'blocked');
  // Disposable fixture timestamps mimic the actual native committed sequence.
  await db.query('reset role');
  await db.query("update project_events set created_at=$2 where id=(select e.id from project_events e where e.project_id=$1 and e.event='block' and e.data->'impediment'->>'minimumAction' like '%53f28eed-631a-4e7e-b868-7b36a34be616%' order by e.created_at desc limit 1)",[project,tBlock]);
  await db.query('update work_projects set updated_at=$2 where id=$1',[project,tBlock]);
  await db.query('set role service_role');
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,false);
  const offer=(await db.query('select project_org_mission82_watchdog_offer($1,$2,$3) offer',[owner,project,release])).rows[0].offer;
  assert.equal(offer.stage,'recover_watchdog');assert.equal(offer.currentAttempts,0);
  assert.equal(offer.missionId,M82);assert.equal(offer.assignmentId,J82);
  const auth=randomUUID();
  const args=[owner,project,release,M82,J82,auth,offer.cutoff,offer.stateHash,generation,deployment];
  const call='select project_org_mission82_watchdog_recover($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result';
  const deny=async(input,regex)=>{
   await db.query('savepoint mission82_denied');
   try{await assert.rejects(db.query(call,input),regex);}
   finally{await db.query('rollback to savepoint mission82_denied');await db.query('release savepoint mission82_denied');}
  };
  await deny([randomUUID(),...args.slice(1)],/owner|authenticated|release/i);
  await deny([...args.slice(0,8),generation+1,deployment],/preflight|changed/i);
  await deny([...args.slice(0,7),'f'.repeat(64),...args.slice(8)],/preflight|changed/i);
  const approved=(await db.query(call,args)).rows[0].result;
  assert.equal(approved.stage,'recovered');assert.equal(approved.existing,false);
  assert.equal(approved.authorizationId,auth);assert.equal(approved.currentAttempts,0);
  await deny(args,/preflight|changed|consumed/i);
  const parent=(await db.query('select status,progress_since from work_projects where id=$1',[project])).rows[0];
  assert.equal(parent.status,'running');
  assert.ok(Date.now()-Date.parse(parent.progress_since)<150000,'Recovery restarts ordinary 45m watchdog');
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,true);
  const lease3=randomUUID();
  await db.query('reset role');
  await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,lease3]);
  await db.query('set role service_role');
  assert.equal((await db.query("select finish_work_project($1,$2,'wait','{}'::jsonb) ok",[project,lease3])).rows[0].ok,true);
  assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'running');
  const claim=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.equal(claim?.job?.id,J82,'Only normal scheduler leases saved M82');
  assert.equal(claim.job.attempts,1);assert.ok(claim.job.lease);
  assert.equal((await db.query(predicate,[project,release,generation,deployment])).rows[0].ok,false);
  const second=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) c',[release,generation,deployment])).rows[0].c;
  assert.notEqual(second?.job?.id,J82,'Duplicate claim denied');
  assert.deepEqual((await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[J81])).rows[0].r,badSnapshot);
  assert.deepEqual((await db.query('select to_jsonb(j) r from mission_assignments j where id=$1',[j80])).rows[0].r,goodSnapshot);
  const limits=(await db.query('select max_missions,token_allowance from work_projects where id=$1',[project])).rows[0];
  assert.equal(limits.max_missions,96);assert.equal(limits.token_allowance,600000);
  assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
  console.log('MISSION82_NATIVE_PASS: authentic 81 failure preserved; independent root exception; negative unauthorized successor; real watchdog; one owner receipt; global scheduler one lease');
 }finally{
  await db.query('rollback to savepoint mission82_native');
  await db.query('release savepoint mission82_native');
  await db.query('set role service_role');
 }
}
