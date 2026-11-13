import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
test('owner execution windows and parent delegation amendments preserve the live organization in PostgreSQL',{timeout:180000},async()=>{
 const env={...process.env,KATIE_TEST_COMPLETION_CONTROLS:'1',KATIE_TEST_AMENDMENT_SUCCESSOR:'1',KATIE_TEST_CAPACITY_RENEWAL:'1',KATIE_TEST_LIFECYCLE_AUTHORIZATION:'1',KATIE_TEST_ORDINARY_AUTHORITY:'1',KATIE_TEST_PROJECT_ORGANIZATION:'1',KATIE_TEST_DIRECTOR_ONE_SHOT:'1',KATIE_TEST_ORG_AMENDMENTS:'1'};
 delete env.NODE_TEST_CONTEXT;
 const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--test','tests/benchmark-renewal-postgres.test.mjs'],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',code=>resolve({code,output}));});
 assert.equal(result.code,0,result.output);
 assert.match(result.output,/ORGANIZATIONAL_CONTRACT_AMENDMENTS_POSTGRES_PASS/);
 assert.match(result.output,/PROJECT_HIERARCHY_RECOVERY_POSTGRES_PASS/);
});
