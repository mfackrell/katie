import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

export async function assertProviderProjectContinuation(db,rival,{project,owner,cutoff,release,recovery,job}){
 const sql=async(c,q,args)=>(await c.query(q,args)).rows[0]?.value;
 const decision=await sql(db,'select id value from project_organization_decisions where assignment_id=$1',[job.id]);
 const nextRelease='c'.repeat(40);
 const admit=(c=db,who=owner,pid=project.id,sha=nextRelease,did=decision,end=cutoff)=>sql(c,
  'select project_provider_continue($1,$2,$3,$4,$5) value',[who,pid,sha,did,end]);
 const snapshot=async()=>{
  await db.query('reset role');
  const value=(await db.query(`select
   (select jsonb_agg(to_jsonb(m) order by id) from agent_missions m where project_id=$1) missions,
   (select jsonb_agg(to_jsonb(j) order by j.id) from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1) assignments,
   (select jsonb_agg(to_jsonb(q) order by id) from project_provider_requests q where project_id=$1) requests,
   (select to_jsonb(r) from project_director_recoveries r where project_id=$1) recovery`,[project.id])).rows[0];
  await db.query('set role service_role');return value;
 };
 const before=await snapshot();
 await assert.rejects(admit(db,randomUUID()),/Authenticated provider project owner/);
 await assert.rejects(admit(db,owner,randomUUID()),/Authenticated provider project owner/);
 await assert.rejects(admit(db,owner,project.id,'invalid'),/Exact release/);
 await assert.rejects(admit(db,owner,project.id,nextRelease,randomUUID()),/Completed Director decision/);
 for(const end of [new Date(Date.now()-1000).toISOString(),new Date(Date.parse(cutoff)+1000).toISOString()])
  await assert.rejects(admit(db,owner,project.id,nextRelease,decision,end),/Exact release/);
 // An unresolved request blocks continuation, even though the Director decision finished.
 await db.query('reset role');await db.query('begin');
 await db.query(`insert into project_provider_requests(id,project_id,mission_id,assignment_id,worker_id,execution_attempt,operation,request_hash)
 values($1,$2,$3,$4,$5,'pending-fixture','model-list',$6)`,[randomUUID(),project.id,recovery.missionId,job.id,job.agent_id,'f'.repeat(64)]);
 await db.query('set local role service_role');
 await assert.rejects(admit(),/resolved execution required/);await db.query('rollback');await db.query('set role service_role');
 // A failed atomic write does not create authority or resume the project.
 await db.query('begin');await admit();await db.query('rollback');
 assert.equal(await sql(db,'select project_provider_continued($1) value',[project.id]),false);
 assert.equal(await sql(db,'select status value from work_projects where id=$1',[project.id]),'blocked');
 const earlyScheduler=new pg.Client(db.connectionParameters);await earlyScheduler.connect();await earlyScheduler.query('begin');
 try{
 const race=await Promise.all([admit(),admit(rival)]);
 assert.equal(race.filter(x=>!x.existing).length,1);
 assert.equal(race[0].admittedAt,race[1].admittedAt);
 assert.equal(await sql(db,'select project_provider_continued($1) value',[project.id]),true);
 await assert.rejects(admit(db,owner,project.id,release),/Continuation authority changed/);
 assert.deepEqual(await snapshot(),before,'Continuation preserves all historical missions, assignments, requests and consumed recovery');
 await assert.rejects(db.query('update project_provider_execution set continued_at=null'),/permission denied/);
 await db.query('reset role');await db.query('set role authenticated');
 await assert.rejects(admit(),/permission denied/);await db.query('reset role');await db.query('set role service_role');
 // Start the scheduler transaction before admission to reproduce transaction-start
 // timestamps predating the receipt. Membership is marked under the scheduler lock.
 await earlyScheduler.query('set local role service_role');
 const lease=randomUUID();await earlyScheduler.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '5 minutes' where id=$1",[project.id,lease]);
 const scheduled=await sql(earlyScheduler,'select project_org_schedule($1,$2) value',[project.id,lease]);
 assert.ok(scheduled.missionId,'Normal scheduler must select an existing Functional Director');
 const node=await sql(earlyScheduler,'select management_level value from project_organization_nodes where id=$1',[scheduled.nodeId]);
 assert.equal(node,'functional_director');
 assert.equal(await sql(earlyScheduler,'select project_provider_continued_assignment(id) value from mission_assignments where mission_id=$1',[scheduled.missionId]),true);
 assert.equal(await sql(earlyScheduler,'select m.created_at<a.continued_at value from agent_missions m join project_provider_execution a on a.project_id=m.project_id where m.id=$1',[scheduled.missionId]),true);
 await earlyScheduler.query('commit');await db.query('set role service_role');
 await db.query("update mission_assignments set created_at='2000-01-01' where mission_id=$1",[scheduled.missionId]);
 await db.query('begin');
 const stale=await sql(db,'select claim_mission_work_release($1) value',[release]);
 assert.notEqual(stale?.mission.id,scheduled.missionId);await db.query('rollback');
 const claims=await Promise.all([sql(db,'select claim_mission_work_release($1) value',[nextRelease]),sql(rival,'select claim_mission_work_release($1) value',[nextRelease])]);
 const wins=claims.filter(x=>x?.mission.id===scheduled.missionId);assert.equal(wins.length,1,'Exactly one scheduler claims the admitted Functional Director');
 const fd=wins[0].job;
 const request=[fd.id,fd.lease,randomUUID(),'model-list','e'.repeat(64),null,null];
 const provider=(c,args)=>sql(c,'select project_provider_request($1,$2,$3,$4,$5,$6,$7) value',args);
 assert.equal(await provider(db,request),true);
 assert.equal(await provider(rival,[...request.slice(0,2),randomUUID(),...request.slice(3)]),false,'Unresolved provider call stays fenced');
 assert.equal(await provider(db,[...request.slice(0,-1),'fixture resolved receipt']),true);
 assert.equal(await sql(db,'select project_provider_continued_assignment($1) value',[job.id]),false,'Recovery never enters normal execution');
 await assert.rejects(sql(db,"select project_org_decide($1,$2,$3) value",[fd.id,fd.lease,JSON.stringify([{action:'appoint',kind:'manager',managementLevel:'project_director'}])]),/director|appointment|reporting/i);
 assert.equal(await sql(db,'select project_org_decide($1,$2,$3) value',[fd.id,fd.lease,JSON.stringify([...['Researcher','Writer','Reviewer'].map(name=>({action:'appoint',kind:'worker',name,area:'development',objective:'Deliver bounded '+name+' evidence',acceptance:['Reviewed evidence'],tools:['analysis'],tokens:1,deadline:cutoff,paths:[]})),{action:'ready'}])]),true);
 assert.equal(await sql(db,"select commit_mission_work($1,$2,'{\"output\":\"Fixture management decision\"}','[]','completed','completed',null) value",[fd.id,fd.lease]),false,'Management decision already consumed its lease');
 // Seed the existing controller team from the FD's authenticated appointments.
 const team=(await db.query("select agent_id from project_organization_nodes where project_id=$1 and kind='worker' order by name",[project.id])).rows.map(n=>n.agent_id);
 assert.equal(team.length,3);
 await db.query('update work_projects set team=$2 where id=$1',[project.id,team]);
 // Generic software-controller membership is tested separately from the legacy
 // game's specialist pin. Changing a test profile is not a live game proof.
 const controllerLease=randomUUID();
 await db.query("update work_projects set lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[project.id,controllerLease]);
 await assert.rejects(sql(db,"select finish_work_project($1,$2,'child',$3) value",[project.id,controllerLease,{kind:'research',objective:'Review the unchanged approved objective',evidence:{}}]),/Pinned game specialist/);
 await db.query('reset role');await db.query('begin');
 await db.query("update work_projects set profile='software' where id=$1",[project.id]);
 await db.query('set local role service_role');
 assert.equal(await sql(db,"select finish_work_project($1,$2,'child',$3) value",[project.id,controllerLease,{kind:'research',objective:'Review the unchanged approved objective',evidence:{}}]),true);
 const controllerMission=await sql(db,'select active_mission_id value from work_projects where id=$1',[project.id]);
 const controllerMembership=await sql(db,'select bool_and(project_provider_continued_assignment(id)) value from mission_assignments where mission_id=$1',[controllerMission]);
 assert.equal(controllerMembership,true,'Generic controller-created children enter the same authorized stage');
 await db.query('rollback');await db.query('set role service_role');
 }finally{await earlyScheduler.end();}
 console.log('PROVIDER_PROJECT_CONTINUATION_POSTGRES_PASS: owner admission race, historical preservation, scheduler membership, release binding and provider replay fencing');
}
