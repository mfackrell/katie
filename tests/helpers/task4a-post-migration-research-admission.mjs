import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Run only AFTER all four Task 4A migrations, including the native trigger.
// The surrounding projects-sql harness owns PostgreSQL 16 and its teardown.
export async function verifyPostMigrationResearchAdmission(db){
 const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
 await db.query('reset role');
 await db.query('begin');
 try{
  const pid=randomUUID(),mid=randomUUID(),actor=randomUUID(),chat=randomUUID();
  const team=(await one("select team from work_projects where id='44444444-4444-4444-8444-444444444444'")).team;
  await db.query('insert into actors(id,name) values($1,$2)',[actor,'Post-migration synthetic owner']);
  await db.query('insert into chats(id,actor_id,title) values($1,$2,$3)',[chat,actor,'Post-migration admission']);
  await db.query("insert into work_projects(id,request_id,actor_id,chat_id,objective,team,status,phase,token_allowance,deadline) values($1,$2,$3,$4,'Synthetic research admission', $5,'running','research',600000,now()+interval '8 hours')",[pid,randomUUID(),actor,chat,team]);
  await db.query("select create_mission($1,'Synthetic saved research recovery',$2,120,null)",[mid,team]);
  await db.query("update agent_missions set project_id=$2,project_kind='research',status='running',token_allowance=120000,deadline=now()+interval '4 hours' where id=$1",[mid,pid]);
  await db.query('update work_projects set active_mission_id=$2 where id=$1',[pid,mid]);
  const ids={};
  for(const role of ['compose','review']){
   const row=await one("insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,status,lease,lease_until) values($1,$2,$2,$3,'Synthetic saved work','running',$4,now()+interval '5 minutes') returning id,lease",[mid,role,team[0],randomUUID()]);
   ids[role]=row;
  }
  // The owner decision is represented ONLY by synthetic fixture authority.
  // This transaction is rolled back; no real owner decision is impersonated.
  const auth=await one("insert into project_continuation_authorizations(project_id,actor_id,chat_id,source_mission_id,approval_digest,deadline,incremental_tokens,incremental_calls,incremental_microusd,assessment_reserve_tokens,completion_reserve_tokens,assessment_reserve_calls,completion_reserve_calls,allowed_models,historical_tokens,historical_calls,historical_mission_deadline,pricing_evidence) values($1,$2,$3,$4,$5,now()+interval '3 hours',440326,53,15000000,60000,60000,6,6,ARRAY['openai:gpt-5.6-sol','openai:gpt-5.3-codex'],76519,9,now()-interval '1 hour','[]'::jsonb) returning id",[pid,actor,chat,mid,'a'.repeat(64)]);
  await db.query('set role service_role');
  const reserve=async(role,model='openai:gpt-5.6-sol',tokens=1000,routing=false,id=randomUUID())=>{
   const job=ids[role];
   return (await one('select try_reserve_mission_capacity($1,$2,$3,$4,$5,$6) ok',[job.id,job.lease,id,model,tokens,routing])).ok;
  };
  assert.equal(await reserve('compose','openai:unknown',1000),false,'Unknown model denied');
  assert.equal(await reserve('compose','openai:gpt-5.6-sol',1000,true),true,'Research routing admitted');
  assert.equal(await reserve('compose'),true,'Research provider call admitted');
  assert.equal(await reserve('review'),true,'Independent review provider call admitted');
  assert.equal(await reserve('review','openai:gpt-5.3-codex',1000,true),true,'Review routing admitted');
  const booked=(await db.query('select c.*,j.role from mission_calls c join mission_assignments j on j.id=c.job_id where c.project_continuation_id=$1 order by c.created_at,c.id',[auth.id])).rows;
  assert.equal(booked.length,4,'Routing and provider calls share one canonical ledger');
  assert.deepEqual(new Set(booked.map(c=>c.role)),new Set(['compose','review']));
  for(const c of booked){
   assert.equal(c.project_continuation_id,auth.id);
   assert.ok(Number(c.project_reserved_microusd)>0);
   assert.equal(c.project_pricing_evidence.phase,'research');
   assert.equal(c.project_pricing_evidence.role,c.role);
   assert.ok(c.project_pricing_evidence.verifiedAt);
  }
  const counters=await one('select calls,routing_calls,reserved_tokens from agent_missions where id=$1',[mid]);
  assert.equal(counters.calls,2);assert.equal(counters.routing_calls,2);
  assert.equal(Number(counters.reserved_tokens),4000);
  assert.equal(await reserve('review','openai:unknown'),false,'Unpriced model denied');
  await db.query('reset role');
  await db.query("update model_registry set pricing_status='missing' where provider_name='openai' and model_id='gpt-5.6-sol'");
  await db.query('set role service_role');
  assert.equal(await reserve('review'),false,'Missing verified price denied');
  await db.query('reset role');
  await db.query("update model_registry set pricing_status='verified' where provider_name='openai' and model_id='gpt-5.6-sol'");
  // Mutation of synthetic authority is prohibited after the fourth migration.
  // Exercise ceilings using fresh synthetic authority rows in separate fixtures
  // rather than disabling its immutable trigger.
  const before=await one('select count(*)::int n from mission_calls where project_continuation_id=$1',[auth.id]);
  await db.query('savepoint direct_unmetered');
  await assert.rejects(db.query("insert into mission_calls(id,job_id,lease,model,reserved_tokens) values($1,$2,$3,'openai:gpt-5.6-sol',1000)",[randomUUID(),ids.review.id,ids.review.lease]),/unmetered project call denied/);
  await db.query('rollback to savepoint direct_unmetered');
  await db.query('release savepoint direct_unmetered');
  await db.query('set role service_role');
  assert.equal(await reserve('review','openai:gpt-5.6-sol',120001),false,'Per-call token cap');
  assert.equal(await reserve('review','openai:gpt-5.6-sol',120000),false,'Mission token allowance');
  assert.equal((await one('select count(*)::int n from mission_calls where project_continuation_id=$1',[auth.id])).n,before.n);
  assert.equal((await one('select count(*)::int n from mission_calls where project_continuation_id is null and job_id in ($1,$2)',[ids.compose.id,ids.review.id])).n,0);
  // Existing isolated continuation test covers independent dollar, token,
  // call, deadline and reserve negatives. This adds post-native-trigger coverage.
  console.log('TASK4A_POST_MIGRATION_RESEARCH_ADMISSION_PASS: compose, review, routing, canonical ledger, model, pricing, token, unmetered rejection');
 }finally{
  await db.query('rollback');
  await db.query('reset role');
 }
}
