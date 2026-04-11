import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicyRouting } from "../lib/router/policy-engine";
import type { LlmProvider } from "../lib/providers/types";
import type { RequestIntent } from "../lib/router/model-intent";
import type { RegistryRoutingModel } from "../lib/models/registry";

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

function modelRecord(
  providerName: LlmProvider["name"],
  modelId: string,
  overrides: Partial<RegistryRoutingModel> = {}
): RegistryRoutingModel {
  return {
    provider_name: providerName,
    model_id: modelId,
    pricing_status: "verified",
    capability_status: "verified",
    pricing_input_per_1m: 1,
    pricing_output_per_1m: 3,
    routing_eligibility: "verified",
    confidence_tier: "high",
    confidence_score: 0.95,
    supports_text: true,
    supports_vision: false,
    supports_web_search: false,
    supports_image_generation: false,
    supports_video: false,
    reasoning_tier: "medium",
    speed_tier: "medium",
    cost_tier: "medium",
    ...overrides
  };
}

function lookup(records: RegistryRoutingModel[]): Map<string, RegistryRoutingModel> {
  return new Map(records.map((record) => [`${record.provider_name}:${record.model_id.toLowerCase()}`, record]));
}

function run(intent: RequestIntent, registryLookup?: Map<string, RegistryRoutingModel>) {
  return evaluatePolicyRouting({
    prompt: "design a distributed system architecture",
    context: "",
    traceId: "test-intent-source",
    resolvedIntent: intent,
    registryLookup,
    availableByProvider: [provider("anthropic", ["claude-4.6-opus"]), provider("google", ["gemini-3.1-flash"])],
    currentSelection: { providerName: "google", modelId: "gemini-3.1-flash" }
  });
}

test("policy engine consumes resolved router intent as source of truth", () => {
  const result = run("architecture-review");
  assert.equal(result.trace.intent.source, "resolved-router-intent");
  assert.equal(result.trace.intent.label, "architecture_design");
});

test("policy hard cap blocks expensive models when backed by verified registry pricing", () => {
  process.env.ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST = "0.0002";
  const result = run(
    "architecture-review",
    lookup([
      modelRecord("anthropic", "claude-4.6-opus", {
        pricing_input_per_1m: 20,
        pricing_output_per_1m: 60,
        reasoning_tier: "high",
        speed_tier: "slow"
      }),
      modelRecord("google", "gemini-3.1-flash", {
        pricing_input_per_1m: 1,
        pricing_output_per_1m: 3,
        reasoning_tier: "medium",
        speed_tier: "fast"
      })
    ])
  );

  const opus = result.trace.candidates.find((candidate) => candidate.model.includes("claude-4.6-opus"));
  assert.ok(opus);
  assert.equal(opus?.policy.flags.includes("blocked_hard_cap"), true);
  assert.equal(opus?.metadata_source, "verified_registry");
  delete process.env.ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST;
});

test("heuristic model names without registry metadata are non-authoritative", () => {
  const result = evaluatePolicyRouting({
    prompt: "small prompt",
    context: "",
    traceId: "heuristic-name-test",
    resolvedIntent: "architecture-review",
    availableByProvider: [provider("anthropic", ["claude-opus-haiku-gpt-5-flash"]), provider("google", ["gemini-mini-haiku"])],
    currentSelection: { providerName: "anthropic", modelId: "claude-opus-haiku-gpt-5-flash" }
  });

  assert.equal(result.selected, null);
  assert.equal(result.metadataMissing, true);
  for (const candidate of result.trace.candidates) {
    assert.equal(candidate.policy.flags.includes("blocked_hard_cap"), false);
    assert.equal(candidate.policy.flags.includes("blocked_quality_floor"), false);
    assert.match(candidate.policy.reasons.join(","), /unverified_non_authoritative/);
  }
});

test("policy only enforces when current selection violates verified hard guardrails", () => {
  const passing = evaluatePolicyRouting({
    prompt: "quick summary",
    context: "",
    traceId: "policy-pass",
    resolvedIntent: "general-text",
    registryLookup: lookup([
      modelRecord("google", "gemini-3.1-flash", {
        pricing_input_per_1m: 0.8,
        pricing_output_per_1m: 2,
        speed_tier: "fast"
      })
    ]),
    availableByProvider: [provider("google", ["gemini-3.1-flash"])],
    currentSelection: { providerName: "google", modelId: "gemini-3.1-flash" }
  });

  assert.equal(passing.selected, null);
  assert.match(passing.trace.selection_summary, /passed hard guardrails/i);
  assert.equal(passing.metadataMissing, true);
});

test("restricted registry metadata remains fallback-only and cannot drive hard reroute", () => {
  process.env.ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST = "0.00001";
  const result = evaluatePolicyRouting({
    prompt: "architecture question",
    context: "",
    traceId: "restricted-fallback",
    resolvedIntent: "architecture-review",
    registryLookup: lookup([
      modelRecord("anthropic", "claude-4.6-opus", {
        routing_eligibility: "restricted",
        capability_status: "heuristic",
        pricing_status: "estimated",
        pricing_input_per_1m: 50,
        pricing_output_per_1m: 120,
        reasoning_tier: "high",
        speed_tier: "slow"
      }),
      modelRecord("google", "gemini-3.1-flash", {
        routing_eligibility: "restricted",
        capability_status: "heuristic",
        pricing_status: "estimated",
        pricing_input_per_1m: 1,
        pricing_output_per_1m: 3,
        reasoning_tier: "low",
        speed_tier: "fast"
      })
    ]),
    availableByProvider: [provider("anthropic", ["claude-4.6-opus"]), provider("google", ["gemini-3.1-flash"])],
    currentSelection: { providerName: "anthropic", modelId: "claude-4.6-opus" }
  });

  assert.equal(result.selected, null);
  assert.equal(result.metadataMissing, true);
  assert.match(result.trace.selection_summary, /unverified/i);
  delete process.env.ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST;
});
