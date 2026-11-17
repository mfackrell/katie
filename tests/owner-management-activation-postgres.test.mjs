import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('mobile owner recovery uses the actual API and native PostgreSQL without live activation',{timeout:240000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'owner-activation-clock-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const library=join(root,'test-clock.so');
 const compile=spawnSync('cc',['-shared','-fPIC','-o',library,'tests/helpers/owner-activation-test-clock.c','-ldl'],{encoding:'utf8'});
 assert.equal(compile.status,0,compile.stderr);
 // Native PostgreSQL, Node and Chromium share the same test-only wall clock.
 // This preserves every installed function body and makes later QA reproducible.
 const offset=(BigInt(Date.parse('2026-11-16T13:00:00Z'))-BigInt(Date.now()))*1000000n;
 const env={...process.env,KATIE_TEST_OWNER_ACTIVATION:'1',LD_PRELOAD:library,KATIE_TEST_REALTIME_OFFSET_NS:String(offset)};delete env.NODE_TEST_CONTEXT;
 const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--test','tests/organizational-contract-amendments-postgres.test.mjs'],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',code=>resolve({code,output}));});
 assert.equal(result.code,0,result.output);assert.match(result.output,/OWNER_MANAGEMENT_BROWSER_POSTGRES_PASS/);
 console.log(result.output.split('\n').filter(line=>/OWNER_MANAGEMENT_BROWSER_POSTGRES_PASS|OWNER_RECOVERY_INSTALLED_DEFINITIONS_PASS|PAUSED_WINDOW_RENEWAL_POSTGRES_PASS/.test(line)).join('\n'));
});
