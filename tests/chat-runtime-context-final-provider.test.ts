import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CHAT_ROUTE = readFileSync("app/api/chat/route.ts", "utf8");

test("buildKatieRuntimeContext formats expected runtime block with unknown fallbacks", () => {
  assert.match(CHAT_ROUTE, /function buildKatieRuntimeContext\(/);
  assert.match(CHAT_ROUTE, /KATIE_RUNTIME_CONTEXT:/);
  assert.match(CHAT_ROUTE, /current_provider: \$\{provider \|\| "unknown"\}/);
  assert.match(CHAT_ROUTE, /current_model: \$\{modelId \|\| "unknown"\}/);
  assert.match(CHAT_ROUTE, /model_tier: \$\{modelTier \|\| "unknown"\}/);
  assert.match(CHAT_ROUTE, /routing_intent: \$\{classifiedIntent \|\| "unknown"\}/);
  assert.match(CHAT_ROUTE, /routing_authority: \$\{routingAuthority \|\| "unknown"\}/);
  assert.match(CHAT_ROUTE, /request_id: \$\{requestId \|\| "unknown"\}/);
});

test("final provider request prepends KATIE_RUNTIME_CONTEXT to persona used by provider.generate", () => {
  assert.match(CHAT_ROUTE, /const finalProviderSupport = getAttachmentSupportForProvider\(/);
  assert.match(CHAT_ROUTE, /personaForGeneration = `\$\{runtimeContext\}\n\n\$\{personaForGeneration\}`;/);
  assert.match(CHAT_ROUTE, /buildGenerationParams\({[\s\S]*persona: personaForGeneration,/);
  assert.match(CHAT_ROUTE, /Katie runtime context injected/);
  assert.match(CHAT_ROUTE, /included: personaForGeneration\.includes\("KATIE_RUNTIME_CONTEXT:"\)/);
});
