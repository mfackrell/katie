import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {parseRecoveryScope,assertRecoveryScope} from '../scripts/recovery-scope.mjs';

const nodeRequire=createRequire(import.meta.url);
const js=ts.transpileModule(readFileSync('lib/recovery/policy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const exports={};
vm.runInNewContext(js,{exports,require:nodeRequire,console},{filename:'lib/recovery/policy.ts'});
const {diagnoseRecoveryFailure,narrowPaths,validRepairPath}=exports;

test('recovery triage distinguishes transient provider, trusted infrastructure, code and permission failures',()=>{
 let d=diagnoseRecoveryFailure({sourceType:'mission',detail:'Model timed out while fetching'});
 assert.equal(d.strategy,'retry_original');assert.equal(d.category,'provider_transient');
 d=diagnoseRecoveryFailure({sourceType:'project',detail:'Browser was blocked',
  trustedLog:"EINVAL: invalid argument, chown '/tmp/fonts'",approvedProjectPaths:['app/project-pilots/token-board/']});
 assert.equal(d.strategy,'scoped_repair');assert.ok(d.allowedPaths.includes('scripts/project-browser-check.mjs'));
 assert.equal(d.allowedPaths.includes('app/project-pilots/token-board/'),false,'infrastructure repair cannot change application code');
d=diagnoseRecoveryFailure({sourceType:'project',detail:'browser_check: browser launch stopped',
  trustedLog:'TRUSTED_PROJECT_BROWSER_RUNNER_ERROR: browserType.launch: Target page, context or browser has been closed'});
 assert.equal(d.category,'verification_infrastructure','server-recorded browser launcher failure is infrastructure');
 assert.equal(d.strategy,'scoped_repair');
 assert.ok(d.allowedPaths.includes('lib/projects/preview.ts'));
 d=diagnoseRecoveryFailure({sourceType:'project',detail:'browser_check: browser launch stopped'});
 assert.notEqual(d.strategy,'scoped_repair','unverified browser errors cannot grant code changes');
 d=diagnoseRecoveryFailure({sourceType:'project',detail:'Independent test failed: Rendered text does not equal approved expected value',
  approvedProjectPaths:['app/project-pilots/token-board/']});
 assert.equal(d.category,'implementation');assert.equal(d.strategy,'scoped_repair');
 assert.deepEqual([...d.allowedPaths],['app/project-pilots/token-board/']);
 d=diagnoseRecoveryFailure({sourceType:'project',detail:'Secret key missing; permission denied',
  trustedLog:'npm error Exit handler never called'});
 assert.equal(d.strategy,'owner_required','security issues cannot be auto-repaired regardless of other logs');
 d=diagnoseRecoveryFailure({sourceType:'task',detail:'Inaccessible credential'});
 assert.equal(d.strategy,'owner_required');
 d=diagnoseRecoveryFailure({sourceType:'mission',detail:'No remaining token allowance'});
 assert.equal(d.strategy,'owner_required');
 d=diagnoseRecoveryFailure({sourceType:'mission',detail:'Mysterious content quality failure'});
 assert.equal(d.strategy,'diagnose');
});
test('recovery paths reject traversal, broad system access and protected configuration',()=>{
 for(const bad of ['../../etc/passwd','lib/../secret','lib/.env.local','scripts/package.json','.github/workflows/ci.yml','scripts/recovery.yml','lib/','tests/../../x']){
  assert.equal(validRepairPath(bad),false,bad);
 }
 assert.deepEqual([...narrowPaths(['scripts/project-ci.mjs','scripts/project-ci.mjs'])],['scripts/project-ci.mjs']);
 assert.throws(()=>narrowPaths(['scripts/project-ci.mjs','scripts/package.json']),/not explicitly authorized/);
});
function marker(scope){return '<!-- katie-recovery: '+Buffer.from(JSON.stringify(scope)).toString('base64url')+' -->';}
test('recovery code scope fences changes even when agent authored instructions differ',()=>{
 const root=mkdtempSync(join(tmpdir(),'recovery-scope-')),repo=join(root,'repo'),request=join(root,'issue.md');
 mkdirSync(repo);
 const git=(...a)=>execFileSync('git',a,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const file=(p,body)=>{mkdirSync(dirname(join(repo,p)),{recursive:true});writeFileSync(join(repo,p),body);};
 try{
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.com');
  file('README.md','base');git('add','.');git('commit','-qm','baseline');
  const head=git('rev-parse','HEAD');
  const scope={version:1,caseId:'11111111-1111-4111-8111-111111111111',sourceSha:head,allowedPaths:['scripts/project-ci.mjs','tests/recovery/'],category:'verification_infrastructure'};
  writeFileSync(request,marker(scope));
  assert.equal(parseRecoveryScope(readFileSync(request,'utf8')).sourceSha,head);
  file('scripts/project-ci.mjs','repair');git('add','.');
  assert.deepEqual(assertRecoveryScope(request,repo),['scripts/project-ci.mjs']);
  file('.github/workflows/evil.yml','escape');git('add','.');
  assert.throws(()=>assertRecoveryScope(request,repo),/unapproved path/);
  git('reset','-q','HEAD');
  file('scripts/package.json','secret');git('add','.');
  assert.throws(()=>assertRecoveryScope(request,repo),/unapproved path/);
  assert.throws(()=>parseRecoveryScope(marker({...scope,allowedPaths:['../escape']})),/Recovery path escaped/);
  assert.throws(()=>parseRecoveryScope(marker(scope)+marker(scope)),/duplicate/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
