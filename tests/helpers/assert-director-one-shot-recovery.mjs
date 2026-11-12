import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function assertDirectorOneShotRecovery(db,rival){
 const sql=async(c,statement,args)=>(await c.query(statement,args)).rows[0]?.value;
 const [owner,actor,chat,repository]=Array.from({length:4},randomUUID);
 await db.query("insert into actors(id,name,actor_kind) values($1,'Recovery test owner','standard')",[actor]);
 await db.query("insert into chats(id,actor_id,title) values($1,$2,'Recovery test chat')",[chat,actor]);
 await db.query("insert into repo_sync_runs(id,repository_full_name) values($1,'mfackrell/katie')",[repository]);
 await db.query('select standalone_bind_scope($1,$2,$3)',[owner,actor,chat]);
 await db.query('set role service_role');
 const project=await sql(db,'select project_provider_launch($1,$2,$3) value',[owner,actor,chat]);
 const release='a'.repeat(40),otherRelease='b'.repeat(40);
 let cutoff=new Date(Date.now()+10*60*1000).toISOString();
 const admit=(c=db,who=owner,id=project.id,sha=release,end=cutoff)=>
  sql(c,'select project_admit_director_recovery($1,$2,$3,$4) value',[who,id,sha,end]);
 const renew=(c,who,prior,end=cutoff,sha=release)=>
  sql(c,'select project_admit_expired_director_recovery($1,$2,$3,$4,$5) value',[who,project.id,sha,prior,end]);
 const deadlines=()=>sql(db,"select jsonb_build_array(p.deadline,a.deadline) value from work_projects p join project_provider_execution a on a.project_id=p.id where p.id=$1",[project.id]);
 const claim=(c=db,sha=release)=>sql(c,'select claim_mission_work_release($1) value',[sha]);
 const provider=(c,args)=>sql(c,'select project_provider_request($1,$2,$3,$4,$5,$6,$7) value',args);
 const args=(job,operation)=>[job.id,job.lease,randomUUID(),operation,'d'.repeat(64),null,null];
 const settle=(c,request)=>provider(c,[...request.slice(0,-1),'verified fixture receipt']);
 const schedule=async c=>{
  const lease=randomUUID();
  await c.query("update work_projects set lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[project.id,lease]);
  return sql(c,'select project_org_schedule($1,$2) value',[project.id,lease]);
 };
 const verifyClaim=async mission=>{
  // Give this fixture priority over older unrelated queue entries in this DB.
  await db.query("update mission_assignments set created_at='2000-01-01' where mission_id=$1",[mission]);
  const c=await claim();
  assert.equal(c?.mission.id,mission);
  return c.job;
 };
 const fail=(c,job)=>sql(c,"select commit_mission_work($1,$2,'{\"detail\":\"Management decisions require immediate reporting authority\"}','[]','failed','blocked',null) value",[job.id,job.lease]);
 for(let i=0;i<2;i++){
  const scheduled=await schedule(db);
  const job=await verifyClaim(scheduled.missionId);
  for(const operation of ['model-list','inference']){
   const request=args(job,operation);
   assert.equal(await provider(db,request),true);
   assert.equal(await settle(db,request),true);
  }
  assert.equal(await fail(db,job),true);
  if(i===0)assert.equal((await schedule(db)).waiting,true);
 }
 assert.match((await schedule(db)).blocked,/bounded retry authority/);
 const projectLease=await sql(db,'select lease value from work_projects where id=$1',[project.id]);
 assert.equal(await sql(db,"select finish_work_project($1,$2,'block',$3) value",[project.id,projectLease,{detail:'Bounded retry authority exhausted'}]),true);
 await db.query('reset role');
 const snapshot=async()=> (await db.query(`select
  (select jsonb_agg(to_jsonb(m) order by m.id) from agent_missions m where m.project_id=$1) as missions,
  (select jsonb_agg(to_jsonb(j) order by j.id) from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1) as assignments,
  (select jsonb_agg(to_jsonb(q) order by q.id) from project_provider_requests q where q.project_id=$1) as requests`,[project.id])).rows[0];
 const before=await snapshot();
 assert.deepEqual([before.missions.length,before.assignments.length,before.requests.length],[2,2,4]);
 await db.query('set role service_role');
 await assert.rejects(admit(db,randomUUID()),/Authenticated trial owner/);
 await assert.rejects(admit(db,owner,randomUUID()),/Authenticated trial owner/);
 await assert.rejects(admit(db,owner,project.id,'invalid'),/Exact release/);
 for(const end of [new Date(Date.now()-1000).toISOString(),new Date(Date.now()+3*60*60*1000).toISOString()])
  await assert.rejects(admit(db,owner,project.id,release,end),/within the existing trial deadline/);
 await assert.rejects(db.query('delete from project_director_recoveries'),/permission denied/);
 await assert.rejects(db.query('select project_org_schedule_before_director_recovery($1,$2)',[project.id,projectLease]),/permission denied/);
 await assert.rejects(db.query("select project_org_decide_before_director_recovery($1,$2,'[]')",[randomUUID(),randomUUID()]),/permission denied/);
 await assert.rejects(db.query("select project_provider_request_before_director_recovery($1,'x',$2,'inference',$3)",[randomUUID(),randomUUID(),'d'.repeat(64)]),/permission denied/);
 const originalCutoffs=await deadlines();
 await assert.rejects(renew(db,owner,originalCutoffs[0]),/Exact expired cutoff/);
 await db.query('begin');
 try{
  assert.equal((await admit()).existing,false,'Original unexpired admission still works');
 }finally{await db.query('rollback');}

 // Expire only the fixture's original project/provider deadline. Leave its
 // failed attempts, provider receipts and Director authority unchanged.
 await db.query('reset role');
 const prior=await sql(db,"update project_provider_execution set deadline=now()-interval '1 minute' where project_id=$1 returning deadline::text value",[project.id]);
 await db.query('update work_projects set deadline=$2 where id=$1',[project.id,prior]);
 await db.query('set role service_role');
 const expired=await deadlines();
 cutoff=new Date(Date.now()+23*60*60*1000).toISOString();
 await assert.rejects(admit(),/within the existing trial deadline/);
 await assert.rejects(renew(db,randomUUID(),prior),/Authenticated trial owner/);
 await assert.rejects(renew(db,owner,cutoff),/Exact expired cutoff/);
 await assert.rejects(renew(db,owner,prior,prior),/Exact expired cutoff/);
 await assert.rejects(renew(db,owner,prior,new Date(Date.now()+25*60*60*1000).toISOString()),/within twenty-four hours/);
 await assert.rejects(renew(db,owner,prior,cutoff,'invalid'),/Exact release/);
 assert.deepEqual(await deadlines(),expired,'Rejected admission rolls back both deadline writes');
 if(process.env.KATIE_TEST_ORG_AMENDMENTS==='1')cutoff=new Date(Date.now()+15000).toISOString();
 const admissions=await Promise.all([renew(db,owner,prior),renew(rival,owner,prior)]);
 assert.equal(admissions.filter(r=>!r.existing).length,1);
 const recovery=admissions[0];
 assert.equal(recovery.assignmentId,admissions[1].assignmentId);
 assert.equal(recovery.missionId,admissions[1].missionId);
 const renewal=(await db.query('select prior_cutoff,cutoff from project_director_recoveries where project_id=$1',[project.id])).rows[0];
 assert.equal(renewal.prior_cutoff.toISOString(),new Date(prior).toISOString());
 assert.equal(renewal.cutoff.toISOString(),cutoff);
 assert.deepEqual((await deadlines()).map(d=>new Date(d).toISOString()),[cutoff,cutoff]);
 await assert.rejects(renew(db,owner,cutoff),/already admitted/);
 await assert.rejects(renew(db,owner,prior,new Date(Date.now()+60000).toISOString()),/already admitted/);
 await assert.rejects(admit(db,owner,project.id,otherRelease),/already admitted/);
 assert.deepEqual(await Promise.all([schedule(db),schedule(rival)]),[{handled:true},{handled:true}]);
 await db.query("update mission_assignments set created_at='2000-01-01' where id=$1",[recovery.assignmentId]);
 await db.query('begin');
 try{
  assert.notEqual((await claim(db,otherRelease))?.job.id,recovery.assignmentId);
  assert.notEqual((await sql(db,'select claim_mission_work() value'))?.job.id,recovery.assignmentId);
 }finally{await db.query('rollback');}
 const claims=await Promise.all([claim(db),claim(rival)]);
 const winner=claims.filter(c=>c?.job.id===recovery.assignmentId);
 assert.equal(winner.length,1);
 const {job}=winner[0];
 assert.equal(job.attempts,1);
 const inference=args(job,'inference');
 const modelList=args(job,'model-list');
 const decide=commands=>sql(db,'select project_org_decide($1,$2,$3::jsonb) value',[job.id,job.lease,JSON.stringify(commands)]);
 const save=async action=>{
  await db.query('begin');
  try{await action();}finally{await db.query('rollback');}
 };
 const crash=async()=>{
  await db.query("update mission_assignments set lease_until=now()-interval '1 second' where id=$1",[job.id]);
  assert.notEqual((await claim())?.job.id,job.id);
  assert.equal(await sql(db,'select status value from mission_assignments where id=$1',[job.id]),'failed');
  assert.equal(await provider(db,inference),false);
 };
 await save(crash); // before any provider reservation
 await save(async()=>{
  assert.equal(await sql(db,"select commit_mission_work($1,$2,'{}','[]','queued',null,null) value",[job.id,job.lease]),true);
  assert.notEqual((await claim())?.job.id,job.id,'Explicit retry cannot claim the consumed assignment');
 });
 assert.equal(await provider(db,inference),false,'Inference needs the same lease model-list receipt');
 assert.equal(await provider(db,modelList),true);
 await save(crash); // after model-list admission, before resolution
 assert.equal(await settle(db,modelList),true);
 assert.equal(await provider(db,args(job,'model-list')),false,'A resolved discovery call cannot be repeated');
 const requests=await Promise.all([provider(db,inference),provider(rival,args(job,'inference'))]);
 assert.equal(requests.filter(Boolean).length,1);
 // Keep the winning identity deterministic for receipt tests below.
 const pending=await sql(db,'select project_provider_request_pending($1) value',[project.id]);
 assert.equal(pending,true);
 await assert.rejects(decide([{action:'ready'}]),/resolved inference required/);
 await save(async()=>{
  assert.equal(await sql(db,'select project_provider_mission_stop($1,$2) value',[job.id,job.lease]),true);
 });
 assert.equal(await provider(rival,args(job,'inference')),false,'Rolled back stop cannot reopen a pending request');
 await save(crash); // after inference admission, before receipt
 await db.query('reset role');
 const admitted=(await db.query("select id from project_provider_requests where assignment_id=$1 and operation='inference'",[job.id])).rows[0].id;
 await db.query('set role service_role');
 assert.equal(await settle(db,[...inference.slice(0,2),admitted,...inference.slice(3)]),true);
 await save(crash); // after receipt, before decisions are committed
 assert.equal(await provider(rival,args(job,'inference')),false,'Resolved inference still consumes the decision');
 await assert.rejects(decide([{action:'dependency'}]),/Functional Director appointments only/);
 await assert.rejects(decide([{action:'appoint',kind:'worker'}]),/invalid|director|appointment/i);
 const amendments=process.env.KATIE_TEST_ORG_AMENDMENTS==='1';
 const commands=[
  {action:'plan',purpose:'Deliver the original game',direction:'Verify rules independently',
   outcomes:[{criterion:'Playable game',verification:'Browser checks'}],milestones:[{objective:'Build the scoped game'}],organizations:amendments?['development','quality_assurance']:['development']},
  {action:'appoint',kind:'manager',managementLevel:'functional_director',name:'Development',area:'development',
   objective:'Own gameplay implementation',acceptance:['Rules pass'],tokens:20000,deadline:cutoff,paths:[],tools:['manage','analysis']},
  ...(amendments?[{action:'appoint',kind:'manager',managementLevel:'functional_director',name:'Independent QA',area:'quality_assurance',objective:'Verify the original requirements independently',acceptance:['Independent evidence'],tokens:10000,deadline:cutoff,paths:[],tools:['manage','analysis','research','repository_review']}]:[]),
  {action:'ready'},
 ];
 assert.equal(await decide(commands),true);
 await assert.rejects(decide(commands),/Live management assignment required/);
 assert.equal(await sql(db,'select status value from work_projects where id=$1',[project.id]),'blocked');
 assert.equal(await sql(db,"select count(*)::int value from project_organization_nodes where project_id=$1 and management_level='functional_director'",[project.id]),amendments?2:1);
 assert.equal(await sql(db,'select count(*)::int value from project_work_packages where project_id=$1',[project.id]),0);
 await save(async()=>assert.notEqual((await claim())?.job.id,job.id));
 assert.equal((await admit()).assignmentId,job.id);
 await db.query('reset role');
 const after=await snapshot();
 for(const key of ['missions','assignments','requests']){
  const ids=new Set(before[key].map(r=>r.id));
  assert.deepEqual(after[key].filter(r=>ids.has(r.id)),before[key],`Preserve original ${key}`);
 }
 assert.deepEqual([after.missions.length,after.assignments.length,after.requests.length],[3,3,6]);
 await db.query('set role service_role');
 console.log('DIRECTOR_ONE_SHOT_POSTGRES_PASS');
 if(amendments)await (await import('./assert-organizational-contract-amendments.mjs')).assertFirstRenewalAdmission(db,{project,owner,cutoff,job});
 if(amendments){await db.query('reset role');await db.query("update project_organization_nodes set created_at='2000-01-01' where project_id=$1 and area='development' and kind='manager'",[project.id]);await db.query('set role service_role');}
 await (await import('./assert-provider-project-continuation.mjs')).assertProviderProjectContinuation(db,rival,{project,owner,cutoff,release,recovery,job});
 if(amendments)await (await import('./assert-organizational-contract-amendments.mjs')).assertOrganizationalContractAmendments(db,rival,{project,owner,cutoff,release,recovery,job});
}
