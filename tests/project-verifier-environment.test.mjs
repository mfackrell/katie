import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {sandboxArgs} from '../scripts/project-sandbox.mjs';
import {createNativeWipCheckpointer} from '../scripts/benchmark/native-wip-checkpoint.mjs';
import {projectMarker,contractHash} from '../scripts/project-context.mjs';

test('diagnostic mount rejects existing source, symlinks and overlapping checkout',t=>{
 const root=mkdtempSync(join(tmpdir(),'verifier-mount-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repo=join(root,'candidate'),artifacts=join(root,'diagnostics');mkdirSync(repo);mkdirSync(artifacts);
 assert.throws(()=>sandboxArgs(repo,{artifacts:repo}),/outside/);
 assert.throws(()=>sandboxArgs(repo,{artifacts:root}),/outside/);
 mkdirSync(join(repo,'test-artifacts'));writeFileSync(join(repo,'test-artifacts','source'),'preserve');
 assert.throws(()=>sandboxArgs(repo,{artifacts}),/hide candidate/);
 assert.equal(readFileSync(join(repo,'test-artifacts','source'),'utf8'),'preserve');
 rmSync(join(repo,'test-artifacts'),{recursive:true});symlinkSync(artifacts,join(repo,'test-artifacts'));
 assert.throws(()=>sandboxArgs(repo,{artifacts}),/hide candidate/);
 rmSync(join(repo,'test-artifacts'));symlinkSync(artifacts,join(root,'alias'));
 assert.throws(()=>sandboxArgs(repo,{artifacts:join(root,'alias')}),/Invalid artifact/);
});

if(process.env.KATIE_VERIFY_NATIVE_ENV==='1')test('native isolation runs PostgreSQL concurrency and preserves clean WIP on passing and failing verification', {timeout:180000},t=>{
 // Explicit opt-in: this test is mandatory in the dedicated native verifier CI
 // job, where missing namespace/PG support is a failure, never a silent skip.
 const root=mkdtempSync(join(tmpdir(),'verifier-native-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repo=join(root,'candidate'),artifacts=join(root,'diagnostics'),remote=join(root,'durable.git');mkdirSync(repo);mkdirSync(artifacts);
 const command=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
 const git=(...args)=>command(repo,...args);
 command(root,'init','--bare','-q',remote);git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.com');
 writeFileSync(join(repo,'README.md'),'baseline');git('add','.');git('commit','-qm','baseline');const base=git('rev-parse','HEAD');
 mkdirSync(join(repo,'app/pilot'),{recursive:true});writeFileSync(join(repo,'app/pilot/page.tsx'),'export default function Page(){return null}');git('add','.');git('commit','-qm','saved application');const head=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');git('remote','add','origin',remote);
 const contract={path:'/',scenarios:[{name:'state',steps:[{action:'expectText',selector:'#state',value:'Ready'}]}]};
 const context={version:1,projectId:'11111111-1111-4111-8111-111111111111',baseSha:base,baselineSha:base,allowedPaths:['app/pilot/'],contractHash:contractHash(contract),contract};
 const requestFile=join(root,'request');writeFileSync(requestFile,projectMarker(context));
 const wip=createNativeWipCheckpointer({workspace:repo,tempRoot:root,toolsRoot:resolve('scripts'),requestFile,context,identity:{projectId:context.projectId,taskId:'22222222-2222-4222-8222-222222222222',runId:'123',runAttempt:'1'},expectedHead:()=>head});
 // Actual server + simultaneous transactions inside exactly sandboxArgs used by
 // project-ci. The second update must block, then observe the first commit.
 const pg=`set -eu
BIN=/usr/lib/postgresql/16/bin
"$BIN/initdb" --version | grep ' 16\.'
"$BIN/initdb" -D /tmp/fixture -U postgres -A trust --no-locale
"$BIN/pg_ctl" -D /tmp/fixture -l /tmp/pg.log -o '-h 127.0.0.1 -k /tmp -p 55432' -w start
trap '"$BIN/pg_ctl" -D /tmp/fixture -m immediate -w stop' EXIT
"$BIN/psql" -h 127.0.0.1 -p 55432 -U postgres -c 'create table counter(n integer); insert into counter values(0)'
"$BIN/psql" -h 127.0.0.1 -p 55432 -U postgres -c 'begin; update counter set n=n+1; select pg_sleep(1); commit' > /tmp/first &
FIRST=$!
"$BIN/psql" -h 127.0.0.1 -p 55432 -U postgres -c 'update counter set n=n+1' > /tmp/second &
SECOND=$!
wait "$FIRST"; wait "$SECOND"
test "$("$BIN/psql" -h 127.0.0.1 -p 55432 -U postgres -Atc 'select n from counter')" = 2
mkdir -p /app/test-artifacts/standalone-rail
printf diagnostics > /app/test-artifacts/standalone-rail/fixture.png
`;
 for(const passed of [true,false]){
  const r=spawnSync('bwrap',[...sandboxArgs(repo,{writable:true,artifacts}),'/bin/bash','-c',pg+`\nexit ${passed?0:17}\n`],{encoding:'utf8',timeout:60000});
  assert.equal(r.status,passed?0:17,r.stderr+r.stdout);assert.equal(readFileSync(join(artifacts,'standalone-rail/fixture.png'),'utf8'),'diagnostics');
  assert.equal(git('status','--porcelain'),'');assert.equal(git('rev-parse','HEAD^{tree}'),tree);
  const record=wip.save({phase:'review',boundary:true,lastCompleted:{verification:{passed,head}}});
  assert.equal(record.sourceTreeSha,tree);assert.equal(record.verification,'unverified');
  assert.equal(record.lastCompleted.verification.passed,passed);
 }
 writeFileSync(join(repo,'unrelated.txt'),'must still be rejected');
 assert.throws(()=>wip.save({phase:'review',boundary:true}),/NATIVE_WIP_CHECKPOINT_DENIED/);
});

test('host diagnostic collection rejects symlinks and hardlinks; preserves normal output',async t=>{
 const {collectTestArtifacts}=await import('../scripts/project-sandbox.mjs');
 const {linkSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'verifier-collector-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,'source'),rail=join(source,'standalone-rail');mkdirSync(rail,{recursive:true});
 writeFileSync(join(source,'hidden-source.ts'),'out of scope');
 assert.throws(()=>collectTestArtifacts(source,join(root,'output')),/Unexpected test artifact path/);
 rmSync(join(source,'hidden-source.ts'));mkdirSync(join(source,'other'));
 assert.throws(()=>collectTestArtifacts(source,join(root,'output')),/Unexpected test artifact path/);
 rmSync(join(source,'other'),{recursive:true});
 writeFileSync(join(root,'secret'),'private');symlinkSync(join(root,'secret'),join(rail,'leak.png'));
 assert.throws(()=>collectTestArtifacts(source,join(root,'output')));
 rmSync(join(rail,'leak.png'));linkSync(join(root,'secret'),join(rail,'leak.png'));
 assert.throws(()=>collectTestArtifacts(source,join(root,'output')),/Invalid test artifact/);
 rmSync(join(rail,'leak.png'));rmSync(rail,{recursive:true});symlinkSync(root,rail);
 assert.throws(()=>collectTestArtifacts(source,join(root,'output')));
 rmSync(rail);mkdirSync(rail);writeFileSync(join(rail,'evidence.png'),'diagnostics');
 collectTestArtifacts(source,join(root,'output'));assert.equal(readFileSync(join(root,'output/evidence.png'),'utf8'),'diagnostics');
});
