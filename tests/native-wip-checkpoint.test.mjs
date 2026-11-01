import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createNativeWipCheckpointer} from '../scripts/benchmark/native-wip-checkpoint.mjs';
import {createNativeHttpBridge} from '../scripts/benchmark/native-http-bridge.mjs';
import {projectMarker,contractHash} from '../scripts/project-context.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'native-wip-')),repo=join(root,'runner'),remote=join(root,'durable.git');
 t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(repo);
 const command=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const git=(...args)=>command(repo,...args);
 const file=(path,content)=>{mkdirSync(dirname(join(repo,path)),{recursive:true});writeFileSync(join(repo,path),content);};
 command(root,'init','--bare','-q',remote);git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.com');
 file('README.md','baseline');git('add','.');git('commit','-qm','baseline');const baseline=git('rev-parse','HEAD');
 const contract={path:'/',scenarios:[{name:'state',steps:[{action:'expectText',selector:'#state',value:'Ready'}]}]};
 const context={version:1,projectId:'11111111-1111-4111-8111-111111111111',baseSha:baseline,baselineSha:baseline,allowedPaths:['app/pilot/'],contractHash:contractHash(contract),contract};
 const requestFile=join(root,'request');writeFileSync(requestFile,projectMarker(context));
 git('remote','add','origin',remote);
 let head=baseline;
 const identity={projectId:context.projectId,taskId:'22222222-2222-4222-8222-222222222222',runId:'123',runAttempt:'1',approvedScopeHash:'approved-scope',grantId:'existing-grant',executionEpoch:2};
 const options={workspace:repo,tempRoot:root,toolsRoot:resolve('scripts'),requestFile,context,identity,expectedHead:()=>head};
 const implementation=()=>{file('app/pilot/a.mjs','original a');file('app/pilot/b.mjs','original b');git('add','.');git('commit','-qm','implementation');head=git('rev-parse','HEAD');git('push','origin','HEAD:refs/heads/completed');return head;};
 return {root,repo,remote,git,file,command,context,options,implementation};
}

test('two incomplete repair writes survive admission denial and runner deletion, with provenance and no promotion',async t=>{
 const f=fixture(t),completed=f.implementation(),wip=createNativeWipCheckpointer(f.options);
 f.file('app/pilot/a.mjs','unfinished repair a');f.file('app/pilot/b.mjs','unfinished repair b');f.file('app/pilot/engine.mjs','new repair file');
 const indexBefore=f.git('write-tree');let saved,provider=0;const calls=[];
 const server=createNativeHttpBridge({db:{rpc:async name=>{calls.push(name);return {data:name==='benchmark_gateway_execution_live'?true:null,error:null};}},
  grantToken:'fixture-'.repeat(8),trialId:'trial',executionEpoch:2,providerNamespace:'fixture',upperTokens:100,
  clientToken:'fixture-client-token',upstream:Object.assign(async()=>{provider++;},{nonbillableFixture:true}),recordReceipt:async()=>assert.fail('no receipt expected'),
  beforeRequest:()=>{saved=wip.save({phase:'repair',reviewFindings:'Fix a and b',lastCompleted:{phase:'review',checkpointSha:completed,modelCall:{requestKey:'historical-call',actualTokens:123}}});}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer fixture-client-token'},body:JSON.stringify({model:'fixture',input:'continue'})});assert.equal(response.status,403);}
 finally{await new Promise(r=>server.close(r));}
 assert.equal(provider,0);assert.deepEqual(calls,['benchmark_gateway_execution_live','benchmark_grant_reserve']);
 assert.equal(f.git('rev-parse','HEAD'),completed);assert.equal(f.git('write-tree'),indexBefore);
 assert.equal(f.command(f.root,'--git-dir='+f.remote,'rev-parse','refs/heads/completed'),completed);
 rmSync(f.repo,{recursive:true,force:true}); // The entire runner is gone.
 const recovered=join(f.root,'recovered');f.command(f.root,'clone','-q',f.remote,recovered);
 f.command(recovered,'checkout','--detach',saved.checkpointSha);
 assert.equal(readFileSync(join(recovered,'app/pilot/a.mjs'),'utf8'),'unfinished repair a');
 assert.equal(readFileSync(join(recovered,'app/pilot/b.mjs'),'utf8'),'unfinished repair b');
 assert.equal(readFileSync(join(recovered,'app/pilot/engine.mjs'),'utf8'),'new repair file');
 const meta=JSON.parse(f.command(recovered,'show','-s','--format=%B',saved.checkpointSha));
 assert.equal(meta.verification,'unverified');assert.equal(meta.phase,'repair');
 assert.equal(meta.taskId,f.options.identity.taskId);assert.equal(meta.originalBaselineSha,f.context.baselineSha);
 assert.deepEqual(meta.approvedScope.allowedPaths,f.context.allowedPaths);assert.equal(meta.reviewFindings,'Fix a and b');
 assert.equal(meta.lastCompleted.modelCall.requestKey,'historical-call');assert.equal(meta.completedCheckpointSha,completed);
 assert.equal(f.command(recovered,'rev-parse',saved.ref),saved.checkpointSha);
});

test('initial empty work is allowed; missing authorized files are preserved without touching the index',t=>{
 const f=fixture(t),wip=createNativeWipCheckpointer(f.options);
 assert.equal(wip.save({phase:'implementation'}),null);
 f.file('app/pilot/new/nested.mjs','new source');const record=wip.save({phase:'implementation'});
 assert.equal(f.git('show',record.checkpointSha+':app/pilot/new/nested.mjs'),'new source');
 assert.equal(f.git('diff','--cached','--name-only'),'');
});

test('out-of-scope, protected configuration, symlink and secret writes never reach remote',t=>{
 for(const kind of ['outside','config','link','secret']){
  const f=fixture(t);f.implementation();
  if(kind==='outside')f.file('lib/escape.mjs','bad');
  if(kind==='config')f.file('app/pilot/package.json','{}');
  if(kind==='link')symlinkSync('/etc/passwd',join(f.repo,'app/pilot/link'));
  if(kind==='secret')f.file('app/pilot/a.mjs','fixture-secret-value');
  const wip=createNativeWipCheckpointer({...f.options,secrets:['fixture-secret-value']});
  assert.throws(()=>wip.save({phase:'repair'}));
  assert.equal(f.git('ls-remote','--tags','origin'),'');
 }
});

test('snapshot failure blocks admission and provider; unauthenticated requests cannot trigger snapshots',async t=>{
 let checkpoints=0,admissions=0,provider=0;
 const server=createNativeHttpBridge({db:{rpc:async()=>{admissions++;}},grantToken:'fixture-'.repeat(8),trialId:'trial',executionEpoch:1,
  providerNamespace:'fixture',upperTokens:100,clientToken:'fixture-client-token',upstream:async()=>{provider++;},recordReceipt:async()=>{},
  beforeRequest:()=>{checkpoints++;throw Error('NATIVE_WIP_CHECKPOINT_DENIED');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}/v1/responses`;
 for(const authorized of [false,true]){const response=await fetch(url,{method:'POST',headers:authorized?{authorization:'Bearer fixture-client-token'}:{},body:JSON.stringify({model:'fixture',input:'test'})});assert.equal(response.status,authorized?403:401);}
 assert.equal(checkpoints,1);assert.equal(admissions,0);assert.equal(provider,0);
});

test('remote failure is fatal and concurrent saves cannot overwrite a checkpoint',async t=>{
 const f=fixture(t);f.implementation();f.file('app/pilot/a.mjs','repair');
 const wip=createNativeWipCheckpointer(f.options);
 const records=await Promise.all([1,2].map(()=>Promise.resolve().then(()=>wip.save({phase:'repair'}))));
 assert.equal(records[0].checkpointSha,records[1].checkpointSha);
 f.git('remote','set-url','origin',join(f.root,'missing.git'));f.file('app/pilot/b.mjs','second repair');
 assert.throws(()=>wip.save({phase:'repair'}));
});

test('deletions and sanitized findings persist; review phases cannot publish WIP',t=>{
 const f=fixture(t);f.implementation();rmSync(join(f.repo,'app/pilot/b.mjs'));
 const wip=createNativeWipCheckpointer({...f.options,secrets:['private-fixture-secret']});
 assert.equal(wip.save({phase:'review'}),null);
 const saved=wip.save({phase:'repair',reviewFindings:'Replace private-fixture-secret'});
 assert.throws(()=>f.git('show',saved.checkpointSha+':app/pilot/b.mjs'));
 assert.ok(!f.git('show','-s','--format=%B',saved.checkpointSha).includes('private-fixture-secret'));
 assert.equal(saved.verification,'unverified');
});

test('existing remote checkpoint cannot be replaced by a new host instance',t=>{
 const f=fixture(t);f.implementation();f.file('app/pilot/a.mjs','first repair');
 const saved=createNativeWipCheckpointer(f.options).save({phase:'repair'});
 f.file('app/pilot/a.mjs','conflicting repair');
 assert.throws(()=>createNativeWipCheckpointer(f.options).save({phase:'repair'}));
 assert.equal(f.git('ls-remote','--refs','origin',saved.ref).split(/\s/)[0],saved.checkpointSha);
});

test('oversized source and symlinked ancestor fail closed',t=>{
 const f=fixture(t);f.implementation();const wip=createNativeWipCheckpointer(f.options);
 f.file('app/pilot/a.mjs','x'.repeat(4*1024*1024+1));assert.throws(()=>wip.save({phase:'repair'}));
 f.file('app/pilot/a.mjs','safe');rmSync(join(f.repo,'app/pilot'),{recursive:true});
 const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'a.mjs'),'external');
 symlinkSync(outside,join(f.repo,'app/pilot'));assert.throws(()=>wip.save({phase:'repair'}));
 assert.equal(f.git('ls-remote','--tags','origin'),'');
});

test('v2 clean pre-implementation boundary survives runner destruction and restores the same baseline',async t=>{
 const {prepareRecovery,recoveryRefs}=await import('../scripts/benchmark/native-wip-recovery.mjs');
 const f=fixture(t),wip=createNativeWipCheckpointer(f.options),baseline=f.context.baseSha;
 f.git('push','origin','HEAD:refs/heads/baseline');
 const record=wip.save({phase:'implementation',boundary:true,lastCompleted:{checkpointSha:baseline}});
 assert.equal(record.version,2);assert.equal(record.sourceTreeSha,f.git('rev-parse','HEAD^{tree}'));
 rmSync(f.repo,{recursive:true,force:true});f.command(f.root,'clone','-q','--branch','baseline',f.remote,f.repo);
 const recovery=prepareRecovery({...f.options,record,refs:recoveryRefs(f.repo,f.options.identity.taskId)}).restore();
 assert.equal(recovery.phase,'implementation');assert.equal(f.git('rev-parse','HEAD'),baseline);assert.equal(f.git('status','--porcelain'),'');
});
