import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const query=(db,sql,values=[])=>db.query(sql,values);
const one=async(db,sql,values=[])=>(await query(db,sql,values)).rows[0];

export async function verifyTask4aContinuationPostgres(db,connect){
 // Disposable isolated PostgreSQL only. Never import or mutate production rows.
 await query(db,'reset role');
 await query(db,'begin');
 const baseline=await one(db,"select * from work_projects where id='44444444-4444-4444-8444-444444444444'");
 assert.ok(baseline,'Project fixture baseline');
 const pilotId='a03df077-9cf9-4e26-a819-fd40535b57e3';
 const pilotActor=randomUUID(),pilotChat=randomUUID(),actor=randomUUID(),chat=randomUUID();
 const pid=randomUUID(),mid=randomUUID(),lease=randomUUID();
 const objective='Create one disposable Task 4A browser application in mfackrell/katie under /project-pilots/task4a-preview-probe; initial state, one button, visible state change. No production publication.';
 const team=baseline.team;
 await query(db,'insert into actors(id,name) values($1,$2),($3,$4)',[pilotActor,'Fixture prior owner',actor,'Fixture original owner']);
 await query(db,'insert into chats(id,actor_id,title) values($1,$2,$3),($4,$5,$6)',[pilotChat,pilotActor,'Prior completed pilot',chat,actor,'Task4A original']);
 await query(db,'insert into work_projects(id,request_id,actor_id,chat_id,objective,team,status,phase,token_allowance) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[
  pilotId,randomUUID(),pilotActor,pilotChat,'Prior two-stage completed browser pilot',team,'completed','assessment',600000
 ]);
 // Four measured fixture missions with 440,326 already billed tokens and
 // 53 total calls (10+3, 10+3, 10+3, 11+3).
 for(const [index,n] of [110000,110000,110000,110326].entries()){
  const id=randomUUID();
  await query(db,'select create_mission($1,$2,$3,120,null)',[id,'Historical comparable fixture',team]);
  await query(db,"update agent_missions set project_id=$2,status='completed',calls=$3,routing_calls=3,actual_tokens=$4,reserved_tokens=$4 where id=$1",[
   id,pilotId,index===3?11:10,n
  ]);
 }
 await query(db,'insert into work_projects(id,request_id,actor_id,chat_id,objective,team,status,phase,token_allowance,deadline,active_mission_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval \'8 hours\',null)',[
  pid,randomUUID(),actor,chat,objective,team,'paused','research',600000
 ]);
 await query(db,'select create_mission($1,$2,$3,120,null)',[mid,'ORIGINAL USER OUTCOME: '+objective+'\nPHASE: Research only. Give research findings in at most 700 words.',team]);
 await query(db,"update agent_missions set project_id=$2,project_kind='research',status='blocked',deadline=now()-interval '2 minutes',actual_tokens=76519,reserved_tokens=76519,calls=4,routing_calls=5 where id=$1",[mid,pid]);
 await query(db,'update work_projects set active_mission_id=$2 where id=$1',[pid,mid]);
 await query(db,"insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index) values($1,$2,'research',1,0)",[pid,mid]);
 await query(db,"update mission_assignments set status='completed',result='{\"text\":\"Saved plan\"}'::jsonb where mission_id=$1 and job_key='plan'",[mid]);
 const saved=JSON.stringify({deliverable:'First line: original source research, relevant routing and Preview protection constraints remain material to the full project.\nSecond line: authentication, source matching and independent review stay mandatory.',composerNotes:'Original material retained'});
 const jobs=[
  ['one','work',team[1],'Source research one','completed',{text:'Saved authoritative first research',sources:[]}],
  ['two','work',team[2],'Source research two','completed',{text:'Saved authoritative second research',sources:[]}],
  ['compose','compose',team[0],'Compose complete original report','queued',{rejectedDeliverableResponse:saved}],
  ['review','review',team[1],'Independent review of report','queued',null]
 ];
 const ids={};
 for(const [key,role,agent,instruction,status,result] of jobs){
  const row=await one(db,"insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,status,result) values($1,$2,$3,$4,$5,$6,$7::jsonb) returning id",[
   mid,key,role,agent,instruction,status,result===null?null:JSON.stringify(result)
  ]);
  ids[key]=row.id;
 }
 // No pending/ambiguous provider calls are allowed into continuation.
 for(let i=0;i<9;i++){
  const n=i===8?8519:8500;
  await query(db,"insert into mission_calls(id,job_id,lease,model,reserved_tokens,actual_tokens,status) values($1,$2,$3,'openai:gpt-5.6-sol',$4,$4,'completed')",[
   randomUUID(),ids.one,lease,n
  ]);
 }
 await query(db,'set role service_role');
 const original=await one(db,'select status,deadline,actual_tokens,reserved_tokens,calls,routing_calls from agent_missions where id=$1',[mid]);
 const notReady=await one(db,'select task4a_continuation_proposal($1) p',[pid]);
 assert.equal(notReady.p.ready,true,'Pinned model verification must be present in this isolated fixture');
 const proposal=notReady.p.proposal;
 assert.equal(Number(proposal.historicalTokens),76519);
 assert.equal(Number(proposal.historicalCalls),9);
 assert.equal(Number(proposal.incrementalTokens),440326);
 assert.equal(Number(proposal.incrementalCalls),53);
 assert.equal(Number(proposal.incrementalDollarCeilingMicrousd),15000000);
 // Old resume is intentionally not permitted to override an expired child.
 await query(db,'savepoint old_resume');
 await assert.rejects(query(db,"select control_work_project($1,$2,$3,'resume')",[pid,actor,chat]),/blocked or expired/);
 await query(db,'rollback to savepoint old_resume');
 await query(db,'release savepoint old_resume');
 await query(db,'savepoint owner_negative');
 await assert.rejects(query(db,"select authorize_task4a_expired_research($1,$2,$3,$4)",[
  pid,randomUUID(),chat,notReady.p.digest]),/paused project|owner identity/);
 await query(db,'rollback to savepoint owner_negative');await query(db,'release savepoint owner_negative');
 await query(db,'savepoint stale_negative');
 await assert.rejects(query(db,"select authorize_task4a_expired_research($1,$2,$3,$4)",[
  pid,actor,chat,'f'.repeat(64)]),/stale/);
 await query(db,'rollback to savepoint stale_negative');await query(db,'release savepoint stale_negative');
 assert.equal((await one(db,'select count(*)::int n from project_continuation_authorizations where project_id=$1',[pid])).n,0);
 const authorization=await one(db,"select authorize_task4a_expired_research($1,$2,$3,$4) a",[
  pid,actor,chat,notReady.p.digest
 ]);
 assert.equal(authorization.a.authorized,true);
 assert.equal(authorization.a.oldMissionId,mid);
 assert.equal(authorization.a.originalTokens,76519);
 const recoveredId=authorization.a.newMissionId;
 const recovered=await one(db,'select * from work_projects where id=$1',[pid]);
 assert.equal(recovered.status,'running');
 assert.equal(recovered.phase,'research');
 assert.equal(recovered.approved_hash,null);
 assert.equal(recovered.token_allowance,600000);
 assert.equal(recovered.active_mission_id,recoveredId);
 assert.equal((await one(db,'select * from agent_missions where id=$1',[mid])).status,'blocked');
 const afterOld=await one(db,'select status,deadline,actual_tokens,reserved_tokens,calls,routing_calls from agent_missions where id=$1',[mid]);
 assert.deepEqual(afterOld,original,'Original mission remains immutable');
 assert.equal((await one(db,'select count(*)::int n from mission_calls where job_id=$1',[ids.one])).n,9);
 assert.equal((await one(db,"select count(*)::int n from mission_assignments where mission_id=$1 and role='work' and status='completed'",[recoveredId])).n,2);
 assert.equal((await one(db,"select result->>'rejectedDeliverableResponse' AS raw from mission_assignments where mission_id=$1 and job_key='compose'",[recoveredId])).raw,saved);
 assert.equal((await one(db,"select status from mission_assignments where mission_id=$1 and job_key='review'",[recoveredId])).status,'queued');
 assert.equal((await one(db,'select count(*)::int n from mission_calls c join mission_assignments j on j.id=c.job_id where j.mission_id=$1',[recoveredId])).n,0);
 await query(db,'savepoint replay_negative');
 await assert.rejects(query(db,"select authorize_task4a_expired_research($1,$2,$3,$4)",[
  pid,actor,chat,notReady.p.digest]),/paused project/);
 await query(db,'rollback to savepoint replay_negative');await query(db,'release savepoint replay_negative');
 // Admit one controlled call and ensure wrong-priced/unknown models are rejected
 // before any mission_calls or token/call counters change.
 const newCompose=await one(db,"select * from mission_assignments where mission_id=$1 and job_key='compose'",[recoveredId]);
 const currentLease=randomUUID();
 await query(db,"update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[newCompose.id,currentLease]);
 const reserve=async(model,tokens,id=randomUUID(),routing=false)=>
  (await one(db,"select try_reserve_mission_capacity($1,$2,$3,$4,$5,$6) ok",[newCompose.id,currentLease,id,model,tokens,routing])).ok;
 const startCalls=(await one(db,"select calls,routing_calls,reserved_tokens from agent_missions where id=$1",[recoveredId]));
 assert.equal(await reserve('openai:unpriced-model',1000),false);
 assert.equal(await reserve('openai:gpt-5.6-sol',1000,randomUUID(),true),true);
 const firstCall=await one(db,"select * from mission_calls where project_continuation_id=$1",[
  authorization.a.authorizationId
 ]);
 assert.equal(firstCall.project_continuation_id,authorization.a.authorizationId);
 assert.ok(Number(firstCall.project_reserved_microusd)>0);
 assert.equal(firstCall.project_pricing_evidence.model,'openai:gpt-5.6-sol');
 assert.equal((await one(db,"select count(*)::int n from mission_calls where project_continuation_id=$1",[authorization.a.authorizationId])).n,1);
 const returned=await one(db,"select calls,routing_calls,reserved_tokens from agent_missions where id=$1",[recoveredId]);
 assert.equal(returned.calls,startCalls.calls);
 assert.equal(returned.routing_calls,startCalls.routing_calls+1);
 // A changed or unknown price must refuse the next call.
 await query(db,'reset role');
 await query(db,"update model_registry set pricing_status='missing' where model_id='gpt-5.6-sol'");
 await query(db,'set role service_role');
 assert.equal(await reserve('openai:gpt-5.6-sol',1000),false);
 await query(db,'reset role');
 await query(db,"update model_registry set pricing_status='verified' where model_id='gpt-5.6-sol'");
 // Force a one-call residual allowance in a transactional synthetic fixture.
 await query(db,"update project_continuation_authorizations set incremental_calls=13 where id=$1",[authorization.a.authorizationId]);
 await query(db,'set role service_role');
 const callsBefore=(await one(db,'select count(*)::int n from mission_calls where project_continuation_id=$1',[authorization.a.authorizationId])).n;
 assert.equal(await reserve('openai:gpt-5.6-sol',1000),false,'Protected future calls remain fenced');
 assert.equal((await one(db,'select count(*)::int n from mission_calls where project_continuation_id=$1',[authorization.a.authorizationId])).n,callsBefore);
 // Real concurrent SQL sessions compete for one remaining admission slot.
 // This isolated fixture commits only its own synthetic data and the global
 // PostgreSQL advisory lock serializes both competing reservations.
 await query(db,'reset role');
 await query(db,"update project_continuation_authorizations set incremental_calls=14 where id=$1",[authorization.a.authorizationId]);
 await query(db,'commit');
 const rivals=await Promise.all([connect(),connect()]);
 for(const client of rivals)await client.query('set role service_role');
 const contested=await Promise.all(rivals.map((client)=>
  client.query("select try_reserve_mission_capacity($1,$2,$3,$4,$5,false) ok",
   [newCompose.id,currentLease,randomUUID(),'openai:gpt-5.6-sol',1000])
 ));
 assert.equal(contested.filter(x=>x.rows[0].ok===true).length,1,
  'Exactly one concurrent provider admission may consume the final call slot');
 await query(db,'begin');
 await query(db,'set role service_role');
 assert.equal((await one(db,'select count(*)::int n from mission_calls where project_continuation_id=$1',[authorization.a.authorizationId])).n,2);
 // Unlike a finished provider call, an unconfirmed receipt remains reserved
 // and must refuse every future admission.
 await query(db,'reset role');
 await query(db,"update mission_calls set status='uncertain' where id=$1",[firstCall.id]);
 await query(db,'set role service_role');
 assert.equal(await reserve('openai:gpt-5.6-sol',1000),false);
 assert.equal((await one(db,"select count(*)::int n from project_events where project_id=$1 and event='task4a_expired_research_continued'",[pid])).n,1);
 await query(db,'reset role');
 await query(db,"update work_projects set status='stopped' where id=$1",[pid]);
 await query(db,"update agent_missions set status='blocked' where id=$1",[recoveredId]);
 await query(db,'set role service_role');
 await query(db,'commit');
 // No repair in the fixture ever calls a real provider.
}
