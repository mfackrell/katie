import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('lib/missions/model.ts','utf8');
test('native tool routing retains capability selection and authorization',()=>{
 assert.match(source,/selectNativeToolModel/);
 assert.match(source,/chooseProvider\(kind/);
 assert.match(source,/providerUnavailable:true/);
 assert.match(source,/reserve_mission_call/);
});

test('protected GitHub coding and independent review receive separate routed models',()=>{
 const workflow=readFileSync('.github/workflows/autonomous-development.yml','utf8');
 const dispatcher=readFileSync('lib/agents/development.ts','utf8');
 const parser=readFileSync('scripts/project-context.mjs','utf8');
 assert.match(dispatcher,/chooseTrustedGithubModels/);
 assert.match(dispatcher,/chooseProvider\(/);
 assert.match(dispatcher,/\.\.\.routed/);
 assert.match(workflow,/coding_model=\$\(jq/);
 assert.match(workflow,/review_model=\$\(jq/);
 assert.equal((workflow.match(/model: \$\{\{ steps\.task\.outputs\.coding_model \}\}/g)||[]).length,2);
 assert.equal((workflow.match(/model: \$\{\{ steps\.task\.outputs\.review_model \}\}/g)||[]).length,2);
 assert.match(parser,/Invalid trusted GitHub model selection/);
});
