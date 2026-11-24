import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
test('native PostgreSQL 16: actual direct delivery chain appoints, scopes and commissions one package',{timeout:300000},async()=>{
 const env={...process.env,KATIE_TEST_COMPLETION_CONTROLS:'1',KATIE_TEST_AMENDMENT_SUCCESSOR:'1',
  KATIE_TEST_CAPACITY_RENEWAL:'1',KATIE_TEST_LIFECYCLE_AUTHORIZATION:'1',KATIE_TEST_ORDINARY_AUTHORITY:'1',
  KATIE_TEST_PROJECT_ORGANIZATION:'1',KATIE_TEST_CODING_COMMISSIONING:'1',KATIE_TEST_DIRECTOR_ONE_SHOT:'1',KATIE_TEST_ORG_AMENDMENTS:'1',KATIE_TEST_BLOCKED_OWNER_RACE_FIXTURE:'0'};
 delete env.NODE_TEST_CONTEXT;
 const result=await new Promise((resolve,reject)=>{
  const c=spawn(process.execPath,['--test','tests/benchmark-renewal-postgres.test.mjs'],{env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);c.on('error',reject);c.on('close',code=>resolve({code,stdout,stderr}));
 });
 assert.equal(result.code,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/CODING_CHAIN_BEFORE_PASS/);assert.match(result.stdout,/CODING_CHAIN_NATIVE_PASS/);
 console.log(result.stdout.split('\n').filter(l=>l.includes('CODING_CHAIN_')).join('\n'));
});
