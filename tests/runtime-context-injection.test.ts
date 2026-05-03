import test from "node:test";
import assert from "node:assert/strict";

import { buildIntentClassifierSystemPrompt, type RequestIntent } from "../lib/router/model-intent.ts";

const intents: RequestIntent[] = ["general-text", "assistant-reflection", "code-review", "web-search"];

test("KATIE_RUNTIME_CONTEXT is injected at the beginning with provided values", () => {
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
  assert.ok(systemPrompt.includes("- routing_intent: assistant-reflection"));
  assert.ok(systemPrompt.includes("- routing_authority: llm-classifier"));
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
