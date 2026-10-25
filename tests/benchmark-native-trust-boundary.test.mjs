import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {assertTrustedBoundary,protectedNativeMounts,protectedGitConfig} from '../scripts/benchmark/native-trust-boundary.mjs';
const withRepo=fn=>{
 const root=mkdtempSync(join(tmpdir(),'katie-trust-test-'));
 try{
  execFileSync('git',['init','-q',root]);
  mkdirSync(join(root,'node_modules'));
  writeFileSync(join(root,'safe.txt'),'SAFE');
  return fn(root);
 }finally{rmSync(root,{recursive:true,force:true})}
};
test('canonical shared boundary rejects Git/dependency symlinks and escapes',()=>{
 withRepo(root=>{
  const boundary=assertTrustedBoundary(root);
  assert.equal(boundary.root,root);
  assert.deepEqual(protectedNativeMounts(boundary).slice(0,2),['--ro-bind',join(root,'.git')]);
  rmSync(join(root,'node_modules'),{recursive:true});
  symlinkSync('/tmp',join(root,'node_modules'));
  assert.throws(()=>assertTrustedBoundary(root),/UNTRUSTED_DEPENDENCIES_SYMLINK/);
 });
 withRepo(root=>{
  rmSync(join(root,'.git'),{recursive:true});
  symlinkSync('/tmp',join(root,'.git'));
  assert.throws(()=>assertTrustedBoundary(root),/UNTRUSTED_GIT_SYMLINK/);
 });
});
test('agent cannot poison credentialed host Git metadata, hooks or dependencies',t=>{
 if(spawnSync('bwrap',['--unshare-user','--ro-bind','/','/','--','/bin/true']).status!==0)
  return t.skip('bubblewrap user namespaces unavailable');
 withRepo(root=>{
  const hooks=join(root,'.git','hooks');
  const hook=join(hooks,'pre-commit');
  const injected=join(root,'host-hook-executed');
  writeFileSync(hook,'#!/bin/sh\nprintf HOOK > '+injected+'\n',{mode:0o755});
  execFileSync('git',['-C',root,'config','core.hooksPath',hooks]);
  const dep=join(root,'node_modules','trusted-sdk.js');
  writeFileSync(dep,'export default "TRUSTED";\n');
  const boundary=assertTrustedBoundary(root);
  const cmd='set +e; printf PWN > /work/.git/hooks/pre-commit; a=$?; printf PWN > /work/.git/config; b=$?; printf PWN > /work/node_modules/trusted-sdk.js; c=$?; ln -s /etc/passwd /work/host-link; test "$a" -ne 0 && test "$b" -ne 0 && test "$c" -ne 0';
  const args=['--die-with-parent','--unshare-all','--ro-bind','/usr','/usr',
    '--ro-bind','/bin','/bin','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
    '--bind',root,'/work',...protectedNativeMounts(boundary),
    '--proc','/proc','--dev','/dev','--chdir','/work','/bin/sh','-c',cmd];
  const outcome=spawnSync('bwrap',args,{encoding:'utf8'});
  assert.equal(outcome.status,0,outcome.stderr);
  assert.match(readFileSync(dep,'utf8'),/TRUSTED/);
  assert.match(readFileSync(hook,'utf8'),/HOOK/);
  assert.doesNotMatch(readFileSync(join(root,'.git','config'),'utf8'),/PWN/);
  execFileSync('git',[...protectedGitConfig,'-C',root,'add','safe.txt']);
  execFileSync('git',[...protectedGitConfig,'-C',root,
   '-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','safe checkpoint']);
  assert.equal(spawnSync('test',['-e',injected]).status,1,'malicious hook ran on host');
 });
});

test('checkpoint, recovery and publication use the same protected Git boundary',()=>{
 const host=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
 const workflow=readFileSync('.github/workflows/autonomous-development.yml','utf8');
 assert.match(host,/\.\.\.protectedGitConfig,\.\.\.args/);
 assert.match(host,/git\('push','origin'/);
 assert.match(host,/git\('reset','--hard',trustedCheckpointSha\)/);
 assert.match(host,/\.\.\.protectedNativeMounts\(boundary\)/);
 const publish=workflow.slice(workflow.indexOf('      - name: Create draft pull request'));
 assert.match(publish,/git\(\) \{ command git -c core\.hooksPath=\/dev\/null/);
 assert.match(publish,/git push origin/);
 assert.match(publish,/git commit -m/);
 assert.match(workflow,/native-trust-boundary\}\.mjs/);
});
