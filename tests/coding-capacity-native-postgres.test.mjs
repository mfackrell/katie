import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

test('native PostgreSQL16: exhausted original project, one bounded owner authorization and real commissioning chain',{timeout:420000},async()=>{
 const env={...process.env,
  KATIE_TEST_COMPLETION_CONTROLS:'1',KATIE_TEST_AMENDMENT_SUCCESSOR:'1',
  KATIE_TEST_CAPACITY_RENEWAL:'1',KATIE_TEST_LIFECYCLE_AUTHORIZATION:'1',
  KATIE_TEST_ORDINARY_AUTHORITY:'1',KATIE_TEST_PROJECT_ORGANIZATION:'1',
  KATIE_TEST_MISSION79_RETRY:'1',KATIE_TEST_MISSION79_WATCHDOG:'1',
  KATIE_TEST_MISSION80_CONTINUATION:'1',KATIE_TEST_MISSION80_WATCHDOG:'1',
  KATIE_TEST_MISSION82_INDEPENDENT:'1',KATIE_TEST_ORIGINAL_BOUNDED_RECOVERY:'1',
  KATIE_TEST_CONTEXT_90_RETEST:'1',
  KATIE_TEST_FOLLOWUP_M95:'1',KATIE_TEST_CODING_CAPACITY:'1',KATIE_TEST_SINGLE_PACKAGE_CONTINUATION:'1',TZ:'UTC',PGTZ:'UTC'
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
 assert.match(result.stdout,/SINGLE_PACKAGE_CONSUMED_LIFECYCLE_NATIVE_PASS/);
 assert.match(result.stdout,/SINGLE_PACKAGE_ACTUAL_FINAL_ASSESSMENT_NATIVE_PASS/);
 console.log('SINGLE_PACKAGE_CONSUMED_LIFECYCLE_NATIVE_PASS');
 console.log('SINGLE_PACKAGE_ACTUAL_FINAL_ASSESSMENT_NATIVE_PASS');
 assert.match(result.stdout,/ORIGINAL_84_BOUNDED_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION_CONTEXT90_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION95_ONE_FOLLOWUP_NATIVE_PASS/);
 assert.match(result.stdout,/CODING_CAPACITY_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION98_EXHAUSTIVE_TARGET_REPRODUCTION_PASS/);
 assert.match(result.stdout,/MISSION98_RESUME_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION99_IDENTITY_REGRESSION_PASS/);
 assert.match(result.stdout,/MISSION99_RESUME_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION102_ROLE_REGRESSION_PASS/);
 assert.match(result.stdout,/MISSION102_FINAL_PACKAGE_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION103_SMART_BOUNDARY_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION103_SMART_RESUME_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION104_PACKAGE_EXECUTION_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION105_NATIVE_CLAIM_ALIAS_PASS/);
 assert.match(result.stdout,/MISSION105_CORRECTED_RELEASE_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION106_STANDING_CORRECTIVE_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION108_SIGNED_CODING_ADMISSION_NATIVE_PASS/);
 assert.match(result.stdout,/MISSION109_UNSPENT_RETRY_NATIVE_PASS/);
 console.log('MISSION109_UNSPENT_RETRY_NATIVE_PASS');
 assert.match(result.stdout,/MISSION109_UNSIGNED_OWNER_CONTROL_HANDOFF_PASS/);
 console.log('MISSION109_UNSIGNED_OWNER_CONTROL_HANDOFF_PASS');
 assert.match(result.stdout,/MISSION111_DIAGNOSED_NATIVE_PREFLIGHT_PASS/);
 console.log('MISSION111_DIAGNOSED_NATIVE_PREFLIGHT_PASS');
 assert.match(result.stdout,/MISSION109_INVALID_RESPONSE_RETRY_NATIVE_PASS/);
 console.log('MISSION109_INVALID_RESPONSE_RETRY_NATIVE_PASS');
 assert.match(result.stdout,/MISSION109_DURABLE_COMPLETION_NATIVE_PASS/);
 console.log('MISSION109_DURABLE_COMPLETION_NATIVE_PASS');
 console.log('MISSION108_SIGNED_CODING_ADMISSION_NATIVE_PASS');
 console.log('MISSION106_STANDING_CORRECTIVE_NATIVE_PASS');
 console.log('MISSION105_CORRECTED_RELEASE_NATIVE_PASS');
 console.log('MISSION105_NATIVE_CLAIM_ALIAS_PASS');
 console.log(result.stdout.split('\n').filter(l=>l.includes('MISSION104_PACKAGE_EXECUTION_NATIVE_PASS')).join('\n'));
 console.log(result.stdout.split('\n').filter(l=>/MISSION103_SMART_(BOUNDARY|RESUME)_NATIVE_PASS/.test(l)).join('\n'));
 console.log(result.stdout.split('\n').filter(l=>/MISSION102_(ROLE_REGRESSION|FINAL_PACKAGE_NATIVE)_PASS/.test(l)).join('\n'));
 console.log(result.stdout.split('\n').filter(l=>/MISSION99_(IDENTITY_REGRESSION|RESUME_NATIVE)_PASS/.test(l)).join('\n'));
 console.log(result.stdout.split('\n').filter(l=>l.includes('MISSION98_RESUME_NATIVE_PASS')).join('\n'));
 console.log(result.stdout.split('\n').filter(l=>l.includes('MISSION98_EXHAUSTIVE_TARGET_REPRODUCTION_PASS')).join('\n'));
 console.log(result.stdout.split('\n').filter(l=>l.includes('CODING_CAPACITY_NATIVE_PASS')).join('\n'));
});
