import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const contract=JSON.parse(readFileSync('fixtures/documents/phase1-acceptance-contract.json','utf8'));
const ids=new Set(contract.rules.map(x=>x.id));
assert.equal(ids.size,contract.rules.length,'Duplicate acceptance rule');
for(const rule of contract.rules){
  assert.ok(rule.id && rule.measurement && rule.classification && rule.phase1 && rule.phase2);
  assert.equal(rule.phase2,'mandatory_pass','Phase2 must not silently exempt a rule');
}
const pending=contract.rules.filter(x=>x.phase1==='pending_professional');
assert.ok(pending.length>=4,'Do not silently declare all professional-quality gates passed');
console.log('Phase1 objective contracts instrumented:',contract.rules.length-pending.length);
console.log('Phase1 unresolved professional-quality contracts:',pending.map(x=>x.id).join(', '));
console.log('Phase2 release qualification: BLOCKED until all pending rules are proven with real page evidence.');
if(process.argv.includes('--enforce-phase2'))
  throw new Error('Phase2 quality acceptance blocked: '+pending.map(x=>x.id).join(', '));
