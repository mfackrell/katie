import {encodeDeveloperHandoff,readDeveloperHandoff} from '../../scripts/benchmark/developer-dispatch-contract.mjs';
// Nonbillable qualification only. Production host/recovery/admission code with
// synthetic provider and GitHub transports, disposable Git and PostgreSQL state.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {encodeNativeHandoff,readNativeHandoff} from '../../scripts/benchmark/native-dispatch-contract.mjs';
import {sealNativeProductionRuntime} from '../../scripts/benchmark/native-runtime-capsule.mjs';
import {projectMarker,contractHash} from '../../scripts/project-context.mjs';
import {createNativeWipCheckpointer} from '../../scripts/benchmark/native-wip-checkpoint.mjs';
import {loadRecoveryDiagnostics,validateRecoveryRecords} from '../../scripts/benchmark/native-wip-recovery.mjs';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
const write=(base,path,content)=>{mkdirSync(dirname(join(base,path)),{recursive:true});writeFileSync(join(base,path),content);};
const quote=v=>"'"+v.replaceAll("'","'\"'\"'")+"'";
export function archive(value){
 const name=Buffer.from('native-metered-review.json.diagnostics.json'),body=Buffer.from(JSON.stringify(value));
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(name.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+body.length,16);
 return Buffer.concat([local,name,body,central,name,end]);
}
export async function createLifecycleCheckpoint(db,ids,{initial=false}={}){
 const root=mkdtempSync(join(tmpdir(),'lifecycle-host-')),remote=join(root,'remote.git'),workspace=join(root,'source'),repo=resolve('.');
 const one=async(table,column,value)=>(await db.query(`select to_jsonb(r) value from ${table} r where ${column}=$1`,[value])).rows[0]?.value;
 const ordinary=ids.authorityKind==='ordinary-developer';
 const trial=ordinary?null:await one('benchmark_three_arm_trials','id',ids.trial),project=await one('work_projects','id',ids.project),baseline=ordinary?project.baseline_sha:trial.baseline_sha;
 git(root,'init','--bare','-q',remote);git(root,'clone','--no-hardlinks','--no-checkout',repo,workspace);git(workspace,'fetch',repo,baseline);git(workspace,'checkout','--detach',baseline);git(workspace,'remote','set-url','origin',remote);git(workspace,'push','origin','HEAD:refs/heads/baseline');
 const contract={path:'/pilot',scenarios:[{name:'recovered state',steps:[{action:'expectText',selector:'#state',value:'Recovered'}]}]};
 const context=ordinary?Object.fromEntries(Object.entries((await one('project_runs','mission_id',ids.mission)).binding).filter(([key])=>key!=='scopeHash')):{version:1,projectId:ids.project,baselineSha:baseline,baseSha:baseline,allowedPaths:['app/pilot/'],contractHash:contractHash(contract),contract};
 if(!ordinary)await db.query('update project_runs set binding=$2 where mission_id=$1',[ids.mission,{...context,scopeHash:project.approved_hash}]);
 if(!ordinary)await db.query('update benchmark_development_dispatches set contract_hash=$2 where task_id=$1',[ids.task,context.contractHash]);
 if(initial){
  const task=await one('agent_tasks','id',ids.task),run=task.external.receipt.run_id,release='b'.repeat(40);
  write(root,'workflow.json',JSON.stringify({id:run,status:'completed',conclusion:'failure',event:'workflow_dispatch',path:'.github/workflows/autonomous-development.yml',head_branch:'main',head_sha:release,run_attempt:1,repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}}));
  write(root,'artifact.zip',archive({taskId:ids.task,runId:String(run),completed:false,phases:[],snapshots:[{label:'final',head:baseline,status:[]}]}));
  write(root,'artifacts.json',JSON.stringify({total_count:1,artifacts:[{id:1,name:'native-execution-diagnostics',expired:false,size_in_bytes:readFileSync(join(root,'artifact.zip')).length,workflow_run:{id:run,head_sha:release}}]}));
  return {root,remote,repo,context,baseline,one,trial};
 }
 write(workspace,'app/pilot/page.tsx','export default function Page(){return <div id="state">Broken</div>}\n');git(workspace,'add','app/pilot');git(workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic completed implementation');const completed=git(workspace,'rev-parse','HEAD');
 write(workspace,'app/pilot/page.tsx','export default function Page(){return <div id="state">Interrupted repair</div>}\n');
 const historical=(await db.query('select * from benchmark_budget_calls where account_id=$1 and legacy_mission_call_id in(select id from mission_calls where lease=$2) order by created_at desc,id desc limit 1',[ids.account,ids.grant.id])).rows[0];
 const approval=ordinary?await one('benchmark_native_spending_approvals','id',ids.grant.developer_approval_id):(await db.query('select * from benchmark_native_spending_approvals where continuation_id=$1',[ids.grant.continuation_id])).rows[0];
 const request=join(root,'request.md');writeFileSync(request,projectMarker(context));
 const lastCompleted={checkpointSha:completed,phase:'review',review:{phase:'review',verdict:'changes_requested',findings:'Repair the displayed state'},verification:{head:completed,passed:false,detail:'Interrupted repair still displays wrong state'},modelCall:{requestKey:historical.request_key,operationId:historical.id,actualTokens:Number(historical.actual_tokens),settlement:historical.state}};
 const record=createNativeWipCheckpointer({workspace,tempRoot:root,toolsRoot:join(repo,'scripts'),requestFile:request,context,
  identity:{taskId:ids.task,projectId:ids.project,trialId:ordinary?null:ids.trial,...(ordinary?{authorityKind:'ordinary-developer'}:{}),approvalId:approval.id,grantId:ids.grant.id,executionEpoch:Number(ids.grant.execution_epoch),runId:'131',runAttempt:'1',approvedScopeHash:project.approved_hash},expectedHead:()=>completed}).save({phase:'repair',reviewFindings:'CHANGES_REQUESTED Repair the displayed state',lastCompleted});
 const release='b'.repeat(40),workflow={id:131,status:'completed',conclusion:'failure',event:'workflow_dispatch',path:'.github/workflows/autonomous-development.yml',head_branch:'main',head_sha:release,run_attempt:1,repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}};
 const samples=(await db.query("select * from benchmark_budget_calls where account_id=$1 and state='settled' and model='gpt-5.3-codex' and provider_usage is not null order by actual_tokens,id limit 12",[ids.account])).rows;
 assert.equal(samples.length,ordinary?11:12);
 const observations=['repair','final_review'].flatMap((stage,k)=>[0,1,2].map(i=>{const rows=samples.slice(k*6+i*2,k*6+i*2+2);return {id:'synthetic-history-'+stage+i,stage,source:'verified_phase_receipts',cohort:project.approved_hash,binding:{projectId:ids.project,scopeHash:project.approved_hash},completed:true,calls:rows.length,inputTokens:rows.reduce((n,c)=>n+c.provider_usage.input_tokens,0),outputTokens:rows.reduce((n,c)=>n+c.provider_usage.output_tokens,0),seconds:5,operationIds:rows.map(c=>c.id)};}));
 const diagnostics={capacityObservations:observations,taskId:ids.task,runId:'131',completed:false,wipCheckpoint:record,snapshots:[{label:'final',head:completed}]};
 write(root,'artifact.zip',archive(diagnostics));const artifact={id:1,name:'native-execution-diagnostics',expired:false,size_in_bytes:readFileSync(join(root,'artifact.zip')).length,workflow_run:{id:131,head_sha:release}};
 write(root,'workflow.json',JSON.stringify(workflow));write(root,'artifacts.json',JSON.stringify({total_count:1,artifacts:[artifact]}));
 const task=await one('agent_tasks','id',ids.task),github=async(path,binary)=>binary?readFileSync(join(root,'artifact.zip')):path.includes('/artifacts?')?{total_count:1,artifacts:[artifact]}:workflow;
 assert.deepEqual((await loadRecoveryDiagnostics({task,repository:'mfackrell/katie',github})).record,record);
 await validateRecoveryRecords({record,task,context,project,trialId:ordinary?null:ids.trial,authorityKind:ordinary?'ordinary-developer':undefined,accountId:ids.account,readOne:one});
 rmSync(workspace,{recursive:true,force:true});
 return {root,remote,repo,context,baseline,record,observations,checkpoint:{...record,scopeHash:record.approvedScopeHash,releaseSha:release},one,trial};
}
export async function qualifyLifecycleContinuation(db,ids,fixture,amendment,options={}){
 const {root,remote,repo,context,baseline,one,trial}=fixture;const ordinary=ids.authorityKind==='ordinary-developer';
 const runtime=join(root,'runtime-'+(options.runId??132)),workspace=join(root,'runner-'+(options.runId??132)),bin=join(root,'bin');mkdirSync(runtime,{recursive:true});mkdirSync(bin,{recursive:true});
 cpSync(join(repo,'scripts'),join(runtime,'project-tools'),{recursive:true});cpSync(join(repo,'scripts/benchmark'),join(runtime,'native-host'),{recursive:true});
 git(root,'clone','-q','--branch','baseline',remote,workspace);mkdirSync(join(workspace,'node_modules'));execFileSync('cp',['-al',join(repo,'node_modules')+'/.',join(workspace,'node_modules')]);
 write(bin,'gh',`#!/usr/bin/env node\nconst fs=require('node:fs'),p=require('node:path');if(process.argv[2]==='auth')process.exit(0);const path=process.argv[3],root=${JSON.stringify(root)};process.stdout.write(fs.readFileSync(p.join(root,path.endsWith('/zip')?'artifact.zip':path.includes('/artifacts?')?'artifacts.json':'workflow.json')));`);execFileSync('chmod',['700',join(bin,'gh')]);
 const allowedTables=new Set(['benchmark_native_spending_approvals','benchmark_three_arm_trials','work_projects','benchmark_budget_accounts','benchmark_production_qualifications','agent_tasks','benchmark_development_dispatches','model_registry','benchmark_development_renewals','benchmark_development_resource_amendments','mission_assignments','project_runs','agent_missions','benchmark_execution_grants','benchmark_budget_calls','mission_calls']);
 const allowedRpcs=new Set(['benchmark_lifecycle_snapshot','developer_issue_execution_grant','developer_gateway_execution_live','developer_native_reserve','benchmark_continuation_live','benchmark_active_full_continuation','benchmark_full_task_provenance','benchmark_issue_development_amendment_grant','benchmark_gateway_execution_live','benchmark_full_native_reserve','benchmark_reconcile_provider_usage','benchmark_full_monetary_control','benchmark_effective_mission_allowance','benchmark_effective_mission_call_limit']);
 const phases=[],history=(await db.query('select to_jsonb(r) value from benchmark_budget_calls r where account_id=$1 order by id',[ids.account])).rows.map(r=>r.value);let host,log='';
 const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');let raw='';for await(const chunk of req){raw+=chunk;assert.ok(raw.length<2100000);}const body=raw?JSON.parse(raw):null;
   if(url.pathname.startsWith('/provider/')){
    if(options.provider){const response=await options.provider(body,url.pathname);res.setHeader('content-type',response.type);res.end(response.body);return;}
    if(url.pathname.endsWith('/input_tokens')){res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'response.input_tokens',input_tokens:3}));return;}
    const text=JSON.stringify(body.input),phase=text.includes('prior findings remain')?'final-review':text.includes('Fix only the independent reviewer')?'repair':null;assert.ok(phase,'Completed engineering phase replayed');
    // One streamed response per remaining phase, including a real sandbox tool.
    // SDK emits a second request for tool completion, so the exact proposal must
    // include measured two-call phases rather than a one-call minimum.
    const n=phases.filter(p=>p===phase).length+1;phases.push(phase);assert.ok(n<=2,'Duplicate paid work');
    const cmd=phase==='repair'?'node -e '+quote(`const f=require('node:fs'),a=require('node:assert/strict');a.match(f.readFileSync('app/pilot/page.tsx','utf8'),/Interrupted repair/);f.writeFileSync('app/pilot/page.tsx','export default function Page(){return <div id="state">Recovered</div>}\\n');`):'node -e '+quote(`require('node:assert/strict').match(require('node:fs').readFileSync('app/pilot/page.tsx','utf8'),/Recovered/);`);
    const item=n===1?{id:'fc_'+phases.length,type:'function_call',namespace:'functions',name:'exec_command',call_id:'call_'+phases.length,status:'completed',arguments:JSON.stringify({cmd,workdir:'/work'})}:{id:'msg_'+phases.length,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:phase==='final-review'?'PASS Independently inspected recovered source.':'DONE',annotations:[],logprobs:[]}]};
    const response={id:'synthetic-lifecycle-'+phases.length,object:'response',model:body.model,created_at:1,status:'completed',service_tier:'default',output:[item],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
    const stream=[['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],['response.completed',{type:'response.completed',response}]].map(([e,d])=>'event: '+e+'\ndata: '+JSON.stringify(d)+'\n\n').join('')+'data: [DONE]\n\n';res.setHeader('content-type','text/event-stream');res.end(stream);return;
   }
   assert.ok(url.pathname.startsWith('/database/rest/v1/'));const name=url.pathname.split('/').at(-1);let data;
   if(url.pathname.includes('/rpc/')){assert.ok(allowedRpcs.has(name),'Unexpected RPC '+name);const keys=Object.keys(body);assert.ok(keys.every(k=>/^p_[a-z_]+$/.test(k)));data=(await db.query(`select ${name}(${keys.map((k,i)=>k+'=>$'+(i+1)).join(',')}) answer`,keys.map(k=>body[k]))).rows[0].answer;}
   else{assert.equal(req.method,'GET');assert.ok(allowedTables.has(name),'Unexpected table '+name);const args=[],where=[];for(const[k,v]of url.searchParams){if(k==='select'||k==='limit')continue;assert.match(k,/^[a-z_]+$/);assert.ok(v.startsWith('eq.'));args.push(v.slice(3));where.push(k+'=$'+args.length);}const rows=(await db.query(`select to_jsonb(r) value from ${name} r${where.length?' where '+where.join(' and '):''}`,args)).rows.map(r=>r.value);data=req.headers.accept?.includes('object')?(rows[0]??null):rows;}
   res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
  }catch(error){res.statusCode=400;res.setHeader('content-type','application/json');res.end(JSON.stringify({message:error.message,code:error.code??'FIXTURE'}));}
 });
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const signing=options.signing??'synthetic-only-handoff-key-no-production-value',proof=ordinary?{version:1,authorityKind:'ordinary-developer',taskId:ids.task,projectId:ids.project,approvalId:amendment.approval_id,accountId:ids.account,scopeHash:fixture.record?.approvedScopeHash??ids.scopeHash,contractHash:context.contractHash,baselineSha:baseline,releaseSha:amendment.release_sha,expiresAt:Date.now()+25*60000}:{taskId:ids.task,trialId:ids.trial,approvalId:amendment.approval_id,projectId:ids.project,contractHash:context.contractHash,benchmarkContractHash:trial.contract_sha256,baselineSha:baseline,expiresAt:Date.now()+25*60000,continuationId:amendment.continuation_id,developmentRenewalId:amendment.renewal_id,resourceAmendmentId:amendment.id};
  proof.productionRuntime=sealNativeProductionRuntime('synthetic-service-role',proof,signing);const request=options.request??(projectMarker(context)+'\nSynthetic lifecycle qualification only.\n'+(ordinary?encodeDeveloperHandoff:encodeNativeHandoff)(proof,signing));
  const requestFile=join(runtime,'request.md'),manifest=join(runtime,'manifest.json'),evidence=join(runtime,'native-metered-review.json');writeFileSync(requestFile,request);writeFileSync(manifest,JSON.stringify((ordinary?readDeveloperHandoff:readNativeHandoff)(request,signing)));
  host=spawn(process.execPath,['--import',join(repo,'tests/helpers/native-recovery-fetch.mjs'),join(runtime,'native-host/native-development-host.mjs'),requestFile,manifest,join(runtime,'native-host/native-development-child.mjs')],{cwd:workspace,env:{PATH:bin+':'+process.env.PATH,HOME:root,RUNNER_TEMP:runtime,GITHUB_REPOSITORY:'mfackrell/katie',GITHUB_RUN_ID:String(options.runId??132),GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:amendment.release_sha,GH_TOKEN:'synthetic-git',OPENAI_API_KEY:'synthetic-provider-key-no-real-access',KATIE_NATIVE_HANDOFF_HMAC_KEY:signing,KATIE_NATIVE_CHECKPOINT_BRANCH:'agent/issue-829-132-1',KATIE_NATIVE_EVIDENCE_FILE:evidence,KATIE_BENCHMARK_GATEWAY_DIAGNOSTICS:'enabled',KATIE_RECOVERY_FIXTURE_ENDPOINT:'http://127.0.0.1:'+server.address().port},stdio:['ignore','pipe','pipe']});
  for(const stream of[host.stdout,host.stderr])stream.on('data',b=>{log=(log+b).slice(-60000)});const timer=setTimeout(()=>host.kill('SIGKILL'),900000);
  const code=await new Promise((resolve,reject)=>{host.once('error',reject);host.once('close',resolve)});clearTimeout(timer);host=null;
  const diagnostics=existsSync(evidence+'.diagnostics.json')?JSON.parse(readFileSync(evidence+'.diagnostics.json')):null;
  if(options.afterRun)return await options.afterRun({code,log,diagnostics,evidence,runtime,workspace,history,request,manifest,phases});
  assert.equal(code,0,log+'\n'+JSON.stringify(diagnostics)+'\n'+(existsSync(join(runtime,'qualification-verifier-tail.json'))?readFileSync(join(runtime,'qualification-verifier-tail.json'),'utf8'):''));
  assert.deepEqual(phases,['repair','repair','final-review','final-review']);
  const completed=JSON.parse(readFileSync(evidence));assert.equal(completed.completed,true);assert.equal(completed.finalReview.verdict,'pass');assert.equal(completed.taskId,ids.task);
  for(const old of history)assert.deepEqual(await one('benchmark_budget_calls','id',old.id),old);
  const mission=await one('agent_missions','id',ids.mission);assert.equal(mission.calls+mission.routing_calls,ordinary?15:32);
  const browser=JSON.parse(readFileSync(join(runtime,'qualification-browser-acceptance.json')));assert.equal(browser.passed,true);assert.equal(browser.headSha,completed.reviewedHeadSha);
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const retained=await Promise.all(history.map(old=>one('benchmark_budget_calls','id',old.id)));
  assert.equal(digest(retained),digest(history));
  writeFileSync(join(runtime,'continuation-report.json'),JSON.stringify({version:1,syntheticConsentOnly:true,paidInference:false,
   authorityKind:ordinary?'ordinary-developer':'benchmark',taskId:ids.task,projectId:ids.project,accountId:ids.account,
   baseline,scopeHash:fixture.record.approvedScopeHash,contract:context.contract,checkpoint:fixture.record,
   amendmentApprovalId:amendment.approval_id,phases,historicalCalls:history.length,historicalAccountingBefore:digest(history),historicalAccountingAfter:digest(retained),
   callsAfter:mission.calls+mission.routing_calls,protectedCompletionCalls:4,
   sourceSha256:createHash('sha256').update(readFileSync(join(workspace,'app/pilot/page.tsx'))).digest('hex'),
   completed,browser,limitations:['Synthetic provider and GitHub transports; actual PostgreSQL, pinned SDK and isolated host.','Host engineering completion is not final project assessment or Task 2C acceptance.']},null,2));
  console.log('LIFECYCLE_SAME_TASK_HOST_PASS: synthetic owner consent, original repair restored, implementation/review not repeated, four approved synthetic native requests, historical receipts unchanged, four completion calls protected, real isolated verification and Chromium passed');
 }finally{
  if(host)host.kill('SIGKILL');await new Promise(r=>server.close(r));
  if(process.env.RUNNER_TEMP){const output=join(process.env.RUNNER_TEMP,ordinary?'ordinary-lifecycle-qualification':'lifecycle-qualification');mkdirSync(output,{recursive:true});writeFileSync(join(output,'host.log'),log);for(const name of['continuation-report.json','native-metered-review.json','native-metered-review.json.diagnostics.json','qualification-browser-acceptance.json','qualification-verifier-tail.json'])if(existsSync(join(runtime,name)))cpSync(join(runtime,name),join(output,name));}
  if(!options.keepRoot)rmSync(root,{recursive:true,force:true});
 }
}
