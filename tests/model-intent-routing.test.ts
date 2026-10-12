import test from "node:test";
import assert from "node:assert/strict";

import { detectWebSearchSignals, hasDirectWebSearchHint, inferRequestClassification } from "@/lib/router/model-intent";
import type { LlmProvider } from "@/lib/providers/types";

test("pasted diff + repo critique + active repo should not route as web-search", async () => {
  const prompt = `Please audit this repo patch and critique routing decisions:\n--- a/lib/router/model-intent.ts\n+++ b/lib/router/model-intent.ts\n@@ -10,4 +10,8 @@\n+if (hasDirectWebSearchHint(prompt)) return { intent: \"web-search\" };`;
  const result = await inferRequestClassification(prompt, { hasImages: false }, { activeRepoContextAttached: true });
  assert.notEqual(result.intent, "web-search");
});

test("review this patch respects the control-plane code-review classification", async () => {
  // The intended review classification comes from the control plane. Without
  // one, the implementation cue 'routing' currently falls back to code-generation.
  const classifier: LlmProvider = {
    name: "openai",
    async listModels() { return ["gpt-5.6-sol"]; },
    async generate(params) {
      assert.match(params.user, /review this patch for routing bugs in repo files/);
      return { text: JSON.stringify({ intent: "code-review", preferred_provider: null }), model: "gpt-5.6-sol", provider: "openai" };
    },
  };
  const result = await inferRequestClassification("review this patch for routing bugs in repo files", { hasImages: false }, {
    activeRepoContextAttached: true,
    decisionProviders: [{ provider: classifier, modelId: "gpt-5.6-sol" }],
  });
  assert.equal(result.intent, "code-review");
});

test("AI news today routes as web-search", async () => {
  const result = await inferRequestClassification("what happened in AI news today", { hasImages: false });
  assert.equal(result.intent, "web-search");
});

test("URL-only summary uses the current web-search fallback when the classifier is unavailable", async () => {
  const result = await inferRequestClassification("https://example.com summarize this", { hasImages: false });
  assert.equal(detectWebSearchSignals("https://example.com summarize this").urlPresent, true);
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
