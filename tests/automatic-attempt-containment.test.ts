import test from "node:test";
import assert from "node:assert/strict";
import { assertAutomaticHelperModel, isPremiumAutomaticModel, isTerminalAttemptError, withProviderAttemptTimeout } from "@/lib/collaboration/attempt-policy";
import { inferRequestClassification } from "@/lib/router/model-intent";
import { selectQualityFirstReviewer } from "@/lib/collaboration/routing";
import { runAdaptiveCollaboration } from "@/lib/collaboration/orchestrator";
import { runRequiredDraftReview } from "@/lib/collaboration/required-review";
import { getAccountingScope, nextStandaloneAttempt, runWithStandaloneAccounting, runWithStandaloneActivity } from "@/lib/standalone-accounting/context";
import type { RegistryRoutingModel } from "@/lib/models/registry";
import type { LlmProvider } from "@/lib/providers/types";

test("automatic premium containment recognizes dated and namespaced aliases", () => {
  for (const model of ["o3-pro", "o3-pro-2025-06-10", "gpt-5.5-pro", "gpt-5.5-pro-2026-04-23", " OpenAI/GPT-6-Astra-2026-10-01 "]) {
    assert.equal(isPremiumAutomaticModel("openai", model), true, model);
    assert.throws(() => assertAutomaticHelperModel("openai", model), { code: "standalone_automatic_premium_helper_blocked" });
  }
  for (const model of ["gpt-5.5", "gpt-5.6-sol", "gpt-5.5-codex"]) {
    assert.equal(isPremiumAutomaticModel("openai", model), false, model);
  }
  assert.equal(isPremiumAutomaticModel("google", "gemini-2.5-pro"), false);
});

test("automatic classifier does not invoke a premium decision provider", async () => {
  const provider: LlmProvider = {
    name: "openai", listModels: async () => ["o3-pro"],
    generate: async () => { assert.fail("Premium control-plane calls must be filtered before dispatch"); },
  };
  const result = await inferRequestClassification("rewrite this sentence", { hasImages: false }, {
    decisionProviders: [{ provider, modelId: "o3-pro" }],
  });
  assert.ok(result.intent);
});

test("required reviewer quality selection excludes premium models despite highest confidence", () => {
  const provider: LlmProvider = { name: "openai", listModels: async () => [], generate: async () => { throw new Error("unused"); } };
  const models = [
    { model_id: "gpt-5.5-pro-2026-04-23", confidence_score: 1 },
    { model_id: "gpt-5.6-sol", confidence_score: 0.9 },
  ].map(model => ({ ...model, routing_eligibility: "verified", reasoning_tier: "high", supports_text: true } as RegistryRoutingModel));
  const selected = selectQualityFirstReviewer({ requester: { provider: "anthropic", modelId: "lead" }, providers: [provider], usedParticipants: [], snapshot: new Map([["openai", models]]) });
  assert.equal(selected?.modelId, "gpt-5.6-sol");
});

test("control-plane approval failure propagates without fallback", async () => {
  let calls = 0;
  const denial = Object.assign(new Error("Exact-attempt approval required"), { code: "standalone_approval_required" });
  const provider: LlmProvider = { name: "openai", listModels: async () => [], generate: async () => { calls++; throw new Error("SDK wrapped accounting failure", { cause: denial }); } };
  await assert.rejects(inferRequestClassification("review this patch", { hasImages: false }, {
    decisionProviders: [{ provider, modelId: "gpt-5.6-sol" }, { provider, modelId: "gpt-5.5" }],
  }), /SDK wrapped accounting failure/);
  assert.equal(calls, 1);
});

test("control-plane timeout cancels its attempt without invoking the next decision model", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let signal: AbortSignal | undefined;
  const provider: LlmProvider = { name: "openai", listModels: async () => [], generate: async params => {
    calls++;
    signal = params.signal;
    queueMicrotask(() => t.mock.timers.tick(25));
    return new Promise<never>(() => {});
  } };
  await assert.rejects(inferRequestClassification("review this patch", { hasImages: false }, {
    timeoutMs: 25,
    decisionProviders: [{ provider, modelId: "gpt-5.6-sol" }, { provider, modelId: "gpt-5.5" }],
  }), /billing outcome is unknown/);
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});

test("timeout requests cancellation and remains terminal if the provider ignores abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  const result = withProviderAttemptTimeout(current => {
    signal = current;
    queueMicrotask(() => t.mock.timers.tick(25));
    return new Promise<never>(() => {});
  }, 25, "fake provider");
  await assert.rejects(result, error => {
    assert.equal(isTerminalAttemptError(error), true);
    assert.match(String(error), /billing outcome is unknown/);
    return true;
  });
  assert.equal(signal?.aborted, true);
});

test("an expired attempt budget blocks dispatch before invoking the provider", async () => {
  for (const timeoutMs of [0, -1, Number.NaN]) {
    await assert.rejects(withProviderAttemptTimeout(async () => { assert.fail("Expired work must not start"); }, timeoutMs, "expired review"), {
      code: "standalone_time_budget_exhausted",
    });
  }
});

test("an injected premium helper cannot bypass the automatic selection policy", async () => {
  let helperCalls = 0;
  let leadCalls = 0;
  const lead: LlmProvider = { name: "anthropic", listModels: async () => ["lead"], generate: async () => {
    leadCalls++;
    return { text: JSON.stringify({ action: "delegate", request: { task: "Check the draft", capability: "critique" } }), provider: "anthropic", model: "lead" };
  } };
  const helper: LlmProvider = { name: "openai", listModels: async () => ["gpt-5.5-pro"], generate: async () => { helperCalls++; throw new Error("Premium helper must not dispatch"); } };
  await assert.rejects(runAdaptiveCollaboration({ requestId: "premium-injected-helper", leadProvider: lead, leadModelId: "lead", providers: [lead, helper],
    params: { name: "test", persona: "", summary: "", history: [], user: "Explain this", requestIntent: "general-text" },
    selectHelper: async () => ({ provider: helper, modelId: "gpt-5.5-pro-2026-04-23" }),
  }), { code: "standalone_automatic_premium_helper_blocked" });
  assert.equal(leadCalls, 1);
  assert.equal(helperCalls, 0);
});

test("required review cannot hide an accounting denial or select another reviewer", async () => {
  let selections = 0;
  let calls = 0;
  const denial = Object.assign(new Error("Unapproved exact attempt"), { code: "standalone_approval_required" });
  const lead: LlmProvider = { name: "openai", listModels: async () => [], generate: async () => { assert.fail("Lead must not run after denial"); } };
  const reviewer: LlmProvider = { name: "anthropic", listModels: async () => [], generate: async () => {
    const scope = getAccountingScope();
    assert.equal(scope?.kind === "standalone" && scope.context.activity, "required_review_assessment");
    calls++; throw denial;
  } };
  await assert.rejects(runWithStandaloneAccounting({ userId: "u", actorId: "a", chatId: "c", requestId: "denied-review" }, () => runRequiredDraftReview({ requestId: "denied-review",
    draft: { text: "Draft", provider: "openai", model: "gpt-5.6-sol" },
    params: { name: "test", persona: "", summary: "", history: [], user: "Review this draft" },
    leadProvider: lead, deadlineMs: Date.now() + 240_000,
    selectHelper: async () => { selections++; return { provider: reviewer, modelId: "reviewer" }; },
  })), /Unapproved exact attempt/);
  assert.equal(selections, 1);
  assert.equal(calls, 1);
});

test("collaboration activities retain parent bindings and independent stable unique attempt keys", async () => {
  const attempts: Array<{ activity?: string; key: string }> = [];
  const record = () => {
    const attempt = nextStandaloneAttempt();
    assert.ok(attempt);
    assert.deepEqual({ userId: attempt.context.userId, actorId: attempt.context.actorId,
      chatId: attempt.context.chatId, requestId: attempt.context.requestId },
    { userId: "u", actorId: "a", chatId: "c", requestId: "activities" });
    attempts.push({ activity: attempt.context.activity, key: attempt.attemptKey });
  };
  let controls = 0;
  const lead: LlmProvider = { name: "anthropic", listModels: async () => [], generate: async () => {
    record();
    const decision = controls++ === 0
      ? { action: "delegate", request: { task: "Check this", capability: "critique" } }
      : { action: "ready", synthesisBrief: "Use the critique" };
    return { text: JSON.stringify(decision), provider: "anthropic", model: "lead" };
  }, generateStream: async () => { record(); return { text: "Finished", provider: "anthropic", model: "lead" }; } };
  const helper: LlmProvider = { name: "google", listModels: async () => [], generate: async () => {
    record(); return { text: JSON.stringify({ action: "answer", answer: "Checked" }), provider: "google", model: "helper" };
  } };
  const run = (withUnrelatedPreparation: boolean) => runWithStandaloneAccounting({ userId: "u", actorId: "a", chatId: "c", requestId: "activities" }, () => runAdaptiveCollaboration({
    requestId: "activities", leadProvider: lead, leadModelId: "lead", providers: [lead, helper],
    params: { name: "test", persona: "", summary: "", history: [], user: "Explain this", requestIntent: "general-text" },
    selectHelper: async () => {
      if (withUnrelatedPreparation) {
        runWithStandaloneActivity("attachment-preprocessing", () => {
          assert.equal(nextStandaloneAttempt()?.attemptKey, "attachment-preprocessing:0");
          assert.equal(nextStandaloneAttempt()?.attemptKey, "attachment-preprocessing:1");
        });
      }
      return { provider: helper, modelId: "helper" };
    },
  }));
  await run(true);
  const expected = [
    { activity: "collaboration_lead_control", key: "collaboration_lead_control:0" },
    { activity: "collaboration_helper", key: "collaboration_helper:0" },
    { activity: "collaboration_lead_control", key: "collaboration_lead_control:1" },
    { activity: "collaboration_synthesis", key: "collaboration_synthesis:0" },
  ];
  assert.deepEqual(attempts, expected);
  assert.equal(new Set(attempts.map(attempt => attempt.key)).size, attempts.length);

  // A replay that restores cached preparation must retain the same inference
  // keys; unrelated activities must not shift this workflow's approvals.
  attempts.length = 0;
  controls = 0;
  await run(false);
  assert.deepEqual(attempts, expected);
  assert.equal(new Set(attempts.map(attempt => attempt.key)).size, attempts.length);
});
