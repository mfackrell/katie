import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('Independent committed-schema two-connection competition of actual owner RPCs', {timeout:420000}, () => {
 const child=spawnSync(process.execPath,['tests/benchmark-renewal-postgres.test.mjs'],{
  cwd:process.cwd(),encoding:'utf8',timeout:360000,maxBuffer:20*1024*1024,
  env:{...process.env,KATIE_QA_COMMITTED_RACE:'1'}
 });
 console.log(child.stdout?.slice(-12000)??'');
 if(child.stderr)console.log(child.stderr.slice(-6000));
 assert.equal(child.error,undefined,String(child.error));
 assert.equal(child.status,0,'Committed-schema nested fixture must complete without error');
 assert.match(child.stdout,/INDEPENDENT_QA_COMMITTED_TWO_RPC_RACE_PASS/,
  'PASS marker must come from actual two-connection RPC assertions, not advisory-lock proxy');
});
