import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

test('actual PostgreSQL 16 verifies Mission80 authorized successor after spent Mission79 recovery', {timeout:300000},async()=>{
 const env={...process.env,
  KATIE_TEST_COMPLETION_CONTROLS:'1',KATIE_TEST_AMENDMENT_SUCCESSOR:'1',
  KATIE_TEST_CAPACITY_RENEWAL:'1',KATIE_TEST_LIFECYCLE_AUTHORIZATION:'1',
  KATIE_TEST_ORDINARY_AUTHORITY:'1',KATIE_TEST_PROJECT_ORGANIZATION:'1',
  KATIE_TEST_MISSION79_RETRY:'1',KATIE_TEST_MISSION79_WATCHDOG:'1',
  KATIE_TEST_MISSION80_CONTINUATION:'1'
 };
 delete env.NODE_TEST_CONTEXT;
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--test','tests/blocked-owner-committed-concurrency.test.mjs'],{
   env,stdio:['ignore','pipe','pipe']
  });
  let stdout='',stderr='';
  child.stdout.on('data',b=>stdout+=b);
  child.stderr.on('data',b=>stderr+=b);
  child.on('error',reject);
  child.on('close',code=>resolve({code,stdout,stderr}));
 });
 assert.equal(result.code,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/MISSION80_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION79_WATCHDOG_RACE_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION79_SINGLE_RETRY_NATIVE_PASS/);
});
