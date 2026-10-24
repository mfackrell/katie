import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const runner='scripts/benchmark/take-eleven-runner.mjs';
const all={isolatedBranchCheckout:true,serverSideTokenCap:true,providerUsageReceipt:true,immutableAcceptance:true,isolatedProject:true};
const config={baselineSha:'a'.repeat(40),capTokens:100,capabilities:{direct:all,orchestrated:all},arms:[{id:'direct',branch:'benchmark/take-eleven-direct',command:'node',args:[]},{id:'orchestrated',branch:'benchmark/take-eleven-orchestrated',command:'node',args:[]}]};
function attempt(extra={},env={}) {const dir=mkdtempSync(join(tmpdir(),'katie-benchmark-'));try { const path=join(dir,'config.json');writeFileSync(path,JSON.stringify({...config,...extra}));return spawnSync(process.execPath,[runner,'--config',path,'--out',join(dir,'out')],{encoding:'utf8',env:{...process.env,...env}})}finally{rmSync(dir,{recursive:true,force:true})}}
test('config capability claims cannot authorize paid execution',()=>{const result=attempt({}, {BENCHMARK_ENABLE_PAID:'1'});assert.notEqual(result.status,0);assert.match(result.stderr,/Live benchmark disabled/)});
test('no paid adapters means no real execution even with forged readiness',()=>{const result=attempt();assert.notEqual(result.status,0);assert.match(result.stderr,/non-billable fixture/)});
test('missing readiness never authorizes execution',()=>{const result=attempt({capabilities:{direct:{},orchestrated:{}}});assert.notEqual(result.status,0);assert.match(result.stderr,/not ready/)});
