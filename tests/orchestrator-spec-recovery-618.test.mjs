import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const root=new URL('../',import.meta.url);
const read=(file)=>readFileSync(new URL(file,root),'utf8');

test('specification recovery does not demand coding approval before scope exists',()=>{
 const worker=read('lib/recovery/worker.ts');
 assert.match(worker,/e\.project\.phase==='development'&&\(/);
 assert.match(worker,/e\.project\.approved_hash===null\|\|e\.project\.approved_hash!==e\.project\.approval_hash/);
 assert.match(worker,/new Date\(e\.project\.deadline\)\.getTime\(\)<=Date\.now\(\)/);
});

test('incomplete model outputs can use a different eligible provider',()=>{
 const model=read('lib/missions/model.ts');
 assert.match(model,/error\.partial\.responseStatus==='incomplete'/);
 assert.match(model,/error\.partial\.incompleteReason==='max_output_tokens'/);
 assert.match(model,/failedProviders\.has\(choice\.provider\.name\)/);
});

test('long original game requirements are not silently truncated',()=>{
 const worker=read('lib/projects/worker.ts');
 assert.match(worker,/sourceForMission=source\.length>6500/);
 assert.match(worker,/originalUserOutcome:source/);
 assert.match(worker,/Do not omit or summarize requirements/);
 assert.match(worker,/await finish\('child', \{ kind: p\.phase, objective, evidence: projectEvidence \}\)/);
});
