import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';

const nativeRequire=createRequire(import.meta.url);
function loadModule(path, resolve) {
 const code=ts.transpileModule(readFileSync(path,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}
 }).outputText;
 const exports={};
 vm.runInNewContext(code,{exports,require:name=>resolve(name),console,Buffer,Date,setTimeout,clearTimeout,process,URL},{
  filename:path,timeout:3000
 });
 return exports;
}
const policy=loadModule('lib/recovery/policy.ts',nativeRequire);
const originalId='44444444-4444-4444-8444-444444444444';
const actor='11111111-1111-4111-8111-111111111111';
const chat='22222222-2222-4222-8222-222222222222';
const mission='55555555-5555-4555-8555-555555555555';
const job='66666666-6666-4666-8666-666666666666';
const caseId='77777777-7777-4777-8777-777777777777';
const sha='a'.repeat(40);
const verifiedHead='b'.repeat(40);
const releaseSha='c'.repeat(40);
const contractHash='d'.repeat(64);

function controlledEnvironment({reviewPass=true,productionVerified=true,scopeApproved=true}={}) {
 const changeLog=[];
 const dispatched=[];
 const events=[];
 const simulated={userRelease:false,repairDraft:false,reviewPass,productionVerified};
 const tables={
  work_projects:[{id:originalId,actor_id:actor,chat_id:chat,repository_id:'33333333-3333-4333-8333-333333333333',
   status:'blocked',phase:'development',deadline:'2099-01-01T00:00:00Z',
   approved_hash:scopeApproved?'approved':'stale',approval_hash:'approved',
   active_mission_id:mission,milestone_index:0,cycles:2,
   detail:'The verifier failed before any app tests ran',verified_sha:null,
   baseline_sha:sha,spec:{allowedPaths:['app/project-pilots/board/'],milestones:[{contract:{path:'/board'}}]}}],
  agent_tasks:[{id:job,status:'blocked',kind:'development',repository_id:'33333333-3333-4333-8333-333333333333',
   details:'Trusted baseline dependency preparation failed',external:{
    issueNumber:539,prUrl:'https://github.com/owner/repo/pull/540',
    receipt:{run_id:101,issue_number:539,outcome:'BLOCKED',tested_head_sha:verifiedHead,
     checks:{build:'success',test:'false',review:'pass',repair:'failure',retest:'',final_review:''}}
   }}],
  project_runs:[{id:'88888888-8888-4888-8888-888888888888',project_id:originalId,mission_id:mission,
   binding:{projectId:originalId,scopeHash:'approved',contractHash,contract:{scenarios:[{name:'moves'}]},
    baseSha:sha,baselineSha:sha,allowedPaths:['app/project-pilots/board/']}}],
  repo_sync_runs:[{id:'33333333-3333-4333-8333-333333333333',repository_full_name:'owner/repo'}],
  recovery_cases:[],
 };
 const missionSnapshot={
  mission:{id:mission,status:'blocked',project_id:originalId,project_kind:'development'},
  jobs:[{id:job,role:'development',status:'failed',result:{detail:'Trusted baseline dependency preparation failed'}}]
 };
 function rows(table,filters,limit) {
  let value=[...(tables[table]??[])];
  for(const filter of filters){
   if(filter.op==='eq')value=value.filter(row=>row[filter.key]===filter.value);
   if(filter.op==='in')value=value.filter(row=>filter.value.includes(row[filter.key]));
  }
  return typeof limit==='number'?value.slice(0,limit):value;
 }
 const db={
  from(table){
   const filters=[];let limit;
   const builder={
    select(){return this;},
    eq(key,value){filters.push({op:'eq',key,value});return this;},
    in(key,value){filters.push({op:'in',key,value});return this;},
    order(){return this;},
    limit(value){limit=value;return this;},
    maybeSingle:async()=>({data:rows(table,filters,limit)[0]??null,error:null}),
    update:async changes=>{
     const matches=rows(table,filters,limit);
     for(const row of matches)Object.assign(row,changes);
     return{data:matches,error:null};
    },
    then(resolve,reject){return Promise.resolve({data:rows(table,filters,limit),error:null}).then(resolve,reject);}
   };
   return builder;
  }
 };
 const repairPr={
  html_url:'https://github.com/owner/repo/pull/77',draft:true,state:'open',merged:false,merged_at:null,
  head:{ref:'agent/issue-77-101-1',sha:releaseSha,repo:{full_name:'owner/repo'}},
  base:{ref:'main',repo:{full_name:'owner/repo'}},merge_commit_sha:releaseSha
 };
 const api={
  users:{getAuthenticated:async()=>({data:{type:'User',login:'owner'}})},
  repos:{
   get:async()=>({data:{owner:{type:'User',login:'owner'},full_name:'owner/repo'}}),
   getBranch:async()=>({data:{commit:{sha:simulated.userRelease?releaseSha:sha}}}),
   compareCommitsWithBasehead:async()=>({data:{status:'ahead',files:[{filename:'scripts/project-ci.mjs'}]}}),
   getCombinedStatusForRef:async()=>({data:{statuses:simulated.productionVerified?[{context:'Vercel',state:'success'}]:[]}})
  },
  issues:{
   listForRepo:async()=>({data:simulated.createdIssue?[simulated.createdIssue]:[]}),
   create:async input=>{
    assert.match(input.body,/katie-recovery:/);
    assert.match(input.body,/RECOVERY_CASE:/);
    assert.match(input.body,/Do not change workflows, credentials/);
    changeLog.push('repair-delegated');
    simulated.createdIssue={number:77,html_url:'https://github.com/owner/repo/issues/77',
     title:input.title,body:input.body};
    return{data:simulated.createdIssue};
   }
  },
  pulls:{
   list:async()=>({data:simulated.repairDraft?[repairPr]:[]}),
   get:async()=>({data:repairPr})
  },
  actions:{
   listJobsForWorkflowRun:async()=>({data:{jobs:[{name:'test',conclusion:'success',id:201}]}}),
   downloadJobLogsForWorkflowRun:async()=>({data:'Trusted baseline dependency preparation failed; candidate tests were not run'}),
   getWorkflowRun:async()=>({data:{repository:{full_name:'owner/repo'},head_sha:sha}}),
   getWorkflow:async()=>({data:{state:'active',path:'.github/workflows/project-reverify.yml'}}),
   listWorkflowRuns:async()=>({data:{workflow_runs:simulated.repairDraft?[{
    id:102,status:'completed',conclusion:'success',path:'.github/workflows/autonomous-development.yml',
    repository:{full_name:'owner/repo'},head_branch:'main'
   }]:[]}}),
   listWorkflowRunArtifacts:async ({run_id})=>({data:{artifacts:run_id===102?
    [{name:'agent-completion',id:301,expired:false,size_in_bytes:700}]:[]}}),
   downloadArtifact:async()=>({data:Buffer.from('trusted-artifact-for-test')}),
   createWorkflowDispatch:async args=>{
    dispatched.push(args);
    changeLog.push('same-code-verification-dispatched');
    assert.equal(args.workflow_id,'project-reverify.yml');
    assert.equal(args.inputs.expected_sha,verifiedHead);
    return{status:204};
   }
  }
 };
 async function rpc(name,args={}){
  if(name==='discover_recovery_cases'){
   if(tables.recovery_cases.length)return 0;
   tables.recovery_cases.push({id:caseId,source_type:'project',source_id:originalId,
    source_revision:'development:0:2:'+mission,actor_id:actor,chat_id:chat,
    repository_id:tables.work_projects[0].repository_id,status:'observed',
    category:null,strategy:null,attempt:0,lease:null,details:'Verifier blocked',evidence:{},
    repair_issue_url:null,repair_pr_url:null,repair_head_sha:null,opened_at:new Date().toISOString(),
    updated_at:new Date().toISOString()});
   events.push('discovered');
   return 1;
  }
  if(name==='claim_recovery_case'){
   const c=tables.recovery_cases.find(c=>c.status==='observed');
   if(!c)return null;
   Object.assign(c,{status:'claimed',lease:'99999999-9999-4999-8999-999999999999',attempt:c.attempt+1});
   events.push('claimed');
   return{...c};
  }
  if(name==='finish_recovery_case'){
   const c=tables.recovery_cases.find(c=>c.id===args.p_id&&c.lease===args.p_lease&&c.status==='claimed');
   if(!c)return null;
   Object.assign(c,{status:args.p_status,category:args.p_category,strategy:args.p_strategy,
    details:args.p_details,evidence:args.p_evidence,repair_issue_url:args.p_issue,
    repair_pr_url:args.p_pr,repair_head_sha:args.p_head,lease:null,updated_at:new Date().toISOString()});
   events.push(args.p_status);
   return{...c};
  }
  if(name==='resume_project_after_recovery'){
   const c=tables.recovery_cases[0],p=tables.work_projects[0],t=tables.agent_tasks[0];
   if(c.status!=='awaiting_release'||p.status!=='blocked'||p.approved_hash!==p.approval_hash||
     args.p_actor!==actor||args.p_original_issue!==539||args.p_original_pr!==540||
     args.p_original_sha!==verifiedHead)return null;
   c.status='verifying';c.updated_at=new Date().toISOString();
   p.status='running';t.status='submitted';
   Object.assign(t.external,{verificationSha:verifiedHead,verificationPr:540});
   missionSnapshot.mission.status='running';
   changeLog.push('original-resumed');
   events.push('original-resumed');
   return{status:'running',cycles:p.cycles,mission:p.active_mission_id};
  }
  throw Error('Unexpected recovery RPC '+name);
 }
 const fakeClass=class Octokit {constructor(){return api;}};
 const realPolicy=policy;
 const worker=loadModule('lib/recovery/worker.ts',name=>{
  if(name==='@/lib/data/supabase/admin')return{getSupabaseAdminClient:()=>db};
  if(name==='@/lib/missions/store')return{rpc,readMission:async()=>missionSnapshot};
  if(name==='@/lib/agents/development')return{
   completionJson:()=>({version:1,repository:'owner/repo',run_id:102,
    issue_number:77,pr_url:repairPr.html_url,outcome:'READY',tested_head_sha:releaseSha,
    reviewed_head_sha:releaseSha,
    checks:{build:'success',test:'true',review:'pass',repair:'skipped',retest:'',final_review:''}}),
   parseCompletionReceipt:(raw,repo,issue,run,conclusion)=>{
    assert.equal(raw.repository,repo);assert.equal(raw.issue_number,issue);
    assert.equal(raw.run_id,run);assert.equal(conclusion,'success');
    return{...raw,outcome:simulated.reviewPass&&raw.tested_head_sha===raw.reviewed_head_sha?'READY':'BLOCKED'};
   }
  };
  if(name==='@/lib/projects/contract')return{digest:()=>contractHash};
  if(name==='./policy')return realPolicy;
  if(name==='./diagnose')return{independentRecoveryDiagnosis:async()=>null};
  if(name==='@octokit/rest')return{Octokit:fakeClass};
  return nativeRequire(name);
 });
 return{worker,simulated,api,tables,repairPr,dispatched,events,changeLog,missionSnapshot,db};
}
test('controlled E2E: recoverable failure -> diagnosis -> repair delegation -> independent review -> owner release -> original resume -> completion',async()=>{
 const h=controlledEnvironment();
 const start=h.tables.work_projects[0];
 const approved=start.approved_hash,cycles=start.cycles;
 const first=await h.worker.runRecoveryBatch();
 assert.equal(first.status,'delegated',JSON.stringify(first));
 assert.equal(first.discovered,1);
 let recovery=h.tables.recovery_cases[0];
 assert.equal(recovery.category,'verification_infrastructure');
 assert.equal(recovery.strategy,'scoped_repair');
 assert.equal(recovery.attempt,1);
 assert.equal(recovery.repair_issue_url,'https://github.com/owner/repo/issues/77');
 assert.equal(h.simulated.createdIssue.body.includes('scripts/project-ci.mjs'),true);
 assert.equal(start.status,'blocked','repair issue creation must not resume the original prematurely');
 assert.equal(h.changeLog.includes('original-resumed'),false);
 // Independent CI/test/review emits same-head receipt. A generated PR alone is
 // not success. The release gate waits for a verified receipt and human merge.
 h.simulated.repairDraft=true;
 const second=await h.worker.runRecoveryBatch();
 assert.equal(second.status,'idle');
 recovery=h.tables.recovery_cases[0];
 assert.equal(recovery.status,'awaiting_release');
 assert.equal(recovery.repair_pr_url,h.repairPr.html_url);
 assert.equal(start.status,'blocked');
 assert.equal(h.dispatched.length,0);
 // The user/owner merges the independently reviewed draft; platform confirms
 // main deployment. This step is an explicit simulated authorized action.
 h.simulated.userRelease=true;h.repairPr.draft=false;h.repairPr.state='closed';
 h.repairPr.merged=true;h.repairPr.merged_at='2026-10-19T12:00:00Z';
 const third=await h.worker.runRecoveryBatch();
 assert.equal(third.status,'idle');
 assert.equal(recovery.status,'verifying');
 assert.equal(start.status,'running');
 assert.equal(h.dispatched.length,1);
 assert.equal(h.dispatched[0].inputs.expected_sha,verifiedHead,'no code regeneration');
 assert.equal(start.cycles,cycles,'coding cycle count cannot increase');
 assert.equal(start.approved_hash,approved,'approval scope unchanged');
 assert.deepEqual(h.events.slice(0,5),['discovered','claimed','delegated','original-resumed']);
 // A running task is not completion. Only the original task's own verified
 // outcome causes the recovery case to resolve.
 await h.worker.runRecoveryBatch();
 assert.equal(recovery.status,'verifying');
 start.status='completed';
 await h.worker.runRecoveryBatch();
 assert.equal(recovery.status,'resolved');
 assert.equal(h.simulated.createdIssue.body.includes('AUTONOMOUS RECOVERY ASSIGNMENT'),true);
 assert.equal(h.changeLog.filter(x=>x==='repair-delegated').length,1);
 assert.equal(h.changeLog.filter(x=>x==='original-resumed').length,1);
 assert.equal(h.dispatched.length,1);
});
test('controlled E2E refuses unverified repair and refuses release without successful deployment',async()=>{
 const h=controlledEnvironment({reviewPass:false});
 await h.worker.runRecoveryBatch();
 h.simulated.repairDraft=true;
 await h.worker.runRecoveryBatch();
 assert.equal(h.tables.recovery_cases[0].status,'delegated','failing independent review cannot open release gate');
 assert.equal(h.dispatched.length,0);
 const other=controlledEnvironment({productionVerified:false});
 await other.worker.runRecoveryBatch();
 other.simulated.repairDraft=true;
 await other.worker.runRecoveryBatch();
 assert.equal(other.tables.recovery_cases[0].status,'awaiting_release');
 other.simulated.userRelease=true;other.repairPr.draft=false;other.repairPr.state='closed';
 other.repairPr.merged=true;other.repairPr.merged_at='2026-10-19T12:00:00Z';
 await other.worker.runRecoveryBatch();
 assert.equal(other.tables.work_projects[0].status,'blocked','unverified production cannot resume');
 assert.equal(other.dispatched.length,0);
 assert.equal(other.tables.work_projects[0].cycles,2);
});
test('controlled E2E does not delegate new work when the project approval is stale',async()=>{
 const h=controlledEnvironment({scopeApproved:false});
 await h.worker.runRecoveryBatch();
 assert.equal(h.changeLog.includes('repair-delegated'),false);
 assert.equal(h.tables.work_projects[0].status,'blocked');
 assert.equal(h.dispatched.length,0);
});
