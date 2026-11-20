import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as economics from "@/lib/router/control-plane-economics";
import { runWithStandaloneAccounting } from "@/lib/standalone-accounting/context";
import {
  buildCandidateMetadata, buildRoutingPreferenceProfile, chooseRoutingWithLLM,
} from "@/lib/router/model-intent";
import type { LlmProvider } from "@/lib/providers/types";

const owner = { userId: "routing-contract-owner", actorId: "routing-contract-actor",
  chatId: "routing-contract-chat", requestId: "routing-contract-request" };
const selected = { provider: "openai", model: "gpt-5.5-pro" };
const qualification = {
  required_quality: "Evaluate the complex current request accurately and preserve material context.",
  selected_fit: "Reported reasoning and long-context capabilities meet the material requirements.",
  evidence_basis_kind: "reasoned_inference",
  evidence_basis: "Reported model capabilities exist; no measured matched task outcome is available.",
  comparative_uncertainty: "Actual comparative quality remains unknown without direct outcomes.",
  cost_after_qualification: "Evaluate quoted prices only after confirming adequate quality.",
};
const correct = JSON.stringify({
  selected,
  selection_justification: "Complex request warrants deeper model reasoning, with unverified comparative outcomes.",
  alternatives: [{
    provider: "openai", model: "gpt-5.4",
    why_not_selected: "Lower expected cost but task-specific quality remains uncertain.",
  }],
  quality_qualification: qualification,
});
const historicalShape = JSON.stringify({
  selected,
  selection_justification: "Complex request warrants deeper model reasoning, with unverified comparative outcomes.",
  alternatives: [{
    provider: "openai", model: "gpt-5.4",
    why_not_selected: "Lower expected cost but task-specific quality remains uncertain.",
  }],
});

async function runJudges(judgeOutput: "one-valid" | "all-invalid") {
  const calls: Record<string, number> = {};
  const ranks = mock.method(economics, "rankControlPlaneByActualCost",
    async (list: unknown[]) => list);
  const judge = (name: LlmProvider["name"], modelId: string, response: "valid" | "invalid" | "timeout") => {
    const provider: LlmProvider = {
      name,
      listModels: async () => [modelId],
      generate: async (p) => {
        calls[name] = (calls[name] ?? 0) + 1;
        assert.match(p.user, /MANDATORY COMPLETE RESPONSE SHAPE/);
        assert.match(p.user, /quality_qualification/);
        if (response === "timeout") throw new Error("simulated provider timeout; no paid transmission");
        return { text: response === "valid" ? correct : historicalShape, provider: name,
          model: p.modelId! };
      },
    };
    return { provider, modelId };
  };
  const decisionProviders = [
    judge("openai", "gpt-4.1-mini", judgeOutput === "one-valid" ? "valid" : "invalid"),
    judge("anthropic", "claude-haiku-5-5", "timeout"),
    judge("google", "gemini-2.5-flash", judgeOutput === "one-valid" ? "timeout" : "invalid"),
  ];
  try {
    const result = await runWithStandaloneAccounting(owner, () => chooseRoutingWithLLM({
      routing_mode: "best_value",
      prompt: "Assess a complex, context-sensitive financial and operational strategy.",
      intent: "assistant-reflection",
      complexity: "high",
      modalityFlags: { has_images: false, has_video_input: false },
      hardRouteContext: { hard_rule_applied: false, rule: "none" },
      preferenceProfile: buildRoutingPreferenceProfile(),
      candidates: [
        buildCandidateMetadata("openai", "gpt-5.5-pro", "assistant-reflection"),
        buildCandidateMetadata("openai", "gpt-5.4", "assistant-reflection"),
      ],
      decisionProviders,
    }));
    return { result, calls };
  } finally {
    ranks.mock.restore();
  }
}

test("one valid judgment wins with two other judges timing out and no replay", async () => {
  const { result, calls } = await runJudges("one-valid");
  assert.equal(result.accepted, true);
  if (!result.accepted) assert.fail("the valid judge must survive other judge failures");
  assert.equal(result.selected.providerName, "openai");
  assert.equal(result.selected.modelId, "gpt-5.5-pro");
  assert.deepEqual(calls, { openai: 1, anthropic: 1, google: 1 },
    "no duplicate or unauthorized provider inference");
});

test("all incomplete/failed judgments retain existing safe fallback result", async () => {
  const { result, calls } = await runJudges("all-invalid");
  assert.equal(result.accepted, false);
  if (result.accepted) assert.fail("no invalid judge may determine the selection");
  assert.equal(result.reason, "all_decision_providers_failed");
  assert.deepEqual(calls, { openai: 1, anthropic: 1, google: 1 },
    "a rejected structured response must not cause any automatic replay");
});
