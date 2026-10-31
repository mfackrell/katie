// Nonbillable end-to-end harness. The host, child SDK, scope gates, verifier,
// recovery code and PostgreSQL RPCs are production code. Only external HTTP
// transports and GitHub artifact storage are replaced with disposable services.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {encodeNativeHandoff,readNativeHandoff} from '../../scripts/benchmark/native-dispatch-contract.mjs';
import {sealNativeProductionRuntime} from '../../scripts/benchmark/native-runtime-capsule.mjs';
import {projectMarker,contractHash} from '../../scripts/project-context.mjs';
import {prepareRecovery,recoveryRefs,loadRecoveryDiagnostics,validateRecoveryRecords} from '../../scripts/benchmark/native-wip-recovery.mjs';
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
function archive(value){
 const name=Buffer.from('native-metered-review.json.diagnostics.json'),body=Buffer.from(JSON.stringify(value));
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(name.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+body.length,16);
 return Buffer.concat([local,name,body,central,name,end]);
}
export async function qualifyNativeRecovery(db,ids){
 const root=mkdtempSync(join(tmpdir(),'native-recovery-e2e-')),repo=resolve('.'),remote=join(root,'remote.git');
 const trace=[],report={version:1,qualification:'synthetic-only',paidInference:0,trace,failures:[]};
 let server,host,workspace,run=900001,recovering=false,phaseCounts=new Map(),providerCalls=0;
 const write=(base,path,content)=>{mkdirSync(dirname(join(base,path)),{recursive:true});writeFileSync(join(base,path),content);};
 const query=async(sql,args=[])=>(await db.query(sql,args)).rows;
 const one=async(table,column,value)=>(await query(`select * from ${table} where ${column}=$1`,[value]))[0];
 const ledger=async()=>(await query(`select jsonb_build_object(
+ 'account',(select to_jsonb(a) from benchmark_budget_accounts a where id=$1),
+ 'calls',(select jsonb_agg(to_jsonb(c) order by id) from benchmark_budget_calls c where account_id=$1),
+ 'missionCalls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id=$2),
+ 'mission',(select jsonb_build_object('calls',calls,'actual_tokens',actual_tokens,'reserved_tokens',reserved_tokens,'max_calls',max_calls,'token_allowance',token_allowance) from agent_missions where id=$3),
+ 'grants',(select jsonb_agg(to_jsonb(g) order by id) from benchmark_execution_grants g where account_id=$1),
+ 'approvals',(select jsonb_agg(to_jsonb(a) order by id) from benchmark_native_spending_approvals a where account_id=$1)) value`.replaceAll('\n+','\n'),[ids.account,ids.task,ids.mission]))[0].value;
 const initialFiles={
  'app/pilot/state.mjs':'export const value = "Broken";\n',
  'app/pilot/page.tsx':'export default function Page(){return <div id="state">Broken</div>}\n',
  'app/pilot/obsolete.mjs':'export const obsolete = true;\n'
 };
 const repairFiles={
  'app/pilot/state.mjs':'export const value = "Recovered";\n',
  'app/pilot/page.tsx':'import {value} from "./state.mjs"; export default function Page(){return <div id="state">{value}</div>}\n',
  'app/pilot/proof.mjs':'export const verification = "unverified";\n'
 };
 const commandFor=(phase)=>{
  if(phase==='implementation')return 'node -e '+quote(`const f=require('node:fs');f.mkdirSync('app/pilot',{recursive:true});for(const [p,c] of Object.entries(${JSON.stringify(initialFiles)}))f.writeFileSync(p,c);console.log('IMPLEMENTATION_WRITTEN')`);
  if(phase==='repair')return 'node -e '+quote(recovering?
   `const f=require('node:fs'),a=require('node:assert/strict');for(const [p,c] of Object.entries(${JSON.stringify(repairFiles)}))a.equal(f.readFileSync(p,'utf8'),c);a.equal(f.existsSync('app/pilot/obsolete.mjs'),false);a.match(f.readFileSync('/trusted/review-findings.txt','utf8'),/Fix state and render/);f.writeFileSync('app/pilot/proof.mjs',${JSON.stringify('export const verification = "verified";\n')});console.log('RESTORED_REPAIR_CONTINUED')`:
   `const f=require('node:fs');for(const [p,c] of Object.entries(${JSON.stringify(repairFiles)}))f.writeFileSync(p,c);f.unlinkSync('app/pilot/obsolete.mjs');console.log('UNFINISHED_REPAIR_WRITTEN')`);
  return 'node -e '+quote(`const f=require('node:fs'),a=require('node:assert/strict');a.match(f.readFileSync('app/pilot/state.mjs','utf8'),/${phase==='review'?'Broken':'Recovered'}/);console.log('INDEPENDENT_SOURCE_INSPECTED')`);
 };
 const classify=body=>{
  const text=JSON.stringify(body.input);
  if(text.includes('prior findings remain'))return 'final-review';
  if(text.includes('Fix only the independent reviewer'))return 'repair';
  if(text.includes('fresh independent reviewer'))return 'review';
  if(text.includes('Complete the approved engineering work'))return 'implementation';
  throw Error('Unknown real SDK phase');
 };
 const respond=(body,phase)=>{
  const n=(phaseCounts.get(phase)??0)+1;phaseCounts.set(phase,n);providerCalls++;
  assert.ok(n<=2,'Unexpected SDK retry');
  trace.push({run,phase,request:n,requestHash:hash(JSON.stringify(body))});
  if(n===2){const output=body.input.find(i=>i.type==='function_call_output');assert.ok(output,'SDK tool output missing');assert.match(JSON.stringify(output.output),/IMPLEMENTATION_WRITTEN|UNFINISHED_REPAIR_WRITTEN|RESTORED_REPAIR_CONTINUED|INDEPENDENT_SOURCE_INSPECTED/);}
  const item=n===1?{id:'fc_'+providerCalls,type:'function_call',namespace:'functions',name:'exec_command',call_id:'call_'+providerCalls,status:'completed',arguments:JSON.stringify({cmd:commandFor(phase),workdir:'/work'})}:
   {id:'msg_'+providerCalls,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:phase==='review'?'CHANGES_REQUESTED Fix state and render; remove obsolete source and retain proof.':phase==='final-review'?'PASS Independently inspected recovered source.':'DONE',annotations:[],logprobs:[]}]};
  const response={id:'synthetic-recovery-'+providerCalls,object:'response',model:body.model,created_at:1,status:'completed',service_tier:'default',output:[item],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
  return [['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],['response.output_item.added',{type:'response.output_item.added',output_index:0,item}],['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],['response.completed',{type:'response.completed',response}]].map(([e,d])=>'event: '+e+'\ndata: '+JSON.stringify(d)+'\n\n').join('')+'data: [DONE]\n\n';
 };
 try{
  // Build a tiny trusted baseline, unrelated to the benchmark application.
  workspace=join(root,'runner-1');mkdirSync(workspace);git(root,'init','--bare','-q',remote);git(workspace,'init','-q');git(workspace,'config','user.name','Recovery qualification');git(workspace,'config','user.email','fixture@example.invalid');
  const pkg=JSON.parse(readFileSync('package.json','utf8'));pkg.scripts={typecheck:'node --check verify.mjs','ci:gate':'node verify.mjs && next build'};
  write(workspace,'package.json',JSON.stringify(pkg));write(workspace,'package-lock.json',readFileSync('package-lock.json'));
  write(workspace,'.gitignore','node_modules/\n.next/\nnext-env.d.ts\ntsconfig.json\n');
  write(workspace,'app/layout.tsx','export default function Layout({children}: {children: React.ReactNode}){return <html><body>{children}</body></html>}');
  write(workspace,'app/page.tsx','export default function Page(){return <div>Recovery qualification</div>}');
  write(workspace,'verify.mjs','import assert from "node:assert/strict"; import {value} from "./app/pilot/state.mjs";import {verification} from "./app/pilot/proof.mjs"; assert.equal(value,"Recovered");assert.equal(verification,"verified");');
  // Next's generated TypeScript defaults must not mutate tracked files.
  write(workspace,'next.config.mjs','export default {typescript:{ignoreBuildErrors:false},experimental:{cpus:1}};');
  git(workspace,'add','.');git(workspace,'commit','-qm','Trusted synthetic baseline');const baseline=git(workspace,'rev-parse','HEAD');git(workspace,'remote','add','origin',remote);git(workspace,'push','origin','HEAD:refs/heads/baseline');
  const contract={path:'/pilot',scenarios:[{name:'recovered state',steps:[{action:'expectText',selector:'#state',value:'Recovered'}]}]};
  const context={version:1,projectId:ids.project,baselineSha:baseline,baseSha:baseline,allowedPaths:['app/pilot/'],contractHash:contractHash(contract),contract};
  const project=await one('work_projects','id',ids.project),scope=project.approved_hash;
  // Only disposable fixture setup changes its synthetic binding before execution.
  await db.query('reset role');
  await db.query('update benchmark_three_arm_trials set baseline_sha=$2 where id=$1',[ids.trial,baseline]);
  await db.query('update benchmark_mission_bindings set baseline_sha=$2 where mission_id=$1',[ids.mission,baseline]);
  await db.query('update project_runs set binding=$2 where mission_id=$1',[ids.mission,{...context,scopeHash:scope}]);
  await db.query('update benchmark_development_dispatches set baseline_sha=$2,contract_hash=$3 where task_id=$1',[ids.task,baseline,context.contractHash]);
  await db.query("update work_projects set deadline=now()+interval '2 hours' where id=$1",[ids.project]);
  await db.query("update agent_tasks set external=(external-'receipt')||jsonb_build_object('issueNumber',829,'developmentRenewalId',$2::text) where id=$1",[ids.task,ids.renewal.id]);
  await db.query('set role service_role');
  const trial=await one('benchmark_three_arm_trials','id',ids.trial);
  const signing='synthetic-only-handoff-key-with-no-production-value';
  const runtime=join(root,'runtime');mkdirSync(runtime);cpSync(join(repo,'scripts'),join(runtime,'project-tools'),{recursive:true});cpSync(join(repo,'scripts/benchmark'),join(runtime,'native-host'),{recursive:true});
  const bin=join(root,'bin');mkdirSync(bin);
  write(bin,'gh',`#!/usr/bin/env node\nconst fs=require('node:fs'),p=require('node:path');if(process.argv[2]==='auth')process.exit(0);const path=process.argv[3];const root=${JSON.stringify(root)};if(path.endsWith('/zip'))process.stdout.write(fs.readFileSync(p.join(root,'artifact.zip')));else if(path.includes('/artifacts?'))process.stdout.write(fs.readFileSync(p.join(root,'artifacts.json')));else process.stdout.write(fs.readFileSync(p.join(root,'workflow.json')));`);execFileSync('chmod',['700',join(bin,'gh')]);
  const allowedTables=new Set(['benchmark_native_spending_approvals','benchmark_three_arm_trials','work_projects','benchmark_budget_accounts','benchmark_production_qualifications','agent_tasks','benchmark_development_dispatches','model_registry','benchmark_development_renewals','benchmark_development_paid_successors','benchmark_amendment_successor_consents','mission_assignments','project_runs','benchmark_execution_grants','benchmark_budget_calls','mission_calls']);
  const allowedRpcs=new Set(['benchmark_continuation_live','benchmark_active_full_continuation','benchmark_full_task_provenance','benchmark_issue_development_renewal_grant','benchmark_issue_development_paid_successor_grant','benchmark_gateway_execution_live','benchmark_full_native_reserve','benchmark_reconcile_provider_usage']);
  server=createServer(async(req,res)=>{
   try{
    const url=new URL(req.url,'http://localhost');let raw='';for await(const chunk of req){raw+=chunk;assert.ok(raw.length<2_100_000);}const body=raw?JSON.parse(raw):null;
    if(url.pathname.startsWith('/provider/')){
     const phase=classify(body);
     if(url.pathname.endsWith('/input_tokens')){
      // Admission denial AFTER the real tool writes. No reservation/provider call.
      res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'response.input_tokens',input_tokens:!recovering&&phase==='repair'&&phaseCounts.get('repair')===1?120000:3}));return;
     }
     assert.equal(url.pathname,'/provider/v1/responses');res.setHeader('content-type','text/event-stream');res.end(respond(body,phase));return;
    }
    assert.ok(url.pathname.startsWith('/database/rest/v1/'));const name=url.pathname.split('/').at(-1);let data;
    if(url.pathname.includes('/rpc/')){
     assert.ok(allowedRpcs.has(name),'Unexpected RPC '+name);const keys=Object.keys(body);assert.ok(keys.every(k=>/^p_[a-z_]+$/.test(k)));
     data=(await query(`select ${name}(${keys.map((k,i)=>k+'=>$'+(i+1)).join(',')}) answer`,keys.map(k=>body[k])))[0].answer;
    }else{
     assert.equal(req.method,'GET');assert.ok(allowedTables.has(name));const args=[],where=[];
     for(const [k,v] of url.searchParams){if(k==='select'||k==='limit')continue;assert.match(k,/^[a-z_]+$/);assert.ok(v.startsWith('eq.'));args.push(v.slice(3));where.push(k+'=$'+args.length);}
     const rows=await query(`select * from ${name}${where.length?' where '+where.join(' and '):''}`,args);data=req.headers.accept?.includes('object')?(rows[0]??null):rows;
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
   }catch(error){res.statusCode=400;res.setHeader('content-type','application/json');res.end(JSON.stringify({message:String(error.message),code:error.code??'FIXTURE'}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const launch=async({successor,release=ids.release}={})=>{
   mkdirSync(join(workspace,'node_modules'),{recursive:true});execFileSync('cp',['-al',join(repo,'node_modules','.'),join(workspace,'node_modules')]);
   const proof={taskId:ids.task,trialId:ids.trial,approvalId:ids.renewal.approval_id,projectId:ids.project,contractHash:context.contractHash,benchmarkContractHash:trial.contract_sha256,baselineSha:baseline,expiresAt:Date.now()+25*60000,continuationId:ids.continuation.id,developmentRenewalId:ids.renewal.id,...(successor?{paidSuccessorId:successor}:{})};
   proof.productionRuntime=sealNativeProductionRuntime('synthetic-service-role',proof,signing);
   const request=projectMarker(context)+'\nSynthetic recovery qualification only.\n'+encodeNativeHandoff(proof,signing);
   const requestFile=join(runtime,'request.md'),manifestFile=join(runtime,'manifest.json');writeFileSync(requestFile,request);writeFileSync(manifestFile,JSON.stringify(readNativeHandoff(request,signing)));
   const evidence=join(runtime,'native-metered-review.json');rmSync(evidence,{force:true});rmSync(evidence+'.diagnostics.json',{force:true});
   let log='';host=spawn(process.execPath,['--import',join(repo,'tests/helpers/native-recovery-fetch.mjs'),join(runtime,'native-host/native-development-host.mjs'),requestFile,manifestFile,join(runtime,'native-host/native-development-child.mjs')],{
    cwd:workspace,env:{PATH:bin+':'+process.env.PATH,HOME:root,RUNNER_TEMP:runtime,GITHUB_REPOSITORY:'mfackrell/katie',GITHUB_RUN_ID:String(run),GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:release,GH_TOKEN:'synthetic-git',OPENAI_API_KEY:'synthetic-provider-key-no-real-access',KATIE_NATIVE_HANDOFF_HMAC_KEY:signing,KATIE_NATIVE_CHECKPOINT_BRANCH:`agent/issue-829-${run}-1`,KATIE_NATIVE_EVIDENCE_FILE:evidence,KATIE_BENCHMARK_GATEWAY_DIAGNOSTICS:'enabled',KATIE_RECOVERY_FIXTURE_ENDPOINT:'http://127.0.0.1:'+server.address().port},stdio:['ignore','pipe','pipe']});
   for(const s of [host.stdout,host.stderr])s.on('data',b=>{log=(log+b).slice(-60000);});
   const timer=setTimeout(()=>host.kill('SIGKILL'),900000);
   const code=await new Promise((resolve,reject)=>{host.once('error',reject);host.once('close',resolve);});clearTimeout(timer);host=null;
   write(root,'host-'+run+'.log',log);
   return {code,log,evidence,requestFile};
  };
  trace.push({stage:'authorized-task',task:ids.task,project:ids.project,baseline});
  const first=await launch();assert.notEqual(first.code,0,first.log);assert.match(first.log,/native repair failed/,first.log);
  assert.deepEqual([...phaseCounts], [['implementation',2],['review',2],['repair',1]]);
  const diagnostics=JSON.parse(readFileSync(first.evidence+'.diagnostics.json')),record=diagnostics.wipCheckpoint;assert.ok(record);assert.equal(record.phase,'repair');assert.equal(record.verification,'unverified');
  report.checkpoint={sha:record.checkpointSha,ref:record.ref,completed:record.completedCheckpointSha};
  report.files=Object.fromEntries(Object.entries(repairFiles).map(([p,c])=>[p,hash(c)]));
  for(const [p,c]of Object.entries(repairFiles))assert.equal(readFileSync(join(workspace,p),'utf8'),c);
  const afterFailure=await ledger();assert.equal(Number(afterFailure.mission.calls),7); // two retained historical calls + five actual synthetic SDK requests
  write(root,'artifact.zip',archive(diagnostics));
  const workflow={id:run,status:'completed',conclusion:'failure',event:'workflow_dispatch',path:'.github/workflows/autonomous-development.yml',head_branch:'main',head_sha:ids.release,run_attempt:1,repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'}};
  const artifact={id:1,name:'native-execution-diagnostics',expired:false,size_in_bytes:readFileSync(join(root,'artifact.zip')).length,workflow_run:{id:run,head_sha:ids.release}};
  write(root,'workflow.json',JSON.stringify(workflow));write(root,'artifacts.json',JSON.stringify({total_count:1,artifacts:[artifact]}));
  const failed={...ids.receipt,run_id:run};await db.query("update agent_tasks set status='blocked',external=jsonb_set(external,'{receipt}',$2::jsonb) where id=$1",[ids.task,failed]);
  const task=await one('agent_tasks','id',ids.task);
  const github=async(path,binary)=>binary?readFileSync(join(root,'artifact.zip')):path.includes('/artifacts?')?{total_count:1,artifacts:[artifact]}:workflow;
  const beforeRestore=await ledger();rmSync(workspace,{recursive:true,force:true});assert.equal(existsSync(workspace),false);trace.push({stage:'runner-destroyed',path:workspace});
  const fresh=()=>{const dir=join(root,'fresh-'+randomUUID());git(root,'clone','-q','--branch','baseline',remote,dir);return dir;};workspace=fresh();
  const restored=await loadRecoveryDiagnostics({task,repository:'mfackrell/katie',github});
  await validateRecoveryRecords({record:restored.record,task,context,project:await one('work_projects','id',ids.project),trialId:ids.trial,accountId:ids.account,readOne:one});
  const prepare=(recordOverride=record,refs=recoveryRefs(workspace,ids.task))=>prepareRecovery({workspace,tempRoot:runtime,toolsRoot:join(runtime,'project-tools'),requestFile:first.requestFile,context,record:recordOverride,refs});
  const state=prepare().restore();assert.equal(state.phase,'repair');assert.equal(state.verification,'unverified');assert.equal(state.reviewFindings,record.reviewFindings);
  for(const [p,c]of Object.entries(repairFiles))assert.equal(hash(readFileSync(join(workspace,p))),hash(c));assert.equal(existsSync(join(workspace,'app/pilot/obsolete.mjs')),false);
  assert.deepEqual(await ledger(),beforeRestore);trace.push({stage:'fresh-runner-restored',head:git(workspace,'rev-parse','HEAD'),hashes:report.files});
  // Destroy a partially recovered runner and repeat solely from durable evidence.
  write(workspace,'app/pilot/state.mjs','partial local recovery lost');rmSync(workspace,{recursive:true,force:true});workspace=fresh();prepare().restore();assert.equal(hash(readFileSync(join(workspace,'app/pilot/state.mjs'))),report.files['app/pilot/state.mjs']);assert.deepEqual(await ledger(),beforeRestore);
  report.failures.push({case:'interrupted recovery',result:'fresh runner restores original durable WIP; ledger unchanged'});
  // Retention is authoritative artifact expiry, not a local timestamp heuristic.
  artifact.expired=true;await assert.rejects(loadRecoveryDiagnostics({task,repository:'mfackrell/katie',github}),/expired/);artifact.expired=false;
  report.failures.push({case:'seven-day trusted artifact expiry',result:'fail closed; Git WIP survives; automatic recovery unavailable'});
  rmSync(workspace,{recursive:true,force:true});workspace=fresh();assert.throws(()=>prepare(record,[]),/checkpoint/);report.failures.push({case:'missing checkpoint',result:'rejected'});
  // The final recovered host must discover and restore again itself.
  await db.query("update mission_assignments set status='failed',lease=null,lease_until=null where id=$1",[ids.task]);await db.query("update agent_missions set status='blocked' where id=$1",[ids.mission]);await db.query("update work_projects set status='blocked' where id=$1",[ids.project]);
  const grant=(await query('select * from benchmark_execution_grants where account_id=$1 order by execution_epoch desc limit 1',[ids.account]))[0];
  const timing=(await query("select created_at-interval '1 second' started,clock_timestamp() finished from benchmark_execution_grants where id=$1",[grant.id]))[0];
  const release='5'.repeat(40);
  const successor=(await query('select benchmark_prepare_development_paid_successor($1,$2,$3,$4,$5,$6,$7,$8,$9) r',[ids.renewal.id,grant.id,run,failed,ids.release,release,timing.started,timing.finished,'bounded-schema-v1']))[0].r;
  assert.equal((await query('select benchmark_claim_development_paid_successor($1,$2) ok',[successor.id,release]))[0].ok,true);
  // Explicit disposable authority is separate from restoration; no reset.
  const historicalCalls=beforeRestore.calls;run++;recovering=true;phaseCounts=new Map();
  const second=await launch({successor:successor.id,release});assert.equal(second.code,0,second.log);
  assert.deepEqual([...phaseCounts],[['repair',2],['final-review',2]]);
  const completed=JSON.parse(readFileSync(second.evidence));assert.equal(completed.completed,true);assert.equal(completed.finalReview.verdict,'pass');assert.equal(completed.review.verdict,'changes_requested');
  const finalDiagnostics=JSON.parse(readFileSync(second.evidence+'.diagnostics.json'));assert.deepEqual(finalDiagnostics.phases.map(p=>p.phase),['repair','final-review']);assert.ok(finalDiagnostics.verification?.every(v=>v.passed));
  const after=await ledger();for(const old of historicalCalls)assert.deepEqual(after.calls.find(c=>c.id===old.id),old,'Historical receipt changed');assert.equal(Number(after.mission.calls),Number(beforeRestore.mission.calls)+4);assert.equal(Number(after.account.spent_tokens),Number(beforeRestore.account.spent_tokens)+20);
  report.completion=completed;report.accounting={beforeHash:hash(JSON.stringify(beforeRestore)),afterHash:hash(JSON.stringify(after)),historicalCallsPreserved:historicalCalls.length,newSyntheticCalls:4,newSyntheticTokens:20,providerCalls};report.verification=finalDiagnostics.verification;
  report.limitations=['Admission-denial termination is qualified. Abrupt host SIGKILL before final artifact upload remains fail-closed, not claimed recovered.','Private acceptance uses the actual network-isolated project verifier and Chromium, not an external Vercel Preview.','Synthetic SDK responses establish execution mechanics, not real-model compliance.'];
  console.log('NATIVE_RECOVERY_LIFECYCLE_PASS='+JSON.stringify(report));
 }finally{
  if(host)host.kill('SIGKILL');if(server)await new Promise(resolve=>server.close(resolve));
  const destination=process.env.RUNNER_TEMP;if(destination){mkdirSync(join(destination,'native-recovery-qualification'),{recursive:true});for(const name of ['host-900001.log','host-900002.log'])if(existsSync(join(root,name)))cpSync(join(root,name),join(destination,'native-recovery-qualification',name));writeFileSync(join(destination,'native-recovery-qualification/report.json'),JSON.stringify(report,null,2));}
  rmSync(root,{recursive:true,force:true});
 }
}
