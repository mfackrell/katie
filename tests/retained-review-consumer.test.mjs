import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';

const {digest}=modules()('@/lib/projects/contract');
function fixture(){
 const projectId=randomUUID(),taskId=randomUUID(),candidate='a'.repeat(40),base='b'.repeat(40),tree='c'.repeat(40),scope='d'.repeat(64);
 const contract={path:'/pilot',scenarios:[{name:'Play',steps:[{action:'click',selector:'#play'},{action:'expectText',selector:'#state',value:'Played'}]}]};
 const context={version:1,projectId,baseSha:base,baselineSha:base,scopeHash:scope,contractHash:digest(contract),allowedPaths:['app/pilot/'],cumulativePaths:['app/pilot/'],contract};
 const project={projectId,contractHash:context.contractHash,scenarioNames:['Play'],packageScope:{baseSha:base,paths:context.allowedPaths}};
 const receipt={version:1,repository:'owner/repo',run_id:42,issue_number:12,pr_url:null,outcome:'BLOCKED',checks:{build:'failure',test:'',review:'',repair:'skipped',retest:'',final_review:''}};
 const task={id:taskId,status:'blocked',repository_id:randomUUID(),repository_full_name:'owner/repo',external:{issueNumber:12,receipt}};
 const settlement={receiptId:randomUUID(),authorizationId:randomUUID(),projectId,packageId:randomUUID(),missionId:randomUUID(),assignmentId:taskId,
  candidateSha:candidate,sourceTreeSha:tree,scopeHash:scope,contractHash:context.contractHash,workflowReceipt:structuredClone(receipt),binding:structuredClone(context),
  qualification:{kind:'retained-final-review-settlement',candidateSha:candidate,sourceTreeSha:tree,scopeHash:scope,contractHash:context.contractHash,runId:'42',workflowConclusion:'failure',phase:'final-review',terminalEvent:'turn.completed',exitCode:0,findings:'PASS all approved criteria',artifactId:'99',artifactSha256:'e'.repeat(64),verificationDigest:'f'.repeat(64)}};
 const origin='https://katie-abcdef123-owner-projects.vercel.app';
 const state={settlement,context,repo:'owner/repo',commit:{sha:candidate,commit:{tree:{sha:tree}}},
  delta:{status:'ahead',merge_base_commit:{sha:base},files:[{filename:'app/pilot/page.tsx',status:'added',additions:1,deletions:0,patch:'+actual implementation'}]},
  deployments:[{id:1,sha:candidate,creator:{login:'vercel[bot]'},production_environment:false,environment:'Preview'}],
  statuses:[{id:2,state:'success',creator:{login:'vercel[bot]'},environment:'Preview',environment_url:origin}],rpcReads:0,sourceReads:0,prReads:0};
 class Octokit{
  pulls={get:async()=>{state.prReads++;throw Error('A failed workflow must not invent a PR');}};
  repos={getCommit:async()=>{state.sourceReads++;return {data:state.commit};},compareCommitsWithBasehead:async()=>({data:state.delta}),
   listDeployments:async()=>({data:state.deployments}),listDeploymentStatuses:async()=>({data:state.statuses})};
 }
 const db={from:table=>{assert.equal(table,'repo_sync_runs');return {select(){return this;},eq(){return this;},maybeSingle:async()=>({data:{repository_full_name:state.repo},error:null})};}};
 const load=modules({'@octokit/rest':{Octokit},'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/projects/store':{getDevelopmentProjectContext:async()=>state.context,projectRpc:async(name,args)=>{assert.equal(name,'project_development_review_settlement');assert.equal(args.p_task,taskId);state.rpcReads++;return state.settlement;}}});
 return {state,task,project,settlement,candidate,origin,consumer:load('@/lib/agents/development'),acceptance:{version:1,projectId,contractHash:context.contractHash,headSha:candidate,passed:true,checks:[{name:'Play',passed:true,detail:'Real deployed browser interaction fixture'}]}};
}
async function env(run){
 const keys=['GITHUB_TOKEN','PROJECT_PREVIEW_HOST_PATTERN','VERCEL_ENV','VERCEL_GIT_COMMIT_SHA','VERCEL_DEPLOYMENT_ID'];const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.GITHUB_TOKEN='fixture-only';process.env.PROJECT_PREVIEW_HOST_PATTERN='^katie-([a-z0-9]{9})-owner-projects\\.vercel\\.app$';
 process.env.VERCEL_ENV='production';process.env.VERCEL_GIT_COMMIT_SHA='f'.repeat(40);process.env.VERCEL_DEPLOYMENT_ID='dpl_fixture';
 try{await run();}finally{for(const k of keys)if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}
}

test('authenticated retained review discovers the original immutable preview without a fabricated workflow or PR',()=>env(async()=>{
 const f=fixture(),before=JSON.stringify(f.task);
 const preview=await f.consumer.developmentPreview(f.task,f.project);
 assert.equal(preview.headSha,f.candidate);assert.equal(preview.url,f.origin+'/');assert.equal(preview.deploymentId,1);
 assert.equal(f.state.rpcReads,2);assert.equal(f.state.prReads,0);assert.equal(JSON.stringify(f.task),before);
 const evidence=await f.consumer.retainedDevelopmentEvidence(f.task,f.project,f.acceptance);
 assert.equal(evidence.reviewSettlement.receiptId,f.settlement.receiptId);
 assert.equal(evidence.reviewSettlement.workflowOutcome,'BLOCKED');assert.equal(evidence.projectAcceptance.headSha,f.candidate);
 assert.equal(evidence.changedFiles[0].patch,'+actual implementation');assert.equal(Object.hasOwn(evidence,'outcome'),false);
 assert.equal(JSON.stringify(f.task),before,'historical task and failed receipt are immutable');
}));

test('task-injected settlement fields cannot authorize consumption',()=>env(async()=>{
 const f=fixture();f.state.settlement=null;
 f.task.external.reviewSettlement=f.settlement;f.task.external.accepted=true;f.task.external.tested_head_sha=f.candidate;
 await assert.rejects(f.consumer.developmentPreview(f.task,f.project),/Head-bound/);
 assert.equal(f.state.sourceReads,0);
}));

test('settlement consumer fails closed on foreign or changed immutable associations',()=>env(async()=>{
 for(const mutate of [
  f=>{f.state.settlement.assignmentId=randomUUID();},f=>{f.state.settlement.projectId=randomUUID();},
  f=>{f.state.context.scopeHash='e'.repeat(64);},f=>{f.state.settlement.workflowReceipt.run_id=43;},
  f=>{f.state.settlement.workflowReceipt.outcome='READY';},f=>{f.state.settlement.qualification.candidateSha='e'.repeat(40);},
  f=>{f.state.settlement.qualification.findings='CHANGES_REQUESTED fix';},f=>{f.state.settlement.qualification.terminalEvent='turn.failed';},
  f=>{f.state.settlement.binding.allowedPaths=['app/else/'];},f=>{f.state.settlement.binding.contract.scenarios[0].steps[1].value='Wrong';},
  f=>{f.project.scenarioNames=['Different'];},f=>{f.task.external.receipt.issue_number=13;},
 ]){const f=fixture();mutate(f);await assert.rejects(f.consumer.developmentPreview(f.task,f.project));assert.equal(f.state.sourceReads,0);}
}));

test('retained source verification rejects changed trees, divergence, scope escape and omitted deltas',()=>env(async()=>{
 for(const mutate of [
  f=>{f.state.commit.commit.tree.sha='e'.repeat(40);},f=>{f.state.commit.sha='e'.repeat(40);},
  f=>{f.state.delta.status='diverged';},f=>{f.state.delta.merge_base_commit.sha='e'.repeat(40);},
  f=>{f.state.delta.files=[];},f=>{f.state.delta.files[0].filename='app/admin/page.tsx';},
  f=>{f.state.delta.files[0].previous_filename='app/admin/page.tsx';},
 ]){const f=fixture();mutate(f);await assert.rejects(f.consumer.developmentPreview(f.task,f.project));}
}));

test('retained review does not turn missing deployment or failed interactive acceptance into completion',()=>env(async()=>{
 for(const mutate of [f=>{f.state.deployments=[];},f=>{f.state.deployments[0].production_environment=true;},f=>{f.state.deployments[0].sha='e'.repeat(40);},
  f=>{f.state.statuses[0].creator.login='imposter';},f=>{f.state.statuses[0].environment_url='https://katie-owner-projects.vercel.app';}]){
  const f=fixture();mutate(f);assert.equal(await f.consumer.developmentPreview(f.task,f.project),null);
 }
 for(const mutate of [f=>{f.acceptance.passed=false;},f=>{f.acceptance.headSha='e'.repeat(40);},f=>{f.acceptance.checks[0].passed=false;},
  f=>{f.acceptance.checks=[];},f=>{f.acceptance.checks[0].name='Different';}]){
  const f=fixture();mutate(f);await assert.rejects(f.consumer.retainedDevelopmentEvidence(f.task,f.project,f.acceptance));
 }
}));

test('a task with a READY receipt retains the ordinary gate and cannot fall through to settlement',()=>env(async()=>{
 const f=fixture();f.task.external.receipt.outcome='READY';
 await assert.rejects(f.consumer.developmentPreview(f.task,f.project),/Head-bound/);
 assert.equal(f.state.rpcReads,0);
}));

test('normal project tick consumes settled development and stops before organizational inference',()=>env(async()=>{
 const f=fixture(),calls=[],events=[];
 const project={id:f.project.projectId,status:'blocked',phase:'development',active_mission_id:f.settlement.missionId,
  approved_hash:f.settlement.scopeHash,approval_hash:f.settlement.scopeHash,deadline:new Date(Date.now()+60000).toISOString()};
 const assignment={id:f.task.id,role:'development',status:'failed'};
 const db={from:table=>{const eqs={};return {select(){return this;},eq(k,v){eqs[k]=v;return this;},order(){return this;},
  limit(){const value={data:table==='work_projects'&&eqs.status==='blocked'&&eqs.phase==='development'?[project]:[],error:null};
   return {then:resolve=>resolve(value),returns:async()=>value};}};}};
 const load=modules({
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/projects/specialist-dispatch':{runSpecialistResourceBatch:async()=>{}},
  '@/lib/projects/store':{getDevelopmentProjectContext:async()=>f.state.context,acceptanceBinding:()=>f.project,
   projectRpc:async(name,args)=>{calls.push({name,args});if(name==='claim_work_project')return null;if(name==='project_dispatch_recovery_candidates')return [];
    if(name==='project_org_retest_release_epoch')return {generation:72,active:true,deploymentId:'dpl_fixture'};
    if(name==='project_consume_development_review_settlement'){assert.equal(project.status,'blocked');assert.equal(args.p_evidence.preview.deploymentId,args.p_browser.deploymentId);assert.equal(args.p_evidence.preview.url,args.p_browser.url);assignment.status='completed';return {consumed:true};}
    throw Error('Unexpected or paid lifecycle transition: '+name);}},
  '@/lib/missions/store':{readMission:async()=>({mission:{status:'blocked'},jobs:[assignment]})},
  '@/lib/agents/store':{readTask:async()=>f.task},
  '@/lib/agents/development':{
   dispatchOwnerRenewedNativeDevelopment:async()=>false,recoverUnusedNativeStartup:async()=>false,
   loadRetainedReviewSettlement:async()=>{events.push('settlement');return f.settlement;},
   developmentPreview:async()=>{events.push('preview');return {url:f.origin+'/',headSha:f.candidate,deploymentId:1,statusId:2,immutable:true};},
   retainedDevelopmentEvidence:async(_task,_project,acceptance)=>{events.push('source');assert.equal(JSON.stringify(acceptance),JSON.stringify(f.acceptance));return {reviewSettlement:{receiptId:f.settlement.receiptId},projectAcceptance:acceptance};},
  },
  '@/lib/projects/preview':{verifyDeployedPreview:async(preview,contract,id)=>{events.push('browser');assert.equal(preview.url,f.origin+contract.path);assert.equal(id,project.id);
   return {...f.acceptance,deploymentId:1,statusId:2,url:preview.url,checkedAt:new Date().toISOString()};},PreviewAccessUnavailable:class extends Error{}},
 });
 await load('@/lib/projects/worker').runProjectBatch();
 assert.deepEqual(events,['settlement','preview','browser','source']);
 assert.equal(calls.filter(c=>c.name==='project_consume_development_review_settlement').length,1);
 assert.equal(project.status,'blocked');assert.equal(f.task.external.receipt.outcome,'BLOCKED');
 await load('@/lib/projects/worker').runProjectBatch();
 assert.equal(calls.filter(c=>c.name==='project_consume_development_review_settlement').length,1,'completed technical acceptance is not rerun');
}));
