import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';
const fixture=JSON.parse(readFileSync('tests/fixtures/take-eleven-specification-696.json','utf8'));
const load=modules(),helper=load('@/lib/projects/specification-recovery');
const old=fixture.jobs.find(j=>j.id==='31853738-0216-499c-b708-196b84781e30');
const latest=fixture.jobs.find(j=>j.id==='71e1c739-1088-4ccb-9ecb-9f38147561da');
const revised=fixture.jobs.find(j=>j.role==='revise');
test('real #696 artifacts select the latest usable revised content rather than the stale event composition',()=>{
 const recovery=helper.selectSpecificationRecovery(fixture.jobs,fixture.project.objective);
 assert.equal(recovery.checkpoint.sourceJobId,latest.id);
 assert.equal(recovery.checkpoint.text,revised.result.text);
 assert.notEqual(recovery.checkpoint.text,old.result.text);
 assert.equal(recovery.priorReviews.length,10);
 assert.match(JSON.stringify(recovery.priorReviews),/B→A|active.player|post.victory/);
 const duplicate={...latest,id:randomUUID(),updated_at:'2026-10-24T00:00:00Z'};
 const again=helper.selectSpecificationRecovery([...fixture.jobs,duplicate],fixture.project.objective);
 assert.equal(again.checkpoint.fullSpecificationHash,recovery.checkpoint.fullSpecificationHash);
 assert.equal(again.fingerprint,recovery.fingerprint,'new job IDs cannot turn equivalent work into progress');
});
test('invalid latest artifact retains diagnostics and falls back to saved valid work without regeneration',()=>{
 const corrupt={...latest,id:randomUUID(),updated_at:'2026-10-24T00:00:00Z',result:{text:'{"name":"broken"}'}};
 const r=helper.selectSpecificationRecovery([...fixture.jobs,corrupt],fixture.project.objective);
 assert.equal(r.checkpoint.text,latest.result.text);assert.equal(r.diagnostics[0].sourceJobId,corrupt.id);
 const only=helper.selectSpecificationRecovery([corrupt],fixture.project.objective);
 assert.equal(only.checkpoint,null);assert.equal(only.hasPriorDraft,true);
});
test('actual accounting preserves 940907 charged, 950000 authorization and 9093 remaining',()=>{
 const charged=fixture.runs.reduce((n,m)=>n+Math.max(m.actual_tokens,m.reserved_tokens),0);
 assert.equal(charged,940907);assert.equal(fixture.project.token_allowance-charged,9093);
 const required=helper.specificationProjectAdmission(true,1);
 assert.equal(required.missionTokens,90000);assert.equal(required.requiredTokens,330000);
 assert.equal(required.requiredMissionSlots,3);
 assert.ok(9093<required.requiredTokens);assert.equal(fixture.runs.length,fixture.project.max_missions);
});
test('full persisted review lineage plus research fits the actual 60000-character SQL envelope through an immutable artifact reference',()=>{
 const r=helper.selectSpecificationRecovery(fixture.jobs,fixture.project.objective),{text,...reference}=r.checkpoint;
 const evidence={projectProfile:'game',savedSpecificationCheckpoint:reference,
  reviewedResearch:{text:fixture.reviewedResearch.result,reviewedMissionId:fixture.reviewedResearch.reviewedMissionId},
  specificationRecovery:{fingerprint:r.fingerprint,priorReviews:r.priorReviews,diagnostics:r.diagnostics},
  completionContract:{version:1,ownerAgentId:randomUUID(),scopeHash:null,stoppingCondition:'Verify this exact original outcome.'},
  specificationBudget:{version:1,missionTokens:90000,futureTokens:240000,sourceHash:reference.fullSpecificationHash}};
 assert.equal(r.priorReviews.length,10);assert.ok(!('text' in reference));
 assert.ok(load('@/lib/projects/game-evidence').jsonbTextSize(evidence)<60000);
});
function harness(checkpoint=helper.selectSpecificationRecovery(fixture.jobs,fixture.project.objective).checkpoint){
 const commits=[],modelInputs=[];
 const team=[{id:randomUUID(),config:{instructions:'Specify only the original outcome.'}},{id:randomUUID(),config:{instructions:'Independently review the original outcome.'}}];
 const mission={id:randomUUID(),project_id:fixture.project.id,project_kind:'specification',objective:fixture.project.objective,status:'running',team,
  project_evidence:{projectProfile:'game',savedSpecificationCheckpoint:checkpoint,reviewedResearch:{text:fixture.reviewedResearch.result,reviewedMissionId:fixture.reviewedResearch.reviewedMissionId},
   specificationRecovery:{priorReviews:helper.selectSpecificationRecovery(fixture.jobs,fixture.project.objective).priorReviews}}};
 const jobs=[];
 const runtime=modules({'@/lib/missions/inspection':{workflowInspection:async()=>null},'@/lib/missions/store':{
  readMission:async(id)=>id===mission.id?({mission,jobs}):({mission:{project_id:mission.project_id,project_kind:'specification'},jobs:[latest]}),rpc:async(name,args)=>{assert.equal(name,'commit_mission_work');commits.push(args);return true;}
 }});
 const job=(role,key)=>({id:randomUUID(),mission_id:mission.id,job_key:key,role,agent_id:team[role==='review'?1:0].id,
  instruction:'Preserve original requirements and address the saved independent findings.',status:'running',payload:{},result:null,dependencies:[],attempts:1});
 return {mission,jobs,job,commits,modelInputs,execute:runtime('@/lib/missions/worker').executeClaim,ids:runtime('@/lib/projects/completion').PROJECT_ACCEPTANCE_IDS};
}
test('fresh and rejected game specification calls receive the exact serialization contract without bypassing validation',async()=>{
 for(const retry of [false,true]){
  const h=harness(null),compose=h.job('compose','compose');h.jobs.push(compose);
  if(retry)compose.result={rejectedSpecification:'{"name":"broken"}',specificationValidationFeedback:'schemaVersion/game required'};
  await assert.rejects(h.execute({mission:h.mission,job:compose},async(_,instruction,input)=>{
   assert.match(instruction,/rules = \{schemaVersion:1, game:\{id,title,edition,kind/);
   assert.match(instruction,/expectedState:COMPLETE_JSON_STATE/);
   assert.match(instruction,/Final milestone contract equals finalContract/);
   assert.match(input,/Take Eleven/);
   if(retry)assert.match(input,/schemaVersion\/game required/);
   return {text:'{"name":"broken"}'};
  }),/Invalid game specification/);
  assert.equal(h.commits.length,0,'schema instructions never manufacture a valid candidate or approval');
 }
});
test('schema retry fits counted input and reduced output inside the same stage while protecting future review',async()=>{
 let capacity={authorized:true,remainingTokens:104000,stageRemainingTokens:14000,callsRemaining:8,routingCallsRemaining:8};
 const runtime=modules({'@/lib/missions/store':{rpc:async(name)=>{assert.equal(name,'specification_call_capacity');return capacity;}}});
 const budget=runtime('@/lib/missions/request-budget'),h=harness(null);
 const claim={mission:{...h.mission,project_evidence:{projectProfile:'game',specificationBudget:{version:1}}},job:h.job('compose','compose')};
 assert.equal(await budget.specificationRetryOutputLimit(claim,6500,16000),16000,'first composition unchanged');
 claim.job.result={rejectedSpecification:'saved invalid draft'};
 assert.equal(budget.specificationRoutingOutputFloor(claim,''),6000);
 assert.equal(await budget.specificationRetryOutputLimit(claim,6500,16000),7500);
 await budget.assertSpecificationStageCapacity(claim,14000);
 await assert.rejects(budget.specificationRetryOutputLimit(claim,8500,16000),/reserved tokens|allowance/);
 capacity={...capacity,remainingTokens:95000};
 await assert.rejects(budget.specificationRetryOutputLimit(claim,6500,16000),/reserved tokens|allowance/);
 capacity={...capacity,authorized:false};
 await assert.rejects(budget.specificationRetryOutputLimit(claim,1,16000),/authorized|allowance/);
});
test('live-sized saved candidate is reused with zero inference; current review receives original research and full findings',async()=>{
 const h=harness();const compose=h.job('compose','compose');h.jobs.push(compose);
 await h.execute({mission:h.mission,job:compose},async()=>assert.fail('Saved specification must not be regenerated'));
 compose.status='completed';compose.result=h.commits.at(-1).p_result;
 const review=h.job('review','review');h.jobs.push(review);
 await h.execute({mission:h.mission,job:review},async(_,instruction,input)=>{
  h.modelInputs.push(input);assert.ok(input.length<96000);
  assert.match(input,/Take Eleven research brief/);assert.match(input,/post.victory|B→A/);
  assert.equal((input.match(/Server-validated lossless|contractRef and stepsRef resolve/g)??[]).length,1);
  return {text:JSON.stringify({verdict:'approve',findings:'Controlled review checked the actual latest saved specification.',checks:h.ids.map(id=>({id,passed:true,evidence:'Checked source rules, original constraints and current fixture assertions.'}))}),model:'offline-independent-fixture'};
 });
 assert.equal(h.modelInputs.length,1);assert.equal(h.commits.at(-1).p_mission_status,'completed');
 assert.equal(h.commits.at(-1).p_final,JSON.stringify(JSON.parse(latest.result.text)));
});
test('known feedback can revise the saved candidate and fresh final review remains bounded to one repair',async()=>{
 const h=harness({...helper.selectSpecificationRecovery([old],fixture.project.objective).checkpoint});
 const compose=h.job('compose','compose');h.jobs.push(compose);
 await h.execute({mission:h.mission,job:compose},async()=>assert.fail('No fresh composition'));
 compose.status='completed';compose.result=h.commits.at(-1).p_result;
 const review=h.job('review','review');h.jobs.push(review);
 const model=async(claim,_,input)=>{
  h.modelInputs.push(input);
  if(claim.job.role==='revise'){
   assert.ok(input.length<96000);assert.match(input,/Next.js/);assert.match(input,/priorReviewFindings/);
   return {text:revised.result.text,model:'offline-revision-fixture'};
  }
  const pass=claim.job.job_key==='review_again';
  return {text:JSON.stringify({verdict:pass?'approve':'revise',findings:pass?'Original feedback is resolved.':'Preserve Next.js and deployment prohibitions; assert A→B→A and all post-win fields.',checks:h.ids.map(id=>({id,passed:pass||id!=='prior-findings',evidence:pass?'Checked corrected fixture assertions.':'Original review feedback remains unresolved.'}))}),model:'offline-review-fixture'};
 };
 await h.execute({mission:h.mission,job:review},model);review.status='completed';review.result=h.commits.at(-1).p_result;
 const revision=h.job('revise','revision');h.jobs.push(revision);
 await h.execute({mission:h.mission,job:revision},model);revision.status='completed';revision.result=h.commits.at(-1).p_result;
 const again=h.job('review','review_again');h.jobs.push(again);await h.execute({mission:h.mission,job:again},model);
 assert.equal(h.modelInputs.length,3);assert.equal(h.commits.at(-1).p_children.length,0);assert.equal(h.commits.at(-1).p_mission_status,'completed');
 const plan=JSON.parse(h.commits.at(-1).p_final),steps=plan.finalContract.scenarios.find(s=>s.name==='b-a-win').steps;
 assert.equal(steps[3].action,'expectText');assert.equal(steps[3].value,'A');
 const after=steps.slice(steps.findLastIndex(s=>s.action==='click')+1);
 assert.deepEqual(after.map(s=>s.value),['0','FINISHED','A','A']);
 assert.match(plan.requirements.join(' '),/Next.js/);
 assert.deepEqual(plan.allowedPaths,JSON.parse(old.result.text).allowedPaths);
});
test('invalid checkpoint blocks instead of silently paying for a blank specification',async()=>{
 const h=harness({status:'unreviewed',text:'{"name":"broken"}'});
 await assert.rejects(h.execute({mission:h.mission,job:h.job('compose','compose')},async()=>assert.fail('No paid regeneration')),/regeneration is not authorized/);
});
test('checkpoint references are hydrated and hash-checked without inference',async()=>{
 const r=helper.selectSpecificationRecovery(fixture.jobs,fixture.project.objective),{text,...reference}=r.checkpoint;
 const h=harness(reference),compose=h.job('compose','compose');
 await h.execute({mission:h.mission,job:compose},async()=>assert.fail('No regeneration'));
 assert.equal(h.commits.at(-1).p_result.text,JSON.stringify(JSON.parse(text)));
});
test('ordinary software specification recovery and full-history independent review fit without repeated evidence',async(t)=>{
 const plan=JSON.parse(revised.result.text);delete plan.game;
 const r=helper.selectSpecificationRecovery([{...revised,result:{text:JSON.stringify(plan)}}],fixture.project.objective);
 const h=harness(r.checkpoint);h.mission.project_evidence.projectProfile='software';
 const compose=h.job('compose','compose');h.jobs.push(compose);
 await h.execute({mission:h.mission,job:compose},async()=>assert.fail('No paid ordinary-spec compose'));
 assert.equal(h.commits.at(-1).p_result.text,JSON.stringify(plan));
 compose.status='completed';compose.result=h.commits.at(-1).p_result;
 const review=h.job('review','review');h.jobs.push(review);
 const expected=h.mission.project_evidence.specificationRecovery.priorReviews;
 await h.execute({mission:h.mission,job:review},async(claim,instruction,input)=>{
  h.modelInputs.push(input);
  const payload=JSON.parse(input.split('\nEvidence and candidate:\n')[1]);
  assert.equal(payload.projectEvidence.specificationRecovery,undefined);
  assert.equal(payload.projectEvidence.savedSpecificationCheckpoint,undefined);
  assert.equal(payload.projectEvidence.reviewedResearch.text,fixture.reviewedResearch.result);
  assert.equal(payload.objective,fixture.project.objective);
  assert.deepEqual(JSON.parse(payload.candidate.result.text),plan);
  assert.equal(payload.priorFindings.length,10);
  for(const original of expected){
   const actual=payload.priorFindings.find(r=>r.key===original.sourceJobId);
   assert.deepEqual(actual.findings,original.findings);
   assert.deepEqual(actual.failedChecks,original.failedChecks);
   assert.equal(actual.clarification,original.clarification);
   if(original.summary)assert.equal(actual.summary,original.summary);
  }
  const budget=load('@/lib/missions/request-budget');
  assert.ok(budget.fitsMissionEnvelope(instruction,input,budget.missionInputLimit(claim)));
  assert.ok(input.length<=96000);
  t.diagnostic(`Ordinary specification review: ${input.length} characters, ten historical reviews supplied once.`);
  assert.equal(budget.missionOutputLimit(claim,input),5000);
  assert.equal(budget.missionInputLimit({...claim,job:{...claim.job,role:'compose'}}),48000,'ordinary composition limits are unchanged');
  return {text:JSON.stringify({verdict:'approve',findings:'All retained ordinary-specification findings checked.',checks:h.ids.map(id=>({id,passed:true,evidence:'Checked complete original scope and saved findings.'}))}),model:'offline-independent-fixture'};
 });
 assert.equal(h.modelInputs.length,1);assert.equal(h.commits.at(-1).p_mission_status,'completed');
});
test('ordinary saved specification completes full-history review, bounded revision and final independent review',async(t)=>{
 const original=JSON.parse(old.result.text),fixed=JSON.parse(revised.result.text);delete original.game;delete fixed.game;
 const r=helper.selectSpecificationRecovery([{...old,result:{text:JSON.stringify(original)}}],fixture.project.objective);
 const h=harness(r.checkpoint);h.mission.project_evidence.projectProfile='software';
 const compose=h.job('compose','compose');h.jobs.push(compose);
 await h.execute({mission:h.mission,job:compose},async()=>assert.fail('No regenerated specification'));
 compose.status='completed';compose.result=h.commits.at(-1).p_result;
 const calls=[],budget=load('@/lib/missions/request-budget');
 const model=async(claim,instruction,input)=>{
  calls.push(claim.job.job_key);
  assert.ok(budget.fitsMissionEnvelope(instruction,input,budget.missionInputLimit(claim)));
  if(claim.job.role==='revise'){
   const payload=JSON.parse(input);
   assert.equal(payload.projectEvidence.specificationRecovery,undefined);
   assert.equal(payload.projectEvidence.savedSpecificationCheckpoint,undefined);
   assert.equal(payload.projectEvidence.reviewedResearch.text,fixture.reviewedResearch.result);
   for(const historical of h.mission.project_evidence.specificationRecovery.priorReviews){
    assert.deepEqual(payload.priorReviewFindings.find(r=>r.key===historical.sourceJobId).findings,historical.findings);
   }
   assert.ok(input.length>48000,'actual full history requires the recovered revision input allowance');
   assert.equal(budget.missionOutputLimit(claim,input),6000,'retained input does not increase output allowance');
   t.diagnostic(`Ordinary specification revision: ${input.length} characters, output ceiling unchanged at 6000.`);
   return {text:JSON.stringify(fixed),model:'offline-revision-fixture'};
  }
  const payload=JSON.parse(input.split('\nEvidence and candidate:\n')[1]);
  assert.equal(payload.projectEvidence.specificationRecovery,undefined);
  assert.equal(payload.priorFindings.filter(r=>r.recovered).length,10);
  const pass=claim.job.job_key==='review_again';
  assert.deepEqual(JSON.parse(payload.candidate.result.text),pass?fixed:original);
  return {text:JSON.stringify({verdict:pass?'approve':'revise',findings:pass?'Saved feedback resolved.':'Preserve Next.js and all deployment prohibitions; assert A→B→A and full post-win state.',checks:h.ids.map(id=>({id,passed:pass||id!=='prior-findings',evidence:pass?'Current repaired candidate checked.':'Retained independent findings require repair.'}))}),model:'offline-review-fixture'};
 };
 for(const [role,key] of [['review','review'],['revise','revision'],['review','review_again']]){
  const job=h.job(role,key);h.jobs.push(job);await h.execute({mission:h.mission,job},model);
  job.status='completed';job.result=h.commits.at(-1).p_result;
 }
 assert.deepEqual(calls,['review','revision','review_again']);
 assert.equal(h.commits.at(-1).p_children.length,0);assert.equal(h.commits.at(-1).p_mission_status,'completed');
 assert.deepEqual(JSON.parse(h.commits.at(-1).p_final),fixed);
 assert.deepEqual(fixed.requirements,JSON.parse(revised.result.text).requirements);
 assert.deepEqual(fixed.allowedPaths,original.allowedPaths);
});
test('oversized ordinary recovery findings stop before inference without deleting saved evidence',async()=>{
 const plan=JSON.parse(revised.result.text);delete plan.game;
 const r=helper.selectSpecificationRecovery([{...revised,result:{text:JSON.stringify(plan)}}],fixture.project.objective);
 const h=harness(r.checkpoint);h.mission.project_evidence.projectProfile='software';
 const compose=h.job('compose','compose');h.jobs.push(compose);
 await h.execute({mission:h.mission,job:compose},async()=>assert.fail('No fresh composition'));
 compose.status='completed';compose.result=h.commits.at(-1).p_result;
 const evidence=h.mission.project_evidence;
 evidence.specificationRecovery.priorReviews.push({sourceJobId:randomUUID(),findings:['Retained additional finding. '.repeat(4000)],failedChecks:[]});
 const saved=JSON.stringify(evidence);
 await assert.rejects(h.execute({mission:h.mission,job:h.job('review','review')},async()=>assert.fail('Oversized review must not dispatch')),e=>e.partial?.reviewContextOverflow===true);
 assert.equal(JSON.stringify(evidence),saved);
});
test('recovery equivalence includes authoritative requirements, not changing reviews or copied job IDs',()=>{
 const r=helper.selectSpecificationRecovery(fixture.jobs,fixture.project.objective);
 const key=helper.specificationRecoveryKey(r.checkpoint.fullSpecificationHash,fixture.project.objective,fixture.project.clarifications);
 const changedFeedback=helper.selectSpecificationRecovery([...fixture.jobs,{...fixture.jobs.find(j=>j.role==='review'),id:randomUUID(),result:{findings:['New reviewer wording.'],verdict:'changes_requested'}}],fixture.project.objective);
 assert.equal(helper.specificationRecoveryKey(changedFeedback.checkpoint.fullSpecificationHash,fixture.project.objective,fixture.project.clarifications),key);
 assert.notEqual(helper.specificationRecoveryKey(r.checkpoint.fullSpecificationHash,fixture.project.objective+' Explicit user requirement.',fixture.project.clarifications),key);
 assert.notEqual(helper.specificationRecoveryKey(r.checkpoint.fullSpecificationHash,fixture.project.objective,fixture.project.clarifications+' USER CLARIFICATION: PLAYING is the approved phase label.'),key);
});
test('actual project worker permits clarified recovery but blocks identical candidate and authoritative scope',async()=>{
 const p={...fixture.project,id:randomUUID(),profile:'software',active_mission_id:null,status:'running',lease:randomUUID(),milestone_index:0};
 const recovered=helper.selectSpecificationRecovery(fixture.jobs,fixture.project.objective);
 const previous={id:randomUUID(),sourceHash:recovered.checkpoint.fullSpecificationHash,recoveryKey:helper.specificationRecoveryKey(recovered.checkpoint.fullSpecificationHash,p.objective,p.clarifications)};
 const calls=[];
 const db={from:table=>{
  const filters=[];const chain={select(){return this;},eq(k,v){filters.push([k,v]);return this;},in(){return this;},order(){return this;},limit(){return this;},returns(){return this;},
   then(resolve){const data=table==='mission_assignments'?fixture.jobs:table==='project_events'?[previous].filter(e=>filters.every(([k,v])=>k.startsWith('data->>')?e[k.slice(7)]===v:true)):[];return Promise.resolve({data,error:null}).then(resolve);}};return chain;
 }};
 const runs=[{kind:'specification',mission_id:latest.mission_id},{kind:'research',mission_id:randomUUID()}];
 const runtime=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/projects/specialist-dispatch':{runSpecialistResourceBatch:async()=>{}},
  '@/lib/projects/recovery-budget':{announceBlockedRecoveryResources:async()=>{}},
  '@/lib/projects/store':{projectRpc:async(name,args)=>{if(name==='claim_work_project')return p;if(name==='project_dispatch_recovery_candidates')return [];assert.equal(name,'finish_work_project');calls.push(args);return true;},projectRuns:async()=>runs,
   milestoneEvidence:async()=>[{phase:'research',missionStatus:'completed',result:fixture.reviewedResearch.result,evidence:{}}]}})('@/lib/projects/worker');
 await runtime.runProjectBatch();assert.equal(calls.at(-1).p_action,'block');assert.match(calls.at(-1).p_data.detail,/already attempted/);
 p.clarifications+=' USER CLARIFICATION: PLAYING is the approved phase label.';
 await runtime.runProjectBatch();assert.equal(calls.at(-1).p_action,'child');assert.match(calls.at(-1).p_data.objective,/USER CLARIFICATION/);
 assert.equal(calls.at(-1).p_data.evidence.savedSpecificationCheckpoint.fullSpecificationHash,previous.sourceHash);
 previous.recoveryKey=helper.specificationRecoveryKey(previous.sourceHash,p.objective,p.clarifications);
 await runtime.runProjectBatch();assert.equal(calls.at(-1).p_action,'block');
});
test('checkpoint persistence failures retain their actual failure classification',async()=>{
 const r=helper.selectSpecificationRecovery(fixture.jobs,fixture.project.objective),h=harness(r.checkpoint);
 const runtime=modules({'@/lib/missions/inspection':{workflowInspection:async()=>null},'@/lib/missions/store':{readMission:async()=>({mission:h.mission,jobs:[]}),rpc:async()=>{throw Error('Checkpoint persistence transport failed');}}});
 await assert.rejects(runtime('@/lib/missions/worker').executeClaim({mission:h.mission,job:h.job('compose','compose')},async()=>assert.fail('No generation')),/Checkpoint persistence transport failed/);
});
test('routing cannot spend the mandatory execution output or future-stage headroom',async()=>{
 let reservedRouting=0;
 const runtime=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>({from:table=>{assert.equal(table,'benchmark_full_project_bindings');const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:null,error:null})};return q;}})},'@/lib/missions/store':{rpc:async(name)=>{
  if(name==='specification_call_capacity')return {authorized:true,remainingTokens:90000,stageRemainingTokens:9000,callsRemaining:8,routingCallsRemaining:8};
  if(name==='reserve_mission_routing_call')reservedRouting++;
  return true;
 }},'@/lib/orchestration/routing':{orchestrationChoices:async(input)=>{await input.accounting.reserve('routing:fixture',5000);assert.fail('Doomed routing must be denied before provider dispatch');}}});
 const h=harness(),claim={mission:{...h.mission,deadline:new Date(Date.now()+3600000).toISOString(),project_evidence:{specificationBudget:{version:1},projectProfile:'game'}},job:h.job('review','review')};
 await assert.rejects(runtime('@/lib/missions/model').missionModel(claim,'Independently review.','Independent assessment:\nlarge specification'),/allowance/);
 assert.equal(reservedRouting,0);
});
test('actual request admission protects required later stages, including provider fallback or retry',async()=>{
 let remaining=90000;
 const budget=modules({'@/lib/missions/store':{rpc:async()=>({authorized:true,remainingTokens:remaining,stageRemainingTokens:40000,callsRemaining:8,routingCallsRemaining:8})}})('@/lib/missions/request-budget');
 const claim={mission:{project_kind:'specification',project_evidence:{specificationBudget:{version:1}}},job:{role:'review',job_key:'review'}};
 await budget.assertSpecificationStageCapacity(claim,24000);
 remaining=65000;await assert.rejects(budget.assertSpecificationStageCapacity(claim,24000),/allowance/);
 claim.job={role:'revise',job_key:'revision'};remaining=50000;
 await assert.rejects(budget.assertSpecificationStageCapacity(claim,40000),/allowance/);
 remaining=90000;await assert.rejects(budget.assertSpecificationStageCapacity(claim,40001),/allowance/);
 claim.job={role:'review',job_key:'review_again'};remaining=24000;await budget.assertSpecificationStageCapacity(claim,24000);
});

test('production Full reserves bounded assessment without increasing project or stage authorizations',()=>{
 const full=helper.specificationProjectAdmission(false,1,60000);
 assert.equal(full.missionTokens,120000);assert.equal(full.futureTokens,180000);assert.equal(full.requiredTokens,300000);
 assert.ok(full.requiredTokens<=350000-31887);
 assert.equal(helper.specificationProjectAdmission(false,1).requiredTokens,360000,'ordinary and staging budgets unchanged');
 assert.equal(helper.specificationProjectAdmission(false,2,60000).requiredTokens,420000,'extra milestones cannot evade headroom');
});
