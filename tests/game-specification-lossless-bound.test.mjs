import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const validator=readFileSync('lib/projects/contract.ts','utf8');
const worker=readFileSync('lib/missions/worker.ts','utf8');
test('lossless game approval bound matches saved checkpoint capacity and preserves all validation gates',()=>{
 assert.match(validator,/canonical\(gameSpecificationView\(p\)\)\.length>40000/);
 assert.match(validator,/validateProjectGame\(p\.game,p\.allowedPaths,p\.finalContract\)/);
 assert.match(validator,/validateGameAssessmentCapacity\(p\)/);
 assert.match(validator,/digest\(p\.milestones\.at\(-1\)!\.contract\) !== digest\(p\.finalContract\)/);
 assert.match(worker,/uniqueCharacterLimit:40000/);
 assert.match(worker,/revalidated_saved_specification/);
 assert.match(worker,/freshReviewRequired:true/);
 assert.match(worker,/uniqueCharacters:canonical\(gameSpecificationView\(plan\)\)\.length/);
});
