import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as economics from "@/lib/router/control-plane-economics";
import { chooseProvider } from "@/lib/router/master-router";
import { scoreModelsForIntent } from "@/lib/router/model-intent";
import { runWithStandaloneAccounting } from "@/lib/standalone-accounting/context";
import type { LlmProvider } from "@/lib/providers/types";
import type { RegistryRoutingModel } from "@/lib/models/registry";

const incidentMessage = "lindsey and i told each other EVERYTHING";
const inventory: Array<{ name: LlmProvider["name"]; models: string[] }> = [
  { name: "openai", models: ["gpt-5.3-codex", "gpt-5.4", "gpt-4.1-mini"] },
  { name: "anthropic", models: ["claude-sonnet-4-6", "claude-haiku-5-5"] },
  { name: "google", models: ["gemini-2.5-flash"] },
  { name: "grok", models: ["grok-4.3"] },
];
const classification = {
  intent: "social-emotional",
  complexity: "high",
  response_purpose: "deliverable",
  provider_refusal_risk: "low",
  quality_requirements: "Respond with nuanced continuity and accurate personal context, not technical coding advice.",
  primary_objective: "Continue a deeply personal conversation about the user's relationship with Lindsey.",
  objective_evidence: [incidentMessage],
  context_influence: "The earlier relationship discussion supplies context, not evidence of prior model success.",
  selection_justification: "The user supplied a personal relationship disclosure requiring conversational sensitivity.",
};
const qualification = {
  required_quality: "Maintain relationship continuity, emotional nuance, and grounded personal context.",
  selected_fit: "Claude Sonnet 4.6 plausibly provides contextual, empathetic dialogue for this request.",
  evidence_basis_kind: "reasoned_inference",
  evidence_basis: "No independently verified feedback or outcome for the selected model was supplied; fit is inferred from the task and general capability.",
  comparative_uncertainty: "Actual matched response quality and user satisfaction are unknown.",
  cost_after_qualification: "Compare costs only among models reasonably meeting the personal-conversation quality threshold.",
};
const validBestValue = {
  selected: { provider: "anthropic", model: "claude-sonnet-4-6" },
  selection_justification: "The task requires sensitive conversational continuity. Sonnet is a plausible fit; matched model outcomes are unverified.",
  alternatives: [{ provider: "openai", model: "gpt-5.3-codex",
    why_not_selected: "Specialization in programming supplies no evidence of better personal dialogue." }],
  quality_qualification: qualification,
};
const unsupportedFeedback = {
  ...validBestValue,
  quality_qualification: { ...qualification, evidence_basis_kind: "attributed_feedback",
    evidence_basis: "Prior successful conversations establish the user's satisfaction with the selected model, but no source is available." },
};

function registry(): Map<LlmProvider["name"], RegistryRoutingModel[]> {
  return new Map(inventory.map(({ name, models }) => [name, models.map(modelId => ({
    provider_name: name, model_id: modelId,
    pricing_status: "verified", capability_status: "verified", routing_eligibility: "verified",
    confidence_tier: "high", confidence_score: 1,
    supports_text: true, supports_vision: false, supports_video: false,
    supports_image_generation: false, supports_web_search: false,
    reasoning_tier: "high", speed_tier: "fast", cost_tier: "low",
    pricing_input_per_1m: null, pricing_output_per_1m: null,
  } as RegistryRoutingModel))]));
}

type JudgeMode = "one-valid" | "all-failed" | "best-answer-valid";
async function routeIncident(routing_mode: "best_value" | "best_answer", mode: JudgeMode) {
  const transmissions: Array<{ provider: string; model: string; stage: "classification" | "judge"; prompt: string }> = [];
  const providers: LlmProvider[] = inventory.map(({ name, models }) => ({
    name,
    listModels: async () => models,
    generate: async params => {
      const stage = params.user.includes("CURRENT_USER_MESSAGE:") ? "classification" : "judge";
      transmissions.push({ provider: name, model: params.modelId!, stage, prompt: params.user });
      if (stage === "classification") return {
        provider: name, model: params.modelId!, text: JSON.stringify(classification),
      };
      const isOpenAiJudge = name === "openai";
      assert.equal(params.user.includes("BEST VALUE ONLY — QUALITY QUALIFICATION BEFORE COST:"),
        routing_mode === "best_value", "Best Answer's existing prompt is unchanged");
      if (isOpenAiJudge) {
        if (mode === "best-answer-valid") return {
          provider: name, model: params.modelId!, text: JSON.stringify({
            selected: { provider: "openai", model: "gpt-5.4" },
            selection_justification: "Best Answer chooses a general-purpose text model for this conversation.",
            alternatives: [{ provider: "anthropic", model: "claude-sonnet-4-6",
              why_not_selected: "This model was not the judge's selection." }],
          }),
        };
        return { provider: name, model: params.modelId!,
          text: JSON.stringify(mode === "one-valid" ? validBestValue : unsupportedFeedback) };
      }
      throw new Error("Simulated unavailable judge; no second generation dispatch");
    },
  }));
  const snapshot = registry();
  const actualScoring = scoreModelsForIntent(
    inventory.map(({ name, models }) => ({ provider: providers.find(p => p.name === name)!, models })),
    "social-emotional",
  );
  const ranking = mock.method(economics, "rankControlPlaneByActualCost",
    async (candidates: unknown[]) => candidates);
  try {
    const result = await runWithStandaloneAccounting({
      userId: "bv-reliability-owner", actorId: "bv-reliability-actor", chatId: "bv-reliability-chat",
      requestId: "d945d22c-46d1-4ed8-9f45-2edb04923b32",
    }, () => chooseProvider(incidentMessage,
      "Earlier exchanges establish the relationship context but contain no attributed model feedback.",
      providers, {
        routing_mode, modelRegistrySnapshot: snapshot,
        routingRequestId: "d945d22c-46d1-4ed8-9f45-2edb04923b32",
      }));
    return { result, transmissions, actualScoring };
  } finally {
    ranking.mock.restore();
  }
}

function assertOneShotJudges(calls: Awaited<ReturnType<typeof routeIncident>>["transmissions"]) {
  const judges = calls.filter(call => call.stage === "judge");
  assert.deepEqual(judges.map(call => call.provider).sort(), ["anthropic", "google", "grok", "openai"]);
  assert.deepEqual(judges.map(call => call.provider + ":" + call.model).sort(), [
    "anthropic:claude-haiku-5-5", "google:gemini-2.5-flash", "grok:grok-4.3", "openai:gpt-4.1-mini"
  ]);
  assert.equal(new Set(judges.map(call => call.provider + ":" + call.model)).size, 4);
  assert.equal(judges.length, 4, "all four independent judges are invoked exactly once");
  assert.equal(new Set(judges.map(call => call.prompt)).size, 1,
    "all four judges receive the exact same routing context, inventory, and instructions");
  assert.equal(calls.filter(call => call.stage === "classification").length, 1);
}

test("Nov 20: one source-honest Sonnet recommendation survives the other three unavailable judges", async () => {
  const { result, transmissions } = await routeIncident("best_value", "one-valid");
  assert.equal(result.modelId, "claude-sonnet-4-6");
  assert.equal(result.provider.name, "anthropic");
  assert.equal(result.explainer?.selected_source, "llm-primary");
  assert.equal(result.explainer?.fallback_used, false);
  assertOneShotJudges(transmissions);
});

test("Nov 21: all unusable judges trigger capability-qualified cost fallback, not premium biased scores or first-inventory Codex", async () => {
  const { result, transmissions, actualScoring } = await routeIncident("best_value", "all-failed");
  assert.equal(inventory[0].models[0], "gpt-5.3-codex", "reproduce Codex at inventory position zero");
  assert.equal(actualScoring[0]?.modelId, "claude-sonnet-4-6",
    "the existing production intent scorer must favor conversational suitability in this fixture");
  assert.notEqual(result.modelId, actualScoring[0]?.modelId,
    "Best Value fallback must no longer apply the premium-biased intent scorer");
  assert.equal(result.modelId, "gpt-5.4",
    "high-complexity fallback excludes low-tier models, then compares reviewed-price scenarios");
  assert.equal(result.provider.name, "openai");
  assert.match(result.explainer?.selection_justification ?? "", /Capability proxy requires high reasoning depth/);
  assert.match(result.explainer?.selection_justification ?? "", /not measured usage/);
  assert.notEqual(result.modelId, "gpt-5.3-codex");
  assert.equal(result.explainer?.selected_source, "deterministic-fallback");
  assert.equal(result.explainer?.fallback_used, true);
  assertOneShotJudges(transmissions);
});

test("Best Answer still honors a valid LLM selection without invoking Best Value fallback scoring", async () => {
  const { result, transmissions } = await routeIncident("best_answer", "best-answer-valid");
  assert.equal(result.provider.name, "openai");
  assert.equal(result.modelId, "gpt-5.4");
  assert.equal(result.explainer?.selected_source, "llm-primary");
  assert.equal(result.explainer?.fallback_used, false);
  assertOneShotJudges(transmissions);
});
