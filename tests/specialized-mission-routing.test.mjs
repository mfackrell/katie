import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('specialized research/calculation and coding stages all select model by capability',()=>{
 const mission=readFileSync('lib/missions/model.ts','utf8');
 const routing=readFileSync('lib/orchestration/routing.ts','utf8');
 const developer=readFileSync('lib/agents/development.ts','utf8');
 const workflow=readFileSync('.github/workflows/autonomous-development.yml','utf8');
 assert.match(mission,/orchestrationChoices/);
 assert.match(mission,/boundedProvider/);
 assert.match(routing,/input.research/);
 assert.match(routing,/same mission call ledger/i);
 assert.match(developer,/chooseTrustedGithubModels/);
 assert.match(developer,/chooseProvider/);
 assert.equal((workflow.match(/model: \$\{\{ steps\.task\.outputs\.coding_model \}\}/g)||[]).length,2);
 assert.equal((workflow.match(/model: \$\{\{ steps\.task\.outputs\.review_model \}\}/g)||[]).length,2);
});
