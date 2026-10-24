import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const cwd=process.cwd();
test('fixture flag cannot run arbitrary command or access inherited secrets',()=>{
 const folder=mkdtempSync(join(tmpdir(),'benchmark-guard-'));
 try{
  const conf={baselineSha:'a'.repeat(40),capTokens:100,nonBillableFixture:true,
   capabilities:{direct:{isolatedBranchCheckout:true,serverSideTokenCap:true,providerUsageReceipt:true,immutableAcceptance:true,ownerApprovalVerifier:true},
   orchestrated:{isolatedProject:true,isolatedBranchCheckout:true,serverSideTokenCap:true,providerUsageReceipt:true,immutableAcceptance:true,ownerApprovalVerifier:true}},
   arms:[{id:'direct',branch:'benchmark/take-eleven-direct',command:'node',args:['-e','process.exit(0)']},
         {id:'orchestrated',branch:'benchmark/take-eleven-orchestrated',command:'node',args:['-e','process.exit(0)']}]};
  const path=join(folder,'config.json');writeFileSync(path,JSON.stringify(conf));
  const r=spawnSync(process.execPath,['scripts/benchmark/take-eleven-runner.mjs','--config',path],{cwd,encoding:'utf8',env:{...process.env,OPENAI_API_KEY:'must-not-leak'}});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/Untrusted non-billable fixture command/);
 }finally{rmSync(folder,{recursive:true,force:true})}
});
