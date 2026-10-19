import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import ts from 'typescript';
const sha='a'.repeat(40);
function receipt(){return{
 version:1,repository:'mfackrell/katie',issue_number:123,run_id:567,pr_url:'https://github.com/mfackrell/katie/pull/234',
 outcome:'READY',tested_head_sha:sha,reviewed_head_sha:sha,
 checks:{build:'success',test:'true',review:'pass',retest:'',final_review:''}
};}
function run(data){
 const path=mkdtempSync(join(tmpdir(),'executive-release-test-'));
 try{
  const file=join(path,'receipt.json');writeFileSync(file,JSON.stringify(data));
  return spawnSync(process.execPath,['scripts/executive-release-verifier.mjs'],{
   env:{...process.env,RECEIPT_FILE:file,GITHUB_REPOSITORY:'mfackrell/katie',
     EXPECTED_SHA:sha,ISSUE_NUMBER:'123',PR_NUMBER:'234',RUN_ID:'567'},encoding:'utf8'
  });
 }finally{rmSync(path,{recursive:true,force:true});}
}
test('verified exact immutable receipt is release eligible',()=>{
 const result=run(receipt());assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/VERIFIED RELEASE RECEIPT/);
});
test('unreviewed, changed, or unrelated PRs never become release eligible',()=>{
 for(const change of [
  {outcome:'BLOCKED'}, {reviewed_head_sha:'b'.repeat(40)},
  {pr_url:'https://github.com/mfackrell/katie/pull/235'},
  {repository:'someone/else'}, {checks:{...receipt().checks,review:'changes_requested'}},
  {checks:{...receipt().checks,test:'false'}},
 ]){
  const result=run({...receipt(),...change});
  assert.notEqual(result.status,0,JSON.stringify(change));
 }
});
test('production release needs explicit user authorization, not a casual coding request',()=>{
 const raw=readFileSync('lib/executive/release-control.ts','utf8');
 const js=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exp={};
 vm.runInNewContext(js,{exports:exp,require:name=>{
  if(name==='@octokit/rest')return{Octokit:class{}};
  if(name==='@/lib/data/supabase/admin')return{};
  if(name==='@/lib/data/persistence-store')return{};
  return require(name);
 }});
 const f=exp.authorizedReleaseObjective;
 assert.equal(f('Delegate software development to fix code and deploy the changes to production.'),true);
 assert.equal(f('Delegate software development to fix code and deploy the changes to production.\\nCONNECTED REPOSITORY: mfackrell/katie\\nDo not auto-merge or deploy without existing release authorization.'),true);
 for(const msg of ['Build an app','Deploy to staging','Deploy to production, but do not deploy',
  'Do not deploy to production','Build and open a draft PR']){
  assert.equal(f(msg),false,msg);
 }
});
test('release workflow verifies reviewed artifact, immutable commit, and Vercel status',()=>{
 const file=readFileSync('.github/workflows/executive-autonomous-release.yml','utf8');
 assert.match(file,/scripts\/executive-release-verifier[.]mjs/);
 assert.match(file,/--match-head-commit/);
 assert.match(file,/context=="Vercel" and [.]state=="success"/);
 assert.doesNotMatch(file,/--admin/);
});
