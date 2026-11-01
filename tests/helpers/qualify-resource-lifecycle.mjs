// Task 2C: one synthetic assignment, real host/route/SQL/dispatcher/recovery.
// The only substituted boundaries are external identity, GitHub and provider transport.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync,rmSync,existsSync,statfsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {NextRequest} from 'next/server.js';
import {modules} from './load-project-modules.mjs';
import {previewTransport} from './lifecycle-preview-transport.mjs';
import {completionTransport} from './lifecycle-completion-transport.mjs';
import {integratedOwnerBrowser} from './lifecycle-owner-integrated-browser.mjs';
import {postgresClient,githubTransport} from './lifecycle-qualification-adapters.mjs';
import {createLifecycleCheckpoint,qualifyLifecycleContinuation,archive} from './qualify-lifecycle-continuation.mjs';
import {projectMarker} from '../../scripts/project-context.mjs';
import {encodeNativeHandoff} from '../../scripts/benchmark/native-dispatch-contract.mjs';
import {sealNativeProductionRuntime} from '../../scripts/benchmark/native-runtime-capsule.mjs';
import config from '../../config/benchmark-715-production-qualification.json' with {type:'json'};
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const quote=v=>"'"+v.replaceAll("'","'\"'\"'")+"'";
export async function qualifyResourceLifecycle(db,rival,ids,initialAmendment,{adequate=false}={}){
 const ordinary=ids.authorityKind==='ordinary-developer';
 if(!ordinary){
 await db.query('reset role');await db.query(readFileSync('supabase/migrations/20261101123639_lifecycle_owner_authorization.sql','utf8'));await db.query('alter table actors add column if not exists actor_kind text');
 for(const name of ['20261022093000_separate_project_resource_estimates.sql','20261028193000_standalone_provider_attempt_ledger.sql','20261101160000_ordinary_developer_authority.sql'])await db.query(readFileSync('supabase/migrations/'+name,'utf8'));
 await db.query('set role service_role');
 }
 const fixture=await createLifecycleCheckpoint(db,ids,{initial:true});
 const {root,remote,context,baseline,one}=fixture,trace=[],report={version:1,mode:adequate?'adequate':'shortage',syntheticOnly:true,paidInference:0,ids,baseline,contract:context.contract,contractHash:context.contractHash,scenarios:[],trace};
 const ledger=async()=>(await db.query(`select jsonb_build_object('calls',(select jsonb_agg(to_jsonb(c) order by id) from benchmark_budget_calls c where account_id=$1),'exposures',(select jsonb_agg(to_jsonb(e) order by call_id) from benchmark_dollar_exposures e where account_id=$1),'account',(select to_jsonb(a) from benchmark_budget_accounts a where id=$1)) value`,[ids.account])).rows[0].value;
 const prior=await ledger();report.initialLedgerHash=hash(prior);
 const authorityHistory=async()=>(await db.query(`select jsonb_build_object('proposals',(select jsonb_agg(to_jsonb(p) order by id) from benchmark_lifecycle_proposals p where task_id=$1),'decisions',(select jsonb_agg(to_jsonb(d) order by proposal_id) from benchmark_lifecycle_decisions d join benchmark_lifecycle_proposals p on p.id=d.proposal_id where p.task_id=$1)) value`,[ids.task])).rows[0].value;
 const originalAuthorityHistory=await authorityHistory();
 // Controlled prior measured phases are linked to genuine isolated settled rows.
 const rows=(await db.query("select to_jsonb(c) value from benchmark_budget_calls c where account_id=$1 and state='settled' and model='gpt-5.3-codex' and provider_usage is not null order by actual_tokens,id limit 12",[ids.account])).rows.map(r=>r.value);if(!ordinary)assert.equal(rows.length,12);
 const scope=(await one('work_projects','id',ids.project)).approved_hash;
 const observations=ordinary?[]:['repair','final_review'].flatMap((stage,k)=>[0,1,2].map(i=>{const calls=rows.slice(k*6+i*2,k*6+i*2+2);return {id:'controlled-history-'+stage+i,stage,source:'verified_phase_receipts',cohort:scope,binding:{projectId:ids.project,scopeHash:scope},completed:true,calls:2,inputTokens:calls.reduce((n,c)=>n+c.provider_usage.input_tokens,0),outputTokens:calls.reduce((n,c)=>n+c.provider_usage.output_tokens,0),seconds:5,operationIds:calls.map(c=>c.id)};}));
 const oldTask=await one('agent_tasks','id',ids.task),oldRun=oldTask.external.receipt?.run_id;
 if(!ordinary)writeFileSync(join(root,'artifact.zip'),archive({taskId:ids.task,runId:String(oldRun),completed:false,phases:[],capacityObservations:observations,snapshots:[{label:'final',head:baseline,status:[]}]}));
 let recovering=false,phaseCounts=new Map(),providerCalls=0;
 const provider=async(body,path)=>{
  if(path.endsWith('/input_tokens'))return {type:'application/json',body:JSON.stringify({object:'response.input_tokens',input_tokens:3})};
  const input=JSON.stringify(body.input),phase=input.includes('prior findings remain')?'final-review':input.includes('Fix only the independent reviewer')?'repair':input.includes('fresh independent reviewer')?'review':input.includes('Complete the approved engineering work')?'implementation':null;assert.ok(phase,'Unknown real SDK phase');
  if(recovering)assert.ok(['repair','final-review'].includes(phase),'Completed engineering replayed');else assert.ok((adequate?['implementation','review','final-review']:['implementation','review']).includes(phase),'Paid repair started before owner approval');
  const n=(phaseCounts.get(phase)??0)+1;phaseCounts.set(phase,n);providerCalls++;const total=adequate||recovering?2:phase==='implementation'?5:6;assert.ok(n<=total);
  const source='export default function Page(){return <div id="state">'+(adequate||recovering?'Recovered':'Broken')+'</div>}\n';
  const cmd=phase==='implementation'&&n===1?'node -e '+quote(`const f=require('node:fs');f.mkdirSync('app/pilot',{recursive:true});f.writeFileSync('app/pilot/page.tsx',${JSON.stringify(source)});`):phase==='repair'?'node -e '+quote(`const f=require('node:fs'),a=require('node:assert/strict');a.match(f.readFileSync('app/pilot/page.tsx','utf8'),/Broken/);f.writeFileSync('app/pilot/page.tsx',${JSON.stringify(source)});`):'node -e '+quote(`require('node:assert/strict').match(require('node:fs').readFileSync('app/pilot/page.tsx','utf8'),/${adequate||recovering?'Recovered':'Broken'}/);`);
  const item=n<total?{id:'fc_'+providerCalls,type:'function_call',namespace:'functions',name:'exec_command',call_id:'call_'+providerCalls,status:'completed',arguments:JSON.stringify({cmd,workdir:'/work'})}:{id:'msg_'+providerCalls,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:phase==='review'?(adequate?'PASS Independently inspected approved display.':'CHANGES_REQUESTED Repair the displayed state to satisfy frozen acceptance.'):phase==='final-review'?'PASS Independently inspected verified source.':'DONE',annotations:[],logprobs:[]}]};
  const response={id:'task2c-synthetic-'+providerCalls,object:'response',model:body.model,created_at:1,status:'completed',service_tier:'default',output:[item],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
  trace.push({boundary:'provider',run:recovering?132:131,phase,request:n,requestHash:hash(body)});
  return {type:'text/event-stream',body:[['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],['response.completed',{type:'response.completed',response}]].map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join('')+'data: [DONE]\n\n'};
 };
 const signing='synthetic-only-task2c-owner-handoff-secret';
 let first,second;
 const oldEnv={...process.env},oldFetch=globalThis.fetch;
 try{
  const release='e'.repeat(40),issue={number:829,user:{login:'mfackrell'},html_url:'https://github.com/mfackrell/katie/issues/829',body:'Synthetic original task '+ids.task};
  let turn=0,scenarioConnection=null,approvalRace=null;
  const client=postgresClient({query:async(...args)=>{
   let connection=scenarioConnection??(turn++%2?db:rival);
   if(approvalRace&&args[0].includes('benchmark_lifecycle_decide')){
    const race=approvalRace,index=race.arrivals++;connection=index===0?db:rival;
    assert.ok(index<2);if(race.arrivals===2)race.release();await race.ready;
   }
   return connection.query(...args);
  }},trace);
  Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:release,NEXT_PUBLIC_SUPABASE_URL:config.productionDatabaseUrl,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-role',KATIE_OWNER_AUTH_USER_ID:ids.owner,PROJECT_PREVIEW_HOST_PATTERN:'^katie-([a-z0-9]{9})-synthetic\\.vercel\\.app$',PROJECT_PREVIEW_BYPASS_SECRET:'',GITHUB_TOKEN:'synthetic-github',KATIE_NATIVE_HANDOFF_HMAC_KEY:signing,KATIE_FULL_BENCHMARK_ENVIRONMENT:'production',KATIE_FULL_BENCHMARK_DISPATCH:'enabled',KATIE_NATIVE_BENCHMARK_DISPATCH:'enabled',KATIE_BENCHMARK_PAID_EXECUTION:'enabled',KATIE_FULL_BENCHMARK_TRIAL_ID:ids.trial,OPENAI_API_KEY:'synthetic-provider-no-real-access',GOOGLE_API_KEY:'',CLAUDE_API_KEY:'',claude_api_key:'',GROK_API_KEY:'',XAI_API_KEY:'',grok_api_key:''});
  // Trusted pricing provenance and catalog below are isolated synthetic evidence,
  // never production verification. Exercise normal registry refresh and routing.
  await db.query(`update model_registry set source_metadata=jsonb_build_object('pricing_verification_source','https://developers.openai.com/api/docs/models/gpt-5.3-codex','pricing_verification_date',current_date::text) where provider_name='openai' and normalized_model_id='gpt-5.3-codex'`);
  globalThis.fetch=async(url,options)=>{if(String(url)==='https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json')return Response.json({'gpt-5.3-codex':{input_cost_per_token:0.00000175,output_cost_per_token:0.000014}});if(new URL(typeof url==='string'||url instanceof URL?url:url.url).origin==='https://api.openai.com'){assert.ok(fixture.workerResponse,'Provider forbidden before completed native engineering');return fixture.workerResponse(url,options);}assert.equal(url,config.productionDatabaseUrl+'/auth/v1/user','External network forbidden');return Response.json(options.headers.Authorization==='Bearer task2c-synthetic-owner'?{id:ids.owner,is_anonymous:false}:{error:'invalid synthetic session'},{status:options.headers.Authorization==='Bearer task2c-synthetic-owner'?200:401});};
  const preview=modules()('@/lib/projects/preview');
  const load=modules({'@/lib/projects/preview':previewTransport(preview,{fixture,trace}),'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>client},'@octokit/rest':{Octokit:githubTransport({fixture,release,trace,issue})}});
  const route=load('@/app/api/projects/lifecycle-approval/route'),development=load('@/lib/agents/development');
  const registry=load('@/lib/models/registry');
  const refreshed=await registry.refreshModelRegistry([{name:'openai',listModels:async()=>['gpt-5.3-codex']}]);
  assert.equal(refreshed[0].ok,true,'Synthetic registry transport must support real refresh');
  const registered=(await db.query("select * from model_registry where provider_name='openai' and normalized_model_id='gpt-5.3-codex'")).rows[0];
  assert.equal(registered.pricing_status,'verified');assert.equal(registered.supports_text,true);assert.ok(['verified','restricted'].includes(registered.routing_eligibility));

  const request=(method,body,token='task2c-synthetic-owner')=>new NextRequest(config.productionUrl+'/api/projects/lifecycle-approval?taskId='+ids.task,{method,headers:{Authorization:'Bearer '+token,Origin:config.productionUrl,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(ordinary){assert.equal(await development.dispatchOwnerRenewedNativeDevelopment(),true,'Initial ordinary owner authority dispatches through existing runtime');assert.equal(await development.dispatchOwnerRenewedNativeDevelopment(),false);}
  first=await qualifyLifecycleContinuation(db,ids,fixture,initialAmendment,{runId:131,provider,signing,keepRoot:true,...(ordinary?{request:issue.body}:{}),afterRun:async result=>result});
  let historical,pending,result,workflow;
  if(adequate){
   assert.equal(first.code,0,first.log+'\n'+JSON.stringify(first.diagnostics));
   assert.deepEqual([...phaseCounts],[['implementation',2],['review',2],['final-review',2]]);assert.equal(providerCalls,6);
   assert.ok(first.diagnostics.capacityForecasts.every(f=>f.status!=='insufficient'));report.forecasts=first.diagnostics.capacityForecasts;
   historical=await ledger();report.historicalCalls=historical.calls;report.originalAuthorityHistory=originalAuthorityHistory;
   second=first;workflow={id:131,event:'issues',path:'.github/workflows/autonomous-development.yml',head_branch:'main',head_sha:release,status:'completed',conclusion:'success',created_at:new Date().toISOString(),html_url:'https://github.com/mfackrell/katie/actions/runs/131',run_attempt:1,repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}};
  }else{
  assert.notEqual(first.code,0,first.log);assert.ok(first.diagnostics,first.log);assert.match(first.diagnostics.failure,/OWNER_APPROVAL_REQUIRED/);
  assert.deepEqual([...phaseCounts],[['implementation',5],['review',6]]);assert.equal(providerCalls,11);
  for(const measured of observations)assert.deepEqual(first.diagnostics.capacityObservations.find(o=>o.id===measured.id),measured,'Authenticated clean-baseline measurements must survive into the owner proposal');
  const record=first.diagnostics.wipCheckpoint;assert.equal(record.phase,'repair');assert.equal(record.lastCompleted.review.verdict,'changes_requested');
  const initialBrowserPath=join(first.runtime,'qualification-browser-acceptance.json');
  assert.ok(existsSync(initialBrowserPath),'Initial deterministic verification must reach the frozen browser assertion');
  const initialBrowser=JSON.parse(readFileSync(initialBrowserPath,'utf8'));
  assert.equal(initialBrowser.passed,false);assert.equal(initialBrowser.projectId,ids.project);assert.equal(initialBrowser.contractHash,context.contractHash);
  assert.equal(initialBrowser.headSha,record.lastCompleted.verification.head);
  assert.deepEqual(context.contract.scenarios[0].steps,[{action:'expectText',selector:'#state',value:'Recovered'}]);
  assert.deepEqual(initialBrowser.checks,[{name:context.contract.scenarios[0].name,passed:false,detail:'Rendered text does not equal approved expected value'}]);
  report.initialBrowserFailure=initialBrowser;
  report.checkpoint=record;report.forecasts=first.diagnostics.capacityForecasts;assert.equal(report.forecasts.at(-1).status,'insufficient');assert.notEqual(report.forecasts[0].status,'insufficient');
  historical=await ledger();for(const row of prior.calls??[])assert.deepEqual(historical.calls.find(c=>c.id===row.id),row);
  assert.equal(historical.calls.length,(prior.calls?.length??0)+11);report.pauseLedgerHash=hash(historical);report.historicalCalls=historical.calls;
  const receipt={version:1,repository:'mfackrell/katie',issue_number:829,checks:{build:'failure',test:'false',review:'changes_requested',repair:'skipped',retest:'skipped',final_review:'skipped'},...oldTask.external.receipt,run_id:131,outcome:'BLOCKED',pr_url:null};fixture.receipt=receipt;

  writeFileSync(join(root,'artifact.zip'),archive(first.diagnostics));
  workflow={id:131,status:'completed',conclusion:'failure',event:ordinary?'issues':'workflow_dispatch',path:'.github/workflows/autonomous-development.yml',head_branch:'main',head_sha:initialAmendment.release_sha,created_at:new Date().toISOString(),html_url:'https://github.com/mfackrell/katie/actions/runs/131',run_attempt:1,repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}};
  writeFileSync(join(root,'workflow.json'),JSON.stringify(workflow));writeFileSync(join(root,'artifacts.json'),JSON.stringify({total_count:1,artifacts:[{id:1,name:'native-execution-diagnostics',expired:false,size_in_bytes:readFileSync(join(root,'artifact.zip')).length,workflow_run:{id:131,head_sha:workflow.head_sha}}]}));
  // Preserve evidence, then destroy both source and trusted scratch from the old
  // runner. The continuation must use only the durable remote/archive bindings.
  const disk=()=>{const value=statfsSync(root);return {availableBytes:value.bavail*value.bsize};};
  report.firstRunnerDisposal={before:disk()};
  const retained=join(root,'retained-131');mkdirSync(retained);
  for(const name of ['qualification-verifier-tail.json','qualification-browser-acceptance.json'])if(existsSync(join(first.runtime,name)))cpSync(join(first.runtime,name),join(retained,name));
  rmSync(first.workspace,{recursive:true,force:true});rmSync(first.runtime,{recursive:true,force:true});first.runtime=retained;
  report.firstRunnerDisposal.after=disk();
  const claim=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(claim?.job.id,ids.task,'Original development assignment must reconcile its host receipt');
  await load('@/lib/missions/worker').executeClaim(claim,async()=>{throw Error('Receipt reconciliation cannot invoke inference');});
  assert.equal((await one('agent_tasks','id',ids.task)).status,'blocked',JSON.stringify(await one('mission_assignments','id',ids.task)));assert.equal((await one('agent_missions','id',ids.mission)).status,'blocked');
  await load('@/lib/projects/worker').runProjectBatch();
  assert.equal((await one('work_projects','id',ids.project)).status,'blocked');
  const offered=await route.GET(request('GET'));assert.equal(offered.status,200,await offered.clone().text());pending=await offered.json();assert.equal(pending.state,'pending');assert.equal(pending.proposal.additions.nativeCalls,4);report.proposal=pending.proposal;
  const preservedTask=await one('agent_tasks','id',ids.task);
  const preservedProposal=(await db.query('select checkpoint from benchmark_lifecycle_proposals where id=$1',[pending.proposal.id])).rows[0].checkpoint;
  const activeGrant=(await db.query('select * from benchmark_execution_grants where account_id=$1 order by execution_epoch desc limit 1',[ids.account])).rows[0];
  const denyNative=async()=>assert.rejects(db.query('select '+(ordinary?'developer_native_reserve':'benchmark_full_native_reserve')+'($1,$2,$3,$4,$5,$6)',[activeGrant.token_digest,ordinary?ids.project:ids.trial,activeGrant.execution_epoch,randomUUID(),'gpt-5.3-codex',100]),/closure|unauthorized|capacity|protected completion|external Developer assignment inactive|Ordinary native admission denied/i);
  await denyNative();
  const decision={taskId:ids.task,proposalId:pending.proposal.id,decision:'approved'};
  assert.equal((await route.POST(request('POST',decision,'wrong-owner'))).status,403);
  assert.equal(providerCalls,11);assert.deepEqual(await ledger(),historical);
  report.ownerBrowser=await integratedOwnerBrowser(route,async(page,exchanges)=>{
   assert.ok((await page.locator('body').innerText()).includes(ids.task));
   assert.equal(providerCalls,11);assert.deepEqual(await ledger(),historical);
   // Isolated rejected decision cannot authorize or corrupt the checkpoint.
   scenarioConnection=db;await db.query('begin');
   await page.getByRole('button',{name:'Reject amendment'}).click();
   await page.getByText(/Owner rejected; saved work remains recoverable/).waitFor();
   assert.equal((await db.query("select count(*)::int n from benchmark_lifecycle_decisions where decision='approved' and proposal_id=$1",[pending.proposal.id])).rows[0].n,0);assert.deepEqual(await ledger(),historical);
   assert.deepEqual(await one('agent_tasks','id',ids.task),preservedTask);
   assert.deepEqual((await db.query('select checkpoint from benchmark_lifecycle_proposals where id=$1',[pending.proposal.id])).rows[0].checkpoint,preservedProposal);
   await db.query('savepoint rejected_native');await denyNative();await db.query('rollback to savepoint rejected_native');
   report.scenarios.push({id:9,pass:true,observed:'Ignored views and actual browser rejection created no authority, calls or checkpoint changes'});
   await db.query('rollback');scenarioConnection=null;await page.reload();await page.getByRole('button',{name:'Approve exactly this amendment'}).waitFor();
   approvalRace={arrivals:0};approvalRace.ready=new Promise(resolve=>{approvalRace.release=resolve;});
   const click=page.getByRole('button',{name:'Approve exactly this amendment'}).click();
   const racing=route.POST(request('POST',decision));await click;const response=await racing;assert.equal(response.status,200,await response.clone().text());
   assert.equal(approvalRace.arrivals,2);approvalRace=null;
   await page.getByText(/Amendment authorized; continuation queued/).waitFor();result=await response.json();
   assert.equal((await db.query('select count(*)::int n from benchmark_lifecycle_decisions where proposal_id=$1',[pending.proposal.id])).rows[0].n,1);assert.deepEqual((await ledger()).calls,historical.calls);
   assert.ok(exchanges.some(x=>x.method==='POST'&&x.request.decision==='approved'&&x.status===200));
   await page.reload();await page.getByText(/Amendment authorized; continuation queued/).waitFor();
   assert.equal((await route.POST(request('POST',decision))).status,200);assert.equal(providerCalls,11,'Committed approval/reload does not dispatch');
  });
  report.authorization=result;
  assert.equal(await development.dispatchOwnerRenewedNativeDevelopment(),true);assert.equal(await development.dispatchOwnerRenewedNativeDevelopment(),false);assert.equal(trace.filter(t=>t.boundary==='workflow_dispatch').length,1);
  const amendment=ordinary?{approval_id:result.approvalId,release_sha:release}:(await db.query('select * from benchmark_development_resource_amendments where continuation_id=$1',[result.continuationId])).rows[0];assert.ok(amendment);
  recovering=true;phaseCounts=new Map();second=await qualifyLifecycleContinuation(db,ids,fixture,amendment,{runId:132,provider,signing,keepRoot:true,request:issue.body,afterRun:async result=>result});
  assert.equal(second.code,0,second.log+'\n'+JSON.stringify(second.diagnostics)+'\n'+(existsSync(join(second.runtime,'qualification-verifier-tail.json'))?readFileSync(join(second.runtime,'qualification-verifier-tail.json'),'utf8'):''));assert.deepEqual([...phaseCounts],[['repair',2],['final-review',2]]);
  }
  const completion=JSON.parse(readFileSync(second.evidence)),browser=JSON.parse(readFileSync(join(second.runtime,'qualification-browser-acceptance.json')));assert.equal(completion.taskId,ids.task);assert.equal(completion.completed,true);assert.equal(browser.passed,true);assert.equal(browser.contractHash,context.contractHash);assert.equal(browser.headSha,completion.reviewedHeadSha);
  for(const row of historical.calls)assert.deepEqual((await ledger()).calls.find(c=>c.id===row.id),row);
  for(const row of historical.exposures)assert.deepEqual((await ledger()).exposures.find(c=>c.call_id===row.call_id),row);
  fixture.completion=completion;fixture.continued=second;
  report.acceptedFiles=[{path:'app/pilot/page.tsx',head:completion.reviewedHeadSha,sha256:hash(execFileSync('git',['--git-dir',remote,'show',completion.reviewedHeadSha+':app/pilot/page.tsx'],{encoding:'utf8'}))}];
  if(adequate){assert.equal(completion.repairPerformed,false);assert.equal(completion.repairVerification,null);}else{assert.equal(completion.repairVerification.after.passed,true);assert.equal(completion.repairVerification.after.head,completion.reviewedHeadSha);}
  fixture.verifierLog=JSON.parse(readFileSync(join(second.runtime,'qualification-verifier-tail.json'),'utf8')).tail;
  fixture.receipt={version:1,repository:'mfackrell/katie',issue_number:829,run_id:adequate?131:132,pr_url:'https://github.com/mfackrell/katie/pull/829',outcome:'READY',tested_head_sha:completion.reviewedHeadSha,reviewed_head_sha:completion.reviewedHeadSha,checks:adequate?{build:'success',test:'true',review:'pass',repair:'skipped',retest:'',final_review:''}:{build:'success',test:'false',review:'changes_requested',repair:'success',retest:'true',final_review:'pass'},projectAcceptance:browser};
  writeFileSync(join(root,'workflow.json'),JSON.stringify({...workflow,id:adequate?131:132,event:adequate?'issues':'workflow_dispatch',head_sha:release,conclusion:'success',created_at:new Date().toISOString()}));
  if(adequate){
   writeFileSync(join(root,'artifact.zip'),archive(first.diagnostics));
   writeFileSync(join(root,'artifacts.json'),JSON.stringify({total_count:1,artifacts:[{id:1,name:'native-execution-diagnostics',expired:false,size_in_bytes:readFileSync(join(root,'artifact.zip')).length,workflow_run:{id:131,head_sha:release}}]}));
  }
  fixture.workerResponse=completionTransport({fixture,trace});
  const worker=load('@/lib/missions/worker');
  const developerClaim=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(developerClaim?.job.id,ids.task);
  await worker.executeClaim(developerClaim);
  const reconciledTask=await one('agent_tasks','id',ids.task);report.reconciledTask=reconciledTask;assert.equal(reconciledTask.status,'ready',JSON.stringify(reconciledTask));
  const completionJobs=[];
  for(let n=0;n<3;n++){
   if((await one('agent_missions','id',ids.mission)).status==='completed')break;
   const next=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(next?.mission.id,ids.mission);assert.ok(['compose','review'].includes(next.job.role),'Completed native development cannot replay');
   completionJobs.push({id:next.job.id,role:next.job.role,agentId:next.job.agent_id});await worker.executeClaim(next);
  }
  assert.deepEqual(completionJobs.map(j=>j.role),['compose','review']);assert.notEqual(completionJobs[0].agentId,completionJobs[1].agentId);
  assert.equal((await one('agent_missions','id',ids.mission)).status,'completed');
  await load('@/lib/projects/worker').runProjectBatch();
  assert.equal((await one('work_projects','id',ids.project)).verified_sha,completion.reviewedHeadSha);
  report.completionWorkers=completionJobs;
  const projectWorker=load('@/lib/projects/worker'),assessmentJobs=[];
  for(let step=0;step<8;step++){
   const current=await one('work_projects','id',ids.project);
   trace.push({boundary:'project_stage',phase:current.phase,status:current.status,missionId:current.active_mission_id});
   if(current.status==='completed')break;
   assert.equal(current.status,'running',current.detail);
   if(current.phase==='assessment'&&current.active_mission_id){
    const next=(await db.query('select claim_mission_work() c')).rows[0].c;
    assert.equal(next?.mission.id,current.active_mission_id);assert.equal(next.mission.project_kind,'assessment');
    assert.ok(['plan','compose','review'].includes(next.job.role));
    assessmentJobs.push({id:next.job.id,role:next.job.role,agentId:next.job.agent_id});await worker.executeClaim(next);
    if((await one('agent_missions','id',current.active_mission_id)).status!=='completed')continue;
   }
   const outcome=await projectWorker.runProjectBatch();assert.notEqual(outcome.status,'error_recorded',JSON.stringify(await one('work_projects','id',ids.project)));
  }
  const finished=await one('work_projects','id',ids.project);
  assert.equal(finished.status,'completed',finished.detail);assert.equal(finished.verified_sha,completion.reviewedHeadSha);
  assert.equal(finished.approved_hash,scope);assert.equal(finished.baseline_sha,baseline);assert.ok(finished.result);
  assert.deepEqual(assessmentJobs.map(j=>j.role),['plan','compose','review']);assert.notEqual(assessmentJobs[1].agentId,assessmentJobs[2].agentId);
  const finalLedger=await ledger();for(const row of historical.calls)assert.deepEqual(finalLedger.calls.find(c=>c.id===row.id),row);
  for(const row of historical.exposures)assert.deepEqual(finalLedger.exposures.find(e=>e.call_id===row.call_id),row);
  assert.ok(finalLedger.calls.every(c=>c.state==='settled'),'No unresolved synthetic paid work');
  assert.equal(providerCalls,adequate?6:15);assert.equal((await db.query("select count(*)::int n from project_runs where project_id=$1 and kind='development'",[ids.project])).rows[0].n,1,'No replacement development mission');
  if(adequate){assert.deepEqual(await authorityHistory(),originalAuthorityHistory,'Adequate task must finish without any amendment proposal or decision');assert.equal((await db.query('select count(*)::int n from benchmark_native_spending_approvals where task_id=$1',[ids.task])).rows[0].n,1);}else assert.equal((await db.query('select count(*)::int n from benchmark_lifecycle_decisions where proposal_id=$1',[pending.proposal.id])).rows[0].n,1);
  report.assessmentWorkers=assessmentJobs;report.finalProjectReceipt=finished;report.finalProjectBrowser=fixture.finalBrowser;
  const purpose=(await db.query(`select m.project_kind,j.role,count(*)::int calls from benchmark_budget_calls c join mission_calls legacy on legacy.id=c.legacy_mission_call_id join mission_assignments j on j.id=legacy.job_id join agent_missions m on m.id=j.mission_id where c.account_id=$1 group by m.project_kind,j.role order by m.project_kind,j.role`,[ids.account])).rows;
  assert.equal(purpose.find(p=>p.role==='development')?.calls,adequate?6:15);
  for(const kind of ['development','assessment']){const protectedCalls=purpose.filter(p=>p.project_kind===kind&&p.role!=='development');assert.ok(protectedCalls.every(p=>['compose','review'].includes(p.role)));const count=protectedCalls.reduce((n,p)=>n+p.calls,0);assert.ok(count>0&&count<=4,JSON.stringify(purpose));}
  report.accountingByPurpose=purpose;report.finalLedgerHash=hash(finalLedger);
  if(adequate)report.scenarios.push({id:1,pass:true,observed:'Original ordinary authority completed implementation, independent review, deterministic acceptance, final review, completion and assessment without repair or any additional proposal/decision. Forecast unknowns remain explicit.'});else report.scenarios.push(
   {id:2,pass:true,observed:'Eleven native calls settled, zero native slots, tokens and dollars retained; one four-call proposal.'},
   {id:5,pass:true,observed:'Four completion slots excluded from repair before and after amendment; retained until legitimate completion-worker use.'},
   {id:6,pass:true,observed:'Review findings required repair; refreshed forecast stopped before its first request and consolidated remaining native demand.'},
   {id:8,pass:true,observed:'Authenticated owner route committed exact proposal and real host used amended capacity on original task.'},
   {id:10,pass:true,observed:'Two barrier-synchronized owner decisions plus duplicate click created one amendment and one continuation dispatch.'},
   {id:12,pass:true,observed:'Fresh host restored original repair checkpoint; only repair and final review ran; initial eleven receipts unchanged.'}
  );

  report.externalTransportLimitations=['Provider responses, model inventory/catalog/pricing provenance and external owner identity are isolated synthetic transports.','GitHub issue/workflow/PR and Vercel deployment responses are synthetic, backed by actual local source and host receipts.','Final browser executes Chromium against the same local immutable candidate; this fixture does not qualify Vercel network, deployment protection or paid model performance.'];
  report.completion=completion;report.browserAcceptance=browser;report.continuationDiagnostics=second.diagnostics;report.finalLedger=await ledger();
  console.log('TASK2C_INTEGRATED_NATIVE_PASS mode='+report.mode);
 }finally{
  globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);
  const destination=join(process.env.RUNNER_TEMP??root,'task2c-qualification');mkdirSync(destination,{recursive:true});writeFileSync(join(destination,'report.json'),JSON.stringify(report,null,2));for(const [label,result]of(adequate?[['adequate',first]]:[['initial',first],['continued',second]]))if(result){writeFileSync(join(destination,label+'-host.log'),result.log);writeFileSync(join(destination,label+'-diagnostics.json'),JSON.stringify(result.diagnostics,null,2));for(const name of ['qualification-verifier-tail.json','qualification-browser-acceptance.json'])if(existsSync(join(result.runtime,name)))cpSync(join(result.runtime,name),join(destination,label+'-'+name));}
  if(process.env.RUNNER_TEMP)rmSync(root,{recursive:true,force:true});
 }
}
