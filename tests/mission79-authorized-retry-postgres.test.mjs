import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

test('real PostgreSQL owner authorization preserves first failure and permits exactly one original Mission79 lease', {timeout:300000},async()=>{
 const env={...process.env,
  KATIE_TEST_COMPLETION_CONTROLS:'1',
  KATIE_TEST_AMENDMENT_SUCCESSOR:'1',
  KATIE_TEST_CAPACITY_RENEWAL:'1',
  KATIE_TEST_LIFECYCLE_AUTHORIZATION:'1',
  KATIE_TEST_ORDINARY_AUTHORITY:'1',
  KATIE_TEST_PROJECT_ORGANIZATION:'1',
  KATIE_TEST_MISSION79_RETRY:'1'};
 delete env.NODE_TEST_CONTEXT;
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--test','tests/benchmark-renewal-postgres.test.mjs'],{
   env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',bytes=>stdout+=bytes);
  child.stderr.on('data',bytes=>stderr+=bytes);
  child.on('error',reject);
  child.on('close',code=>resolve({code,stdout,stderr}));
 });
 assert.equal(result.code,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/MISSION79_SINGLE_RETRY_NATIVE_PASS/,
  'Real PostgreSQL original-project fixture must exercise immutable one-time owner receipt and actual claim');
 assert.match(result.stdout,/MISSION79_NEW_OWNER_WINDOW_TWO_CONNECTION_RACE_PASS|MISSION79_NEW_OWNER_WINDOW_TWO_CONNECTION_RACE/,
  'Existing owner concurrency tests must continue to pass');
});
