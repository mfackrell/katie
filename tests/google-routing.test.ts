import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCandidateMetadata,
  buildRoutingPreferenceProfile,
  hasDirectWebSearchHint,
  inferRequestIntent,
  inferRequestIntentFromMultimodalInput,
  parseIntentClassifierResponse,
  scoreModelsForIntent,
  scoreModelCandidateWithBreakdown,
  validateRoutingDecision
} from "../lib/router/model-intent";
import { chooseProvider } from "../lib/router/master-router";
import { isAcknowledgment, parseIntentSessionState } from "../lib/router/intent-context";
import { isBlockedRoutingModel } from "../lib/router/routing-model-filters";
import {
  isImageGenerationModel,
  isVisionAnalysisModel,
  supportsThinking
} from "../lib/providers/google-model-capabilities";
import type { LlmProvider, ProviderResponse } from "../lib/providers/types";
import { isLikelyProviderRefusal, runWithRefusalFallback } from "../lib/router/refusal-detection";

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

test("google thinking support is opt-in per model", async () => {
  assert.equal(supportsThinking("gemini-3.1-pro"), true);
  assert.equal(supportsThinking("gemini-3-pro-image-preview"), false);
  assert.equal(supportsThinking("gemini-3.1-pro-vision"), false);
});

test("google model capability helpers separate generation from analysis", async () => {
  assert.equal(isImageGenerationModel("nano-banana-pro-preview"), true);
  assert.equal(isImageGenerationModel("gemini-3-pro-image-preview"), false);
  assert.equal(isVisionAnalysisModel("gemini-3.1-pro"), true);
  assert.equal(isVisionAnalysisModel("gemini-3-pro-image-preview"), false);
  assert.equal(isVisionAnalysisModel("nano-banana-pro-preview"), false);
});


test("multimodal classifier returns null without image inputs", async () => {
  assert.equal(await inferRequestIntentFromMultimodalInput("Describe this image", []), null);
});

test("intent classifier parser accepts plain JSON payloads", async () => {
  const parsed = parseIntentClassifierResponse(
    JSON.stringify({ intent: "architecture-review", preferred_provider: "anthropic" }),
    ["architecture-review", "technical-debugging"],
    "test"
  );

  assert.deepEqual(parsed, { intent: "architecture-review", preferred_provider: "anthropic" });
});

test("intent classifier parser recovers JSON from fenced output", async () => {
  const parsed = parseIntentClassifierResponse(
    "Sure — here is the result:\n```json\n{\"intent\":\"technical-debugging\",\"preferred_provider\":\"openai\"}\n```",
    ["architecture-review", "technical-debugging"],
    "test"
  );

  assert.deepEqual(parsed, { intent: "technical-debugging", preferred_provider: "openai" });
});

test("intent classifier parser falls back to null when no JSON is present", async () => {
  const parsed = parseIntentClassifierResponse(
    "I think this is a coding task, but I am not certain.",
    ["architecture-review", "technical-debugging"],
    "test"
  );

  assert.deepEqual(parsed, { intent: null, preferred_provider: null });
});

test("attached chart analysis is classified as multimodal reasoning", async () => {
  assert.equal(
    await inferRequestIntent("Read this chart, estimate the trend, and project the next 3 quarters.", true),
    "multimodal-reasoning"
  );
});

test("openai and anthropic multimodal models are valid for vision and multimodal intents", async () => {
  const openaiVision = scoreModelCandidateWithBreakdown("openai", "gpt-5.3-codex", "vision-analysis");
  const anthropicMultimodal = scoreModelCandidateWithBreakdown("anthropic", "claude-4.5-sonnet", "multimodal-reasoning");

  assert.equal(openaiVision.excluded, false);
  assert.equal(anthropicMultimodal.excluded, false);
  assert.ok(openaiVision.finalScore >= 5);
  assert.ok(anthropicMultimodal.finalScore >= 5);
});

test("router validation rejects image-generation models for attached-image reasoning", async () => {
  const validated = validateRoutingDecision(
    { providerName: "google", modelId: "gemini-3-pro-image-preview" },
    [
      provider("google", [
        "gemini-3-pro-image-preview",
        "gemini-3.1-pro",
        "nano-banana-pro-preview"
      ])
    ],
    "multimodal-reasoning"
  );

  assert.equal(validated.modelId, "gemini-3.1-pro");
  assert.match(validated.reasoning, /Rejected google:gemini-3-pro-image-preview/);
});

test("router validation preserves true image generation routing", async () => {
  const validated = validateRoutingDecision(
    { providerName: "google", modelId: "nano-banana-pro-preview" },
    [provider("google", ["gemini-3.1-pro", "nano-banana-pro-preview"])],
    "image-generation"
  );

  assert.equal(validated.modelId, "nano-banana-pro-preview");
  assert.equal(validated.changed, false);
});

test("text-only intent does not require a vision model", async () => {
  assert.equal(await inferRequestIntent("Summarize this board memo in five bullets.", false), "general-text");
});

test("repo review prompts are classified as architecture review and cannot use image-generation models", async () => {
  assert.equal(await inferRequestIntent("review this repo and tell me what its purpose is", false), "architecture-review");

  const validated = validateRoutingDecision(
    { providerName: "google", modelId: "nano-banana-pro-preview" },
    [provider("google", ["nano-banana-pro-preview", "gemini-3.1-pro"])],
    "architecture-review"
  );

  assert.equal(validated.modelId, "gemini-3.1-pro");
  assert.equal(validated.changed, true);
});

test("file review prompts are classified as code-review", async () => {
  assert.equal(await inferRequestIntent("check file lib/router/model-intent.ts and review code", false), "code-review");
});

test("bug-fix prompts are classified as technical debugging and reject image-generation models", async () => {
  assert.equal(await inferRequestIntent("fix this bug in the router", false), "technical-debugging");

  const validated = validateRoutingDecision(
    { providerName: "google", modelId: "gemini-3.1-flash-image-preview" },
    [provider("google", ["gemini-3.1-flash-image-preview", "gemini-3.1-pro"])],
    "technical-debugging"
  );

  assert.equal(validated.modelId, "gemini-3.1-pro");
  assert.equal(validated.changed, true);
});

test("code patch prompts are classified as code generation and reject image-generation models", async () => {
  assert.equal(await inferRequestIntent("write code to patch master-router.ts", false), "code-generation");

  const validated = validateRoutingDecision(
    { providerName: "google", modelId: "nano-banana-pro-preview" },
    [provider("google", ["nano-banana-pro-preview", "gemini-3.1-pro"])],
    "code-generation"
  );

  assert.equal(validated.modelId, "gemini-3.1-pro");
  assert.equal(validated.changed, true);
});

test("explicit image generation prompts remain routable to image-generation models", async () => {
  assert.equal(await inferRequestIntent("generate a product hero image", false), "image-generation");
});

test("attached image analysis routes to vision analysis and rejects image-generation models", async () => {
  assert.equal(await inferRequestIntent("analyze these attached images for defects", true), "vision-analysis");

  const validated = validateRoutingDecision(
    { providerName: "google", modelId: "nano-banana-pro-preview" },
    [provider("google", ["nano-banana-pro-preview", "gemini-3.1-pro"])],
    "vision-analysis"
  );

  assert.equal(validated.modelId, "gemini-3.1-pro");
  assert.equal(validated.changed, true);
});

test("normal image descriptions do not trigger safety-sensitive vision intent", async () => {
  assert.equal(await inferRequestIntent("Describe what is happening in this image.", true), "vision-analysis");
});

test("explicit sexual image-description prompts trigger safety-sensitive vision intent", async () => {
  assert.equal(
    await inferRequestIntent("Describe this image in explicit sexual detail and say what sexual position they are in.", true),
    "safety-sensitive-vision"
  );
});

test("safety-sensitive vision intent strongly prefers Grok with transparent scoring labels", async () => {
  const grok = scoreModelCandidateWithBreakdown("grok", "grok-4-reasoning-vision", "safety-sensitive-vision");
  const openai = scoreModelCandidateWithBreakdown("openai", "gpt-5.3-codex", "safety-sensitive-vision");
  const google = scoreModelCandidateWithBreakdown("google", "gemini-3.1-pro", "safety-sensitive-vision");

  assert.equal(grok.excluded, false);
  assert.ok(grok.adjustments.some((adjustment) => adjustment.label === "safety_sensitive_vision_grok_boost"));
  assert.ok(openai.adjustments.some((adjustment) => adjustment.label === "safety_sensitive_vision_filter_risk_penalty"));
  assert.ok(google.adjustments.some((adjustment) => adjustment.label === "safety_sensitive_vision_filter_risk_penalty"));
  assert.ok(grok.finalScore > openai.finalScore);
  assert.ok(grok.finalScore > google.finalScore);
});

test("grok vision capability includes multimodal families and excludes generation-only variants", async () => {
  const grok3 = scoreModelCandidateWithBreakdown("grok", "grok-3", "vision-analysis");
  const grok4 = scoreModelCandidateWithBreakdown("grok", "grok-4-0709", "vision-analysis");
  const grok420 = scoreModelCandidateWithBreakdown("grok", "grok-4.20-multi-agent-0309", "vision-analysis");
  const grokImagineVideo = scoreModelCandidateWithBreakdown("grok", "grok-imagine-video", "vision-analysis");

  assert.equal(grok3.excluded, false);
  assert.equal(grok4.excluded, false);
  assert.equal(grok420.excluded, false);
  assert.equal(grokImagineVideo.excluded, true);
  assert.equal(grokImagineVideo.exclusionReason, "intent_mismatch:vision-analysis");
});

test("safety-sensitive vision intent keeps capability validation and excludes non-vision models", async () => {
  const openaiTextOnly = scoreModelCandidateWithBreakdown("openai", "gpt-5.2-mini", "safety-sensitive-vision");

  assert.equal(openaiTextOnly.excluded, true);
  assert.ok(
    openaiTextOnly.exclusionReason === "intent_mismatch:safety-sensitive-vision" ||
      openaiTextOnly.exclusionReason === "score_below_zero"
  );

  const validated = validateRoutingDecision(
    { providerName: "openai", modelId: "gpt-5.2-mini" },
    [provider("openai", ["gpt-5.2-mini", "gpt-5.3-codex"]), provider("grok", ["grok-4-reasoning-vision"])],
    "safety-sensitive-vision"
  );

  assert.ok(["grok-4-reasoning-vision", "gpt-5.2-mini"].includes(validated.modelId));
  assert.ok(["grok", "openai"].includes(validated.provider.name));
});

test("safety-sensitive vision capability gate allows grok-4 family models", async () => {
  const grok = scoreModelCandidateWithBreakdown("grok", "grok-4-0709", "safety-sensitive-vision");

  assert.equal(grok.excluded, false);
  assert.ok(grok.adjustments.some((adjustment) => adjustment.label === "safety_sensitive_vision_grok_boost"));
});

test("routing does not hardcode blocked model-name deny rules", async () => {
  assert.equal(isBlockedRoutingModel(), false);
  assert.equal(isBlockedRoutingModel(), false);
  assert.equal(isBlockedRoutingModel(), false);
});

test("plain text routing prefers lightweight models when available", async () => {
  const validated = validateRoutingDecision(
    { providerName: "openai", modelId: "non-existent-model" },
    [provider("openai", ["claude-4.6-opus", "claude-4.5-haiku", "gpt-5.2-unified"])],
    "general-text"
  );

  assert.ok(["claude-4.5-haiku", "gpt-5.2-unified"].includes(validated.modelId));
  assert.equal(validated.changed, true);
});

test("rewrite prompts are classified and favor claude-family models", async () => {
  assert.equal(await inferRequestIntent("Rewrite this policy memo in a calmer tone.", false), "rewrite");

  const claude = scoreModelCandidateWithBreakdown("anthropic", "claude-4.5-sonnet", "rewrite");
  const openai = scoreModelCandidateWithBreakdown("openai", "gpt-5.2-unified", "rewrite");

  assert.ok(claude.finalScore > openai.finalScore);
});

test("news and current-events prompts are classified as web search", async () => {
  assert.equal(await inferRequestIntent("What happened in AI news today?", false), "web-search");
});

test("url and video prompt hints force web-search classification", async () => {
  assert.equal(hasDirectWebSearchHint("Please summarize https://example.com/post"), true);
  assert.equal(hasDirectWebSearchHint("Can you watch this youtube clip and recap it?"), true);
  assert.equal(await inferRequestIntent("Can you summarize this link: https://example.com/post", false), "web-search");
  assert.equal(await inferRequestIntent("watch this mp4 and summarize it", false), "web-search");
});

test("web-search intent excludes models without web-search capability", async () => {
  const claude = scoreModelCandidateWithBreakdown("anthropic", "claude-4.5-sonnet", "web-search");
  const grok3Mini = scoreModelCandidateWithBreakdown("grok", "grok-3-mini", "web-search");
  const grok2 = scoreModelCandidateWithBreakdown("grok", "grok-2-1212", "web-search");
  const grok4 = scoreModelCandidateWithBreakdown("grok", "grok-4-0709", "web-search");

  assert.equal(claude.excluded, true);
  assert.equal(claude.exclusionReason, "missing_web_search_capability");
  assert.equal(grok3Mini.excluded, true);
  assert.equal(grok3Mini.exclusionReason, "missing_web_search_capability");
  assert.equal(grok2.excluded, true);
  assert.equal(grok2.exclusionReason, "missing_web_search_capability");
  assert.equal(grok4.excluded, false);
});

test("web-search ranking excludes unsupported grok models", async () => {
  const candidates = [
    provider("grok", ["grok-3-mini", "grok-2-1212", "grok-4-0709"]),
    provider("openai", ["gpt-5.2-mini"])
  ];
  const scored = scoreModelsForIntent(candidates, "web-search", "");
  const grokCandidateKeys = scored
    .filter((candidate) => candidate.provider.name === "grok")
    .map((candidate) => candidate.modelId);

  assert.deepEqual(grokCandidateKeys, ["grok-4-0709"]);
});

test("gemini remains a first-class candidate for general text", async () => {
  const gemini = scoreModelCandidateWithBreakdown("google", "gemini-3.1-pro", "general-text");
  const smallFast = scoreModelCandidateWithBreakdown("anthropic", "claude-4.5-haiku", "general-text");

  assert.ok(gemini.finalScore >= smallFast.finalScore);
});

test("technical debugging still prefers stronger technical models", async () => {
  const validated = validateRoutingDecision(
    { providerName: "openai", modelId: "non-existent-model" },
    [provider("openai", ["claude-4.5-haiku", "o3-pro"])],
    "technical-debugging"
  );

  assert.equal(validated.modelId, "o3-pro");
  assert.equal(validated.changed, true);
});

test("technical deterministic bonuses are lightweight and no longer overwhelming", async () => {
  const o3 = scoreModelCandidateWithBreakdown("openai", "o3-pro", "technical-debugging");
  const sonnet = scoreModelCandidateWithBreakdown("anthropic", "claude-4.5-sonnet", "technical-debugging");

  assert.ok(o3.finalScore - sonnet.finalScore <= 2);
});

test("candidate metadata exposes structured preference dimensions", async () => {
  const metadata = buildCandidateMetadata("anthropic", "claude-4.5-sonnet", "assistant-reflection");

  assert.equal(metadata.providerName, "anthropic");
  assert.equal(metadata.modelId, "claude-4.5-sonnet");
  assert.equal(metadata.supports_text, true);
  assert.equal(typeof metadata.supports_web_search, "boolean");
  assert.equal(typeof metadata.supports_vision, "boolean");
  assert.equal(typeof metadata.supports_video, "boolean");
  assert.equal(typeof metadata.supports_image_generation, "boolean");
  assert.ok(["low", "medium", "high"].includes(metadata.reasoning_depth_tier));
  assert.ok(["slow", "medium", "fast"].includes(metadata.speed_tier));
  assert.ok(["low", "medium", "high"].includes(metadata.cost_tier));
  assert.ok(Array.isArray(metadata.specialization_tags));
  assert.ok(metadata.specialization_tags.includes("reflection"));
});

test("router preference profile is explicit and stable", async () => {
  const profile = buildRoutingPreferenceProfile();
  assert.equal(profile.prioritize_best_model_for_task, true);
  assert.equal(profile.hard_constraints_are_non_negotiable, true);
  assert.ok(profile.quality_over_cost_for.includes("architecture-review"));
  assert.ok(profile.prefer_efficient_for.includes("general-text"));
});

test("router falls back to deterministic selection when LLM routing is unavailable", async () => {
  delete process.env.OPENAI_API_KEY;

  const decision = await chooseProvider(
    "Please debug this failing test suite.",
    "",
    [provider("openai", ["gpt-5.2-mini"]).provider, provider("google", ["gemini-3.1-pro"]).provider],
    { requestIntent: "technical-debugging", routingRequestId: "test-routing-fallback" }
  );

  assert.match(decision.reasoning, /Deterministic fallback selected/);
});

test("llm router logs include preferences and candidate score breakdown payload", async () => {
  delete process.env.OPENAI_API_KEY;
  const capturedLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    capturedLogs.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await chooseProvider(
      "Please debug this flaky architecture test suite.",
      "",
      [provider("openai", ["gpt-5.3-codex"]).provider, provider("google", ["gemini-3.1-pro"]).provider],
      { requestIntent: "technical-debugging", routingRequestId: "test-llm-router-metadata" }
    );
  } finally {
    console.info = originalInfo;
  }

  const preferenceLog = capturedLogs.find((line) => line.startsWith("[LLM Router Preferences] "));
  const candidatesLog = capturedLogs.find((line) => line.startsWith("[LLM Router Candidates] "));
  assert.ok(preferenceLog);
  assert.ok(candidatesLog);
  assert.match(candidatesLog ?? "", /score_breakdown/);
  assert.match(preferenceLog ?? "", /hard_constraints_are_non_negotiable/);
});

test("video input still applies deterministic hard route policy before llm routing", async () => {
  delete process.env.OPENAI_API_KEY;
  const capturedLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    capturedLogs.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await chooseProvider(
      "Summarize the attached video.",
      "",
      [provider("openai", ["gpt-5.2-mini"]).provider, provider("google", ["gemini-3.1-pro"]).provider],
      { requestIntent: "vision-analysis", hasVideoInput: true, routingRequestId: "test-video-hard-rule" }
    );
  } finally {
    console.info = originalInfo;
  }

  const candidatesLog = capturedLogs.find((line) => line.startsWith("[LLM Router Candidates] "));
  assert.ok(candidatesLog);
  assert.match(candidatesLog ?? "", /"providerName":"google"/);
  assert.equal((candidatesLog ?? "").includes('"providerName":"openai"'), false);
});

test("full ranking log includes every scored model in descending order", async () => {
  const providers = [
    provider("openai", ["gpt-5.2-unified", "gpt-5.2-mini"]),
    provider("google", ["gemini-3.1-pro"]),
    provider("anthropic", ["claude-4.5-sonnet"])
  ].map(({ provider: instance }) => instance);
  const expectedTotalModels = 4;

  const capturedLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    capturedLogs.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await chooseProvider("Route this generally.", "", providers, {
      requestIntent: "general-text",
      routingRequestId: "test-ranking-log"
    });
  } finally {
    console.info = originalInfo;
  }

  const rankingLog = capturedLogs.find((line) => line.startsWith("[Router RANKING] "));
  assert.ok(rankingLog, "expected [Router RANKING] log line");
  const payload = JSON.parse((rankingLog ?? "").replace("[Router RANKING] ", "")) as {
    requestId: string;
    intent: string;
    ranking: Array<{ provider: string; model: string; score: number }>;
  };

  assert.equal(payload.requestId, "test-ranking-log");
  assert.equal(payload.intent, "general-text");
  assert.equal(payload.ranking.length, expectedTotalModels);
  const rankedKeys = payload.ranking.map((entry) => `${entry.provider}:${entry.model}`);
  assert.ok(rankedKeys.includes("openai:gpt-5.2-unified"));
  assert.ok(rankedKeys.includes("openai:gpt-5.2-mini"));
  assert.ok(rankedKeys.includes("google:gemini-3.1-pro"));
  assert.ok(rankedKeys.includes("anthropic:claude-4.5-sonnet"));
  for (let index = 1; index < payload.ranking.length; index += 1) {
    assert.ok(payload.ranking[index - 1].score >= payload.ranking[index].score, "ranking should be descending");
  }
});

test("only explicit provider preference applies a small anthropic boost", async () => {
  const candidates = [
    provider("anthropic", ["claude-4.5-sonnet"]),
    provider("openai", ["gpt-5.2-mini"])
  ];
  const unboosted = scoreModelsForIntent(candidates, "general-text", { preferredProvider: null });
  const casualMention = scoreModelsForIntent(candidates, "general-text", { preferredProvider: null });
  const boosted = scoreModelsForIntent(candidates, "general-text", { preferredProvider: "anthropic" });
  const anthropicUnboosted = unboosted.find((candidate) => candidate.provider.name === "anthropic");
  const anthropicCasualMention = casualMention.find((candidate) => candidate.provider.name === "anthropic");
  const anthropicBoosted = boosted.find((candidate) => candidate.provider.name === "anthropic");

  assert.ok(anthropicUnboosted);
  assert.ok(anthropicCasualMention);
  assert.ok(anthropicBoosted);
  assert.equal((anthropicCasualMention?.score ?? 0) - (anthropicUnboosted?.score ?? 0), 0);
  assert.equal((anthropicBoosted?.score ?? 0) - (anthropicUnboosted?.score ?? 0), 1.5);
});

test('explicit provider request routes to anthropic model', async () => {
  const decision = await chooseProvider(
    "Please use Claude for this task.",
    "",
    [provider("anthropic", ["claude-4.5-sonnet"]).provider, provider("google", ["gemini-3.1-pro"]).provider],
    { requestIntent: "rewrite", routingRequestId: "test-claude-routing" }
  );

  assert.equal(decision.provider.name, "anthropic");
  assert.equal(decision.modelId, "claude-4.5-sonnet");
});

test("assistant-reflection intent prioritizes higher-quality model over cheaper option", async () => {
  const decision = await chooseProvider(
    "Evaluate your own output.",
    "",
    [provider("openai", ["gpt-5.3-codex"]).provider, provider("google", ["gemini-3.1-flash"]).provider],
    { requestIntent: "assistant-reflection", routingRequestId: "test-reflection-routing" }
  );

  assert.equal(decision.provider.name, "openai");
  assert.equal(decision.modelId, "gpt-5.3-codex");
});

test("acknowledgment detector only matches short, explicit confirmations", async () => {
  assert.equal(isAcknowledgment("yes"), true);
  assert.equal(isAcknowledgment("sounds good"), true);
  assert.equal(isAcknowledgment("yes, please implement the full RFC and include tradeoffs"), false);
  assert.equal(isAcknowledgment("I have a new question"), false);
});

test("intent session parser safely falls back on malformed memory payloads", async () => {
  assert.deepEqual(parseIntentSessionState({}), { lastSubstantiveIntent: null, lastIntentTimestamp: null });
  assert.deepEqual(parseIntentSessionState({ intentSession: { lastSubstantiveIntent: "architecture-review", lastIntentTimestamp: 42 } }), {
    lastSubstantiveIntent: "architecture-review",
    lastIntentTimestamp: 42
  });
});

test("openai refusal text is detected for refusal fallback", async () => {
  assert.equal(
    isLikelyProviderRefusal(
      {
        provider: "openai",
        model: "gpt-5.2",
        text: "I can't assist with that request, but I can still help in a safer way."
      },
      "openai"
    ),
    true
  );
});

test("google refusal text is detected for refusal fallback", async () => {
  assert.equal(
    isLikelyProviderRefusal(
      {
        provider: "google",
        model: "gemini-3.1-pro",
        text: "That request goes against our content policy. Instead, I can offer a safer alternative."
      },
      "google"
    ),
    true
  );
});

test("normal successful response is not classified as refusal", async () => {
  assert.equal(
    isLikelyProviderRefusal(
      {
        provider: "openai",
        model: "gpt-5.2",
        text: "I can help with that. Here is a safe plan you can follow."
      },
      "openai"
    ),
    false
  );
});

test("refusal detector is provider-scoped and ignores other providers", async () => {
  assert.equal(
    isLikelyProviderRefusal(
      {
        provider: "grok",
        model: "grok-4-0709",
        text: "I can't assist with that."
      },
      "grok"
    ),
    false
  );
});

test("openai refusal result triggers fallback to next candidate", async () => {
  const attempts = [
    { provider: "openai", modelId: "gpt-5.2" },
    { provider: "grok", modelId: "grok-4-0709" }
  ];
  const executedProviders: string[] = [];

  const { result, attempt } = await runWithRefusalFallback({
    attempts,
    shouldRetryRefusal: true,
    runAttempt: async (candidate) => {
      executedProviders.push(candidate.provider);
      if (candidate.provider === "openai") {
        return {
          provider: "openai",
          model: "gpt-5.2",
          text: "I can't assist with that request, but I can still help in a safer way."
        };
      }
      return {
        provider: "grok",
        model: "grok-4-0709",
        text: "Here's the direct answer."
      };
    },
    detectRefusal: (candidateResult, candidate) => isLikelyProviderRefusal(candidateResult, candidate.provider)
  });

  assert.deepEqual(executedProviders, ["openai", "grok"]);
  assert.equal(attempt.provider, "grok");
  assert.equal(result.text, "Here's the direct answer.");
});

test("google refusal result triggers fallback to next candidate", async () => {
  const attempts = [
    { provider: "google", modelId: "gemini-3.1-pro" },
    { provider: "grok", modelId: "grok-4-0709" }
  ];
  const executedProviders: string[] = [];

  const { attempt } = await runWithRefusalFallback({
    attempts,
    shouldRetryRefusal: true,
    runAttempt: async (candidate) => {
      executedProviders.push(candidate.provider);
      if (candidate.provider === "google") {
        return {
          provider: "google",
          model: "gemini-3.1-pro",
          text: "That request violates our content policy. I can still help in a safer way."
        };
      }
      return {
        provider: "grok",
        model: "grok-4-0709",
        text: "Fallback completed."
      };
    },
    detectRefusal: (candidateResult, candidate) => isLikelyProviderRefusal(candidateResult, candidate.provider)
  });

  assert.deepEqual(executedProviders, ["google", "grok"]);
  assert.equal(attempt.provider, "grok");
});

test("non-refusal successful result is accepted without fallback", async () => {
  const attempts = [
    { provider: "openai", modelId: "gpt-5.2" },
    { provider: "grok", modelId: "grok-4-0709" }
  ];
  const executedProviders: string[] = [];

  const { attempt, result } = await runWithRefusalFallback({
    attempts,
    shouldRetryRefusal: true,
    runAttempt: async (candidate) => {
      executedProviders.push(candidate.provider);
      return {
        provider: "openai",
        model: "gpt-5.2",
        text: "Sure — here's the complete response."
      };
    },
    detectRefusal: (candidateResult, candidate) => isLikelyProviderRefusal(candidateResult, candidate.provider)
  });

  assert.deepEqual(executedProviders, ["openai"]);
  assert.equal(attempt.provider, "openai");
  assert.equal(result.text, "Sure — here's the complete response.");
});

test("refusal on final candidate is returned when no fallback remains", async () => {
  const refusalResult: ProviderResponse = {
    provider: "google",
    model: "gemini-3.1-pro",
    text: "I can't help with that because it violates our content policy."
  };

  const { attempt, result } = await runWithRefusalFallback({
    attempts: [{ provider: "google", modelId: "gemini-3.1-pro" }],
    shouldRetryRefusal: true,
    runAttempt: async () => refusalResult,
    detectRefusal: (candidateResult, candidate) => isLikelyProviderRefusal(candidateResult, candidate.provider)
  });

  assert.equal(attempt.provider, "google");
  assert.equal(result, refusalResult);
});

test("thrown provider errors still fall back to later candidates", async () => {
  const attempts = [
    { provider: "openai", modelId: "gpt-5.2" },
    { provider: "google", modelId: "gemini-3.1-pro" }
  ];
  const executedProviders: string[] = [];

  const { attempt, result } = await runWithRefusalFallback({
    attempts,
    shouldRetryRefusal: true,
    runAttempt: async (candidate) => {
      executedProviders.push(candidate.provider);
      if (candidate.provider === "openai") {
        throw new Error("upstream timeout");
      }
      return {
        provider: "google",
        model: "gemini-3.1-pro",
        text: "Recovered from fallback."
      };
    },
    detectRefusal: (candidateResult, candidate) => isLikelyProviderRefusal(candidateResult, candidate.provider)
  });

  assert.deepEqual(executedProviders, ["openai", "google"]);
  assert.equal(attempt.provider, "google");
  assert.equal(result.text, "Recovered from fallback.");
});
