import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const workflow=readFileSync(new URL('../.github/workflows/autonomous-development.yml',import.meta.url),'utf8');
const host=readFileSync(new URL('../scripts/benchmark/native-development-host.mjs',import.meta.url),'utf8');
const stage=workflow.slice(workflow.indexOf('          # Native workers read the immutable external request'),workflow.indexOf('          echo "issue=$ISSUE"'));
assert.ok(stage.includes('agent-task/AGENT_REQUEST.md'),'Missing actual request staging block');
const guard=host.split('\n').find(line=>line.includes("denied('review candidate changed')"));
assert.ok(guard,'Missing trusted review candidate guard');
const original='authenticated immutable request\n';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'native-review-binding-')),repo=join(root,'repo'),temp=join(root,'runner');
 t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(repo);mkdirSync(join(temp,'agent-task'),{recursive:true});
 writeFileSync(join(temp,'original-agent-request.md'),original);
 const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 writeFileSync(join(repo,'app.txt'),'approved candidate');git('add','app.txt');git('commit','-qm','candidate');
 const head=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');
 const stageRequest=native=>{const r=spawnSync('bash',['-euc',stage],{cwd:repo,env:{...process.env,RUNNER_TEMP:temp,native},encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 const verify=()=>new Function('git','reviewedHeadSha','denied',guard)(git,head,message=>{throw Error(message);});
 return {repo,temp,git,head,tree,stageRequest,verify};
}
test('reproduces the false review rejection on the former workflow request copy',t=>{
 const f=fixture(t);writeFileSync(join(f.repo,'AGENT_REQUEST.md'),original);
 assert.equal(f.git('status','--porcelain'),'?? AGENT_REQUEST.md');assert.equal(f.git('rev-parse','HEAD'),f.head);assert.equal(f.git('rev-parse','HEAD^{tree}'),f.tree);
 assert.throws(f.verify,/review candidate changed/);
});
test('actual native staging preserves external request and passes unchanged candidate guard',t=>{
 const f=fixture(t);f.stageRequest('true');
 assert.equal(readFileSync(join(f.temp,'agent-task','AGENT_REQUEST.md'),'utf8'),original);
 assert.equal(existsSync(join(f.repo,'AGENT_REQUEST.md')),false);assert.equal(f.git('status','--porcelain'),'');
 assert.equal(f.git('rev-parse','HEAD'),f.head);assert.equal(f.git('rev-parse','HEAD^{tree}'),f.tree);f.verify();
});
test('actual nonnative staging still provides the original local request',t=>{
 const f=fixture(t);f.stageRequest('false');assert.equal(readFileSync(join(f.repo,'AGENT_REQUEST.md'),'utf8'),original);
 assert.equal(readFileSync(join(f.temp,'agent-task','AGENT_REQUEST.md'),'utf8'),original);
});
test('native review still rejects tracked edits, staged edits, arbitrary untracked files and moved HEAD',t=>{
 const f=fixture(t);f.stageRequest('true');
 writeFileSync(join(f.repo,'app.txt'),'changed');assert.throws(f.verify,/review candidate changed/);
 f.git('add','app.txt');assert.throws(f.verify,/review candidate changed/);f.git('reset','--hard',f.head);
 writeFileSync(join(f.repo,'unexpected.txt'),'untracked');assert.throws(f.verify,/review candidate changed/);rmSync(join(f.repo,'unexpected.txt'));
 f.git('commit','--allow-empty','-qm','changed HEAD');assert.equal(f.git('rev-parse','HEAD^{tree}'),f.tree);assert.throws(f.verify,/review candidate changed/);
});
