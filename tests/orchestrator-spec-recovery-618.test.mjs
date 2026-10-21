import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const root=new URL('../',import.meta.url);
const read=(file)=>readFileSync(new URL(file,root),'utf8');

test('specification recovery does not demand development scope approval',()=>{
 const worker=read('lib/recovery/worker.ts');
 assert.match(worker,/e\.project\.phase==='development'&&\(/);
 assert.match(worker,/new Date\(e\.project\.deadline\)\.getTime\(\)<=Date\.now\(\)/);
});

test('incomplete inference attempts can use a different eligible provider',()=>{
 const model=read('lib/missions/model.ts');
 assert.match(model,/error\.partial\.responseStatus==='incomplete'/);
 assert.match(model,/error\.partial\.incompleteReason==='max_output_tokens'/);
 assert.match(model,/failedProviders\.has\(choice\.provider\.name\)/);
});

test('game specification carries original user words to compose and draft-blind review',()=>{
 const worker=read('lib/projects/worker.ts');
 const review=read('lib/missions/worker.ts');
 assert.match(worker,/boundedGameSpecification\(detailed:string,original:string,game:boolean\)/);
 assert.match(worker,/if\(detailed\.length<=12000\)return detailed/);
 assert.match(worker,/const compact=\x60\$\{original\}/);
 assert.match(worker,/objective = boundedGameSpecification/);
 assert.match(worker,/await finish\('child', \{ kind: p\.phase, objective, evidence: projectEvidence \}\)/);
 assert.match(review,/text:mission\.objective/);
 assert.doesNotMatch(worker,/sourceForMission/);
 assert.match(worker,/originalUserOutcome:source/);
 assert.match(review,/const sourceForReview=typeof authoritativeBrief==='string'/);
 assert.match(review,/text:sourceForReview/);
 assert.match(review,/originalUserOutcome:e\.originalUserOutcome/);
});

test('both guarded recovery RPCs have active supervisor callers',()=>{
 const worker=read('lib/projects/worker.ts');
 assert.match(worker,/resume_incomplete_game_review',authorized/);
 assert.match(worker,/resume_oversized_game_specification',authorized/);
 for(const file of ['20261021121500_incomplete_game_review_recovery.sql','20261021121600_resume_oversized_game_specification.sql']){
  const sql=read('supabase/migrations/'+file);
  assert.match(sql,/actor_id=p_actor and chat_id=p_chat/);
  assert.match(sql,/token_allowance-charged/);
  assert.match(sql,/revoke all on function public\./);
  assert.match(sql,/to service_role/);
 }
});

test('review recovery checks two real call slots and adequate uncommitted budget',()=>{
 const sql=read('supabase/migrations/20261021121500_incomplete_game_review_recovery.sql');
 assert.match(sql,/m\.max_calls-m\.calls<2/);
 assert.match(sql,/m\.token_allowance-greatest\(m\.actual_tokens,m\.reserved_tokens\)<20000/);
 assert.match(sql,/savedCandidateUnchanged/);
 assert.doesNotMatch(sql,/set attempts\s*=|set reserved_tokens\s*=|set token_allowance\s*=|set approved_hash\s*=/i);
});

test('real PostgreSQL fixture exercises both recovery RPCs and browser role denials',()=>{
 const testSource=read('tests/projects-sql.test.mjs');
 const sql=read('tests/fixtures/game-orchestrator-recovery-618.sql');
 assert.match(testSource,/game-orchestrator-recovery-618\.sql/);
 assert.match(sql,/claim_mission_work\(\)/);
 assert.match(sql,/claim_work_project\(\)/);
 assert.match(sql,/review_wrong_actor/);
 assert.match(sql,/oversized_wrong_chat/);
 assert.match(sql,/has_function_privilege\('anon'/);
});
