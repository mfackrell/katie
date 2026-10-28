import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("lib/memory/summarizer.ts", "utf8");
const migration = readFileSync("supabase/migrations/20261026165000_intermediate_memory_checkpoint.sql", "utf8");

test("intermediate memory has sufficient response budget and bounded batches", () => {
  assert.match(source, /SUMMARY_MAX_TOKENS = 2500/);\n  assert.match(source, /ITM_TARGET_MIN_TOKENS = 1500/);\n  assert.match(source, /ITM_MAX_TOKENS = 2500/);
  assert.match(source, /max_tokens: SUMMARY_MAX_TOKENS/);\n  assert.doesNotMatch(source, /thinking: \{ type: "between_tools" \}/);\n  assert.match(source, /response\.stop_reason !== "end_turn" \|\| !summary/);
  assert.match(source, /SUMMARY_BATCH_MESSAGES = 20/);
  assert.match(source, /offset < SUMMARY_BATCH_MESSAGES \* 3/);
});
test("incomplete summaries do not commit, and retry with smaller batch", () => {
  assert.match(source, /response\.stop_reason !== "end_turn" \|\| !summary/);
  assert.match(source, /size = Math.min\(10, size\)/);
  assert.ok(source.indexOf("candidate = await summarizeInto") < source.indexOf('rpc("commit_intermediate_memory_checkpoint"'));
});
test("checkpoints use an atomic and actor-scoped cursor comparison", () => {
  assert.match(source, /p_expected_cursor: expectedCursor/);
  assert.match(source, /if \(committed !== true\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /if v_cursor is distinct from p_expected_cursor/);
  assert.match(migration, /where actor_id = p_actor_id and chat_id = p_chat_id/);
  assert.match(migration, /grant execute .* to service_role/);
});
test("memory retains its 30-exchange STM boundary and source cursor", () => {
  assert.match(source, /conversationalMessages\.slice\(0, conversationalMessages\.length - SHORT_TERM_MESSAGE_LIMIT\)/);
  assert.match(source, /summarizedThroughMessageId: checkpoint\.id/);
  assert.match(source, /summarizedThroughCreatedAt: checkpoint\.createdAt/);
});
