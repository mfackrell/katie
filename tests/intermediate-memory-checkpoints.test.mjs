import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const summary=readFileSync("lib/memory/summarizer.ts","utf8");
const route=readFileSync("app/api/chat/route.ts","utf8");
const migration=readFileSync("supabase/migrations/20261102154000_itm_two_stage_batch_claims.sql","utf8");
const originalCheckpoint=readFileSync("supabase/migrations/20261026165000_intermediate_memory_checkpoint.sql","utf8");

test("one-model-stage ITM batches 30 older conversational messages",()=>{
  assert.match(summary,/SUMMARY_BATCH_MESSAGES = 30/);
  assert.match(summary,/remaining < SUMMARY_BATCH_MESSAGES/);
  assert.match(summary,/olderMessages\\.slice\\(after, after \\+ SUMMARY_BATCH_MESSAGES\\)/);
  assert.match(summary,/summarizeNewBatch\\(batch\\)/);
  assert.match(summary,/composeRollingEpisodes\\(summary, newSummary, checkpoint\\.createdAt \\?\\? null\\)/);
  assert.doesNotMatch(summary,/reconcileIntermediateMemory\\(/);
});

test("deterministic rollover retains atomic source-cursor checkpoint",()=>{
  assert.match(summary,/ITM_TARGET_CHARACTERS = 6500/);
  assert.match(summary,/ITM_NEW_EPISODE_MAX_CHARACTERS = 3300/);
  assert.match(summary,/if \\(result\\.length > ITM_TARGET_CHARACTERS\\)/);
  assert.match(summary,/p_expected_cursor: expectedCursor, p_content: payload/);
  assert.match(originalCheckpoint,/pg_advisory_xact_lock/);
  assert.match(originalCheckpoint,/if v_cursor is distinct from p_expected_cursor/);
});
test("server-only batch claim blocks duplicate paid work across requests and preserves source",()=>{
  assert.match(migration,/create table if not exists public\.intermediate_memory_batch_attempts/);
  assert.match(migration,/on conflict do nothing/);
  assert.match(migration,/if v_cursor is distinct from p_expected_cursor then return 'stale'/);
  assert.match(migration,/perform pg_advisory_xact_lock/);
  assert.match(migration,/alter table public\.intermediate_memory_batch_attempts enable row level security/);
  assert.match(migration,/revoke all on public\.intermediate_memory_batch_attempts from public, anon, authenticated/);
  assert.match(migration,/grant execute on function public\.claim_intermediate_memory_batch\([^;]+to service_role/s);
  assert.match(migration,/grant execute on function public\.finish_intermediate_memory_batch\([^;]+to service_role/s);
  assert.match(summary,/p_state: "blocked"/);
});
test("known blocked ITM is reported as degraded, not a success",()=>{
  assert.match(route,/Memory persistence degraded/);
  assert.match(route,/summaryResult\.value === "blocked"/);
});
test("30-exchange STM is preserved; pending older context is recoverable",()=>{
  const assembly=readFileSync("lib/memory/assemble-context.ts","utf8");
  const storage=readFileSync("lib/data/persistence-store.ts","utf8");
  const admin=readFileSync("lib/data/supabase/admin.ts","utf8");
  assert.match(assembly,/getPendingIntermediateContext\(chatId, cutoff, stmHistory\[0\]\.createdAt, 120\)/);
  assert.match(assembly,/const joinedHistory = \[\.\.\.pendingHistory, \.\.\.stmHistory\]/);
  assert.match(assembly,/const history = uniqueMessagesById\(joinedHistory\)/);
  assert.match(admin,/url\.searchParams\.append\(filter\.field,/);
  assert.match(assembly,/INTERMEDIATE MEMORY COVERAGE DEGRADED/);
  assert.match(storage,/export async function getPendingIntermediateContext/);
  assert.match(storage,/\.lt\("created_at", beforeCreatedAt\)/);
  assert.match(storage,/query\.gt\("created_at", afterCreatedAt\)/);
  assert.match(admin,/gt\(field: string, value: unknown\)/);
});



test("v6 eliminates full-memory model rewrite and retains fail-closed batch claims",()=>{
  assert.match(summary,/ITM_PROCESSOR_VERSION = "single-stage-30-messages-v6-deterministic-rollover"/);
  assert.match(summary,/SUMMARY_MAX_TOKENS = 2300/);
  assert.match(summary,/max_tokens: SUMMARY_MAX_TOKENS/);
  assert.equal((summary.match(/client\\.post</g)||[]).length,1);
  assert.match(summary,/p_processor_version: ITM_PROCESSOR_VERSION/);
  assert.match(summary,/p_state: "blocked"/);
  assert.match(summary,/return result/);
});

test("older summaries are rolled forward by local code without enlarging the memory",()=>{
  assert.match(summary,/previousEpisodes\\(priorSummary: string\\)/);
  assert.match(summary,/clipCompleteThought\\(newSummary, ITM_NEW_EPISODE_MAX_CHARACTERS\\)/);
  assert.match(summary,/result\\.length > ITM_TARGET_CHARACTERS/);
  assert.match(summary,/sourceMessageCount: after \\+ SUMMARY_BATCH_MESSAGES/);
});
