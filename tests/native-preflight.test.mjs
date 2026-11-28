import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const workflow=readFileSync('.github/workflows/autonomous-development.yml','utf8');
function step(name){
 const start=workflow.indexOf('      - name: '+name+'\n');
 assert.ok(start>=0,'Missing production workflow step '+name);
 const next=workflow.indexOf('\n      - ',start+1);
 return workflow.slice(start,next<0?workflow.length:next);
}
function shell(name){
 const block=step(name),index=block.indexOf('        run: |\n');
 assert.ok(index>=0,'Missing exact shell block');
 return block.slice(index+'        run: |\n'.length).split('\n').map(l=>l.replace(/^ {10}/,'')).join('\n');
}
const run=(script,env={})=>{
 const r=spawnSync('bash',['-euo','pipefail','-c',script],{encoding:'utf8',env:{...process.env,...env},timeout:240000,maxBuffer:8*1024*1024});
 assert.equal(r.status,0,[r.error?.message,r.stdout,r.stderr].filter(Boolean).join('\n'));
 return r.stdout;
};
test('native build uses the qualified Ubuntu 24.04 runner, keeps sandbox and diagnostic evidence gates',()=>{
 const build=workflow.slice(workflow.indexOf('  build:\n'),workflow.indexOf('\n  test:'));
 assert.match(build,/runs-on: ubuntu-24\.04/);
 assert.doesNotMatch(build,/runs-on: ubuntu-latest/);
 assert.match(step('Install pinned native SDK for benchmark-bound engineering'),/id: native_setup/);
 assert.match(shell('Install pinned native SDK for benchmark-bound engineering'),/@openai\/codex-sdk@0\.164\.0/);
 assert.match(shell('Install pinned native SDK for benchmark-bound engineering'),/\/usr\/lib\/postgresql\/16\/bin\/initdb --version/);
 assert.match(step('Run approved native Developer through trusted gateway'),/id: native_host/);
 const fallback=step('Record native preflight failure diagnostics');
 assert.match(fallback,/steps\.native_host\.outcome == 'skipped'/);
 assert.match(fallback,/steps\.native_setup\.outcome != 'success'/);
 assert.match(step('Preserve bounded native execution diagnostics'),/if-no-files-found: error/);
 assert.match(step('Preserve trusted native review evidence'),/native-metered-review\.json/);
});
test('exact preflight diagnostic shell preserves bounded failure evidence without creating a successful review',()=>{
 const temp=mkdtempSync(join(tmpdir(),'native-preflight-diagnostics-'));
 const file=join(temp,'native-metered-review.json.diagnostics.json');
 try{
  const env={RUNNER_TEMP:temp,GITHUB_RUN_ID:'45853736930',NATIVE_SETUP_OUTCOME:'failure'};
  run(shell('Record native preflight failure diagnostics'),env);
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{version:1,runId:'45853736930',failure:'native_preflight_failure',nativeHostStarted:false,providerUsage:{responses:0,observedTokens:0,unknownUsage:0}});
  assert.equal(existsSync(join(temp,'native-metered-review.json')),false);
  const genuine='{"version":1,"runId":"fixture","providerUsage":{"responses":2}}\n';
  writeFileSync(file,genuine);
  run(shell('Record native preflight failure diagnostics'),env);
  assert.equal(readFileSync(file,'utf8'),genuine,'Never replace real host diagnostics');
  console.log('MISSION111_NATIVE_DIAGNOSTICS_PASS');
 }finally{rmSync(temp,{recursive:true,force:true});}
});
// Installing runner dependencies is a hosted qualification, not an offline
// test. The dedicated workflow executes it explicitly with the opt-in flag.
// Register only offline tests in the strict offline inventory; do not create
// a skipped test or classify an unexecuted host test as a pass.
test('dedicated hosted qualification explicitly runs the real dependency preflight',()=>{
 const qualification=readFileSync('.github/workflows/coding-capacity-recovery-qualification.yml','utf8');
 assert.match(qualification,/      - 'tests\/native-preflight\.test\.mjs'/);
 const start=qualification.indexOf('      - name: Mission111 exact pinned runner setup and failure artifact qualification\n');
 assert.ok(start>=0,'Missing dedicated hosted preflight qualification');
 const next=qualification.indexOf('\n      - ',start+1);
 const block=qualification.slice(start,next<0?qualification.length:next);
 assert.match(block,/KATIE_QUALIFY_NATIVE_PREFLIGHT: '1'/);
 assert.match(block,/run: node --test tests\/native-preflight\.test\.mjs/);
 assert.doesNotMatch(block,/^\s*(if|continue-on-error):/m);
});
if(process.env.KATIE_QUALIFY_NATIVE_PREFLIGHT==='1')test('execute the production dependency preflight on the pinned LTS image without a provider call',{timeout:300000},()=>{
 const os=readFileSync('/etc/os-release','utf8');
 assert.match(os,/VERSION_ID="24\.04"/);
 run(shell('Install pinned native SDK for benchmark-bound engineering'));
 assert.equal(JSON.parse(readFileSync('node_modules/@openai/codex-sdk/package.json','utf8')).version,'0.164.0');
 assert.match(run('/usr/lib/postgresql/16/bin/initdb --version'),/PostgreSQL\) 16\./);
 assert.match(run('/usr/lib/postgresql/16/bin/pg_ctl --version'),/PostgreSQL\) 16\./);
 run('command -v socat >/dev/null; command -v bwrap >/dev/null; bwrap --unshare-user --unshare-net --ro-bind / / -- /bin/true');
 console.log('MISSION111_NATIVE_PREFLIGHT_DEPENDENCIES_PASS');
});
