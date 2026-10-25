import test from "node:test";
import assert from "node:assert/strict";
import { chooseProvider } from "../lib/router/master-router";
import { computeRoutingEligibility, isDefinitiveModelUnavailable, normalizeModelId, type RegistryRoutingModel } from "../lib/models/registry";
import type { LlmProvider } from "../lib/providers/types";

function fakeProvider(name: LlmProvider["name"], models: string[]): LlmProvider {
  return {
    name,
    async listModels() {
      return models;
    },
    async generate() {
      throw new Error("not used");
    }
  };
}

test("normalizeModelId strips provider-specific prefixes", () => {
  assert.equal(normalizeModelId("models/Gemini-3.1-Pro"), "gemini-3.1-pro");
});

test("eligibility is conservative when metadata is weak", () => {
  assert.equal(computeRoutingEligibility({ capability_status: "heuristic", pricing_status: "missing", confidence_score: 0.4 }), "restricted");
  assert.equal(computeRoutingEligibility({ capability_status: "missing", pricing_status: "missing", confidence_score: 0.2 }), "manual_override_only");
  assert.equal(computeRoutingEligibility({ capability_status: "conflict", pricing_status: "verified", confidence_score: 0.9 }), "disabled");
});

test("router consumes registry snapshot and avoids manual_override_only entries", async () => {
  const google = fakeProvider("google", ["gemini-3.1-pro", "gemini-3.1-flash"]);
  const snapshot = new Map<LlmProvider["name"], RegistryRoutingModel[]>([
    [
      "google",
      [
        {
          provider_name: "google",
          model_id: "gemini-3.1-pro",
          pricing_status: "missing",
          capability_status: "heuristic",
          pricing_input_per_1m: null,
          pricing_output_per_1m: null,
          routing_eligibility: "manual_override_only",
          confidence_tier: "low",
          confidence_score: 0.3,
          supports_text: true,
          supports_vision: true,
          supports_web_search: false,
          supports_image_generation: false,
          supports_video: true,
          reasoning_tier: "high",
          speed_tier: "medium",
          cost_tier: "high"
        },
        {
          provider_name: "google",
          model_id: "gemini-3.1-flash",
          pricing_status: "estimated",
          capability_status: "heuristic",
          pricing_input_per_1m: 1,
          pricing_output_per_1m: 3,
          routing_eligibility: "restricted",
          confidence_tier: "medium",
          confidence_score: 0.6,
          supports_text: true,
          supports_vision: true,
          supports_web_search: false,
          supports_image_generation: false,
          supports_video: true,
          reasoning_tier: "low",
          speed_tier: "fast",
          cost_tier: "low"
        }
      ]
    ]
  ]);

  for (const excludedEligibility of ["manual_override_only", "disabled"] as const) {
    snapshot.get("google")![0].routing_eligibility = excludedEligibility;
    const selected = await chooseProvider("summarize this note", "", [google], {
      requestIntent: "general-text",
      modelRegistrySnapshot: snapshot,
      routingTraceEnabled: false
    });
    assert.equal(selected.modelId, "gemini-3.1-flash");
  }
});

test("only confirmed upstream 404 quarantines a model; transient failures never do", () => {
  assert.equal(isDefinitiveModelUnavailable({status:404}), true);
  for (const status of [401,403,408,429,500,503]) {
    assert.equal(isDefinitiveModelUnavailable({status}), false);
  }
  assert.equal(isDefinitiveModelUnavailable(new Error("timeout")), false);
  assert.equal(isDefinitiveModelUnavailable(new Error("HTTP 404 mentioned in unrelated text")), false);
});

test("empty registry pool cannot fall back to provider catalog and reselect quarantined model", async () => {
  const openai = fakeProvider("openai", ["gpt-5-chat-latest"]);
  const snapshot = new Map<LlmProvider["name"], RegistryRoutingModel[]>([["openai", []]]);
  await assert.rejects(
    chooseProvider("hello", "", [openai], {
      requestIntent: "general-text", modelRegistrySnapshot: snapshot, routingTraceEnabled: false,
    }),
    /No eligible routing candidates/,
  );
});
