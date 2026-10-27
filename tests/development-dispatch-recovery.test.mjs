import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {modules} from './helpers/load-project-modules.mjs';
function zipJSON(name,body){
 const file=Buffer.from(name),content=Buffer.from(JSON.stringify(body)),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt32LE(content.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(file.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt32LE(content.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(file.length,28);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+file.length,12);end.writeUInt32LE(local.length+file.length+content.length,16);
 return Buffer.concat([local,file,content,central,file,end]);
}
function fixture(){
 const historical=JSON.parse(readFileSync('tests/fixtures/take-eleven-specification-696.json','utf8'));
 const plan=JSON.parse(historical.jobs.find(j=>j.role==='revise').result.text);
 const p={id:randomUUID(),status:'running',phase:'development',approved_hash:'b'.repeat(64),approval_hash:'b'.repeat(64)};
 const config={name:'Developer',instructions:'Implement only the approved original requirements.',research:false,attachments:false,development:true,reviewMode:'always',maxActiveTasks:1,maxInputChars:16000};
 const agent={id:randomUUID(),version:1,config},mission={id:randomUUID(),project_id:p.id,project_kind:'development',repository_id:randomUUID(),objective:historical.project.objective,status:'running',team:[agent]},lease=randomUUID();
 const job={id:randomUUID(),mission_id:mission.id,job_key:'implement',role:'development',agent_id:agent.id,status:'running',lease,payload:{approved:true},dependencies:[],instruction:'Implement the saved scope.',attempts:2};
 const task={id:job.id,agent_id:agent.id,actor_id:randomUUID(),chat_id:randomUUID(),snapshot:config,definition_version:1,kind:'development',input:'Implement the original approved Take Eleven scope.',initial_input:'Implement the original approved Take Eleven scope.',repository_id:mission.repository_id,repository_full_name:'owner/repo',request_id:'fixture:'+job.id,status:'dispatching',external:{},details:null};
 const {digest}=modules()('@/lib/projects/contract');
 const c={version:1,projectId:p.id,baseSha:'a'.repeat(40),baselineSha:'a'.repeat(40),allowedPaths:plan.allowedPaths,contractHash:digest(plan.finalContract),contract:plan.finalContract,scopeHash:p.approved_hash};
 let writes=0,claims=0,failPreflight=false,loseAck=false,stale=false,receiptReady=false;
 const events=[],commits=[];let issue=null;
 const receipt={version:1,repository:'owner/repo',run_id:99,issue_number:7,pr_url:'https://github.com/owner/repo/pull/8',outcome:'READY',checks:{build:'success',test:'true',review:'pass',repair:'skipped',retest:'',final_review:''},tested_head_sha:'c'.repeat(40),reviewed_head_sha:'c'.repeat(40),projectAcceptance:{version:1,projectId:p.id,contractHash:c.contractHash,headSha:'c'.repeat(40),passed:true,checks:c.contract.scenarios.map(s=>({name:s.name,passed:true,detail:'Controlled observed original acceptance state'}))}};
 const rpc=async(name,args)=>{
  events.push(name);
  if(name==='save_project_development_dispatch'){
   if(stale||args.p_lease!==lease)return false;
   Object.assign(task,{status:args.p_status,details:args.p_detail,external:args.p_external});return structuredClone(task);
  }
  if(name==='claim_project_dispatch'){
   claims++;if(stale||args.p_lease!==lease||task.external.attempted)return false;
   task.external={...task.external,attempted:true,projectId:p.id,dispatchStartedAt:new Date().toISOString()};return true;
  }
  if(name==='mission_development_task')return structuredClone(task);
  if(name==='claim_mission_work'){if(job.status!=='waiting_external')return null;job.status='running';return {mission:structuredClone(mission),job:structuredClone(job)};}
  if(name==='commit_mission_work'){assert.equal(args.p_lease,lease);commits.push(args);job.status=args.p_status;return true;}
  return false;
 };
 const db={from:()=>{const q={select(){return q;},eq(){return q;},order(){return q;},limit(){return q;},returns(){return q;},maybeSingle:async()=>({data:{repository_full_name:'owner/repo'},error:null}),then:resolve=>Promise.resolve({data:[],error:null}).then(resolve)};return q;}};
 class GitHub{
  users={getAuthenticated:async()=>{if(failPreflight){const error=Error('503 temporary GitHub failure');error.status=503;throw error;}return{data:{type:'User',login:'owner'}};}};
  repos={get:async()=>({data:{owner:{type:'User',login:'owner'}}})};
  issues={create:async args=>{writes++;issue={number:7,html_url:'https://github.com/owner/repo/issues/7',title:args.title,body:args.body,user:{login:'owner'}};if(loseAck)throw Error('Acknowledgment lost after acceptance');return{data:issue};},listForRepo:async()=>({data:issue?[issue]:[]})};
  actions={getWorkflow:async()=>({data:{path:'.github/workflows/autonomous-development.yml',state:'active'}}),listWorkflowRuns:async()=>({data:{workflow_runs:receiptReady?[{id:99,status:'completed',conclusion:'success',event:'issues',repository:{full_name:'owner/repo'},head_repository:{full_name:'owner/repo'},head_branch:'main',path:'.github/workflows/autonomous-development.yml',html_url:'https://github.com/owner/repo/actions/runs/99'}]:[]}}),listWorkflowRunArtifacts:async()=>({data:{artifacts:[{id:10,name:'agent-completion',expired:false,size_in_bytes:1000}]}}),downloadArtifact:async()=>({data:zipJSON('agent-result.json',receipt)})};
 }
 const overrides={'@octokit/rest':{Octokit:GitHub},'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/agents/store':{agentRpc:rpc,readTask:async()=>structuredClone(task)},'@/lib/projects/store':{getDevelopmentProjectContext:async()=>c,acceptanceBinding:x=>({projectId:x.projectId,contractHash:x.contractHash,scenarioNames:x.contract.scenarios.map(s=>s.name)}),projectRuns:async()=>[],projectRpc:async(name)=>{
  if(name==='project_dispatch_recovery_candidates'){if(job.status==='failed'){job.status='waiting_external';p.status='running';mission.status='running';task.status=task.external.attempted?'dispatching':task.status;events.push('atomic-recovery-existing-task');}return [];}
  if(name==='claim_work_project')return null;return false;
 }},'@/lib/providers':{getAvailableProviders:()=>[{name:'openai'}]},'@/lib/router/master-router':{chooseProvider:async prompt=>({provider:{name:'openai'},modelId:prompt.includes('implementation')?'gpt-5.3-codex':'gpt-5.4',fallbackChain:[]})},'@/lib/missions/store':{rpc,readMission:async()=>({mission,jobs:[job]})},'@/lib/missions/inspection':{workflowInspection:async()=>null,readOnlyRepositoryObjective:()=>false},'@/lib/projects/specialist-dispatch':{runSpecialistResourceBatch:async()=>{}},'@/lib/projects/recovery-budget':{announceBlockedRecoveryResources:async()=>{}}};
 const load=modules(overrides),development=load('@/lib/agents/development');
 return {task,p,mission,job,c,lease,events,commits,development,overrides,get writes(){return writes;},get claims(){return claims;},set preflightFailure(v){failPreflight=v;},set lostAck(v){loseAck=v;},set stale(v){stale=v;},set ready(v){receiptReady=v;}};
}
async function withToken(work){const old=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='offline-fixture-only';try{await work();}finally{if(old===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=old;}}
test('transient unsent preflight does not consume POST approval and the same task can continue',()=>withToken(async()=>{
 const f=fixture();f.preflightFailure=true;
 const blocked=await f.development.dispatchDevelopment(f.task,f.c,f.lease);
 assert.equal(blocked.status,'blocked');assert.equal(blocked.external.attempted,undefined);assert.equal(blocked.external.dispatchFailure.kind,'transient');assert.equal(f.claims,0);assert.equal(f.writes,0);
 f.preflightFailure=false;f.task.status='dispatching';
 await f.development.dispatchDevelopment(f.task,f.c,f.lease);
 assert.equal(f.task.status,'submitted');assert.equal(f.writes,1);assert.equal(f.task.id,f.job.id);
}));
test('concurrent dispatches and a later duplicate produce exactly one issue',()=>withToken(async()=>{
 const f=fixture();await Promise.all([f.development.dispatchDevelopment(structuredClone(f.task),f.c,f.lease),f.development.dispatchDevelopment(structuredClone(f.task),f.c,f.lease)]);
 await f.development.dispatchDevelopment({...f.task,status:'dispatching'},f.c,f.lease);
 assert.equal(f.writes,1);assert.equal(f.task.external.issueNumber,7);
}));
test('lost acknowledgment reconciles the exact marker and never resubmits the issue',()=>withToken(async()=>{
 const f=fixture();f.lostAck=true;await f.development.dispatchDevelopment(f.task,f.c,f.lease);
 assert.equal(f.task.status,'dispatching');assert.equal(f.writes,1);
 await f.development.reconcileDevelopment(f.task,{projectId:f.c.projectId,contractHash:f.c.contractHash,scenarioNames:f.c.contract.scenarios.map(s=>s.name)},f.lease);
 assert.equal(f.task.status,'submitted');assert.equal(f.task.external.issueNumber,7);assert.equal(f.writes,1);
}));
test('stale worker cannot persist a later dispatch observation',()=>withToken(async()=>{
 const f=fixture();f.preflightFailure=true;f.stale=true;
 await assert.rejects(f.development.dispatchDevelopment(f.task,f.c,f.lease),/lease is stale/);
 assert.equal(f.task.status,'dispatching');assert.equal(f.writes,0);
}));
test('unreconciled legacy acceptance persists an explicit blocker with no resubmission',()=>withToken(async()=>{
 const f=fixture();f.task.external={attempted:true,projectId:f.p.id};
 await f.development.reconcileDevelopment(f.task,undefined,f.lease);
 assert.equal(f.task.status,'blocked');assert.match(f.task.details,/exact accepted issue identity/);assert.equal(f.writes,0);assert.equal(f.task.external.attempted,true);
}));
test('existing project and mission workers automatically reconcile a stranded authorized task and advance it',()=>withToken(async()=>{
 const f=fixture();f.lostAck=true;await f.development.dispatchDevelopment(f.task,f.c,f.lease);
 f.job.status='failed';f.p.status='blocked';f.mission.status='blocked';f.ready=true;
 const actual=modules(f.overrides)('@/lib/agents/development');
 const load=modules({...f.overrides,'@/lib/agents/development':{...actual,developmentEvidence:async()=>({testedHeadSha:'c'.repeat(40),reviewedHeadSha:'c'.repeat(40),note:'Controlled verified checkpoint'})}});
 await load('@/lib/projects/worker').runProjectBatch();
 const result=await load('@/lib/missions/worker').runMissionBatch(async()=>assert.fail('No regeneration or paid inference is needed'));
 assert.equal(result.claimed,1);assert.equal(f.job.status,'completed');assert.equal(f.commits.at(-1).p_status,'completed');
 assert.equal(f.task.external.receipt.outcome,'READY');assert.equal(f.writes,1);assert.equal(f.events.filter(n=>n==='atomic-recovery-existing-task').length,1);
 assert.equal(f.commits.at(-1).p_result.verification.testedHeadSha,'c'.repeat(40));
}));
