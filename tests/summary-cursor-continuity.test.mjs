import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const code=readFileSync("lib/memory/summarizer.ts","utf8");
test("intermediate source cursor advances only after source summarization and deterministic compaction",()=>{
  assert.ok(code.indexOf("summarizeNewBatch(batch)") < code.indexOf("composeRollingEpisodes(summary, newSummary, checkpoint.createdAt ?? null)"));
  assert.ok(code.indexOf("composeRollingEpisodes(summary, newSummary, checkpoint.createdAt ?? null)") <
            code.indexOf('rpc<boolean>("commit_intermediate_memory_checkpoint"'));
  assert.match(code,/if \(response\.stop_reason !== "end_turn" \|\| !text \|\| text\.length > maxCharacters\)/);
  assert.match(code,/summarizedThroughMessageId: checkpoint\.id/);
  assert.match(code,/sourceMessageCount: after \+ SUMMARY_BATCH_MESSAGES/);
  assert.match(code,/if \(existing\?\.summarizedThroughMessageId\)/);
});
test("failed or insufficient source batches preserve stored checkpoint without paid retry",()=>{
  assert.match(code,/if \(remaining < SUMMARY_BATCH_MESSAGES\)/);
  assert.match(code,/if \(claim\.data === "blocked"\)/);
  assert.match(code,/Previously failed batch blocked without another provider call/);
  assert.match(code,/if \(isStandaloneAccountingError\(error\)\) throw error/);
});
