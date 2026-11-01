// Task 2C: one synthetic assignment, real host/route/SQL/dispatcher/recovery.
// The only substituted boundaries are external identity, GitHub and provider transport.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {NextRequest} from 'next/server.js';
import {modules} from './load-project-modules.mjs';
import {integratedOwnerBrowser} from './lifecycle-owner-integrated-browser.mjs';
import {postgresClient,githubTransport} from './lifecycle-qualification-adapters.mjs';
import {createLifecycleCheckpoint,qualifyLifecycleContinuation,archive} from './qualify-lifecycle-continuation.mjs';
import {projectMarker} from '../../scripts/project-context.mjs';
import {encodeNativeHandoff} from '../../scripts/benchmark/native-dispatch-contract.mjs';
import {sealNativeProductionRuntime} from '../../scripts/benchmark/native-runtime-capsule.mjs';
import config from '../../config/benchmark-715-production-qualification.json' with {type:'json'};
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const quote=v=>"'"+v.replaceAll("'","'\"'\"'")+"'";
export async function qualifyResourceLifecycle(db,rival,ids,initialAmendment){
 await db.query('reset role');await db.query(readFileSync('supabase/migrations/20261101123639_lifecycle_owner_authorization.sql','utf8'));await db.query('alter table actors add column if not exists actor_kind text');
 for(const name of ['20261022093000_separate_project_resource_estimates.sql','20261028193000_standalone_provider_attempt_ledger.sql','20261101160000_ordinary_developer_authority.sql'])await db.query(readFileSync('supabase/migrations/'+name,'utf8'));
 await db.query('set role service_role');
 const fixture=await createLifecycleCheckpoint(db,ids,{initial:true});
 const {root,remote,context,baseline,one}=fixture,trace=[],report={version:1,syntheticOnly:true,paidInference:0,ids,baseline,contract:context.contract,contractHash:context.contractHash,scenarios:[],trace};
 const ledger=async()=>(await db.query(`select jsonb_build_object('calls',(select jsonb_agg(to_jsonb(c) order by id) from benchmark_budget_calls c where account_id=$1),'exposures',(select jsonb_agg(to_jsonb(e) order by call_id) from benchmark_dollar_exposures e where account_id=$1),'account',(select to_jsonb(a) from benchmark_budget_accounts a where id=$1)) value`,[ids.account])).rows[0].value;
 const prior=await ledger();report.initialLedgerHash=hash(prior);
 // Controlled prior measured phases are linked to genuine isolated settled rows.
 const rows=(await db.query("select to_jsonb(c) value from benchmark_budget_calls c where account_id=$1 and state='settled' and model='gpt-5.3-codex' and provider_usage is not null order by actual_tokens,id limit 12",[ids.account])).rows.map(r=>r.value);assert.equal(rows.length,12);
 const scope=(await one('work_projects','id',ids.project)).approved_hash;
 const observations=['repair','final_review'].flatMap((stage,k)=>[0,1,2].map(i=>{const calls=rows.slice(k*6+i*2,k*6+i*2+2);return {id:'controlled-history-'+stage+i,stage,source:'verified_phase_receipts',cohort:scope,binding:{projectId:ids.project,scopeHash:scope},completed:true,calls:2,inputTokens:calls.reduce((n,c)=>n+c.provider_usage.input_tokens,0),outputTokens:calls.reduce((n,c)=>n+c.provider_usage.output_tokens,0),seconds:5,operationIds:calls.map(c=>c.id)};}));
 const oldTask=await one('agent_tasks','id',ids.task),oldRun=oldTask.external.receipt.run_id;
 writeFileSync(join(root,'artifact.zip'),archive({taskId:ids.task,runId:String(oldRun),completed:false,phases:[],capacityObservations:observations,snapshots:[{label:'final',head:baseline,status:[]}]}));
 let recovering=false,phaseCounts=new Map(),providerCalls=0;
 const provider=async(body,path)=>{
  if(path.endsWith('/input_tokens'))return {type:'application/json',body:JSON.stringify({object:'response.input_tokens',input_tokens:3})};
  const input=JSON.stringify(body.input),phase=input.includes('prior findings remain')?'final-review':input.includes('Fix only the independent reviewer')?'repair':input.includes('fresh independent reviewer')?'review':input.includes('Complete the approved engineering work')?'implementation':null;assert.ok(phase,'Unknown real SDK phase');
  if(recovering)assert.ok(['repair','final-review'].includes(phase),'Completed engineering replayed');else assert.ok(['implementation','review'].includes(phase),'Paid repair started before owner approval');
  const n=(phaseCounts.get(phase)??0)+1;phaseCounts.set(phase,n);providerCalls++;const total=recovering?2:phase==='implementation'?6:5;assert.ok(n<=total);
  const source='export default function Page(){return <div id="state">'+(recovering?'Recovered':'Broken')+'</div>}\n';
  const cmd=phase==='implementation'&&n===1?'node -e '+quote(`const f=require('node:fs');f.mkdirSync('app/pilot',{recursive:true});f.writeFileSync('app/pilot/page.tsx',${JSON.stringify(source)});`):phase==='repair'?'node -e '+quote(`const f=require('node:fs'),a=require('node:assert/strict');a.match(f.readFileSync('app/pilot/page.tsx','utf8'),/Broken/);f.writeFileSync('app/pilot/page.tsx',${JSON.stringify(source)});`):'node -e '+quote(`require('node:assert/strict').match(require('node:fs').readFileSync('app/pilot/page.tsx','utf8'),/${recovering?'Recovered':'Broken'}/);`);
  const item=n<total?{id:'fc_'+providerCalls,type:'function_call',namespace:'functions',name:'exec_command',call_id:'call_'+providerCalls,status:'completed',arguments:JSON.stringify({cmd,workdir:'/work'})}:{id:'msg_'+providerCalls,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:phase==='review'?'CHANGES_REQUESTED Repair the displayed state to satisfy frozen acceptance.':phase==='final-review'?'PASS Independently inspected repaired source.':'DONE',annotations:[],logprobs:[]}]};
  const response={id:'task2c-synthetic-'+providerCalls,object:'response',model:body.model,created_at:1,status:'completed',service_tier:'default',output:[item],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
  trace.push({boundary:'provider',run:recovering?132:131,phase,request:n,requestHash:hash(body)});
  return {type:'text/event-stream',body:[['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],['response.completed',{type:'response.completed',response}]].map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join('')+'data: [DONE]\n\n'};
 };
 const signing='synthetic-only-task2c-owner-handoff-secret';
 let first,second;
 const oldEnv={...process.env},oldFetch=globalThis.fetch;
 try{
  first=await qualifyLifecycleContinuation(db,ids,fixture,initialAmendment,{runId:131,provider,signing,keepRoot:true,afterRun:async result=>result});
  assert.notEqual(first.code,0,first.log);assert.ok(first.diagnostics,first.log);assert.match(first.diagnostics.failure,/OWNER_APPROVAL_REQUIRED/);
  assert.deepEqual([...phaseCounts],[['implementation',6],['review',5]]);assert.equal(providerCalls,11);
  for(const measured of observations)assert.deepEqual(first.diagnostics.capacityObservations.find(o=>o.id===measured.id),measured,'Authenticated clean-baseline measurements must survive into the owner proposal');
  const record=first.diagnostics.wipCheckpoint;assert.equal(record.phase,'repair');assert.equal(record.lastCompleted.review.verdict,'changes_requested');
  report.checkpoint=record;report.forecasts=first.diagnostics.capacityForecasts;assert.equal(report.forecasts.at(-1).status,'insufficient');assert.notEqual(report.forecasts[0].status,'insufficient');
  const historical=await ledger();for(const row of prior.calls)assert.deepEqual(historical.calls.find(c=>c.id===row.id),row);
  assert.equal(historical.calls.length,prior.calls.length+11);report.pauseLedgerHash=hash(historical);report.historicalCalls=historical.calls;
  const receipt={...oldTask.external.receipt,run_id:131,outcome:'BLOCKED',pr_url:null};fixture.receipt=receipt;

  writeFileSync(join(root,'artifact.zip'),archive(first.diagnostics));
  const workflow={id:131,status:'completed',conclusion:'failure',event:'workflow_dispatch',path:'.github/workflows/autonomous-development.yml',head_branch:'main',head_sha:initialAmendment.release_sha,created_at:new Date().toISOString(),html_url:'https://github.com/mfackrell/katie/actions/runs/131',run_attempt:1,repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}};
  writeFileSync(join(root,'workflow.json'),JSON.stringify(workflow));writeFileSync(join(root,'artifacts.json'),JSON.stringify({total_count:1,artifacts:[{id:1,name:'native-execution-diagnostics',expired:false,size_in_bytes:readFileSync(join(root,'artifact.zip')).length,workflow_run:{id:131,head_sha:workflow.head_sha}}]}));
  rmSync(first.workspace,{recursive:true,force:true});
  const release='e'.repeat(40),issue={number:829,user:{login:'mfackrell'},body:'<!-- katie-managed-task:'+ids.task+' -->\n\n'+first.request};
  let turn=0,scenarioConnection=null,approvalRace=null;
  const client=postgresClient({query:async(...args)=>{
   let connection=scenarioConnection??(turn++%2?db:rival);
   if(approvalRace&&args[0].includes('benchmark_lifecycle_decide')){
    const race=approvalRace,index=race.arrivals++;connection=index===0?db:rival;
    assert.ok(index<2);if(race.arrivals===2)race.release();await race.ready;
   }
   return connection.query(...args);
  }},trace);
  Object.assign(process.env,{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:release,NEXT_PUBLIC_SUPABASE_URL:config.productionDatabaseUrl,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-role',KATIE_OWNER_AUTH_USER_ID:ids.owner,GITHUB_TOKEN:'synthetic-github',KATIE_NATIVE_HANDOFF_HMAC_KEY:signing,KATIE_FULL_BENCHMARK_ENVIRONMENT:'production',KATIE_FULL_BENCHMARK_DISPATCH:'enabled',KATIE_NATIVE_BENCHMARK_DISPATCH:'enabled',KATIE_BENCHMARK_PAID_EXECUTION:'enabled'});
  globalThis.fetch=async(url,options)=>{assert.equal(url,config.productionDatabaseUrl+'/auth/v1/user','External network forbidden');return Response.json(options.headers.Authorization==='Bearer task2c-synthetic-owner'?{id:ids.owner,is_anonymous:false}:{error:'invalid synthetic session'},{status:options.headers.Authorization==='Bearer task2c-synthetic-owner'?200:401});};
  const load=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>client},'@octokit/rest':{Octokit:githubTransport({fixture,release,trace,issue})}});
  const route=load('@/app/api/projects/lifecycle-approval/route'),development=load('@/lib/agents/development');
  const request=(method,body,token='task2c-synthetic-owner')=>new NextRequest(config.productionUrl+'/api/projects/lifecycle-approval?taskId='+ids.task,{method,headers:{Authorization:'Bearer '+token,Origin:config.productionUrl,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const claim=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(claim?.job.id,ids.task,'Original development assignment must reconcile its host receipt');
  await load('@/lib/missions/worker').executeClaim(claim,async()=>{throw Error('Receipt reconciliation cannot invoke inference');});
  assert.equal((await one('agent_tasks','id',ids.task)).status,'blocked');assert.equal((await one('agent_missions','id',ids.mission)).status,'blocked');
  await load('@/lib/projects/worker').runProjectBatch();
  assert.equal((await one('work_projects','id',ids.project)).status,'blocked');
  const offered=await route.GET(request('GET'));assert.equal(offered.status,200,await offered.clone().text());const pending=await offered.json();assert.equal(pending.state,'pending');assert.equal(pending.proposal.additions.nativeCalls,4);report.proposal=pending.proposal;
  const preservedTask=await one('agent_tasks','id',ids.task);
  const preservedProposal=(await db.query('select checkpoint from benchmark_lifecycle_proposals where id=$1',[pending.proposal.id])).rows[0].checkpoint;
  const activeGrant=(await db.query('select * from benchmark_execution_grants where account_id=$1 order by execution_epoch desc limit 1',[ids.account])).rows[0];
  const denyNative=async()=>assert.rejects(db.query('select benchmark_full_native_reserve($1,$2,$3,$4,$5,$6)',[activeGrant.token_digest,ids.trial,activeGrant.execution_epoch,randomUUID(),'gpt-5.3-codex',100]),/closure|unauthorized|capacity/i);
  await denyNative();
  const decision={taskId:ids.task,proposalId:pending.proposal.id,decision:'approved'};
  assert.equal((await route.POST(request('POST',decision,'wrong-owner'))).status,403);
  assert.equal(providerCalls,11);assert.deepEqual(await ledger(),historical);
  let result;
  report.ownerBrowser=await integratedOwnerBrowser(route,async(page,exchanges)=>{
   assert.ok((await page.locator('body').innerText()).includes(ids.task));
   assert.equal(providerCalls,11);assert.deepEqual(await ledger(),historical);
   // Isolated rejected decision cannot authorize or corrupt the checkpoint.
   scenarioConnection=db;await db.query('begin');
   await page.getByRole('button',{name:'Reject amendment'}).click();
   await page.getByText(/Owner rejected; saved work remains recoverable/).waitFor();
   assert.equal((await db.query("select count(*)::int n from benchmark_lifecycle_decisions where decision='approved'")).rows[0].n,0);assert.deepEqual(await ledger(),historical);
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
   assert.equal((await db.query('select count(*)::int n from benchmark_lifecycle_decisions')).rows[0].n,1);assert.deepEqual((await ledger()).calls,historical.calls);
   assert.ok(exchanges.some(x=>x.method==='POST'&&x.request.decision==='approved'&&x.status===200));
   await page.reload();await page.getByText(/Amendment authorized; continuation queued/).waitFor();
   assert.equal((await route.POST(request('POST',decision))).status,200);assert.equal(providerCalls,11,'Committed approval/reload does not dispatch');
  });
  report.authorization=result;
  assert.equal(await development.dispatchOwnerRenewedNativeDevelopment(),true);assert.equal(await development.dispatchOwnerRenewedNativeDevelopment(),false);assert.equal(trace.filter(t=>t.boundary==='workflow_dispatch').length,1);
  const amendment=(await db.query('select * from benchmark_development_resource_amendments where continuation_id=$1',[result.continuationId])).rows[0];assert.ok(amendment);
  recovering=true;phaseCounts=new Map();second=await qualifyLifecycleContinuation(db,ids,fixture,amendment,{runId:132,provider,signing,keepRoot:true,request:issue.body,afterRun:async result=>result});
  assert.equal(second.code,0,second.log+'\n'+JSON.stringify(second.diagnostics));assert.deepEqual([...phaseCounts],[['repair',2],['final-review',2]]);
  const completion=JSON.parse(readFileSync(second.evidence)),browser=JSON.parse(readFileSync(join(second.runtime,'qualification-browser-acceptance.json')));assert.equal(completion.taskId,ids.task);assert.equal(completion.completed,true);assert.equal(browser.passed,true);assert.equal(browser.contractHash,context.contractHash);assert.equal(browser.headSha,completion.reviewedHeadSha);
  for(const row of historical.calls)assert.deepEqual((await ledger()).calls.find(c=>c.id===row.id),row);
  for(const row of historical.exposures)assert.deepEqual((await ledger()).exposures.find(c=>c.call_id===row.call_id),row);
  report.completion=completion;report.browserAcceptance=browser;report.continuationDiagnostics=second.diagnostics;report.finalLedger=await ledger();
  console.log('TASK2C_INTEGRATED_NATIVE_PASS');
 }finally{
  globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);
  const destination=join(process.env.RUNNER_TEMP??root,'task2c-qualification');mkdirSync(destination,{recursive:true});writeFileSync(join(destination,'report.json'),JSON.stringify(report,null,2));for(const [label,result]of[['initial',first],['continued',second]])if(result){writeFileSync(join(destination,label+'-host.log'),result.log);writeFileSync(join(destination,label+'-diagnostics.json'),JSON.stringify(result.diagnostics,null,2));}
  if(process.env.RUNNER_TEMP)rmSync(root,{recursive:true,force:true});
 }
}
