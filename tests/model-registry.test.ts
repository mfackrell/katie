import test from "node:test";
import assert from "node:assert/strict";
import { chooseProvider } from "../lib/router/master-router";
import { computeRoutingEligibility, normalizeModelId, type RegistryRoutingModel } from "../lib/models/registry";
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

  const selected = await chooseProvider("summarize this note", "", [google], {
    requestIntent: "general-text",
    modelRegistrySnapshot: snapshot,
    routingTraceEnabled: false
  });

  assert.equal(selected.modelId, "gemini-3.1-flash");
});
