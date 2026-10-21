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


test('durable review recovery keeps original attempt counts and budgets',()=>{
 const sql=read('supabase/migrations/20261021121500_incomplete_game_review_recovery.sql');
 assert.match(sql,/p\.actor_id|actor_id=p_actor/);
 assert.match(sql,/p\.chat_id|chat_id=p_chat/);
 assert.match(sql,/m\.deadline<=now\(\)\+interval '5 minutes'/);
 assert.match(sql,/p\.token_allowance-charged<10000/);
 assert.match(sql,/j\.status='failed'|status='failed'/);
 assert.match(sql,/savedCandidateUnchanged/);
 assert.doesNotMatch(sql,/set attempts\s*=|set reserved_tokens\s*=|set token_allowance\s*=|set approved_hash\s*=/i);
});

test('oversized game recovery requires completed research and a current budget',()=>{
 const sql=read('supabase/migrations/20261021121600_resume_oversized_game_specification.sql');
 assert.match(sql,/m\.status='completed'/);
 assert.match(sql,/r\.kind='research'/);
 assert.match(sql,/p\.token_allowance-charged<30000/);
 assert.match(sql,/p\.approved_hash is not null/);
 assert.match(sql,/oversized_game_specification_resumed/);
});
