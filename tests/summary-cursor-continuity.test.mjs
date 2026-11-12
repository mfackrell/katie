import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const code=readFileSync("lib/memory/summarizer.ts","utf8");
test("ITM source cursor advances only after source-cited Grok factual episodes and retention",()=>{
  assert.ok(code.indexOf("summarizeNewBatch(batch,provider!,signal)") < code.indexOf("reconcileEpisodePlan(episodes, newSummary,provider!,signal)"));
  assert.ok(code.indexOf("parseGroundedEpisodes") < code.indexOf('rpc<boolean>("commit_intermediate_memory_checkpoint"'));
  assert.match(code,/parseGroundedEpisodes\(completedResponsesText\(response, "factual episodes"/);
  assert.match(code,/response\.status !== "completed"/);
  assert.match(code,/grokClient\.post<GrokResponsesResponse>\("\/responses"/);
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
  assert.match(code,/SUMMARY_TIMEOUT_MS = 90_000/);
  assert.match(code,/processorVersion\(candidate\)/);
  assert.match(code,/return nextProvider \? "deferred" : "blocked"/);
  assert.match(code,/if \(isStandaloneAccountingError\(error\) && !shouldUseNextProvider\(error\)\) throw error/);
});
