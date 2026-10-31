import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createNativeWipCheckpointer} from '../scripts/benchmark/native-wip-checkpoint.mjs';
import {recoveryCompletedEvidence,prepareRecovery,recoveryRefs,validateRecoveryRecords,loadRecoveryDiagnostics,readRecoveryArtifact} from '../scripts/benchmark/native-wip-recovery.mjs';
import {executeNativeDevelopmentLifecycle} from '../scripts/benchmark/native-development-lifecycle.mjs';
import {createNativeHttpBridge} from '../scripts/benchmark/native-http-bridge.mjs';
import {projectMarker,contractHash} from '../scripts/project-context.mjs';

// A bounded single-entry ZIP, matching the immutable GitHub artifact transport.
function archive(value){
 const name=Buffer.from('native-metered-review.json.diagnostics.json'),body=Buffer.from(JSON.stringify(value));
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(name.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+body.length,16);
 return Buffer.concat([local,name,body,central,name,end]);
}
function fixture(t,{phase='repair',legacy=false,attributes=false}={}){
 const root=mkdtempSync(join(tmpdir(),'native-recovery-')),remote=join(root,'remote.git');let workspace=join(root,'first');
 t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(workspace);
 const command=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const git=(...args)=>command(workspace,...args);
 const file=(path,contents)=>{mkdirSync(dirname(join(workspace,path)),{recursive:true});writeFileSync(join(workspace,path),contents);};
 command(root,'init','--bare','-q',remote);git('init','-q');git('config','user.name','Recovery fixture');git('config','user.email','recovery@example.invalid');
 file('README.md','trusted baseline');git('add','.');git('commit','-qm','baseline');const baseline=git('rev-parse','HEAD');
 git('remote','add','origin',remote);git('push','origin','HEAD:refs/heads/baseline');
 const contract={path:'/',scenarios:[{name:'state',steps:[{action:'expectText',selector:'#state',value:'Ready'}]}]};
 const context={version:1,projectId:'11111111-1111-4111-8111-111111111111',baseSha:baseline,baselineSha:baseline,allowedPaths:['app/pilot/'],contractHash:contractHash(contract),contract};
 const task={id:'22222222-2222-4222-8222-222222222222',repository_full_name:'mfackrell/katie',external:{issueNumber:829,receipt:{issue_number:829,run_id:123,repository:'mfackrell/katie',outcome:'BLOCKED'}}};
 const project={id:context.projectId,approved_hash:'scope',approval_hash:'scope',active_mission_id:'mission'};
 let completed=baseline;
 if(phase==='repair'){
  file('app/pilot/a.mjs','implementation a');file('app/pilot/b.mjs','implementation b');file('app/pilot/deleted.mjs','obsolete');git('add','.');git('commit','-qm','completed implementation');completed=git('rev-parse','HEAD');git('push','origin','HEAD:refs/heads/completed');
 }
 const requestFile=join(root,'request');writeFileSync(requestFile,projectMarker(context));
 const identity={taskId:task.id,projectId:project.id,trialId:'trial',approvalId:'approval',grantId:'grant',executionEpoch:2,runId:'123',runAttempt:'1',approvedScopeHash:'scope'};
 const lastCompleted={checkpointSha:completed,modelCall:{requestKey:'historical-call',operationId:'historical-operation',actualTokens:120,settlement:'settled'},...(phase==='repair'?{phase:'review',review:{phase:'review',verdict:'changes_requested',findings:'Fix a and b'},verification:{head:completed,passed:false,detail:'two deterministic findings'}}:{})};
 if(legacy){delete lastCompleted.review;delete lastCompleted.verification;}
 const wip=createNativeWipCheckpointer({workspace,tempRoot:root,toolsRoot:resolve('scripts'),requestFile,context,identity,expectedHead:()=>completed});
 file('app/pilot/a.mjs','unfinished repair a');file('app/pilot/b.mjs','unfinished repair b');file('app/pilot/new/nested.mjs','third new file');if(phase==='repair')rmSync(join(workspace,'app/pilot/deleted.mjs'));
 if(attributes)file('app/pilot/.gitattributes','*.mjs filter=sentinel working-tree-encoding=UTF-16LE\n');
 const record=wip.save({phase,reviewFindings:phase==='repair'?'CHANGES_REQUESTED Fix a and b\nTrusted deterministic verification: two deterministic findings':'',lastCompleted});
 const diagnostics={taskId:task.id,runId:'123',completed:false,wipCheckpoint:record,snapshots:[{label:'final',head:completed}]};
 const rows={mission_assignments:{id:task.id,mission_id:'mission'},project_runs:{project_id:project.id,binding:{...context,scopeHash:'scope'}},
  benchmark_native_spending_approvals:{id:'approval',task_id:task.id,project_id:project.id,trial_id:'trial',account_id:'account',consumed_at:'2026-10-31',actor_id:'owner',protocol_digest:'protocol',model:'gpt-5.3-codex'},
  benchmark_execution_grants:{id:'grant',mission_assignment_id:task.id,project_id:project.id,trial_id:'trial',account_id:'account',execution_epoch:2,owner_actor_id:'owner',repository:'mfackrell/katie',protocol_digest:'protocol',model:'gpt-5.3-codex',deadline:'2026-10-30'},
  benchmark_budget_calls:{id:'historical-operation',account_id:'account',request_key:'historical-call',legacy_mission_call_id:'historical-call',actual_tokens:120,reserved_tokens:4096,state:'settled',provider_receipt_at:'retained'},
  mission_calls:{id:'historical-call',job_id:task.id,lease:'grant',actual_tokens:120,reserved_tokens:4096},
  accounting:{calls:9,tokens:242673,reservations:1234,receipts:['prior-failed','prior-settled']}};
 const readOne=async(table,column,value)=>{const row=rows[value]??rows[table];assert.ok(row);if(column==='id')assert.equal(row.id,value);return structuredClone(row);};
 const workflow={id:123,status:'completed',conclusion:'failure',event:'workflow_dispatch',path:'.github/workflows/autonomous-development.yml',head_branch:'main',repository:{full_name:'mfackrell/katie'},head_repository:{full_name:'mfackrell/katie'},head_sha:'a'.repeat(40),run_attempt:1};
 const artifact={id:456,name:'native-execution-diagnostics',expired:false,size_in_bytes:1000,workflow_run:{id:123,head_sha:'a'.repeat(40)}};
 const github=async(path,binary)=>binary?archive(diagnostics):path.endsWith('/123')?workflow:{total_count:1,artifacts:[artifact]};
 const fresh=()=>{rmSync(workspace,{recursive:true,force:true});workspace=join(root,'fresh');command(root,'clone','-q','--branch','baseline',remote,workspace);return workspace;};
 const validate=completedEvidence=>validateRecoveryRecords({record,task,context,project,trialId:'trial',accountId:'account',readOne,completedEvidence});
 const prepare=completedEvidence=>prepareRecovery({workspace,tempRoot:root,toolsRoot:resolve('scripts'),requestFile,context,record,refs:recoveryRefs(workspace,task.id),completedEvidence});
 return {root,remote,git,file,context,record,rows,diagnostics,task,workflow,artifact,github,validate,prepare,fresh,completed,baseline,requestFile,get workspace(){return workspace;}};
}

test('destroyed runner restores two edits, a new directory/file and deletion; resumes repair with prior findings and immutable accounting',async t=>{
 const f=fixture(t),history=JSON.stringify(f.rows);f.fresh();
 const loaded=await loadRecoveryDiagnostics({task:f.task,repository:'mfackrell/katie',github:f.github});assert.deepEqual(loaded.record,f.record);
 await f.validate();const recovery=f.prepare().restore();
 assert.equal(f.git('rev-parse','HEAD'),f.completed);assert.equal(f.git('diff','--cached','--name-only'),'');
 assert.equal(readFileSync(join(f.workspace,'app/pilot/a.mjs'),'utf8'),'unfinished repair a');
 assert.equal(readFileSync(join(f.workspace,'app/pilot/b.mjs'),'utf8'),'unfinished repair b');
 assert.equal(readFileSync(join(f.workspace,'app/pilot/new/nested.mjs'),'utf8'),'third new file');
 assert.throws(()=>readFileSync(join(f.workspace,'app/pilot/deleted.mjs')));
 assert.equal(recovery.verification,'unverified');assert.equal(recovery.reviewFindings,f.record.reviewFindings);
 const phases=[],verified=[];
 const result=await executeNativeDevelopmentLifecycle({recovery,qualifiedLifecycle:true,runPhase:async(phase,findings)=>{
  phases.push(phase);if(phase==='repair'){assert.equal(findings,f.record.reviewFindings);f.file('app/pilot/a.mjs','corrected a');return;}
  assert.equal(phase,'final-review');return {phase,verdict:'pass',findings:'independently verified synthetic source'};
 },commitCandidate:()=>{f.git('add','app/pilot');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','synthetic repair');return f.git('rev-parse','HEAD');},verifyCandidate:async head=>{verified.push(head);return {passed:true,detail:'synthetic deterministic/build/browser assertions'};}});
 assert.deepEqual(phases,['repair','final-review']);assert.deepEqual(verified,[result.candidateHead]);assert.equal(result.review.verdict,'changes_requested');assert.equal(result.repairPerformed,true);
 assert.equal(JSON.stringify(f.rows),history,'no calls/tokens/reservations/receipts or historical authorization changed');
 assert.equal(f.git('ls-remote','--refs','origin',f.record.ref).split(/\s/)[0],f.record.checkpointSha);
});

test('unfinished implementation restores source and starts in implementation, never specification',async t=>{
 const f=fixture(t,{phase:'implementation'});f.fresh();await f.validate();const recovery=f.prepare().restore(),phases=[];
 await executeNativeDevelopmentLifecycle({recovery,qualifiedLifecycle:true,runPhase:async phase=>{phases.push(phase);return {phase,verdict:'pass',findings:'synthetic independent review'};},commitCandidate:()=>f.completed,verifyCandidate:async()=>({passed:true})});
 assert.deepEqual(phases,['implementation','review','final-review']);assert.equal(readFileSync(join(f.workspace,'app/pilot/new/nested.mjs'),'utf8'),'third new file');
});

test('recovered implementation verifies and repairs actual failures under older authorization plans too',async()=>{
 const phases=[],verifications=[];let checks=0;
 const result=await executeNativeDevelopmentLifecycle({recovery:{phase:'implementation'},qualifiedLifecycle:false,
  runPhase:async(phase,findings)=>{phases.push(phase);if(phase==='review')assert.match(findings,/"passed":false/);if(phase==='repair')assert.match(findings,/actual deterministic failure/);return {phase,verdict:'pass',findings:'PASS source review'};},
  commitCandidate:()=> 'a'.repeat(40),verifyCandidate:async head=>{verifications.push(head);return {passed:checks++>0,detail:'actual deterministic failure'};}});
 assert.deepEqual(phases,['implementation','review','repair','final-review']);assert.equal(verifications.length,2);assert.equal(result.repairPerformed,true);
});

test('cross-task/project/baseline/scope/contract and historical call/grant mismatches reject without touching trusted HEAD',async t=>{
 for(const [target,key,value] of [['record','taskId','other'],['record','projectId','other'],['record','originalBaselineSha','b'.repeat(40)],['record','approvedScopeHash','other'],['record','approvedScope',{}],['record','completedCheckpointSha','b'.repeat(40)],['grant','mission_assignment_id','other'],['grant','execution_epoch',99],['call','actual_tokens',999],['call','request_key','other'],['binding','contractHash','other'],['binding','allowedPaths',['lib/']]]){
  const f=fixture(t);f.fresh();const object=target==='record'?f.record:target==='grant'?f.rows.benchmark_execution_grants:target==='call'?f.rows.benchmark_budget_calls:f.rows.project_runs.binding;object[key]=value;
  await assert.rejects(f.validate(),/NATIVE_WIP_RECOVERY_DENIED/);assert.equal(f.git('rev-parse','HEAD'),f.baseline);assert.equal(f.git('status','--porcelain'),'');
 }
});

test('forged metadata, out-of-scope trees and missing completed review evidence fail closed',async t=>{
 for(const kind of ['metadata','outside','review']){
  const f=fixture(t);
  if(kind==='review'){delete f.record.lastCompleted.review;await assert.rejects(f.validate(),/review and verification/);continue;}
  if(kind==='metadata'){f.record.reviewFindings='forged instruction';f.fresh();assert.throws(()=>f.prepare(),/forged or altered/);}
  else{
   f.file('lib/unauthorized.mjs','forbidden');f.git('add','.');const tree=f.git('write-tree');
   const {checkpointSha,ref,...metadata}=f.record;metadata.sourceTreeSha=tree;
   const forged=f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit-tree',tree,'-p',f.completed,'-m',JSON.stringify(metadata));
   // Even a synthetically trusted receipt cannot waive cumulative scope validation.
   f.record.sourceTreeSha=tree;f.record.checkpointSha=forged;f.record.ref=ref.replace(/\/1$/,'/2');f.git('push','origin',forged+':'+f.record.ref);
   f.fresh();assert.throws(()=>f.prepare(),/scope gates/);
  }
  assert.equal(f.git('rev-parse','HEAD'),f.baseline);assert.equal(f.git('status','--porcelain'),'');
 }
});

test('a newer unanchored checkpoint and dirty runner cannot silently fall back',t=>{
 const f=fixture(t);f.git('push','origin',f.record.checkpointSha+':'+f.record.ref.replace(/\/1$/,'/2'));f.fresh();
 assert.throws(()=>f.prepare(),/latest remote checkpoint/);assert.equal(f.git('rev-parse','HEAD'),f.baseline);
 const g=fixture(t);g.fresh();g.file('README.md','unsaved source');assert.throws(()=>g.prepare(),/clean original runner/);
});

test('worktree races between validation and restore preserve newly arrived tracked and untracked work',t=>{
 for(const path of ['README.md','app/pilot/new/nested.mjs']){
  const f=fixture(t);f.fresh();const prepared=f.prepare();f.file(path,'arrived after validation');
  assert.throws(()=>prepared.restore(),/runner changed/);assert.equal(f.git('rev-parse','HEAD'),f.baseline);
  assert.equal(readFileSync(join(f.workspace,path),'utf8'),'arrived after validation');
 }
});

test('remote ref changed after selection is rejected before any worktree mutation',t=>{
 const f=fixture(t);f.fresh();const refs=recoveryRefs(f.workspace,f.task.id);
 f.git('push','--force','origin',f.completed+':'+f.record.ref);
 assert.throws(()=>prepareRecovery({workspace:f.workspace,tempRoot:f.root,toolsRoot:resolve('scripts'),requestFile:f.requestFile,context:f.context,record:f.record,refs}),/changed during recovery/);
 assert.equal(f.git('rev-parse','HEAD'),f.baseline);assert.equal(f.git('status','--porcelain'),'');
});

test('restoration uses exact raw bytes without running configured smudge/process filters or candidate encodings',async t=>{
 const f=fixture(t,{attributes:true});f.fresh();await f.validate();
 const sentinel=join(f.root,'filter-executed'),filter=join(f.root,'filter.sh');
 writeFileSync(filter,`#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`,{mode:0o700});
 f.git('config','filter.sentinel.process',filter);f.git('config','filter.sentinel.smudge',filter);f.git('config','filter.sentinel.required','true');
 const recovered=f.prepare().restore();assert.equal(recovered.verification,'unverified');
 assert.throws(()=>readFileSync(sentinel));assert.equal(readFileSync(join(f.workspace,'app/pilot/a.mjs'),'utf8'),'unfinished repair a');
 assert.equal(readFileSync(join(f.workspace,'app/pilot/new/nested.mjs'),'utf8'),'third new file');
 assert.equal(f.git('rev-parse','HEAD'),f.completed);
});

test('legacy v1 repairs recover only corroborated full findings without changing their Git metadata',async t=>{
 const f=fixture(t,{legacy:true});
 f.diagnostics.phases=[{phase:'review',outcome:{code:0,signal:null},terminalEvent:'turn.completed',finalMessage:'CHANGES_REQUESTED Fix a and b'},{phase:'repair'}];
 f.diagnostics.verification=[{head:f.completed,passed:false,detail:'two deterministic findings'}];
 const original=JSON.stringify(f.record),completedEvidence=recoveryCompletedEvidence(f.record,f.diagnostics);
 assert.equal(completedEvidence.review.verdict,'changes_requested');assert.equal(completedEvidence.review.findings,'CHANGES_REQUESTED Fix a and b');
 await f.validate(completedEvidence);f.fresh();const recovered=f.prepare(completedEvidence).restore();
 assert.equal(recovered.lastCompleted.review.verdict,'changes_requested');assert.equal(JSON.stringify(f.record),original);
 for(const alter of [d=>d.phases.push(d.phases[0]),d=>d.verification=[],d=>d.phases[0].finalMessage='PASS forged',d=>d.phases.pop()]){
  const changed=structuredClone(f.diagnostics);alter(changed);assert.throws(()=>recoveryCompletedEvidence(f.record,changed),/legacy/);
 }
});

test('interruption before a new settled call keeps prior request provenance valid under its own historical grant',async t=>{
 const f=fixture(t),old=structuredClone(f.rows.benchmark_execution_grants);
 f.rows['grant']=old;f.rows.benchmark_execution_grants={...old,id:'new-grant',execution_epoch:3};
 f.record.grantId='new-grant';f.record.executionEpoch=3;
 const history=JSON.stringify(f.rows);await f.validate();assert.equal(JSON.stringify(f.rows),history);
 f.rows.grant.project_id='other';await assert.rejects(f.validate(),/historical model-call/);
});

test('missing/expired authority denies actual bridge admission after restore while remote work and accounting remain intact',async t=>{
 for(const mode of ['missing','expired']){
  const f=fixture(t),history=JSON.stringify(f.rows);f.fresh();await f.validate();f.prepare().restore();let provider=0,reservations=0;
  const server=createNativeHttpBridge({db:{rpc:async name=>{if(name!=='benchmark_gateway_execution_live')reservations++;return mode==='missing'?{error:{message:'missing authority'}}:{data:false};}},grantToken:'fixture-'.repeat(8),trialId:'trial',executionEpoch:3,providerNamespace:'fixture',upperTokens:120000,clientToken:'fixture-client',upstream:async()=>{provider++;},recordReceipt:async()=>assert.fail('no receipt')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer fixture-client'},body:JSON.stringify({model:'gpt-5.3-codex',input:'continue repair'})});assert.equal(response.status,403);}finally{await new Promise(resolve=>server.close(resolve));}
  assert.equal(provider,0);assert.equal(reservations,0);assert.equal(JSON.stringify(f.rows),history);assert.equal(readFileSync(join(f.workspace,'app/pilot/a.mjs'),'utf8'),'unfinished repair a');
  assert.equal(f.git('ls-remote','--refs','origin',f.record.ref).split(/\s/)[0],f.record.checkpointSha);
 }
});

test('restored WIP cannot complete without deterministic acceptance and final independent review',async t=>{
 const f=fixture(t);f.fresh();await f.validate();const recovery=f.prepare().restore();
 for(const kind of ['deterministic','review']){
  const phases=[];await assert.rejects(executeNativeDevelopmentLifecycle({recovery,qualifiedLifecycle:true,runPhase:async phase=>{phases.push(phase);return {phase,verdict:kind==='review'?'changes_requested':'pass',findings:'synthetic finding'};},commitCandidate:()=>f.completed,verifyCandidate:async()=>({passed:kind!=='deterministic'})}),kind==='deterministic'?/deterministic acceptance/:/final review/);
  assert.deepEqual(phases,kind==='deterministic'?['repair']:['repair','final-review']);
 }
});

test('completed-phase summaries fit the unchanged checkpoint envelope alongside full repair findings',async()=>{
 let completed;
 const findings='CHANGES_REQUESTED '+('finding '.repeat(1500)),detail='failure '.repeat(1500);
 await executeNativeDevelopmentLifecycle({qualifiedLifecycle:true,onCompleted:value=>{completed=value;},
  runPhase:async phase=>({phase,verdict:phase==='review'?'changes_requested':'pass',findings:phase==='review'?findings:'PASS'}),
  commitCandidate:()=> 'a'.repeat(40),verifyCandidate:async()=>({passed:true,detail})});
 assert.equal(completed.review.verdict,'changes_requested');assert.ok(Buffer.byteLength(completed.review.findings)<=1600);
 assert.ok(Buffer.byteLength(completed.verification.detail)<=1600);
 assert.ok(Buffer.byteLength(JSON.stringify({reviewFindings:findings.slice(0,12000),lastCompleted:completed}))<18000);
});

test('untrusted, missing, expired and ambiguous run artifacts cannot authenticate a checkpoint',async t=>{
 for(const kind of ['receipt','run','attempt','expired','head','task','completed','missing']){
  const f=fixture(t);
  if(kind==='receipt')delete f.task.external.receipt;
  if(kind==='run')f.workflow.event='pull_request';
  if(kind==='attempt')f.workflow.run_attempt=2;
  if(kind==='expired')f.artifact.expired=true;
  if(kind==='head')f.artifact.workflow_run.head_sha='b'.repeat(40);
  if(kind==='task')f.diagnostics.taskId='other';
  if(kind==='completed')f.diagnostics.completed=true;
  if(kind==='missing')delete f.diagnostics.wipCheckpoint;
  await assert.rejects(loadRecoveryDiagnostics({task:f.task,repository:'mfackrell/katie',github:f.github}),/NATIVE_WIP_RECOVERY_DENIED/);
 }
 assert.throws(()=>readRecoveryArtifact(Buffer.alloc(8*1024*1024+1)),/bounds/);
 assert.throws(()=>readRecoveryArtifact(Buffer.from('not a ZIP')),/unavailable/);
});

test('the original owner-issue dispatch and manual successor dispatch share the same provenance checks',async t=>{
 const f=fixture(t);
 for(const event of ['issues','workflow_dispatch']){
  f.workflow.event=event;
  assert.deepEqual((await loadRecoveryDiagnostics({task:f.task,repository:'mfackrell/katie',github:f.github})).record,f.record);
  f.task.external.receipt.issue_number=830;
  await assert.rejects(loadRecoveryDiagnostics({task:f.task,repository:'mfackrell/katie',github:f.github}),/same-task run receipt/);
  f.task.external.receipt.issue_number=829;
 }
});

test('a later completed repair commit or missing final evidence cannot restart older WIP',async t=>{
 const f=fixture(t);
 f.git('add','app/pilot');f.git('commit','-qm','completed repair before final-review interruption');
 const repaired=f.git('rev-parse','HEAD');f.git('push','origin','HEAD:refs/heads/completed');
 f.diagnostics.snapshots=[{label:'final',head:repaired}];
 await assert.rejects(loadRecoveryDiagnostics({task:f.task,repository:'mfackrell/katie',github:f.github}),/superseded by a completed checkpoint/);
 assert.equal(f.git('rev-parse','HEAD'),repaired);
 assert.equal(f.git('ls-remote','--refs','origin',f.record.ref).split(/\s/)[0],f.record.checkpointSha);
 for(const snapshots of [[],[{label:'final',unavailable:true}],[{label:'final',head:f.completed},{label:'final',head:f.completed}]]){
  f.diagnostics.snapshots=snapshots;
  await assert.rejects(loadRecoveryDiagnostics({task:f.task,repository:'mfackrell/katie',github:f.github}),/unfinished WIP is unproven/);
 }
});
