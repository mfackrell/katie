import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const src = readFileSync("lib/memory/long-term-editor.ts","utf8");
test("automatic memory evidence is derived from actual cited user messages", () => {
  assert.match(src, /userById\.get\(messageId\)!\.content\.trim\(\)/);
  assert.match(src, /source\.includes\(provided\)/);
  assert.match(src, /source\.slice\(0, 800\)/);
  assert.match(src, /evidenceIds\.some\(id => !userById\.has\(id\)\)/);
});
test("candidate acceptance still requires independent reviews and verified source", () => {
  assert.match(src, /reviewAutomaticSupport\(client, literal, recentMessages\)/);
  assert.match(src, /const qualified = await reviewMemoryCandidates\(client, sourceAccepted, recentMessages, "qualification"\)/);
  assert.match(src, /await mergeActorLongTermMemoryEntries\(actorId, changes\)/);
});
