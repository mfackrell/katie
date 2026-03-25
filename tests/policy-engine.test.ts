import test from "node:test";
import assert from "node:assert/strict";
import { classifyPolicyIntent, evaluatePolicyRouting } from "../lib/router/policy-engine";
import type { LlmProvider } from "../lib/providers/types";

function provider(name: LlmProvider["name"], models: string[]): { provider: LlmProvider; models: string[] } {
  return {
    provider: {
      name,
      async listModels() {
        return models;
      },
      async generate() {
        throw new Error("not used");
      }
    },
    models
  };
}

test("self-referential prompts classify to reflection/meta despite technical words", () => {
  const intent = classifyPolicyIntent("Katie why did you route my router debugging request this way?", "");
  assert.ok(["conversation_reflection", "explanation_meta"].includes(intent.label));
  assert.ok(intent.confidence > 0.85);
});

test("policy hard cap blocks expensive models", () => {
  process.env.ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST = "0.00001";
  const result = evaluatePolicyRouting({
    prompt: "design a distributed system architecture",
    context: "",
    traceId: "test-hard-cap",
    availableByProvider: [provider("anthropic", ["claude-4.6-opus"]), provider("google", ["gemini-3.1-flash"])],
    currentSelection: { providerName: "google", modelId: "gemini-3.1-flash" }
  });

  const opus = result.trace.candidates.find((candidate) => candidate.model.includes("claude-4.6-opus"));
  assert.ok(opus);
  assert.equal(opus?.policy.flags.includes("blocked_hard_cap"), true);
  delete process.env.ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST;
});

test("ambiguous scores can trigger broader-model tiebreaker", () => {
  const result = evaluatePolicyRouting({
    prompt: "explain this and maybe patch if needed",
    context: "recent coding discussion",
    traceId: "test-tiebreak",
    availableByProvider: [provider("openai", ["gpt-5.2-unified"]), provider("google", ["gemini-3.1-pro"])],
    currentSelection: { providerName: "openai", modelId: "gpt-5.2-unified" }
  });

  assert.equal(typeof result.trace.tiebreaker_applied, "boolean");
  assert.ok(result.trace.selected_model.length > 0);
});

test("policy metadata assigns high quality tiers to explicit frontier models", () => {
  const result = evaluatePolicyRouting({
    prompt: "review this architecture and improve reliability",
    context: "",
    traceId: "test-quality-tier-overrides",
    availableByProvider: [
      provider("anthropic", ["claude-4.5-sonnet"]),
      provider("openai", ["gpt-5.3-codex", "o3-pro"]),
      provider("google", ["gemini-3.1-flash"])
    ],
    currentSelection: { providerName: "google", modelId: "gemini-3.1-flash" }
  });

  const qualityByModel = Object.fromEntries(result.trace.candidates.map((candidate) => [candidate.model, candidate.quality_score]));
  assert.equal(qualityByModel["anthropic:claude-4.5-sonnet"], 1);
  assert.equal(qualityByModel["openai:gpt-5.3-codex"], 1);
  assert.equal(qualityByModel["openai:o3-pro"], 1);
  assert.ok((qualityByModel["google:gemini-3.1-flash"] ?? 0) < 1);
});
