import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
// Disposable DB only: real completion/assessment state transitions with synthetic receipts.
export async function assertRenewalCompletionLifecycle(db,{project,mission,task,c,cumulativeCap}){
 await db.query('begin');
 const team=(await db.query('select team from agent_missions where id=$1',[mission])).rows[0].team;
 const head='a'.repeat(40),contractHash='b'.repeat(64);
 // This startup fixture only supplied scopeHash; add synthetic immutable-head
 // acceptance metadata here to exercise lifecycle gates, never production proof.
 await db.query("update project_runs set binding=binding||jsonb_build_object('contractHash',$2::text) where mission_id=$1",[mission,contractHash]);
 await db.query('update mission_assignments set available_at=now() where id=$1',[task]);
 const developer=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(developer.job.id,task);
 const verification={testedHeadSha:head,reviewedHeadSha:head,observedHeadSha:head,projectAcceptance:{passed:true,headSha:head,contractHash,projectId:project}};
 const children=[{key:'amendment_compose',role:'compose',agent_id:team[0].id,instruction:'Summarize the synthetic verified fixture.',dependencies:[developer.job.job_key],payload:{}},{key:'amendment_review',role:'review',agent_id:team[1].id,instruction:'Review the synthetic verified fixture.',dependencies:['amendment_compose'],payload:{}}];
 assert.equal((await db.query("select commit_mission_work($1,$2,$3,$4,'completed',null,null) ok",[task,developer.job.lease,{verification},JSON.stringify(children)])).rows[0].ok,true);
 const composer=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(composer.job.role,'compose');
 for(const routing of [true,false]){
  const call=randomUUID();const op=(await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,15000,$5) id',[composer.job.id,composer.job.lease,call,'openai:gpt-5.3-codex',routing])).rows[0].id;assert.ok(op);
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[call,'synthetic-closure-'+call,{input_tokens:7000,output_tokens:2000,total_tokens:9000}]);
 }

 assert.equal((await db.query("select commit_mission_work($1,$2,$3,'[]','completed',null,null) ok",[composer.job.id,composer.job.lease,{text:'Synthetic completed code and browser receipt.'}])).rows[0].ok,true);
 const review=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(review.job.role,'review');
 for(const routing of [true,false]){
  const call=randomUUID();const op=(await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,15000,$5) id',[review.job.id,review.job.lease,call,'openai:gpt-5.3-codex',routing])).rows[0].id;assert.ok(op);
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[call,'synthetic-closure-'+call,{input_tokens:7000,output_tokens:2000,total_tokens:9000}]);
 }
 await db.query('savepoint call_limit');
 await assert.rejects(db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,1,true)',[review.job.id,review.job.lease,randomUUID(),'openai:gpt-5.3-codex']),/billable call ceiling/);await db.query('rollback to savepoint call_limit');

 assert.equal((await db.query("select commit_mission_work($1,$2,$3,'[]','completed','completed',$4) ok",[review.job.id,review.job.lease,{verdict:'pass'},'Synthetic independently reviewed fixture.'])).rows[0].ok,true);
 assert.equal((await db.query('select status from agent_missions where id=$1',[mission])).rows[0].status,'completed');
 const projectClaim=(await db.query('select claim_work_project() p')).rows[0].p;assert.equal(projectClaim.id,project);assert.equal(projectClaim.token_allowance,cumulativeCap,'Coordinator must see effective cumulative cap');
 assert.equal((await db.query("select finish_work_project($1,$2,'advance',$3) ok",[project,projectClaim.lease,{head}])).rows[0].ok,true);
 assert.equal((await db.query('select verified_sha from work_projects where id=$1',[project])).rows[0].verified_sha,head);
 // Stand in for the separately tested deployment/browser receipt, then use the
 // real coordinator's assessment child creation and ordinary reservation path.
 await db.query("update work_projects set phase='assessment' where id=$1",[project]);
 const nextProjectClaim=(await db.query('select claim_work_project() p')).rows[0].p;assert.equal(nextProjectClaim.id,project);
 assert.equal((await db.query("select finish_work_project($1,$2,'child',$3) ok",[project,nextProjectClaim.lease,{kind:'assessment',objective:'Synthetic preserved assessment',evidence:{benchmarkContinuationId:c.id,benchmarkContinuationPlanHash:c.planHash}}])).rows[0].ok,true);
 const assessmentWork=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(assessmentWork.mission.project_kind,'assessment');assert.equal(assessmentWork.mission.token_allowance,60000);
 const assessmentCall=randomUUID();
 const reserved=(await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,60000,false) id',[assessmentWork.job.id,assessmentWork.job.lease,assessmentCall,'openai:gpt-5.3-codex'])).rows[0].id;assert.ok(reserved);
 assert.equal((await db.query('select continuation_id from benchmark_budget_calls where id=$1',[reserved])).rows[0].continuation_id,c.id);
 assert.equal((await db.query('select benchmark_reserve_mission_call($1,$2,$3,$4,1,false) id',[assessmentWork.job.id,assessmentWork.job.lease,randomUUID(),'openai:gpt-5.3-codex'])).rows[0].id,null);
 await db.query('rollback');
}
