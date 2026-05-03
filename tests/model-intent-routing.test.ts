import test from "node:test";
import assert from "node:assert/strict";

import { detectWebSearchSignals, hasDirectWebSearchHint, inferRequestClassification } from "@/lib/router/model-intent";

test("pasted diff + repo critique + active repo should not route as web-search", async () => {
  const prompt = `Please audit this repo patch and critique routing decisions:\n--- a/lib/router/model-intent.ts\n+++ b/lib/router/model-intent.ts\n@@ -10,4 +10,8 @@\n+if (hasDirectWebSearchHint(prompt)) return { intent: \"web-search\" };`;
  const result = await inferRequestClassification(prompt, { hasImages: false }, { activeRepoContextAttached: true });
  assert.notEqual(result.intent, "web-search");
});

test("review this patch routes as architecture-review or code-review", async () => {
  const result = await inferRequestClassification("review this patch for routing bugs in repo files", { hasImages: false }, { activeRepoContextAttached: true });
  assert.ok(["architecture-review", "code-review"].includes(result.intent));
});

test("AI news today routes as web-search", async () => {
  const result = await inferRequestClassification("what happened in AI news today", { hasImages: false });
  assert.equal(result.intent, "web-search");
});

test("URL-only summary request can route as web-search", async () => {
  const result = await inferRequestClassification("https://example.com summarize this", { hasImages: false });
  assert.equal(result.intent, "web-search");
});

test("video/url/model/log/diff hints alone should not force web-search in active repo code review context", async () => {
  const prompt = `watch this mp4 route bug\nmodel: gpt-5\nlog: stacktrace...\n--- a/a.ts\n+++ b/a.ts`;
  const result = await inferRequestClassification(prompt, { hasImages: false }, { activeRepoContextAttached: true });
  assert.notEqual(result.intent, "web-search");
});

test("detectWebSearchSignals respects explicit no-browse overrides", () => {
  const signals = detectWebSearchSignals("Review this architecture: do not browse. source_url is an audit field.");
  assert.equal(signals.urlPresent, false);
  assert.equal(signals.keywordMatch, false);
  assert.equal(signals.noSearchExplicit, true);
  assert.equal(signals.confidence, "low");
  assert.equal(signals.detected, false);
});

test("detectWebSearchSignals does not treat video hints as web-search cues", () => {
  const signals = detectWebSearchSignals("Debug this route: youtube watcher url param returns 404");
  assert.equal(signals.urlPresent, false);
  assert.equal(signals.keywordMatch, false);
  assert.equal(signals.detected, false);
  assert.equal(hasDirectWebSearchHint("Debug this route: youtube watcher url param returns 404"), false);
});
