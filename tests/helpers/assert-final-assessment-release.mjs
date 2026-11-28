import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

// Continue the native release fixture through the real retained-review RPC,
// then exercise the real assignment/request predicates on the new runtime.
export async function assertFinalAssessmentRelease({db,ids,contract,contractHash,binding,proof,receipt,newSha,newDeployment,oldSha,oldDeployment,before}){
 const migration='supabase/migrations/20261128194010_authorized_final_assessment_continuity.sql';
 const protectedFunctions="('project_org_package_nonbillable_checkpoint','project_org_package_checkpoint_dispatch_live','project_org_package_execution_request')";
 const definitions=(await db.query(`select proname,prosrc from pg_proc where proname in ${protectedFunctions} order by proname`)).rows;
 await db.query(readFileSync(migration,'utf8'));
 assert.deepEqual((await db.query(`select proname,prosrc from pg_proc where proname in ${protectedFunctions} order by proname`)).rows,definitions,'native dispatch, nonbillable exact request set and paid ceilings stay unchanged');
 const live=async()=>(await db.query('select project_org_package_final_assessment_release_live($1,$2,73,$3) ok',[ids.project,newSha,newDeployment])).rows[0].ok;
 const checkpointLive=async()=>(await db.query('select project_org_package_checkpoint_live($1) ok',[ids.project])).rows[0].ok;
 const matches=async(sha,gen,dep)=>(await db.query('select project_org_package_release_matches($1,$2,$3,$4) ok',[ids.project,sha,gen,dep])).rows[0].ok;
 const assignment=async(job)=>(await db.query('select project_org_package_execution_assignment($1) ok',[job])).rows[0].ok;
 const request=async(job,attempt,op,scope=null)=>(await db.query('select project_org_package_execution_request($1,$2,$3,$4) ok',[job,attempt,op,scope])).rows[0].ok;
 const deny=async(sql,args=[])=>{await db.query('begin');try{await db.query(sql,args);assert.equal(await live(),false,sql);assert.equal(await checkpointLive(),false,sql);}finally{await db.query('rollback');}};
 assert.equal(await live(),false,'a qualified release alone never reopens paid work');
 assert.equal(await checkpointLive(),false);
 assert.equal(await matches(oldSha,71,oldDeployment),false,'the stale original runtime cannot claim new-generation jobs');
 const preview={url:'https://demo-abcdef123-owner.vercel.app/demo',headSha:proof.candidateSha,deploymentId:123,statusId:456,provider:'vercel',immutable:true};
 const browser={version:1,projectId:ids.project,contractHash,headSha:proof.candidateSha,deploymentId:123,statusId:456,url:preview.url,checkedAt:new Date().toISOString(),passed:true,checks:[{name:contract.scenarios[0].name,passed:true,detail:'Expected initial state observed'}]};
 const {version,projectId,headSha,passed,checks}=browser;
 const evidence={observedHeadSha:proof.candidateSha,testedHeadSha:proof.candidateSha,reviewedHeadSha:proof.candidateSha,sourceTreeSha:proof.sourceTreeSha,
  reviewSettlement:{receiptId:ids.settlement,authorizationId:ids.authorization,scopeHash:binding.scopeHash,contractHash},
  changedFiles:[{path:'app/demo/page.tsx'}],packageDelta:{baseSha:binding.baseSha,headSha:proof.candidateSha,changedFiles:[{path:'app/demo/page.tsx'}]},
  preview,projectAcceptance:{version,projectId,contractHash,headSha,passed,checks}};
 await db.query('update mission_assignments set result=$1',[{detail:'Infrastructure failure',external:{receipt}}]);
 const consumed=(await db.query('select project_consume_development_review_settlement($1,$2,$3,73,$4,$5,$6) result',[ids.task,ids.settlement,newSha,newDeployment,evidence,browser])).rows[0].result;
 assert.equal(consumed.consumed,true);assert.equal(consumed.additionalPaidInference,0);
 assert.equal(await live(),false,'consumption is technical acceptance, not project/package approval');
 // These fixture states are produced by the real protected transition in the
 // full coding-capacity integration suite. Status changes alone are rejected.
 const summary='Server-owned consumed independent technical review';
 await db.query("update agent_missions set status='completed',result=$2 where id=$1",[ids.mission,summary]);
 await db.query("update project_work_packages set status='accepted'");
 await db.query("update work_projects set status='running',phase='delivery',milestone_index=1,verified_sha=$1,active_mission_id=null",[proof.candidateSha]);
 assert.equal(await live(),false,'mutable acceptance statuses do not authorize paid assessment');
 await db.query("insert into project_events(project_id,event,data) values($1,'single_package_development_completed',$2)",[ids.project,{receiptId:ids.settlement,authorizationId:ids.authorization,packageId:ids.package,missionId:ids.mission,assignmentId:ids.task,head:proof.candidateSha,source:'consumed-independent-native-review-and-deployed-browser',summary,additionalPaidInference:0}]);
 assert.equal(await live(),false,'completed event also requires exact accepted package evidence');
 await db.query("update project_work_packages set evidence=jsonb_build_object('source','consumed-independent-native-review-and-deployed-browser','head',$1::text,'assignmentId',$2::uuid,'result',(select result from mission_assignments where id=$2::uuid),'receiptId',$3::uuid,'authorizationId',$4::uuid)",[proof.candidateSha,ids.task,ids.settlement,ids.authorization]);
 assert.equal(await live(),true);assert.equal(await checkpointLive(),true);
 assert.equal(await matches(newSha,73,newDeployment),true);
 assert.equal(await matches(newSha,72,newDeployment),false);
 assert.equal(await matches(oldSha,71,oldDeployment),false);
 assert.equal(await assignment(ids.task),false,'retained coding job never becomes claimable');
 await deny("update work_projects set phase='development'");
 await deny("update work_projects set verified_sha=repeat('9',40)");
 await deny("update work_projects set token_allowance=600001");
 await deny("update work_projects set max_missions=125");
 await deny("update work_projects set max_cycles=6");
 await deny("update work_projects set deadline=deadline+interval '1 second'");
 await deny("update project_package_checkpoint_continuations set cutoff=now()-interval '1 second'");
 await deny("update project_package_checkpoint_continuations set terms=jsonb_set(terms,'{additionalPaidRetries}','1')");
 await deny("update project_retest_production_release_gate set generation=75");
 await deny("update project_retest_production_release_gate set state='closed'");
 await deny("update project_work_packages set status='review'");
 await deny("update project_work_packages set evidence='{}'");
 await deny("delete from project_events where event='single_package_development_completed'");
 await deny("update mission_assignments set result='{}' where id=$1",[ids.task]);
 await deny("update agent_missions set status='blocked' where id=$1",[ids.mission]);
 await db.query("update work_projects set phase='browser_check'");assert.equal(await live(),true);
 await db.query("update work_projects set phase='assessment'");assert.equal(await live(),false,'assessment requires real candidate-bound browser proof');
 await db.query('update work_projects set preview=$1',[{...preview,browserAcceptance:browser}]);assert.equal(await live(),true);
 await deny("update work_projects set preview=jsonb_set(preview,'{browserAcceptance,contractHash}','\"wrong\"')");
 const mission=randomUUID(),plan=randomUUID(),compose=randomUUID(),review=randomUUID();
 await db.query("insert into agent_missions(id,project_id,project_kind,status,deadline,project_evidence) values($1,$2,'assessment','running',(select cutoff from project_package_checkpoint_continuations),$3)",[mission,ids.project,{packageExecutionAuthorizationId:ids.authorization,checkpointRecoveryAuthorizationId:ids.authorization,approvedScopeHash:binding.scopeHash,approvedFinalContract:contract,preview:{...preview,browserAcceptance:browser},finalIntegratedEvidence:{head:proof.candidateSha,taskId:ids.task,verification:evidence}}]);
 for(const [id,role,agent,status] of [[plan,'plan',ids.worker,'completed'],[compose,'compose',ids.worker,'queued'],[review,'review',ids.reviewer,'queued']])await db.query('insert into mission_assignments(id,mission_id,role,agent_id,status,attempts,job_key) values($1,$2,$3,$4,$5,0,$3)',[id,mission,role,agent,status]);
 await db.query('update work_projects set active_mission_id=$1',[mission]);
 assert.equal(await live(),true);assert.equal(await assignment(compose),true);assert.equal(await assignment(review),true);assert.equal(await assignment(plan),false);
 await deny("insert into agent_missions(id,project_id,project_kind,status) values(gen_random_uuid(),$1,'assessment','running')",[ids.project]);
 await deny("update mission_assignments set attempts=2 where id=$1",[compose]);
 await deny("update mission_assignments set attempts=1 where id=$1",[compose]);
 await deny("update mission_assignments set status='failed' where id=$1",[compose]);
 await deny("update mission_assignments set agent_id=$1 where id=$2",[ids.worker,review]);
 await deny("update mission_assignments set job_key='work' where id=$1",[compose]);
 await deny("update agent_missions set project_evidence='{}' where id=$1",[mission]);
 for(const path of ['approvedScopeHash','finalIntegratedEvidence,taskId','finalIntegratedEvidence,verification,reviewedHeadSha'])await deny("update agent_missions set project_evidence=jsonb_set(project_evidence,$2::text[],'\"wrong\"') where id=$1",[mission,path.split(',')]);
 // A new management mission cannot inherit the one-assessment capability.
 await db.query('begin');try{
  const management=randomUUID(),job=randomUUID();
  await db.query("insert into agent_missions(id,project_id,project_kind,status,deadline,project_evidence) values($1,$2,'management','running',(select cutoff from project_package_checkpoint_continuations),$3)",[management,ids.project,{packageExecutionAuthorizationId:ids.authorization,previousMissionId:ids.mission}]);
  await db.query("insert into mission_assignments(id,mission_id,role,job_key,agent_id,status,attempts,lease,lease_until) values($1,$2,'work','work',$3,'running',1,gen_random_uuid(),now()+interval '5 minutes')",[job,management,ids.worker]);
  await db.query('update work_projects set active_mission_id=$1',[management]);
  assert.equal(await assignment(job),false);assert.equal(await live(),false);
 }finally{await db.query('rollback');}
 const attempt=randomUUID();
 await db.query("update mission_assignments set status='running',attempts=1,lease=$1,lease_until=now()+interval '5 minutes' where id=$2",[attempt,compose]);
 assert.equal(await request(compose,attempt,'model-list'),true,'positive real provider-admission control on new qualified release');
 assert.equal(await request(compose,attempt,'inference'),false,'catalog preflight is still required');
 assert.equal(await request(compose,randomUUID(),'model-list'),false,'wrong lease rejected');
 assert.equal(await request(compose,attempt,'input-count',binding.scopeHash),false,'native input-count remains closed');
 assert.equal(await request(ids.task,'123','input-count',binding.scopeHash),false,'retained native dispatch remains closed');
 const addRequest=async(job,agent,lease,operation,resolved=true)=>{
  const id=randomUUID();await db.query("insert into project_provider_requests(id,operation,worker_id,mission_id,project_id,started_at,resolved_at,request_hash,assignment_id,provider_receipt,execution_attempt) values($1::uuid,$2,$3,$4,$5,clock_timestamp(),case when $6 then clock_timestamp() end,$7,$8,case when $6 then $1::text end,$9)",[id,operation,agent,mission,ids.project,resolved,'e'.repeat(64),job,lease]);return id;
 };
 await addRequest(compose,ids.worker,attempt,'model-list');
 assert.equal(await live(),true);assert.equal(await request(compose,attempt,'model-list'),false,'model-list cannot repeat');
 assert.equal(await request(compose,attempt,'inference'),true,'first signed assessment inference is admitted');
 await db.query('begin');try{
  // Older settled calls remain in the cumulative paid budget. They are not
  // part of the retained run and must never be reset by runtime continuity.
  await db.query("insert into project_provider_requests(id,operation,worker_id,mission_id,project_id,started_at,resolved_at,request_hash,assignment_id,provider_receipt,execution_attempt) select gen_random_uuid(),'inference',$1,$2,$3,c.authorized_at-interval '1 hour',c.authorized_at-interval '59 minutes',repeat('e',64),$4,'prior-'||n,'122' from project_package_checkpoint_continuations c cross join generate_series(1,78) n",[ids.worker,ids.mission,ids.project,ids.task]);
  assert.equal(await request(compose,attempt,'inference'),true,'the 80th cumulative paid call can use the signed remaining budget');
  await db.query("insert into project_provider_requests(id,operation,worker_id,mission_id,project_id,started_at,resolved_at,request_hash,assignment_id,provider_receipt,execution_attempt) select gen_random_uuid(),'inference',$1,$2,$3,c.authorized_at-interval '1 hour',c.authorized_at-interval '59 minutes',repeat('e',64),$4,'prior-79','122' from project_package_checkpoint_continuations c",[ids.worker,ids.mission,ids.project,ids.task]);
  assert.equal(await live(),true,'exhaustion allows bookkeeping but grants no next call');
  assert.equal(await request(compose,attempt,'inference'),false,'the unchanged paid predicate rejects an 81st cumulative call');
 }finally{await db.query('rollback');}
 assert.equal((await db.query('select project_org_package_nonbillable_checkpoint($1) cp',[ids.project])).rows[0].cp,null,'zero-inference release predicate remains exact');
 const paid=await addRequest(compose,ids.worker,attempt,'inference',false);
 assert.equal(await live(),true,'pending authorized receipt does not destroy checkpoint identity');
 assert.equal(await request(compose,attempt,'inference'),false,'pending work blocks duplicate provider reservation');
 await db.query('update project_provider_requests set resolved_at=clock_timestamp(),provider_receipt=$1::text where id=$1::uuid',[paid]);
 assert.equal(await request(compose,attempt,'inference'),false,'resolved first inference cannot be retried');
 await deny("update project_provider_requests set worker_id=gen_random_uuid() where id=$1",[paid]);
 await deny("update project_provider_requests set execution_attempt=gen_random_uuid()::text where id=$1",[paid]);
 await deny("update project_provider_requests set operation='input-count' where id=$1",[paid]);
 await deny("insert into project_provider_requests select gen_random_uuid(),operation,worker_id,mission_id,project_id,started_at,resolved_at,request_hash,assignment_id,provider_receipt,execution_attempt from project_provider_requests where id=$1",[paid]);
 await db.query("update mission_assignments set status='completed',lease=null,lease_until=null where id=$1",[compose]);
 assert.equal(await live(),true);
 const reviewAttempt=randomUUID();
 await db.query("update mission_assignments set status='running',attempts=1,lease=$1,lease_until=now()+interval '5 minutes' where id=$2",[reviewAttempt,review]);
 assert.equal(await request(review,reviewAttempt,'model-list'),true);
 await addRequest(review,ids.reviewer,reviewAttempt,'model-list');
 assert.equal(await request(review,reviewAttempt,'inference'),true,'independent reviewer has its single signed assessment call');
 await addRequest(review,ids.reviewer,reviewAttempt,'inference');
 assert.equal(await request(review,reviewAttempt,'inference'),false);
 await db.query("update mission_assignments set status='completed',lease=null,lease_until=null where id=$1",[review]);
 await db.query("update agent_missions set status='completed' where id=$1",[mission]);
 assert.equal(await live(),true,'completed independent assessment can reach ordinary finalization');
 assert.equal(await assignment(review),false,'completed mission cannot be reclaimed');
 await deny("update agent_missions set status='failed' where id=$1",[mission]);
 await db.query('begin');try{
  await db.query("update project_provider_requests set provider_receipt='altered' where assignment_id=$1 and operation='inference'",[ids.task]);
  await assert.rejects(live(),/authenticated evidence/);
 }finally{await db.query('rollback');}
 const source=(await db.query('select project_development_review_settlement($1) e',[ids.task])).rows[0].e;
 assert.equal(source.receiptId,ids.settlement,'source receipt remains readable after legitimate assessment calls');
 assert.equal(source.workflowReceipt.outcome,'BLOCKED','workflow history remains honest');
 assert.deepEqual((await db.query('select to_jsonb(c) cp from project_package_checkpoint_continuations c')).rows[0].cp,before,'signed checkpoint terms and cutoff remain untouched');
 assert.equal((await db.query("select count(*) n from project_provider_requests where operation='inference'")).rows[0].n,'3','one retained review plus writer and reviewer, never a reset');
 assert.equal((await db.query('select count(*) n from project_provider_requests')).rows[0].n,'6','catalog reads are distinct from the two paid assessment calls');
}
