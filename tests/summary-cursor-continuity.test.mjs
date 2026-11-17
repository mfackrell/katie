import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const code=readFileSync("lib/memory/summarizer.ts","utf8");
test("ITM source cursor advances only after source-cited Grok factual episodes and retention",()=>{
  assert.ok(code.indexOf("summarizeNewBatch(batch,provider,client,") < code.indexOf("reconcileEpisodePlan(episodes,newSummary,provider,client,"));
  assert.ok(code.indexOf("parseGroundedEpisodes") < code.indexOf('rpc<boolean>("commit_intermediate_memory_checkpoint"'));
  assert.match(code,/parseGroundedEpisodes\(raw,messages\)/);
  assert.match(code,/response\.status !== "completed"/);
  assert.match(code,/client\.post\("\/responses"/);
  assert.match(code,/assembleEpisodePlan\(episodes, keep, newSummary\)/);
  assert.match(code,/getMessages\(chatId\)/);
  assert.match(code,/summarizedThroughMessageId: checkpoint\.id/);
  assert.match(code,/sourceMessageCount: after \+ SUMMARY_BATCH_MESSAGES/);
  assert.match(code,/if \(existing\?\.summarizedThroughMessageId\)/);
});
test("failed source batches preserve the checkpoint and only a later request may use the next provider",()=>{
  assert.match(code,/if \(remaining < SUMMARY_BATCH_MESSAGES\)/);
  assert.match(code,/if \(claim\.data === "blocked"\)/);
  assert.match(code,/Provider attempt already blocked; checking next safe provider/);
  assert.match(code,/SUMMARY_TIMEOUT_MS = 180_000/);
  const chatRoute = readFileSync("app/api/chat/route.ts", "utf8");
  const routeMaxSeconds = Number(chatRoute.match(/export const maxDuration = ([0-9]+);/)?.[1]);
  assert.ok(routeMaxSeconds > 180, "Chat runtime must exceed the entire ITM summarization deadline");
  assert.match(code,/timeoutMs:\(\)=>Math\.max\(1,deadline-Date\.now\(\)\)/);
  assert.match(code,/timeoutCode:"memory_timeout"/);
  assert.doesNotMatch(code,/withinSummaryDeadline/);
  assert.match(code,/processorVersion\(candidate\)/);
  assert.match(code,/return nextProvider \? "deferred" : "blocked"/);
  // SDK-level "Connection error" may wrap a more specific accounting
  // denial. The nested cause must govern whether a fallback is permissible.
  assert.match(code,/const accountingCause=standaloneAccountingCause\(error\)/);
  assert.ok(code.includes('const terminalDenial=(Boolean(accountingCause) || isRequestAbort(error)) && !shouldUseNextProvider(error);'));
  assert.ok(code.includes('if (terminalDenial) {'));
  // A prior v12 terminal *accounting* flag must not block v13 memory
  // infrastructure. Exact dispatch exposure and in-flight claims remain fenced.
  assert.doesNotMatch(code,/if \(inspection\.data\.terminal\) \{/);
  assert.match(code,/if \(inspection\.data\.in_flight\) \{/);
  assert.match(code,/inspection\.data\.anthropic_sent/);
  assert.match(code,/inspection\.data\.grok_sent/);
  assert.match(code,/p_state: "blocked"/);
  assert.ok(code.includes('p_reason: (terminalDenial ? "ITM_TERMINAL:" + diagnostic : diagnostic).slice(0,160)'));
});
