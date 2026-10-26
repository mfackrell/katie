import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const maintenance=readFileSync("lib/memory/long-term-maintenance.ts","utf8");
const editor=readFileSync("lib/memory/long-term-editor.ts","utf8");
const migration=readFileSync("supabase/migrations/20261026192000_actor_ltm_maintenance.sql","utf8");
test("semantic consolidation requires independent completeness and source checks",()=>{
  assert.match(maintenance,/const proposal = await ask\(system\)/);
  assert.match(maintenance,/const reviewResponse = await client\.chat\.completions\.create/);
  assert.match(maintenance,/verdicts\[0\]\.supported !== true/);
  assert.match(maintenance,/verdicts\[0\]\.complete !== true/);
  assert.match(maintenance,/verdicts\[0\]\.sameSubject !== true/);
  assert.match(maintenance,/value:group\.value\.trim\(\)/);
  assert.match(maintenance,/CLEANUP_EVERY_MESSAGES = 30/);
  assert.match(maintenance,/count % CLEANUP_EVERY_MESSAGES !== 0/);
  assert.match(maintenance,/seen\.size !== originals\.length/);
});
test("cleanup is independent from normal automatic memory saving",()=>{
  assert.match(editor,/await mergeActorLongTermMemoryEntries\(actorId, changes\)/);
  assert.doesNotMatch(editor,/maybeMaintainActorMemory/);
  const route=readFileSync("app/api/chat/route.ts","utf8");
  assert.match(route,/maybeUpdateLongTermMemory\(actorId, chatId, message\)/);
  assert.match(route,/maybeRunThirtyMessageCleanup\(actorId\)/);
  assert.match(route,/Promise\.allSettled/);
});
test("storage requires revision and content match and keeps reversible history",()=>{
  assert.match(migration,/original\.revision is distinct from p_expected_revision/);
  assert.match(migration,/original\.content is distinct from p_expected_content/);
  assert.match(migration,/previous_content jsonb not null/);
  assert.match(migration,/enable row level security/);
  assert.match(migration,/grant execute on function public\.commit_actor_ltm_maintenance.*service_role/);
});
