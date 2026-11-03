import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './load-project-modules.mjs';
import {savedTask4aPlan,savedTask4aFinalReview,oldPath,newPath} from '../fixtures/task4a-saved-specification.mjs';

// Must run inside the existing disposable PostgreSQL harness after ALL Task 4A migrations.
export async function verifyTask4aSavedSpecificationPostgres(db){
 const {prepareTask4aSavedRecovery}=modules()('@/lib/projects/task4a-saved-specification-recovery');
 const query=(sql,args=[])=>db.query(sql,args);
 const one=async(sql,args=[])=>(await query(sql,args)).rows[0];
 const pid='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
 const specMid='20a837cb-98ae-470f-8308-8526d8dceed3';
 const revisionId='08a62aa5-e4c0-49a3-ae9d-ae5b77275a71';
 const reviewId='dd46bc5a-50cf-49fe-a8dd-ab36e52d6d73';
 const researchId='d35b71d3-fbe2-4e9b-8bde-4d0fe8c9968e';
 const actor=randomUUID(),chat='e53defeb-16eb-457e-aa07-435141165ee8';
 const repoId=randomUUID(),research2=randomUUID(),review=savedTask4aFinalReview(),raw=JSON.stringify(savedTask4aPlan());
 const prepared=prepareTask4aSavedRecovery(raw,raw,review),baseline='a'.repeat(40);
 const team=(await one("select team from work_projects where id='44444444-4444-4444-8444-444444444444'")).team;
 await query('reset role');
 await query('begin');
 try{
  await query('insert into actors(id,name) values($1,$2)',[actor,'Synthetic Task 4A owner']);
  await query('insert into chats(id,actor_id,title) values($1,$2,$3)',[chat,actor,'Synthetic original Task 4A conversation']);
  await query('insert into repo_sync_runs(id,repository_full_name) values($1,$2)',[repoId,'mfackrell/katie']);
  await query("insert into work_projects(id,request_id,actor_id,chat_id,objective,team,status,phase,profile,repository_id,token_allowance,deadline,detail) values($1,$2,$3,$4,$5,$6,'failed','specification','software',$7,600000,now()+interval '24 hours',$8)",[
   pid,randomUUID(),actor,chat,'Create one disposable Task 4A browser app; no production publication.',team,repoId,
   'Project coordination error: Error; Scope requires isolated application/source/test paths; dependencies, secrets and deployment configuration need a separate decision'
  ]);
  const missions=[[researchId,'research','blocked',76519,4,5],[research2,'research','completed',38780,4,4],[specMid,'specification','completed',31803,4,4]];
  const plans={};
  for(const [id,kind,status,tokens,calls,routing] of missions){
   await query('select create_mission($1,$2,$3,120,null)',[id,'Synthetic preserved '+kind,team]);
   await query("update agent_missions set project_id=$2,project_kind=$3,status=$4,actual_tokens=$5,reserved_tokens=$5,calls=$6,routing_calls=$7,created_at=now()-interval '30 minutes',deadline=now()-interval '1 minute' where id=$1",[
    id,pid,kind,status,tokens,calls,routing
   ]);
   const plan=await one("select id from mission_assignments where mission_id=$1 and job_key='plan'",[id]);
   plans[id]=plan.id;
   await query("update mission_assignments set status='completed',result='{\"text\":\"Saved mission plan\"}'::jsonb where id=$1",[plan.id]);
  }
  await query("update agent_missions set created_at=now()-interval '2 hours' where id=$1",[researchId]);
  await query("update agent_missions set result=$2 where id=$1",[specMid,raw]);
  await query('update work_projects set active_mission_id=$2 where id=$1',[pid,specMid]);
  await query("insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index) values($1,$2,'specification',1,0)",[pid,specMid]);
  const roles=[
   [randomUUID(),'compose','compose',{text:raw}],
   [randomUUID(),'review','review',{verdict:'changes_requested',checks:[{id:'criterion:1',passed:false}]}],
   [revisionId,'revision','revise',{text:raw,model:'synthetic'}],
   [reviewId,'review_again','review',review]
  ];
  for(const [id,key,role,result] of roles)
   await query("insert into mission_assignments(id,mission_id,job_key,role,agent_id,instruction,status,attempts,result) values($1,$2,$3,$4,$5,'Synthetic retained artifact','completed',1,$6::jsonb)",[
    id,specMid,key,role,team[1],JSON.stringify(result)
   ]);
  // Historical completed call records predate the continuation authority.
  // No original provider usage is rebilled by the recovery operation.
  const distribution=[
   [researchId,plans[researchId],Array(8).fill(8500).concat([8519])],
   [research2,plans[research2],Array(7).fill(4800).concat([5180])],
   [specMid,revisionId,Array(7).fill(3800).concat([5203])]
  ];
  for(const [,job,amounts] of distribution)for(const n of amounts)
   await query("insert into mission_calls(id,job_id,lease,model,reserved_tokens,actual_tokens,status) values($1,$2,$3,'openai:gpt-5.6-sol',$4,$4,'completed')",[
    randomUUID(),job,randomUUID(),n
   ]);
  // Set the synthetic authorization's historical cutoff after the original 9
  // calls but before the recovered research/specification, as in production.
  await query("update agent_missions set created_at=now()-interval '30 minutes' where id in ($1,$2)",[research2,specMid]);
  await query("insert into project_continuation_authorizations(project_id,actor_id,chat_id,source_mission_id,approval_digest,authorized_at,deadline,incremental_tokens,incremental_calls,incremental_microusd,assessment_reserve_tokens,completion_reserve_tokens,assessment_reserve_calls,completion_reserve_calls,allowed_models,historical_tokens,historical_calls,historical_mission_deadline,pricing_evidence) values($1,$2,$3,$4,$5,now()-interval '1 hour',now()+interval '3 hours',440326,53,15000000,60000,60000,6,6,ARRAY['openai:gpt-5.6-sol','openai:gpt-5.3-codex'],76519,9,now()-interval '2 hours','[]'::jsonb)",[
   pid,actor,chat,researchId,'e'.repeat(64)
  ]);
  await query('set role service_role');
  const before=await one('select sum(greatest(actual_tokens,reserved_tokens))::bigint charged, sum(calls+routing_calls)::bigint calls from agent_missions where project_id=$1',[pid]);
  assert.equal(Number(before.charged),147102);
  assert.equal(Number(before.calls),25);
  const callCount=(await one("select count(*)::int n from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=$1",[pid])).n;
  assert.equal(callCount,25);
  const originalReview=(await one('select result from mission_assignments where id=$1',[reviewId])).result;
  const attempt=async({who=actor,whichChat=chat,source=prepared.sourceHash,reviewHash=prepared.reviewHash,corrected=prepared.corrected,correctedHash=prepared.correctedHash,base=baseline}={})=>
   one('select recover_task4a_reviewed_specification($1,$2,$3,$4,$5::jsonb,$6,$7) receipt',[
    who,whichChat,source,reviewHash,JSON.stringify(corrected),correctedHash,base
   ]);
  const rejects=async(args,pattern)=>{
   await query('savepoint negative_recovery');
   await assert.rejects(attempt(args),pattern);
   await query('rollback to savepoint negative_recovery');
   await query('release savepoint negative_recovery');
   assert.equal((await one("select status from work_projects where id=$1",[pid])).status,'failed');
   assert.equal((await one("select count(*)::int n from project_events where project_id=$1 and event='task4a_saved_specification_recovered'",[pid])).n,0);
  };
  await rejects({who:randomUUID()},/original failed state|identity/);
  await rejects({whichChat:randomUUID()},/original failed state|identity/);
  await rejects({source:'f'.repeat(64)},/integrity hash/);
  await rejects({reviewHash:'f'.repeat(64)},/integrity hash/);
  await rejects({corrected:{...prepared.corrected,name:'widened scope'}},/more than allowedPaths/);
  await rejects({correctedHash:'f'.repeat(64)},/canonical hash/);
  await rejects({base:'untrusted-baseline'},/verified baseline/);
  await query('savepoint revoked_authority');
  await query('reset role');
  await query("update project_continuation_authorizations set revoked_at=now() where project_id=$1",[pid]);
  await query('set role service_role');
  await assert.rejects(attempt(),/financial authority expired or changed/);
  await query('rollback to savepoint revoked_authority');
  await query('release savepoint revoked_authority');
  await query('savepoint already_approved');
  await query("update work_projects set approved_hash='f' where id=$1",[pid]);
  await assert.rejects(attempt(),/original failed state/);
  await query('rollback to savepoint already_approved');
  await query('release savepoint already_approved');
  await query('savepoint changed_review');
  await query("update mission_assignments set result=jsonb_set(result,'{verdict}','\"changes_requested\"'::jsonb) where id=$1",[reviewId]);
  await assert.rejects(attempt(),/independent review PASS/);
  await query('rollback to savepoint changed_review');
  await query('release savepoint changed_review');
  const applied=(await attempt()).receipt;
  assert.equal(applied.recovered,true);
  assert.equal(applied.status,'awaiting_approval');
  assert.equal(applied.historicalTokens,147102);
  assert.equal(applied.historicalCalls,25);
  const saved=await one("select status,phase,active_mission_id,approved_hash,approval_hash,baseline_sha,spec from work_projects where id=$1",[pid]);
  assert.equal(saved.status,'awaiting_approval');
  assert.equal(saved.phase,'approval');
  assert.equal(saved.active_mission_id,null);
  assert.equal(saved.approved_hash,null);
  assert.match(saved.approval_hash,/^[a-f0-9]{64}$/);
  assert.equal(saved.baseline_sha,baseline);
  assert.deepEqual(saved.spec.allowedPaths,[newPath]);
  assert.deepEqual(saved.spec.finalContract,savedTask4aPlan().finalContract);
  assert.deepEqual(saved.spec.milestones,savedTask4aPlan().milestones);
  assert.deepEqual(saved.spec.requirements,savedTask4aPlan().requirements);
  assert.deepEqual((await one('select result from mission_assignments where id=$1',[reviewId])).result,originalReview);
  assert.equal((await one('select result from agent_missions where id=$1',[specMid])).result,raw);
  assert.equal((await one("select count(*)::int n from project_runs where project_id=$1 and kind='development'",[pid])).n,0);
  const event=await one("select id,data from project_events where project_id=$1 and event='task4a_saved_specification_recovered'",[pid]);
  assert.equal(event.data.sourceHash,prepared.sourceHash);
  assert.equal(event.data.correctedHash,prepared.correctedHash);
  assert.equal(event.data.sourceReviewOnly,true);
  assert.equal(event.data.correctedBytesReviewedByModel,false);
  assert.equal(event.data.developmentApproved,false);
  assert.deepEqual(event.data.originalReviewResult,review);
  await query('savepoint immutable_receipt');
  await assert.rejects(query("update project_events set data='{}'::jsonb where id=$1",[event.id]),/immutable/);
  await query('rollback to savepoint immutable_receipt');
  await query('release savepoint immutable_receipt');
  await query('savepoint duplicate');
  await assert.rejects(attempt(),/original failed state|already recovered/);
  await query('rollback to savepoint duplicate');
  await query('release savepoint duplicate');
  const after=await one('select sum(greatest(actual_tokens,reserved_tokens))::bigint charged,sum(calls+routing_calls)::bigint calls from agent_missions where project_id=$1',[pid]);
  assert.deepEqual(after,before,'Historical token/call usage remains exactly unchanged');
  assert.equal((await one("select count(*)::int n from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=$1",[pid])).n,25);
  assert.equal((await one('select approved_hash from work_projects where id=$1',[pid])).approved_hash,null);
  console.log('TASK4A_SAVED_SPEC_RECOVERY_PASS: original fail, corrected validator, source-review hashes, atomic owner gate, unchanged contracts, immutable receipt, awaiting_approval, zero inference');
 }finally{
  await query('rollback');
  await query('reset role');
 }
}
