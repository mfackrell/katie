import test from "node:test";
import assert from "node:assert/strict";

import { buildIntentClassifierSystemPrompt, type RequestIntent } from "../lib/router/model-intent.ts";

const intents: RequestIntent[] = ["general-text", "assistant-reflection", "code-review", "web-search"];

test("intent classifier runtime context does not expose a proposed routing answer", () => {
  const systemPrompt = buildIntentClassifierSystemPrompt(
    intents,
    true,
    {
      currentProvider: "anthropic",
      currentModel: "claude-sonnet-4.6",
      modelTier: "premium",
      routingIntent: "assistant-reflection",
      routingAuthority: "llm-classifier",
      requestId: "test-req-123"
    },
    { requestId: "test-req-123" }
  );

  assert.ok(systemPrompt.startsWith("KATIE_RUNTIME_CONTEXT:"));
  assert.ok(systemPrompt.includes("- current_provider: anthropic"));
  assert.ok(systemPrompt.includes("- current_model: claude-sonnet-4.6"));
  assert.ok(systemPrompt.includes("- model_tier: premium"));
  assert.ok(systemPrompt.includes("- routing_intent: unknown"));
  assert.ok(systemPrompt.includes("- routing_authority: unknown"));
  assert.equal(systemPrompt.includes('"routingIntent":"assistant-reflection"'), false);
  assert.equal(systemPrompt.includes('"routingAuthority":"llm-classifier"'), false);
  assert.ok(systemPrompt.includes("- request_id: test-req-123"));
});

test("KATIE_RUNTIME_CONTEXT handles missing values with graceful defaults", () => {
  const systemPrompt = buildIntentClassifierSystemPrompt(intents, false, {}, {});

  assert.ok(systemPrompt.includes("- current_provider: unknown"));
  assert.ok(systemPrompt.includes("- current_model: unknown"));
  assert.ok(systemPrompt.includes("- model_tier: unknown"));
  assert.ok(systemPrompt.includes("- routing_intent: unknown"));
  assert.ok(systemPrompt.includes("- routing_authority: unknown"));
  assert.ok(systemPrompt.includes("- request_id: N/A"));
});
