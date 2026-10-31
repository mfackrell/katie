import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import vm from 'node:vm';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {sanitizeEvidence,summarizeNativeEvent,worktreeEvidence} from '../scripts/benchmark/native-execution-evidence.mjs';

test('command evidence distinguishes failed execution without retaining protected reads or arguments',()=>{
 const secret='ephemeral-bridge-bearer';
 const event=summarizeNativeEvent({type:'item.completed',item:{id:'tool-1',type:'command_execution',status:'failed',command:'cat /trusted/AGENT_REQUEST.md; echo '+secret,exit_code:1,aggregated_output:'protected transcript '+secret+'\nPermission denied\nRead-only file system'}} ,[secret]);
 assert.equal(event.exitCode,1);assert.equal(event.status,'failed');
 assert.deepEqual(event.errors,['Permission denied','Read-only file system']);
 assert.ok(event.outputBytes>0);assert.match(event.commandHash,/^[a-f0-9]{64}$/);
 const serialized=JSON.stringify(event);
 for(const forbidden of [secret,'protected transcript','/trusted/AGENT_REQUEST.md','aggregated_output'])assert.ok(!serialized.includes(forbidden));
 const succeeded=summarizeNativeEvent({type:'item.completed',item:{id:'tool-2',type:'command_execution',status:'completed',command:'true',exit_code:0,aggregated_output:''}});
 assert.equal(succeeded.exitCode,0);assert.deepEqual(succeeded.errors,[]);
});

test('final messages, failed turns and error events remain bounded and sanitized',()=>{
 const secret='short-live-secret';
 const text='Done. '+secret+' Bearer another-bearer <!-- katie-native-benchmark:signed.payload --> '+ 'x'.repeat(3000);
 const message=summarizeNativeEvent({type:'item.completed',item:{type:'agent_message',id:'final',text}},[secret]);
 assert.equal(message.itemType,'agent_message');assert.ok(message.message.startsWith('Done.'));
 assert.ok(message.message.length<=1600);assert.ok(!message.message.includes(secret));assert.ok(!message.message.includes('signed.payload'));assert.ok(!message.message.includes('another-bearer'));
 for(const event of [{type:'turn.failed',error:{message:secret}},{type:'error',message:secret}])assert.equal(summarizeNativeEvent(event,[secret]).error,'[REDACTED]');
 assert.equal(summarizeNativeEvent({type:'item.completed',item:{type:'reasoning',text:'protected reasoning'}}),null);
 assert.equal(summarizeNativeEvent({type:'thread.started',thread_id:secret}),null);
});

test('credential filtering handles quoted JSON and ordinary key-value evidence',()=>{
 const input='{"password":"short-password","api_key":"short-api-value","authorization":"Bearer token-value","access_token":"short-access-value"} secret=short-secret-value';
 const safe=sanitizeEvidence(input);
 for(const secret of ['short-password','short-api-value','token-value','short-access-value','short-secret-value'])assert.ok(!safe.includes(secret),secret+' must be redacted');
 assert.ok(!sanitizeEvidence('a\u0000b\n').includes('\u0000'));
 assert.ok(!sanitizeEvidence('sk-testcredential github_pat_examplecredential ghp_examplecredential').includes('examplecredential'));
});

test('file changes are bounded metadata, never contents or arbitrary change fields',()=>{
 const changes=Array.from({length:150},(_,i)=>({path:'app/project-pilots/take-eleven/file-'+i+'.mjs',kind:i?'update':'unexpected',diff:'protected source contents'}));
 const summary=summarizeNativeEvent({type:'item.completed',item:{id:'patch',type:'file_change',status:'completed',changes}});
 assert.ok(summary.changes.length<=20);assert.equal(summary.changes[0].kind,'unknown');
 assert.ok(!JSON.stringify(summary).includes('protected source contents'));
 assert.deepEqual(Object.keys(summary.changes[0]).sort(),['kind','path']);
 const huge=summarizeNativeEvent({type:'item.completed',item:{id:'patch',type:'file_change',changes:Array.from({length:1000},()=>({path:'a/'.repeat(1000),kind:'update'}))}});
 assert.ok(Buffer.byteLength(JSON.stringify(huge))<32768,'sanitized event fits the host framing buffer');
});

test('worktree snapshots distinguish inaction, surviving writes, and discarded writes without file contents',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-evidence-test-'));
 const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 try{
  git('init','-q');writeFileSync(join(root,'source.mjs'),'export const value=1;\n');git('add','source.mjs');
  git('-c','user.name=Evidence fixture','-c','user.email=evidence@example.invalid','commit','-qm','Synthetic baseline');
  const initial=worktreeEvidence(root);assert.match(initial.head,/^[a-f0-9]{40}$/);assert.deepEqual(initial.status,[]);
  assert.deepEqual(worktreeEvidence(root),initial,'no action leaves the same clean worktree');
  writeFileSync(join(root,'source.mjs'),'protected source contents\n');
  const changed=worktreeEvidence(root);assert.ok(changed.status.some(x=>x.includes('source.mjs')));assert.equal(changed.head,initial.head);
  assert.ok(!JSON.stringify(changed).includes('protected source contents'));
  git('restore','source.mjs');assert.deepEqual(worktreeEvidence(root),initial,'reset is distinguishable by comparing retained before/after snapshots');
  assert.deepEqual(worktreeEvidence(join(root,'missing')),{unavailable:true});
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('actual host event collector bounds events but preserves final message and terminal outcome',()=>{
 const source=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
 const start=source.indexOf("let output='',pending='';"),end=source.indexOf("child.stderr.on('data'",start);
 assert.ok(start>=0&&end>start);
 let consume,saves=0;const diagnostics={phases:[]};
 const collect=vm.runInNewContext(source.slice(start,end)+';phaseEvidence',{phase:'implementation',diagnostics,diagnosticSecrets:['retained-secret'],sanitizeEvidence,saveDiagnostics:()=>saves++,child:{stdout:{on:(name,fn)=>{assert.equal(name,'data');consume=fn;}}}});
 const emit=event=>consume('NATIVE_EXECUTION_EVENT='+JSON.stringify(event)+'\n');
 for(let i=0;i<150;i++)emit(summarizeNativeEvent({type:'item.completed',item:{type:'command_execution',id:String(i),status:'completed',exit_code:0,command:'true'}}));
 emit({event:'item.completed',itemType:'agent_message',message:'Final retained-secret'});
 emit({event:'turn.completed'});
 assert.equal(collect.events.length,120);assert.equal(collect.dropped,32);
 assert.equal(collect.finalMessage,'Final [REDACTED]');assert.equal(collect.terminalEvent,'turn.completed');assert.ok(saves>=152);
 emit({event:'turn.failed',error:'Bounded failure'});assert.equal(collect.terminalEvent,'turn.failed');
});

test('actual host scope wrapper retains rejected scope and cannot commit or push it',()=>{
 const source=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
 const start=source.indexOf('const commitCandidate='),end=source.indexOf('const sockdir=',start);
 assert.ok(start>=0&&end>start);
 for(const rejected of [false,true]){
  const diagnostics={scope:[]},commands=[],snapshots=[];let saved=0;
  const fn=vm.runInNewContext(source.slice(start,end)+';commitCandidate',{
   trustedCheckpointSha:'a'.repeat(40),lastCompleted:{checkpointSha:'a'.repeat(40)},activeWipPhase:{phase:'implementation'},
   checkpointBranch:'synthetic',requestFile:'/trusted/request',boundary:{root:'/synthetic'},join,
   process:{cwd:()=>'/synthetic',env:{RUNNER_TEMP:'/scratch'}},rmSync:()=>{},
   git:(...args)=>{commands.push(args);return 'a'.repeat(40);},denied:message=>{throw Error(message);},
   snapshot:label=>snapshots.push(label),diagnostics,diagnosticSecrets:['scope-secret'],sanitizeEvidence,saveDiagnostics:()=>saved++,
   execFileSync:(_bin,args)=>{if(rejected&&args[0].endsWith('/project-scope.mjs'))throw Object.assign(Error('scope failed'),{stderr:Buffer.from('Unapproved path; secret=scope-secret')});}
  });
  if(rejected){
   assert.throws(()=>fn('synthetic checkpoint'),/NATIVE_PROJECT_SCOPE_FAILED/);
   assert.equal(diagnostics.scope[0].passed,false);assert.ok(!diagnostics.scope[0].detail.includes('scope-secret'));assert.equal(saved,1);
   assert.ok(!commands.some(args=>args.includes('commit')||args.includes('push')));
  }else{
   assert.equal(fn('synthetic checkpoint'),'a'.repeat(40));assert.equal(diagnostics.scope[0].passed,true);
   assert.ok(commands.some(args=>args.includes('commit')));assert.ok(commands.some(args=>args.includes('push')));
  }
  assert.deepEqual(snapshots,['before-scope']);
 }
});
