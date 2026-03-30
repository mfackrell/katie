import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicyRouting } from "../lib/router/policy-engine";
import type { LlmProvider } from "../lib/providers/types";
import type { RequestIntent } from "../lib/router/model-intent";

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

function run(intent: RequestIntent) {
  return evaluatePolicyRouting({
    prompt: "design a distributed system architecture",
    context: "",
    traceId: "test-intent-source",
    resolvedIntent: intent,
    availableByProvider: [provider("anthropic", ["claude-4.6-opus"]), provider("google", ["gemini-3.1-flash"])],
    currentSelection: { providerName: "google", modelId: "gemini-3.1-flash" }
  });
}

test("policy engine consumes resolved router intent as source of truth", () => {
  const result = run("architecture-review");
  assert.equal(result.trace.intent.source, "resolved-router-intent");
  assert.equal(result.trace.intent.label, "architecture_design");
});

test("policy hard cap blocks expensive models", () => {
  process.env.ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST = "0.00001";
  const result = run("architecture-review");

  const opus = result.trace.candidates.find((candidate) => candidate.model.includes("claude-4.6-opus"));
  assert.ok(opus);
  assert.equal(opus?.policy.flags.includes("blocked_hard_cap"), true);
  delete process.env.ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST;
});

test("policy only enforces when current selection violates hard guardrails", () => {
  const passing = evaluatePolicyRouting({
    prompt: "quick summary",
    context: "",
    traceId: "policy-pass",
    resolvedIntent: "general-text",
    availableByProvider: [provider("google", ["gemini-3.1-flash"])],
    currentSelection: { providerName: "google", modelId: "gemini-3.1-flash" }
  });

  assert.equal(passing.selected, null);
  assert.match(passing.trace.selection_summary, /passed hard guardrails/i);
});
