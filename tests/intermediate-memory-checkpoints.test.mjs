import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const summary=readFileSync("lib/memory/summarizer.ts","utf8");
const route=readFileSync("app/api/chat/route.ts","utf8");
const migration=readFileSync("supabase/migrations/20261102154000_itm_two_stage_batch_claims.sql","utf8");
const originalCheckpoint=readFileSync("supabase/migrations/20261026165000_intermediate_memory_checkpoint.sql","utf8");

test("two bounded model stages process 30 older conversational messages",()=>{
  assert.match(summary,/SUMMARY_BATCH_MESSAGES = 30/);
  assert.match(summary,/remaining < SUMMARY_BATCH_MESSAGES/);
  assert.match(summary,/olderMessages\.slice\(after, after \+ SUMMARY_BATCH_MESSAGES\)/);
  assert.match(summary,/summarizeNewBatch\(batch\)/);
  assert.match(summary,/reconcileEpisodePlan\(episodes, newSummary\)/);
  assert.match(summary,/assembleEpisodePlan\(episodes, keep, newSummary\)/);
  assert.doesNotMatch(summary,/reconcileIntermediateMemory\(/);
});

test("factual source excerpts retain atomic source-cursor checkpoint",()=>{
  assert.match(summary,/ITM_TARGET_CHARACTERS = 6500/);
  assert.match(summary,/RECONCILE_MAX_TOKENS = 2800/);
  assert.match(summary,/if \(output\.length > ITM_TARGET_CHARACTERS\)/);
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



test("v8 uses Grok source excerpts and bounded index-only retention",()=>{
  assert.match(summary,/ITM_PROCESSOR_VERSION = "two-stage-30-messages-v8-grok-factual-extracts"/);
  assert.match(summary,/SUMMARY_MAX_TOKENS = 2300/);
  assert.match(summary,/RECONCILE_MAX_TOKENS = 2800/);
  assert.equal((summary.match(/client\.chat\.completions\.create\(/g)||[]).length,2);
  assert.match(summary,/parseRetentionPlan\(completedText\(response, "retention plan"/);
  assert.match(summary,/p_processor_version: ITM_PROCESSOR_VERSION/);
  assert.match(summary,/p_state: "blocked"/);
  assert.match(summary,/reconcileEpisodePlan\(episodes, newSummary\)/);
  assert.match(summary,/assembleEpisodePlan\(episodes, keep, newSummary\)/);
  assert.match(summary,/sourceMessageCount: after \+ SUMMARY_BATCH_MESSAGES/);
  assert.match(summary,/parseGroundedExcerpts\(completedText\(response, "quote selection"/);
  assert.match(summary,/!message\.content\.includes\(quote\)/);
  assert.match(summary,/createActivityAccountingFetch\("grok", "memory-summary"\)/);
  assert.doesNotMatch(summary,/api\.anthropic\.com|CLAUDE_API_KEY/);
});
