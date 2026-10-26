import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const maintenance=readFileSync("lib/memory/long-term-maintenance.ts","utf8");
const editor=readFileSync("lib/memory/long-term-editor.ts","utf8");
const migration=readFileSync("supabase/migrations/20261026192000_actor_ltm_maintenance.sql","utf8");
test("consolidation is gated by two independent decisions and exact value equivalence",()=>{
  assert.match(maintenance,/const proposal = await ask\(system\)/);
  assert.match(maintenance,/const independent = await ask\(/);
  assert.match(maintenance,/JSON\.stringify\(approved\.entries\) !== JSON\.stringify\(confirmed\.entries\)/);
  assert.match(maintenance,/byKey\.get\(k\)!\.value === selected\.value/);
  assert.match(maintenance,/seen\.size !== originals\.length/);
});
test("existing LTM updates trigger maintenance only after verified automatic merge",()=>{
  assert.match(editor,/await mergeActorLongTermMemoryEntries\(actorId, changes\);\s*await maybeMaintainActorMemory\(actorId, client\)/);
});
test("storage requires revision and content match and keeps reversible history",()=>{
  assert.match(migration,/original\.revision is distinct from p_expected_revision/);
  assert.match(migration,/original\.content is distinct from p_expected_content/);
  assert.match(migration,/previous_content jsonb not null/);
  assert.match(migration,/enable row level security/);
  assert.match(migration,/grant execute on function public\.commit_actor_ltm_maintenance.*service_role/);
});
