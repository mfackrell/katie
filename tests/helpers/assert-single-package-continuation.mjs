import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

// Called inside the existing full native hierarchy/SMART/provider/lifecycle
// fixture after its retained-checkpoint migration, before its rollback.
export async function assertSinglePackageContinuation(db,{project,owner,packageId,taskId,release,generation,deployment}){
 const one=async(sql,args=[])=> (await db.query(sql,args)).rows[0];
 const rejects=async(action,pattern)=>{
  await db.query('savepoint expected_single_package_error');
  try{await assert.rejects(action(),pattern);}finally{await db.query('rollback to savepoint expected_single_package_error');await db.query('release savepoint expected_single_package_error');}
 };
 await db.query('reset role');
 const p=await one('select * from work_projects where id=$1',[project]);
 const j=await one('select * from mission_assignments where id=$1',[taskId]);
 const task=await one('select * from agent_tasks where id=$1',[taskId]);
 const m=await one('select * from agent_missions where id=$1',[j.mission_id]);
 const w=await one('select * from project_work_packages where id=$1',[packageId]);
 const r=await one('select * from project_runs where mission_id=$1',[m.id]);
 const authorization=(await one('select id from project_execution_windows where project_id=$1 order by authorized_at desc limit 1',[project])).id;
 const source=(await one('select * from project_package_corrective_receipts where project_id=$1 order by ordinal desc limit 1',[project]));
 const head='b'.repeat(40),tree='c'.repeat(40),run='1234567',settlement=source.receipt_id;
 // Place this synthetic signed checkpoint after every earlier fixture call,
 // without rewriting any retained provider receipt or counter.
 const lastRequest=await one('select max(started_at) t from project_provider_requests where project_id=$1',[project]);
 const cutoff=p.deadline,authorized=new Date(Math.max(Date.now(),+(lastRequest.t??0))+1),recorded=new Date(+authorized+30);
 assert.equal(p.spec.milestones.length,1);assert.deepEqual(p.spec.milestones[0].contract,p.spec.finalContract);
 assert.deepEqual(r.binding.contract,p.spec.finalContract);
 const proof={candidateSha:head,sourceTreeSha:tree};
 const receipt={version:1,repository:task.repository_full_name,issue_number:1188,run_id:Number(run),outcome:'BLOCKED',pr_url:null,tested_head_sha:null,reviewed_head_sha:null};
 // Restore a controlled retained-source baseline before preservation snapshots.
 // These are fixture inserts/updates, not runtime authority operations.
 await db.query(`insert into project_package_checkpoint_continuations(project_id,package_id,authorization_id,owner_id,mission_id,assignment_id,release_sha,release_generation,deployment_id,prior_cutoff,cutoff,proof,terms,state_hash,prior_state,renewed_fingerprint,authorized_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,project_org_package_checkpoint_terms(),$13,jsonb_build_object('task',(select to_jsonb(t) from agent_tasks t where id=$6)),$13,$14)`,[project,packageId,authorization,owner,m.id,taskId,release,generation,deployment,cutoff,cutoff,proof,'d'.repeat(64),authorized]);
 await db.query("update work_projects set status='blocked',active_mission_id=null where id=$1",[project]);
 await db.query('update work_projects set max_missions=124,active_mission_id=$2 where id=$1',[project,m.id]);
 p.max_missions=124;
 await db.query('alter table project_package_checkpoint_continuations disable trigger checkpoint_continuation_immutable');
 await db.query('update project_package_checkpoint_continuations set renewed_fingerprint=project_org_package_execution_fingerprint(package_id) where project_id=$1',[project]);
 await db.query('alter table project_package_checkpoint_continuations enable trigger checkpoint_continuation_immutable');
 await db.query('insert into project_package_checkpoint_dispatches(authorization_id,task_id,run_id) values($1,$2,$3)',[authorization,taskId,run]);
 for(const [index,operation,provider] of [[0,'input-count','token-count'],[1,'inference','retained-final-response']]){
  await db.query('insert into project_provider_requests(id,project_id,mission_id,assignment_id,worker_id,execution_attempt,operation,request_hash,started_at,provider_receipt,resolved_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[randomUUID(),project,m.id,taskId,j.agent_id,run,operation,String(index).repeat(64),new Date(+authorized+10+index*10),provider,new Date(+authorized+11+index*10)]);
 }
 const requests=(await one('select jsonb_agg(to_jsonb(x) order by x.started_at,x.id) v from project_provider_requests x where assignment_id=$1 and execution_attempt=$2',[taskId,run])).v;
 const checkpoint={mode:'retained-final-review-settlement',authorizationId:authorization,missionId:m.id,assignmentId:taskId,...proof,scopeHash:p.approved_hash,contractHash:r.binding.contractHash,reviewVerdict:'pass',additionalPaidInference:0,nativeDispatchConsumed:true,workflowReceipt:receipt,providerRequests:requests};
 const qualification={kind:'retained-final-review-settlement',phase:'final-review',runId:run,workflowConclusion:'failure',...proof,scopeHash:p.approved_hash,contractHash:r.binding.contractHash,terminalEvent:'turn.completed',exitCode:0,findings:'PASS source and deterministic behavior verified',artifactId:'1',artifactSha256:'1'.repeat(64),diagnosticsSha256:'2'.repeat(64),verificationDigest:'3'.repeat(64),snapshots:['initial','after-final-review','final'].map(label=>({label,head})),providerUsage:{unknownUsage:0,responses:1,receipts:[{providerRequestId:'retained-final-response'}]}};
 await db.query('alter table project_package_corrective_receipts disable trigger package_corrective_receipt_immutable');
 await db.query('update project_package_corrective_receipts set checkpoint=$2,qualification=$3,state_hash=$4,recorded_at=$5 where receipt_id=$1',[settlement,checkpoint,qualification,'d'.repeat(64),recorded]);
 await db.query('alter table project_package_corrective_receipts enable trigger package_corrective_receipt_immutable');
 await db.query("update agent_tasks set status='blocked',external=external||$2::jsonb where id=$1",[taskId,{receipt,issueNumber:1188,checkpointRecoveryAuthorizationId:authorization,checkpointRecoveryCandidate:head}]);
 await db.query("update mission_assignments set status='failed',lease=null,lease_until=null,result=$2 where id=$1",[taskId,{detail:'Retained independent review; workflow infrastructure blocked',external:(await one('select external from agent_tasks where id=$1',[taskId])).external}]);
 await db.query("update agent_missions set status='blocked' where id=$1",[m.id]);
 await db.query("update project_work_packages set status='running' where id=$1",[w.id]);
 await db.query("update work_projects set status='blocked',phase='development',active_mission_id=$2,lease=null,lease_until=null,verified_sha=null,preview=null where id=$1",[project,m.id]);
 await db.query("insert into project_events(project_id,event,data,created_at) values($1,'package_checkpoint_authorized',$2,$3),($1,'package_checkpoint_final_review_settled',$4,$5)",[project,{authorizationId:authorization},authorized,{receiptId:settlement,authorizationId:authorization,candidateSha:head,reviewVerdict:'pass',additionalPaidInference:0},recorded]);
 await db.query(readFileSync('supabase/migrations/20261128192606_retained_review_consumption.sql','utf8'));
 // Exercise actual operator fencing and qualification before any runtime
 // consumer or signed final assessment. The encompassing fixture owns its
 // savepoint, so remove only migration transaction wrappers.
 const install=async(file)=>db.query(readFileSync(file,'utf8').replace(/^BEGIN;\s*$/mg,'').replace(/^COMMIT;\s*$/mg,''));
 await install('supabase/migrations/20261128192855_nonbillable_release_continuity.sql');
 assert.ok((await one('select project_org_package_nonbillable_checkpoint($1) cp',[project])).cp);
 await db.query("select project_org_retest_set_release_gate($1,$2,$3,'closed',$4)",[project,release,deployment,generation]);
 release='f'.repeat(40);deployment='dpl_AuthorizedAssessmentFixture';
 await db.query("select project_org_retest_set_release_gate($1,$2,$3,'active',$4)",[project,release,deployment,generation+1]);
 generation+=2;
 await db.query('select project_org_package_nonbillable_release_qualify($1,$2,$3,$4,$5)',[project,release,generation,deployment,{releaseSha:release,deploymentId:deployment,canonicalAlias:'katie-mu.vercel.app',conclusion:'success',candidateSha:head,additionalPaidInference:0,testedTree:'e'.repeat(40),pullRequest:'1198',ciRunId:'123456'}]);
 await install('supabase/migrations/20261128194010_authorized_final_assessment_continuity.sql');
 const preview={url:'https://demo-abcdef123-owner.vercel.app'+p.spec.finalContract.path,headSha:head,deploymentId:123,statusId:456,provider:'vercel',immutable:true};
 const browser={version:1,projectId:project,contractHash:r.binding.contractHash,headSha:head,deploymentId:123,statusId:456,url:preview.url,checkedAt:new Date().toISOString(),passed:true,checks:p.spec.finalContract.scenarios.map(s=>({name:s.name,passed:true,detail:'Actual controlled browser fixture'}))};
 const {deploymentId,statusId,url,checkedAt,...acceptance}=browser;
 const changedFiles=r.binding.allowedPaths.map(path=>({path:path.endsWith('/')?path+'fixture.ts':path}));
 const verification={observedHeadSha:head,testedHeadSha:head,reviewedHeadSha:head,sourceTreeSha:tree,reviewSettlement:{receiptId:settlement,authorizationId:authorization,scopeHash:p.approved_hash,contractHash:r.binding.contractHash},changedFiles,packageDelta:{baseSha:r.binding.baseSha,headSha:head,changedFiles},preview,projectAcceptance:acceptance};
 const consume=async()=> (await one('select project_consume_development_review_settlement($1,$2,$3,$4,$5,$6,$7) v',[taskId,settlement,release,generation,deployment,verification,browser])).v;
 assert.equal((await consume()).consumed,true);
 const originalEvent=(await one("select data from project_events where project_id=$1 and event='development_review_settlement_consumed'",[project])).data;
 const snapshot=async()=>({nodes:(await db.query('select to_jsonb(n) v from project_organization_nodes n where project_id=$1 order by id',[project])).rows,exceptions:(await db.query('select to_jsonb(e) v from project_organization_exceptions e where project_id=$1 order by id',[project])).rows,requests:(await db.query('select to_jsonb(q) v from project_provider_requests q where project_id=$1 order by id',[project])).rows,task:(await one('select to_jsonb(t) v from agent_tasks t where id=$1',[taskId])).v});
 const before=await snapshot();
 await db.query(readFileSync('supabase/migrations/20261128193901_single_package_reviewed_completion.sql','utf8'));
 const deny=async(sql,args,pattern=/authority|assignment|independent|bound/)=>{
  await db.query('savepoint single_package_negative');
  try{await db.query(sql,args);await assert.rejects(consume(),pattern);}finally{await db.query('rollback to savepoint single_package_negative');await db.query('release savepoint single_package_negative');}
 };
 await deny("update mission_assignments set attempts=1 where mission_id=$1 and role='compose'",[m.id]);
 await deny('update work_projects set lease=$2 where id=$1',[project,randomUUID()]);
 await deny("update mission_assignments set result='{}' where id=$1",[taskId],/assignment/);
 await db.query('set role service_role');
 await rejects(()=>db.query('select project_advance_consumed_single_package($1,$2,$3,$4)',[taskId,release,generation,deployment]),/permission denied/);
 assert.equal((await consume()).consumed,true);
 await db.query('reset role');
 const advanced=await one('select * from work_projects where id=$1',[project]);
 assert.equal(advanced.status,'running');assert.equal(advanced.phase,'assessment');assert.equal(advanced.verified_sha,head);
 assert.equal(advanced.active_mission_id,null);assert.equal(advanced.lease,null);assert.equal(advanced.lease_until,null);
 assert.deepEqual(advanced.preview,{...preview,browserAcceptance:browser});
 assert.equal(advanced.token_allowance,p.token_allowance);assert.equal(advanced.max_missions,p.max_missions);assert.equal(+advanced.deadline,+p.deadline);
 const superseded=(await db.query("select role,status,attempts,result from mission_assignments where mission_id=$1 and role in('compose','review') order by role",[m.id])).rows;
 assert.deepEqual(superseded.map(x=>[x.role,x.status,x.attempts,x.result]),[['compose','stopped',0,null],['review','stopped',0,null]]);
 const finished=await one('select status,result from agent_missions where id=$1',[m.id]);assert.equal(finished.status,'completed');assert.equal(JSON.parse(finished.result).wholeProjectAssessment,'pending');
 assert.deepEqual(await snapshot(),before,'No hierarchy, exceptions, provider requests or original BLOCKED task changed');
 assert.deepEqual((await one("select data from project_events where project_id=$1 and event='development_review_settlement_consumed'",[project])).data,originalEvent);
 assert.equal((await consume()).consumed,true);
 assert.equal((await one("select count(*)::int n from project_events where project_id=$1 and event='single_package_development_completed'",[project])).n,1);
 await rejects(()=>db.query("update project_events set data='{}' where project_id=$1 and event='single_package_development_completed'",[project]),/append-only/);
 // The real source-bound completion trigger still prevents early or fabricated
 // final acceptance. The second suite exercises actual assessment provider work.
 await rejects(()=>db.query("update work_projects set status='completed' where id=$1",[project]),/assessment|Director|independent/i);
 // Exercise the existing scheduler, lifecycle child creation, SMART admission,
 // provider request/capture and real mission commit functions. Provider output
 // is synthetic; no external provider or network request is made by this test.
 // The enclosing historical suite uses one transaction. This default models
 // a later worker transaction without rewriting any existing mission row.
 await db.query('alter table agent_missions alter column created_at set default clock_timestamp()');
 // The large historical fixture also owns unrelated runnable examples.
 // Isolate scheduling within this rollback-only scenario, not its authority.
 await db.query("update work_projects set status='paused' where id<>$1 and status='running'",[project]);
 await db.query("update agent_missions set status='stopped' where project_id is distinct from $1 and status='running'",[project]);
 const claimed=(await one('select claim_work_project() p')).p;
 assert.equal(claimed.id,project);assert.equal(claimed.phase,'assessment');
 assert.equal((await one('select project_org_schedule($1,$2) result',[project,claimed.lease])).result,null);
 const finalEvidence=(await one('select outcome from project_runs where mission_id=$1',[m.id])).outcome;
 const assessmentEvidence={approvedScopeHash:p.approved_hash,approvedFinalContract:p.spec.finalContract,preview:advanced.preview,finalIntegratedEvidence:finalEvidence};
 const child={kind:'assessment',objective:p.objective+'\nIndependently verify the complete approved outcome and all six checks.',evidence:assessmentEvidence};
 assert.equal((await one("select finish_work_project($1,$2,'child',$3) ok",[project,claimed.lease,child])).ok,true);
 const assessmentId=(await one('select active_mission_id from work_projects where id=$1',[project])).active_mission_id;
 const assessmentNodes=(await db.query('select to_jsonb(n) v from project_organization_nodes n where project_id=$1 order by id',[project])).rows;
 const checks=['requirement:assigned-outcome','criterion:1','criterion:2','overall-objective','factual-support','prior-findings'].map(id=>({id,passed:true,evidence:'Verified exact approved source, immutable deployed contract and retained prior findings.'}));
 const deliverable='The complete approved application is verified at the immutable preview.';
 const capture=async(claim,body)=>{
  const list=randomUUID(),request=randomUUID(),requestHash='e'.repeat(64);
  assert.equal((await one("select project_provider_request($1,$2,$3,'model-list',$4) ok",[claim.job.id,claim.job.lease,list,requestHash])).ok,true);
  assert.equal((await one("select project_provider_request($1,$2,$3,'model-list',$4,null,'fixture-catalog') ok",[claim.job.id,claim.job.lease,list,requestHash])).ok,true);
  assert.equal((await one("select project_provider_request($1,$2,$3,'inference',$4) ok",[claim.job.id,claim.job.lease,request,requestHash])).ok,true);
  const response={status:'completed',text:JSON.stringify(body),model:'gpt-5.4',output:[],usage:{total_tokens:50}};
  assert.equal((await one('select project_org_package_capture_response($1,$2,$3,$4,$5,$6) ok',[claim.job.id,claim.job.lease,request,requestHash,'fixture-response-'+request,response])).ok,true);
  return request;
 };
 await db.query('set role service_role');
 const compose=(await one('select claim_mission_work_release_epoch($1,$2,$3) r',[release,generation,deployment])).r;
 assert.equal(compose.mission.id,assessmentId);assert.equal(compose.job.role,'compose');
 const composeRequest=await capture(compose,{deliverable,composerNotes:''});
 assert.equal((await one("select commit_mission_work($1,$2,$3,'[]'::jsonb,'completed',null,null) ok",[compose.job.id,compose.job.lease,{text:deliverable,composerNotes:'',model:'gpt-5.4',sources:[],calculations:[]}])).ok,true);
 const review=(await one('select claim_mission_work_release_epoch($1,$2,$3) r',[release,generation,deployment])).r;
 assert.equal(review.mission.id,assessmentId);assert.equal(review.job.role,'review');assert.notEqual(compose.job.agent_id,review.job.agent_id);
 const reviewRequest=await capture(review,{verdict:'approve',findings:'All approved requirements supported by exact immutable evidence.',checks});
 assert.equal((await one("select commit_mission_work($1,$2,$3,'[]'::jsonb,'completed','completed',$4) ok",[review.job.id,review.job.lease,{verdict:'pass',checks,model:'gpt-5.4',findings:['All approved requirements supported by exact immutable evidence.']},deliverable])).ok,true);
 await db.query('reset role');
 const finalProject=(await one('select claim_work_project() p')).p;assert.equal(finalProject.id,project);
 const completion={result:deliverable,preview,verified_head:head,reviewedMissionId:assessmentId,receipt:{version:1,projectId:project,taskId,developmentMissionId:m.id,assessmentMissionId:assessmentId,verifiedSha:head,approvedScopeHash:p.approved_hash,finalContractHash:r.binding.contractHash,browserAcceptance:browser}};
 const complete=()=>one("select finish_work_project($1,$2,'complete',$3) ok",[project,finalProject.lease,completion]);
 const rejectFinal=async(sql,args,pattern=/assessment|bound|financial|authority/i)=>{
  await db.query('savepoint tampered_final');
  try{await assert.rejects(async()=>{await db.query(sql,args);await complete();},pattern);}finally{await db.query('rollback to savepoint tampered_final');await db.query('release savepoint tampered_final');}
 };
 await rejectFinal("update mission_assignments set result=jsonb_set(result,'{checks,0,evidence}','\"Invented evidence\"') where id=$1",[review.job.id]);
 await rejectFinal("update mission_assignments set result=jsonb_set(result,'{text}','\"Invented composition\"') where id=$1",[compose.job.id]);
 await rejectFinal("update agent_missions set project_evidence=jsonb_set(project_evidence,'{approvedScopeHash}','\"wrong scope\"') where id=$1",[assessmentId],/immutable|assessment|bound/);
 await rejectFinal("update work_projects set preview=jsonb_set(preview,'{browserAcceptance,headSha}',to_jsonb($2::text)) where id=$1",[project,'f'.repeat(40)]);
 // Seed malformed/failed captured responses only inside rolled-back fixture
 // savepoints. Their immutable hashes are valid; mutable claimed pass results
 // must still never override what the provider actually returned.
 for(const raw of [
  {verdict:'revise',findings:'A required behavior failed.',checks:checks.map((c,i)=>i?c:{...c,passed:false})},
  {verdict:'approve',findings:'Malformed boolean',checks:checks.map((c,i)=>i?c:{...c,passed:'true'})},
  {verdict:'approve',findings:'Malformed evidence',checks:checks.map((c,i)=>i?c:{...c,evidence:{invented:true}})},
  {verdict:'approve',findings:'Malformed clarification',checks,clarification:{essential:false}},
 ]){
  await db.query('savepoint malformed_paid_response');
  try{
   await db.query('alter table project_package_paid_responses disable trigger package_paid_response_immutable');
   await db.query("update project_package_paid_responses set response=jsonb_set(response,'{text}',to_jsonb($2::text)) where request_id=$1",[reviewRequest,JSON.stringify(raw)]);
   await db.query("update project_package_paid_responses set response_hash=encode(sha256(convert_to(project_canonical(response),'UTF8')),'hex') where request_id=$1",[reviewRequest]);
   await db.query('alter table project_package_paid_responses enable trigger package_paid_response_immutable');
   await db.query("update mission_assignments set result=jsonb_set(result,'{checks}',$2::jsonb) where id=$1",[review.job.id,JSON.stringify(raw.checks)]);
   await assert.rejects(complete(),/assessment|bound/i);
  }finally{await db.query('rollback to savepoint malformed_paid_response');await db.query('release savepoint malformed_paid_response');}
 }
 await db.query('savepoint ordinary_hierarchy_still_required');
 try{
  await db.query('alter table project_events disable trigger project_review_settlement_consumption_guard');
  await db.query("delete from project_events where project_id=$1 and event='single_package_development_completed'",[project]);
  await db.query('alter table project_events enable trigger project_review_settlement_consumption_guard');
  await assert.rejects(complete(),/Project Director closure authorization required|Live checkpoint authority required/);
 }finally{await db.query('rollback to savepoint ordinary_hierarchy_still_required');await db.query('release savepoint ordinary_hierarchy_still_required');}
 assert.equal((await complete()).ok,true);
 assert.equal((await one('select status from work_projects where id=$1',[project])).status,'completed');
 const accepted=(await one("select data from project_events where project_id=$1 and event='single_package_project_accepted'",[project])).data;
 assert.equal(accepted.composeProviderRequestId,composeRequest);assert.equal(accepted.reviewProviderRequestId,reviewRequest);
 assert.deepEqual(accepted.review.checks,checks);assert.equal(accepted.historicalHierarchyUnchanged,true);
 assert.deepEqual((await db.query('select to_jsonb(n) v from project_organization_nodes n where project_id=$1 order by id',[project])).rows,assessmentNodes,'Direct project closure does not certify hierarchy nodes');
 assert.deepEqual((await db.query('select to_jsonb(e) v from project_organization_exceptions e where project_id=$1 order by id',[project])).rows,before.exceptions);
 assert.equal((await one('select count(*)::int n from project_organization_closures where project_id=$1',[project])).n,0);
 await rejects(()=>db.query("delete from project_events where project_id=$1 and event='single_package_project_accepted'",[project]),/append-only/);
 console.log('SINGLE_PACKAGE_CONSUMED_LIFECYCLE_NATIVE_PASS');
 console.log('SINGLE_PACKAGE_ACTUAL_FINAL_ASSESSMENT_NATIVE_PASS');
}
