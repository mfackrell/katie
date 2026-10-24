import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const validator=readFileSync('lib/projects/contract.ts','utf8');
const worker=readFileSync('lib/missions/worker.ts','utf8');
const projectWorker=readFileSync('lib/projects/worker.ts','utf8');
const recoveryBudget=readFileSync('lib/projects/recovery-budget.ts','utf8');
const checkpointMigration=readFileSync('supabase/migrations/20261024103000_enforce_game_recovery_budget_guard.sql','utf8');
// Check executable SQL, excluding comments that can conceal inert conditions.
const executableSQL=checkpointMigration.replace(/--[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
test('lossless game approval bound matches saved checkpoint capacity and preserves all validation gates',()=>{
 assert.match(validator,/canonical\(gameSpecificationView\(p\)\)\.length>40000/);
 assert.match(validator,/validateProjectGame\(p\.game,p\.allowedPaths,p\.finalContract\)/);
 assert.match(validator,/validateGameAssessmentCapacity\(p\)/);
 assert.match(validator,/digest\(p\.milestones\.at\(-1\)!\.contract\) !== digest\(p\.finalContract\)/);
 assert.match(worker,/uniqueCharacterLimit:40000/);
 assert.match(projectWorker,/if\(canonical\(view\)\.length<=40000\)draft=view/);
 assert.doesNotMatch(projectWorker,/if\(canonical\(view\)\.length<=20000\)draft=view/);
 assert.match(recoveryBudget,/\.in\('role',\['revise','compose'\]\)/);
 assert.match(recoveryBudget,/\.order\('created_at',\{ascending:false\}\)/);
 assert.match(worker,/revalidated_saved_specification/);
 assert.match(worker,/freshReviewRequired:true/);
 assert.match(worker,/uniqueCharacters:canonical\(gameSpecificationView\(plan\)\)\.length/);
});

test('autonomous checkpoint recovers newest revision with a project budget fence and fresh independent review',()=>{
 assert.match(checkpointMigration,/j\.role IN \('revise','compose'\)/);
 assert.match(checkpointMigration,/ORDER BY m\.created_at DESC,j\.created_at DESC LIMIT 1/);
 assert.match(executableSQL,/IF\s+run_count\s*>=\s*p\.max_missions\s+OR\s+p\.token_allowance\s*-\s*spent\s*<\s*25000\s+THEN\s+RETURN\s+false\s*;/i);
 assert.match(projectWorker,/\['compose','revise'\]\.includes\(composition\.role\)/);
 assert.match(projectWorker,/status:'unreviewed'/);
});
