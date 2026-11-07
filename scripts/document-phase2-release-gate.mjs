import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract=JSON.parse(readFileSync('fixtures/documents/phase1-acceptance-contract.json','utf8'));
const evidence=JSON.parse(readFileSync('fixtures/documents/phase2-acceptance-evidence.json','utf8'));
const required=new Set(contract.rules.map(x=>x.id));
assert.equal(required.size,11,'Phase 1 contract unexpectedly changed');
assert.equal(evidence.acceptance.length,11,'All 11 Phase 2 gates must be reported');
for(const row of evidence.acceptance){
  assert.ok(required.delete(row.id),'Unknown or duplicate acceptance rule '+row.id);
  assert.ok(row.evidence && row.status,'Every gate must include evidence and status');
}
assert.equal(required.size,0,'Missing acceptance contract clauses');
const blocked=evidence.acceptance.filter(x=>x.status!=='passed');
console.log('Phase 2 acceptance matrix:',JSON.stringify(evidence.acceptance));
if(blocked.length) {
  console.error('PHASE 2 FAIL: '+blocked.length+' mandatory gates are unverified: '+
    blocked.map(x=>x.id+' ('+x.status+')').join(', '));
  process.exitCode=1;
}else console.log('All eleven gates have evidence: independent final confirmation still required.');
