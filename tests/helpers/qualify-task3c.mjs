// Task 3C: continue Task 3B's actual three-repair/two-interruption host
// directly through the original mission and project completion workers.
// Only provider, owner identity, GitHub and Vercel transports are synthetic.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {modules} from './load-project-modules.mjs';
import {previewTransport} from './lifecycle-preview-transport.mjs';
import {completionTransport} from './lifecycle-completion-transport.mjs';
import {postgresClient,githubTransport} from './lifecycle-qualification-adapters.mjs';
import {archive} from './qualify-lifecycle-continuation.mjs';
import config from '../../config/benchmark-715-production-qualification.json' with {type:'json'};

const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function qualifyTask3cCompletion(db,ids,fixture,engineering,host) {
 const {root,remote,context,baseline,one}=fixture;
 const receipt=JSON.parse(readFileSync(host.evidence,'utf8'));
 const browser=JSON.parse(readFileSync(join(host.runtime,'qualification-browser-acceptance.json'),'utf8'));
 const verifier=JSON.parse(readFileSync(join(host.runtime,'qualification-verifier-tail.json'),'utf8'));
 assert.equal(engineering.attempts.length,3);
 assert.deepEqual(engineering.attempts.map(x=>x.run),[131,132,133]);
 assert.ok(engineering.trace.filter(x=>x.phase==='repair'&&x.event==='completed').length>=3);
 assert.equal(engineering.authorizations.length,2);
 assert.equal(receipt.completed,true);
 assert.equal(receipt.taskId,ids.task);
 assert.equal(receipt.repairIterations,3);
 assert.equal(receipt.finalReview.verdict,'pass');
 assert.equal(browser.passed,true);
 assert.equal(browser.projectId,ids.project);
 assert.equal(browser.headSha,receipt.reviewedHeadSha);
 assert.equal(browser.contractHash,context.contractHash);

 const trace=[{stage:'actual-native-host',taskId:ids.task,projectId:ids.project,threeRepairs:true,twoInterruptions:true,head:receipt.reviewedHeadSha,sourceHash:engineering.finalSourceHash}];
 const report={version:1,taskId:ids.task,projectId:ids.project,scopeHash:ids.scopeHash,baseline,syntheticOnly:true,paidInference:0,engineering:{attempts:engineering.attempts,trace:engineering.trace,authorizations:engineering.authorizations,receipt},events:trace,negativeCases:[],limitations:['Synthetic nonbillable provider, owner, GitHub and Vercel transports; actual pinned SDK, sandbox, PostgreSQL and Chromium.','The final browser uses the local immutable candidate, not a live Vercel deployment.','Trusted recovery diagnostics have approximately seven-day retention.','This does not prove paid-model engineering performance.']};
 const output=join(process.env.RUNNER_TEMP??root,'task3c-qualification');mkdirSync(output,{recursive:true});
 const oldEnv={...process.env},oldFetch=globalThis.fetch;
 const issue={number:829,user:{login:'mfackrell'},html_url:'https://github.com/mfackrell/katie/issues/829',body:'Frozen synthetic Task 3C original development task '+ids.task};
 const release='e'.repeat(40);
 const workflow={id:133,status:'completed',conclusion:'success',event:'workflow_dispatch',path:'.github/workflows/autonomous-development.yml',head_branch:'main',head_sha:release,created_at:new Date().toISOString(),html_url:'https://github.com/mfackrell/katie/actions/runs/133',run_attempt:1,repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}};
 fixture.completion=receipt;fixture.continued=host;fixture.verifierLog=typeof verifier.tail==='string'?verifier.tail:JSON.stringify(verifier);
 fixture.receipt={version:1,repository:'mfackrell/katie',issue_number:829,run_id:133,pr_url:'https://github.com/mfackrell/katie/pull/829',outcome:'READY',tested_head_sha:receipt.reviewedHeadSha,reviewed_head_sha:receipt.reviewedHeadSha,checks:{build:'success',test:'true',review:'changes_requested',repair:'success',retest:'true',final_review:'pass'},projectAcceptance:browser};
 writeFileSync(join(root,'workflow.json'),JSON.stringify(workflow));
 writeFileSync(join(root,'artifact.zip'),archive(host.diagnostics));
 writeFileSync(join(root,'artifacts.json'),JSON.stringify({total_count:1,artifacts:[{id:133,name:'native-execution-diagnostics',expired:false,size_in_bytes:readFileSync(join(root,'artifact.zip')).length,workflow_run:{id:133,head_sha:release}}]}));
 const client=postgresClient({query:(...args)=>db.query(...args)},trace);
 // Load worker modules only AFTER synthetic fetch and credentials are installed.
 // VM modules capture fetch at load time; preloading silently probed the real
 // provider endpoint instead of the isolated /v1/models fixture.
 let load,worker,projects;
 const ledger=async()=>(await db.query('select to_jsonb(c) value from benchmark_budget_calls c where account_id=$1 order by id',[ids.account])).rows.map(x=>x.value);
 const historical=await ledger();
 try{
  Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:release,NEXT_PUBLIC_SUPABASE_URL:config.productionDatabaseUrl,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-role',KATIE_OWNER_AUTH_USER_ID:ids.owner,PROJECT_PREVIEW_HOST_PATTERN:'^katie-([a-z0-9]{9})-synthetic\\.vercel\\.app$',PROJECT_PREVIEW_BYPASS_SECRET:'',GITHUB_TOKEN:'synthetic-github',KATIE_FULL_BENCHMARK_ENVIRONMENT:'production',KATIE_FULL_BENCHMARK_DISPATCH:'enabled',KATIE_NATIVE_BENCHMARK_DISPATCH:'enabled',KATIE_BENCHMARK_PAID_EXECUTION:'enabled',OPENAI_API_KEY:'synthetic-in-memory-transport-only',GOOGLE_API_KEY:'',CLAUDE_API_KEY:'',GROK_API_KEY:'',XAI_API_KEY:''});
  fixture.workerResponse=completionTransport({fixture,trace});
  globalThis.fetch=async(url,options={})=>{
   const target=new URL(typeof url==='string'||url instanceof URL?url:url.url);
   if(target.origin==='https://api.openai.com')return fixture.workerResponse(url,options);
   if(target.origin==='https://raw.githubusercontent.com')return Response.json({'gpt-5.3-codex':{input_cost_per_token:0.00000175,output_cost_per_token:0.000014}});
   if(target.href===config.productionDatabaseUrl+'/auth/v1/user')return Response.json({id:ids.owner,is_anonymous:false});
   throw Error('Task 3C synthetic transport forbids external network: '+target.origin);
  };
  const preview=modules()('@/lib/projects/preview');
  load=modules({'@/lib/projects/preview':previewTransport(preview,{fixture,trace}),'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>client},'@octokit/rest':{Octokit:githubTransport({fixture,release,trace,issue})}});
  worker=load('@/lib/missions/worker');projects=load('@/lib/projects/worker');
  await db.query("update model_registry set source_metadata=jsonb_build_object('pricing_verification_source','https://developers.openai.com/api/docs/models/gpt-5.3-codex','pricing_verification_date',current_date::text) where provider_name='openai' and normalized_model_id='gpt-5.3-codex'");
  const registry=load('@/lib/models/registry');
  const refreshed=await registry.refreshModelRegistry([{name:'openai',listModels:async()=>['gpt-5.3-codex']}]);
  assert.equal(refreshed[0].ok,true);

  const first=(await db.query('select claim_mission_work() c')).rows[0].c;
  assert.equal(first?.job.id,ids.task,'Native completion must reconcile the original task, not create another');
  assert.equal(first.mission.id,ids.mission);
  await worker.executeClaim(first);
  const ready=await one('agent_tasks','id',ids.task);
  assert.equal(ready.status,'ready',JSON.stringify(ready));
  trace.push({stage:'development-reconciled',taskId:ids.task,head:receipt.reviewedHeadSha,receipt:ready.external.receipt});
  const jobs=[];
  for(let i=0;i<4;i++){
   if((await one('agent_missions','id',ids.mission)).status==='completed')break;
   const claim=(await db.query('select claim_mission_work() c')).rows[0].c;
   assert.equal(claim?.mission.id,ids.mission);
   assert.ok(['compose','review'].includes(claim.job.role),'Engineering implementation must not replay');
   jobs.push({id:claim.job.id,role:claim.job.role,agentId:claim.job.agent_id});
   await worker.executeClaim(claim);
  }
  assert.deepEqual(jobs.map(j=>j.role),['compose','review']);
  assert.notEqual(jobs[0].agentId,jobs[1].agentId);
  assert.equal((await one('agent_missions','id',ids.mission)).status,'completed');
  trace.push({stage:'development-mission-completed',missionId:ids.mission,jobs});
  await projects.runProjectBatch();
  const advanced=await one('work_projects','id',ids.project);
  assert.equal(advanced.verified_sha,receipt.reviewedHeadSha,JSON.stringify(advanced));
  assert.equal(advanced.phase,'delivery');
  const assessments=[];
  for(let i=0;i<12;i++){
   const p=await one('work_projects','id',ids.project);
   trace.push({stage:'project-worker',phase:p.phase,status:p.status,missionId:p.active_mission_id});
   if(p.status==='completed')break;
   assert.equal(p.status,'running',p.detail);
   if(p.phase==='assessment'&&p.active_mission_id){
    const claim=(await db.query('select claim_mission_work() c')).rows[0].c;
    assert.equal(claim?.mission.id,p.active_mission_id);
    assessments.push({id:claim.job.id,role:claim.job.role,agentId:claim.job.agent_id});
    await worker.executeClaim(claim);
    if((await one('agent_missions','id',p.active_mission_id)).status!=='completed')continue;
    await assertAtomicRejects(db,ids,p,report.negativeCases);
   }
   const result=await projects.runProjectBatch();
   assert.notEqual(result?.status,'error_recorded',JSON.stringify(await one('work_projects','id',ids.project)));
  }
  const final=await one('work_projects','id',ids.project);
  assert.equal(final.status,'completed',JSON.stringify(final));
  assert.equal(final.verified_sha,receipt.reviewedHeadSha);
  assert.equal(final.approved_hash,ids.scopeHash);
  assert.deepEqual(assessments.map(a=>a.role),['plan','compose','review']);
  assert.notEqual(assessments[1].agentId,assessments[2].agentId);
  assert.equal((await db.query("select count(*)::int n from project_runs where project_id=$1 and kind='development'",[ids.project])).rows[0].n,1);
  assert.equal((await db.query("select count(*)::int n from project_runs where project_id=$1 and kind='assessment'",[ids.project])).rows[0].n,1);
  const after=await ledger();
  for(const row of historical)assert.deepEqual(after.find(c=>c.id===row.id),row,'Engineering accounting cannot be rewritten');
  assert.ok(after.every(c=>c.state==='settled'));
  const spent=after.reduce((n,c)=>n+Number(c.actual_tokens),0);
  const account=await one('benchmark_budget_accounts','id',ids.account);
  assert.equal(Number(account.spent_tokens),spent);
  const closed=(await db.query('select finish_work_project($1,$2,$3,$4) value',[ids.project,randomUUID(),'complete',{}])).rows[0].value;
  assert.equal(closed,false,'Replayed project completion must be fenced');
  report.missionJobs=jobs;report.assessmentJobs=assessments;report.finalProject=final;report.finalBrowser=fixture.finalBrowser;report.finalAccount=account;report.finalLedgerHash=digest(after);report.events.push({stage:'authoritative-project-completed',projectId:ids.project,head:final.verified_sha,assessmentMissionId:final.active_mission_id,receipt:final.result});
  assert.equal(report.negativeCases.length>=19,true,'Valid control and all negative acceptance cases must execute');
  report.passed=true;
  console.log('TASK3C_INTEGRATED_PROJECT_CLOSURE_PASS');
 } finally {
  globalThis.fetch=oldFetch;
  for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];
  Object.assign(process.env,oldEnv);
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));
 }
}

async function assertAtomicRejects(db,ids,project,negativeCases){
 // Keep the production completion function and its actual lease/SQL gates.
 // Each mutation is rolled back. Nothing is inserted into production.
 await db.query('begin');
 try{
  const claim=(await db.query('select claim_work_project() c')).rows[0].c;
  assert.equal(claim?.id,ids.project);
  const assessment=claim.active_mission_id;
  const development=(await db.query("select mission_id,outcome from project_runs where project_id=$1 and kind='development' and outcome->>'head'=$2 order by ordinal desc limit 1",[ids.project,claim.verified_sha])).rows[0];
  assert.ok(development?.outcome?.taskId,'Original development receipt required for valid completion control');
  const contractHash=(await db.query("select encode(sha256(convert_to(project_canonical($1::jsonb),'UTF8')),'hex') hash",[JSON.stringify(claim.spec.finalContract)])).rows[0].hash;
  const completion={result:'Completed: frozen synthetic project',preview:claim.preview,verified_head:claim.verified_sha,reviewedMissionId:assessment,receipt:{
   version:1,projectId:ids.project,taskId:development.outcome.taskId,developmentMissionId:development.mission_id,
   assessmentMissionId:assessment,verifiedSha:claim.verified_sha,approvedScopeHash:claim.approved_hash,
   finalContractHash:contractHash,browserAcceptance:claim.preview.browserAcceptance
  }};
  const complete=() => db.query("select finish_work_project($1,$2,'complete',$3::jsonb) ok",[ids.project,claim.lease,JSON.stringify(completion)]);
  await db.query('savepoint task3c_valid_control');
  assert.equal((await complete()).rows[0].ok,true,'Unmodified original project must complete with the same authentic receipt');
  await db.query('rollback to savepoint task3c_valid_control');
  await db.query('release savepoint task3c_valid_control');
  negativeCases.push({name:'positive-closure-control',accepted:true,rolledBack:true});
  await db.query('savepoint task3c_missing_receipt');
  await assert.rejects(db.query("select finish_work_project($1,$2,'complete',$3::jsonb)",[ids.project,claim.lease,JSON.stringify({...completion,receipt:null})]),/Final assessment is not bound/);
  await db.query('rollback to savepoint task3c_missing_receipt');
  await db.query('release savepoint task3c_missing_receipt');
  negativeCases.push({name:'missing-structured-closure-receipt',rejected:true});
  const cases=[
   {name:'missing-native-completion-task',sql:"update project_runs set outcome=outcome-'taskId' where project_id=$1 and kind='development'",args:[ids.project]},
   {name:'missing-final-verification',sql:"update project_runs set outcome=jsonb_set(outcome,'{verification,testedHeadSha}','null'::jsonb) where project_id=$1 and kind='development'",args:[ids.project]},
   {name:'wrong-reviewer-candidate',sql:"update agent_missions set project_evidence=jsonb_set(project_evidence,'{finalIntegratedEvidence,verification,reviewedHeadSha}',to_jsonb(repeat('f',40))) where id=$1",args:[assessment]},
   {name:'wrong-approved-scope',sql:"update agent_missions set project_evidence=jsonb_set(project_evidence,'{approvedScopeHash}',to_jsonb(repeat('f',64))) where id=$1",args:[assessment]},
   {name:'wrong-task-identity',sql:"update agent_missions set project_evidence=jsonb_set(project_evidence,'{finalIntegratedEvidence,taskId}',to_jsonb($2::text)) where id=$1",args:[assessment,randomUUID()]},
   {name:'missing-independent-assessment',sql:"update agent_missions set status='blocked' where id=$1",args:[assessment]},
   {name:'rejected-assessment-review',sql:"update mission_assignments set result=jsonb_set(result,'{verdict}',to_jsonb('changes_requested'::text)) where mission_id=$1 and role='review'",args:[assessment]},
   {name:'wrong-final-contract',sql:"update agent_missions set project_evidence=jsonb_set(project_evidence,'{approvedFinalContract,scenarios,0,name}',to_jsonb('Different contract'::text)) where id=$1",args:[assessment]},
   {name:'obsolete-browser-candidate',sql:"update agent_missions set project_evidence=jsonb_set(project_evidence,'{preview,browserAcceptance,headSha}',to_jsonb(repeat('f',40))) where id=$1",args:[assessment]},
   {name:'missing-acceptance-criterion',sql:"update work_projects set preview=jsonb_set(preview,'{browserAcceptance,checks}','[]'::jsonb) where id=$1",args:[ids.project]},
   {name:'wrong-project-identity',sql:'update agent_missions set project_id=null where id=$1',args:[assessment]}
  ];
  for(const item of cases){
   await db.query('savepoint task3c_negative');
   await db.query(item.sql,item.args);
   await assert.rejects(complete(),/bound|independent|acceptance|required|contract|candidate/i,item.name);
   await db.query('rollback to savepoint task3c_negative');
   await db.query('release savepoint task3c_negative');
   negativeCases.push({name:item.name,rejected:true});
  }
  await db.query('savepoint task3c_expired');
  await db.query("update work_projects set deadline=now()-interval '1 second' where id=$1",[ids.project]);
  assert.equal((await complete()).rows[0].ok,false);
  await db.query('rollback to savepoint task3c_expired');
  await db.query('release savepoint task3c_expired');
  negativeCases.push({name:'expired-project-authorization',rejected:true});
  await db.query('savepoint task3c_direct');
  await db.query("update mission_assignments set result=jsonb_set(result,'{verdict}',to_jsonb('changes_requested'::text)) where mission_id=$1 and role='review'",[assessment]);
  await assert.rejects(db.query("update work_projects set status='completed' where id=$1",[ids.project]),/Final assessment is not bound/,'Direct privileged status writes must not bypass the independent reviewer');
  await db.query('rollback to savepoint task3c_direct');
  await db.query('release savepoint task3c_direct');
  negativeCases.push({name:'direct-status-bypass-rejected',rejected:true});
  // The original completion RPC checks deadlines, scopes and leases. Prove
  // a privileged direct UPDATE cannot bypass those checks with VALID
  // reviewer, browser and candidate evidence.
  for(const [name,sql] of [
   ['direct-expired-deadline',"update work_projects set deadline=now()-interval '1 second' where id=$1"],
   ['direct-missing-lease',"update work_projects set lease=null where id=$1"],
   ['direct-blocked-project',"update work_projects set status='blocked' where id=$1"],
   ['direct-revoked-scope',"update work_projects set approval_hash=repeat('f',64) where id=$1"]
  ]){
   await db.query('savepoint task3c_authority');
   await db.query(sql,[ids.project]);
   await assert.rejects(db.query("update work_projects set status='completed' where id=$1",[ids.project]),/Final assessment is not bound/,name);
   await db.query('rollback to savepoint task3c_authority');
   await db.query('release savepoint task3c_authority');
   negativeCases.push({name,rejected:true});
  }
 }finally{await db.query('rollback');}
}
