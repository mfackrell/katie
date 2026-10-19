import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {decide,assertPaths,ownerEnabled,REVIEWER_ID} from '../../scripts/game-repair/control.mjs';
const config=JSON.parse(readFileSync(new URL('../../config/game-projects/beacon-relay.json',import.meta.url)));
const head='a'.repeat(40),repo='mfackrell/katie';
const pr={state:'open',base:{ref:'main',repo:{full_name:repo,owner:{login:'mfackrell'}}},head:{sha:head,ref:'game-repair/beacon-relay/test',repo:{full_name:repo}}};
const owner={user:{login:'mfackrell'},body:'/katie-game-repair enable beacon-relay'};
const summary=(commit=head,status='completed',findings=true)=>({user:{id:REVIEWER_ID},updated_at:'2026-10-19T15:00:00Z',body:'<!-- codex-review-state:v1 '+JSON.stringify({code_review:{commit_sha:commit,status,has_any_findings:findings,has_unresolved_findings:findings}})+' -->'});
const finding={user:{id:REVIEWER_ID},commit_id:head,id:33,path:config.allowedPaths[0],line:3,body:'Fix victory threshold. <!-- codex-code-review-finding:v1 -->'};
function input(patch={}){return{repo,pr,config,comments:[owner,summary()],reviewComments:[finding],attempts:0,...patch};}
test('trusted completed current-head finding starts one scoped repair',()=>assert.deepEqual(decide(input()),{status:'repair',head,attempt:1,findings:[{id:33,path:config.allowedPaths[0],line:3,body:finding.body}]}));
test('owner registration is required; ordinary and forged PR comments cannot start coding',()=>{
 assert.equal(decide(input({comments:[summary()]})).status,'disabled');
 assert.equal(decide(input({comments:[{...owner,user:{login:'outsider'}},summary()]})).status,'disabled');
 assert.equal(decide(input({comments:[owner,{...summary(),user:{id:123}}]})).status,'waiting');
});
test('stale, running or absent evidence never starts a repair',()=>{
 for(const comments of [[owner,summary('b'.repeat(40))],[owner,summary(head,'running')],[owner]])assert.equal(decide(input({comments})).status,'waiting');
 assert.equal(decide(input({reviewComments:[{...finding,commit_id:'b'.repeat(40)}]})).status,'waiting');
 assert.equal(decide(input({reviewComments:[]})).status,'waiting');
});
test('clean review and exhausted budget cause no new coding',()=>{
 assert.equal(decide(input({comments:[owner,summary(head,'completed',false)]})).status,'clean');
 assert.equal(decide(input({attempts:2})).status,'exhausted');
});
test('forks, merged PRs and unregistered branches fail closed',()=>{
 for(const other of [{...pr,merged_at:'now'},{...pr,state:'closed'},{...pr,head:{...pr.head,ref:'ordinary-task'}},{...pr,head:{...pr.head,repo:{full_name:'outsider/fork'}}}])assert.throws(()=>decide(input({pr:other})));
});
test('only game source can change; workflows, tests, credentials and empty repairs rejected',()=>{
 assert.doesNotThrow(()=>assertPaths([config.allowedPaths[0]],config));
 for(const paths of [[],['tests/game-development/beacon-relay.test.mjs'],['.github/workflows/autonomous-development.yml'],['.env.local'],[config.allowedPaths[0],'lib/executive/autonomous.ts']])assert.throws(()=>assertPaths(paths,config));
});
test('workflow uses trusted default-branch events and bounded isolated independent stages',()=>{
 const {load}=createRequire(import.meta.url)('js-yaml');
 const workflow=load(readFileSync(new URL('../../.github/workflows/game-review-repair.yml',import.meta.url),'utf8'));
 assert.deepEqual(Object.keys(workflow.on).sort(),['issue_comment','workflow_dispatch']);
 assert.equal(workflow.concurrency['cancel-in-progress'],false);
 assert.equal(workflow.jobs['round-one'].with.round,1);assert.equal(workflow.jobs['round-two'].with.round,2);
 const round=load(readFileSync(new URL('../../.github/workflows/game-repair-round.yml',import.meta.url),'utf8'));
 assert.ok(round.jobs.review.steps.some(s=>s.with?.['permission-profile']===':read-only'));
 assert.ok(round.jobs.repair.steps.some(s=>s.with?.['permission-profile']===':workspace'));
 assert.ok(!JSON.stringify(round).includes('merge_pull_request'));
});

test('trusted preflight rejects protected source changes before an agent can execute them',async t=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {execFileSync,spawnSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'game-preflight-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','test');git('config','user.email','test@example.com');
 mkdirSync(join(root,'app/project-pilots/beacon-relay'),{recursive:true});
 for(const path of config.allowedPaths)writeFileSync(join(root,path),'original');git('add','.');git('commit','-qm','baseline');
 const baselineSha=git('rev-parse','HEAD');const plan=join(root,'..','game-plan-'+Date.now()+'.json');t.after(()=>rmSync(plan,{force:true}));
 writeFileSync(plan,JSON.stringify({config:{...config,baselineSha}}));
 const script=new URL('../../scripts/game-repair/check-source.mjs',import.meta.url).pathname;
 const run=()=>spawnSync(process.execPath,[script,plan],{cwd:root,encoding:'utf8'});
 assert.equal(run().status,0);
 writeFileSync(join(root,config.allowedPaths[0]),'fixed');git('add','.');git('commit','-qm','game change');assert.equal(run().status,0);
 mkdirSync(join(root,'.codex'));writeFileSync(join(root,'.codex/config.toml'),'dangerous');git('add','.');git('commit','-qm','protected change');
 assert.notEqual(run().status,0);
});

test('an owner can revoke repair authorization and stale enable commands cannot override it',()=>{
 const enable={...owner,updated_at:'2026-10-19T15:00:00Z'};
 const disable={...owner,body:'/katie-game-repair disable beacon-relay',updated_at:'2026-10-19T15:01:00Z'};
 assert.equal(ownerEnabled([enable,disable],'mfackrell','beacon-relay'),false);
 assert.equal(decide(input({comments:[enable,disable,summary()]})).status,'disabled');
 assert.equal(ownerEnabled([enable,disable,{...disable,user:{login:'outsider'},body:enable.body,updated_at:'2026-10-19T15:02:00Z'}],'mfackrell','beacon-relay'),false);
});
