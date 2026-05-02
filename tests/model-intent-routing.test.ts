import test from "node:test";
import assert from "node:assert/strict";

import { inferRequestClassification } from "@/lib/router/model-intent";

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
