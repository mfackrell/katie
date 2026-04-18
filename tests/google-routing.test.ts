import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCandidateMetadata,
  buildRoutingPreferenceProfile,
  hasDirectWebSearchHint,
  inferRequestClassification,
  inferRequestIntent,
  inferRequestIntentFromMultimodalInput,
  parseIntentClassifierResponse,
  scoreModelsForIntent,
  scoreModelCandidateWithBreakdown,
  validateRoutingDecision
} from "../lib/router/model-intent";
import { chooseProvider, selectControlPlaneDecisionModels, type ResolvedRoutingIntent } from "../lib/router/master-router";
import { createNeutralActorRoutingProfile, normalizeActorRoutingProfile } from "../lib/router/actor-routing-profile";
import { isAcknowledgment, parseIntentSessionState } from "../lib/router/intent-context";
import { isBlockedRoutingModel } from "../lib/router/routing-model-filters";
import {
  isImageGenerationModel,
  isVisionAnalysisModel,
  supportsThinking
} from "../lib/providers/google-model-capabilities";
import type { LlmProvider, ProviderResponse } from "../lib/providers/types";
import { isLikelyProviderRefusal, runWithRefusalFallback } from "../lib/router/refusal-detection";

function provider(
  name: LlmProvider["name"],
  models: string[],
  generateImpl?: (params: { user: string; modelId?: string }) => Promise<ProviderResponse>
): { provider: LlmProvider; models: string[] } {
  return {
    provider: {
      name,
      async listModels() {
        return models;
      },
      async generate(params) {
        if (generateImpl) {
          return generateImpl({ user: params.user, modelId: params.modelId });
        }
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

test("socially nuanced prompt is classified into social-emotional lane", async () => {
  assert.equal(await inferRequestIntent("how are you feeling?", false), "social-emotional");
});

test("banter greeting routes to social-emotional lane", async () => {
  assert.equal(await inferRequestIntent("what up kat?", false), "social-emotional");
});

test("personality complaint routes to social-emotional lane", async () => {
  assert.equal(await inferRequestIntent("i need you to develop a fucking personality ...", false), "social-emotional");
});

test("social-emotional fallback heuristic still classifies when control-plane providers fail", async () => {
  const unavailableDecisionProvider = provider("openai", ["gpt-5.2-mini"], async () => {
    throw new Error("control plane unavailable");
  });
  assert.equal(
    await inferRequestIntent("what's your sense of this?", false, {
      decisionProviders: [{ provider: unavailableDecisionProvider.provider, modelId: "gpt-5.2-mini" }]
    }),
    "social-emotional"
  );
});

test("social-emotional fallback heuristic works for intent+provider classification when control-plane fails", async () => {
  const unavailableDecisionProvider = provider("openai", ["gpt-5.2-mini"], async () => {
    throw new Error("control plane unavailable");
  });
  const classified = await inferRequestClassification("what up kat?", false, {
    decisionProviders: [{ provider: unavailableDecisionProvider.provider, modelId: "gpt-5.2-mini" }]
  });

  assert.equal(classified.intent, "social-emotional");
  assert.equal(classified.preferredProvider, null);
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

test("social-emotional lane suppresses gemini general bonus and favors nuanced providers", async () => {
  const geminiFlashLite = scoreModelCandidateWithBreakdown("google", "gemini-3.1-flash-lite-preview", "social-emotional");
  const claudeSonnet = scoreModelCandidateWithBreakdown("anthropic", "claude-4.5-sonnet", "social-emotional");
  const grok4 = scoreModelCandidateWithBreakdown("grok", "grok-4-0709", "social-emotional");
  const openaiGpt5 = scoreModelCandidateWithBreakdown("openai", "gpt-5.2-unified", "social-emotional");

  assert.equal(geminiFlashLite.adjustments.some((adjustment) => adjustment.label === "gemini_general_reasoning_bonus"), false);
  assert.equal(geminiFlashLite.adjustments.some((adjustment) => adjustment.label === "speed_efficiency_bonus"), false);
  assert.ok(geminiFlashLite.adjustments.some((adjustment) => adjustment.label === "social_emotional_speed_bonus_suppressed"));
  assert.ok(claudeSonnet.finalScore > geminiFlashLite.finalScore);
  assert.ok(grok4.finalScore > geminiFlashLite.finalScore);
  assert.ok(openaiGpt5.finalScore > geminiFlashLite.finalScore);
});

test("social-emotional lane ranks depth-first conversational models above speed-first variants", async () => {
  const haiku = scoreModelCandidateWithBreakdown("anthropic", "claude-haiku-4-5-20251001", "social-emotional");
  const opus = scoreModelCandidateWithBreakdown("anthropic", "claude-4.6-opus", "social-emotional");
  const grokMini = scoreModelCandidateWithBreakdown("grok", "grok-3-mini", "social-emotional");
  const grok4 = scoreModelCandidateWithBreakdown("grok", "grok-4-0709", "social-emotional");
  const gptMini = scoreModelCandidateWithBreakdown("openai", "gpt-5.2-mini", "social-emotional");
  const gptUnified = scoreModelCandidateWithBreakdown("openai", "gpt-5.2-unified", "social-emotional");

  assert.ok(opus.finalScore > haiku.finalScore);
  assert.ok(grok4.finalScore > grokMini.finalScore);
  assert.ok(gptUnified.finalScore > gptMini.finalScore);
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

test("code-review routing prefers technical models over lightweight text models", async () => {
  const validated = validateRoutingDecision(
    { providerName: "openai", modelId: "non-existent-model" },
    [provider("openai", ["gpt-5.2-mini", "gpt-5.3-codex"])],
    "code-review"
  );

  assert.equal(validated.modelId, "gpt-5.3-codex");
  assert.equal(validated.changed, true);
});

test("code-review scoring uses technical adjustments and avoids general-text penalties", async () => {
  const codex = scoreModelCandidateWithBreakdown("openai", "gpt-5.3-codex", "code-review");
  const mini = scoreModelCandidateWithBreakdown("openai", "gpt-5.2-mini", "code-review");

  assert.equal(codex.baseScore, 10);
  assert.ok(codex.adjustments.some((adjustment) => adjustment.label === "coding_reasoning_bonus"));
  assert.ok(codex.adjustments.some((adjustment) => adjustment.label === "latest_gpt_bonus"));
  assert.ok(codex.adjustments.every((adjustment) => adjustment.label !== "deep_reasoning_penalty"));
  assert.ok(codex.finalScore > mini.finalScore);
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
  assert.ok(profile.quality_over_cost_for.includes("social-emotional"));
  assert.ok(profile.prefer_efficient_for.includes("general-text"));
  assert.equal(profile.prefer_efficient_for.includes("social-emotional"), false);
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

test("router control-plane classification works without openai when another eligible non-google provider is available", async () => {
  delete process.env.OPENAI_API_KEY;
  const anthropicDecisionProvider = provider("anthropic", ["claude-4.5-sonnet"], async ({ user, modelId }) => {
    const text = user.includes("Intent Classifier")
      ? JSON.stringify({ intent: "rewrite", preferred_provider: "anthropic" })
      : JSON.stringify({ selected: { provider: "anthropic", model: "claude-4.5-sonnet" } });
    return { text, model: modelId ?? "claude-4.5-sonnet", provider: "anthropic" };
  }).provider;
  const openaiUnavailable = provider("openai", ["gpt-5.2-mini"], async () => {
    throw new Error("openai unavailable");
  }).provider;

  const decision = await chooseProvider("How should I improve this paragraph for clarity?", "", [openaiUnavailable, anthropicDecisionProvider], {
    routingRequestId: "test-cross-provider-intent-classification"
  });

  assert.equal(decision.explainer?.selected_source, "llm-primary");
  assert.equal(decision.explainer?.fallback_used, false);
});

test("router reranker accepts first successful compatible provider without heuristic fallback", async () => {
  const attempts: string[] = [];
  const anthropicFail = provider("anthropic", ["claude-4.5-sonnet"], async () => {
    attempts.push("anthropic");
    throw new Error("upstream timeout");
  }).provider;
  const openaiPass = provider("openai", ["gpt-5.3-codex"], async ({ user, modelId }) => {
    attempts.push("openai");
    const text = user.includes("\"candidates\"")
      ? JSON.stringify({ selected: { provider: "openai", model: "gpt-5.3-codex" } })
      : JSON.stringify({ intent: "technical-debugging", preferred_provider: null });
    return { text, model: modelId ?? "gpt-5.3-codex", provider: "openai" };
  }).provider;

  const decision = await chooseProvider("Please debug this flaky architecture test suite.", "", [openaiPass, anthropicFail], {
    requestIntent: "technical-debugging",
    routingRequestId: "test-control-plane-failover"
  });

  assert.deepEqual(attempts, ["openai"]);
  assert.ok(attempts.includes("openai"));
  assert.equal(attempts.includes("anthropic"), false);
  assert.equal(decision.explainer?.selected_source, "llm-primary");
  assert.equal(decision.explainer?.fallback_used, false);
});

test("router uses heuristics as last resort only when all decision providers fail", async () => {
  const openaiFail = provider("openai", ["gpt-5.2-mini"], async () => {
    throw new Error("down");
  }).provider;
  const googleFail = provider("google", ["gemini-3.1-pro"], async () => {
    throw new Error("down");
  }).provider;

  const decision = await chooseProvider("Please debug this flaky architecture test suite.", "", [openaiFail, googleFail], {
    requestIntent: "technical-debugging",
    routingRequestId: "test-last-resort-heuristic"
  });

  assert.equal(decision.explainer?.selected_source, "deterministic-fallback");
  assert.equal(decision.explainer?.fallback_used, true);
  assert.match(decision.explainer?.fallback_reason ?? "", /llm_router_rejected:no_decision_provider_available/);
});

test("control-plane capability filtering excludes non-text models from decision provider selection", async () => {
  const imageOnly = provider("google", ["nano-banana-pro-preview"], async () => {
    throw new Error("should not be called");
  }).provider;
  const textProvider = provider("anthropic", ["claude-4.5-sonnet"]).provider;

  const decision = await chooseProvider("Please rewrite this paragraph.", "", [imageOnly, textProvider], {
    requestIntent: "rewrite",
    routingRequestId: "test-control-plane-capability-filter"
  });

  assert.notEqual(decision.provider.name, "google");
  assert.equal(decision.explainer?.selected_source, "deterministic-fallback");
  assert.match(decision.explainer?.fallback_reason ?? "", /all_decision_providers_failed/);
});

test("control-plane selects explicit flagship models instead of first-two list ordering", async () => {
  const attempts: string[] = [];
  const openai = provider("openai", ["gpt-5.2-mini", "gpt-5.2-nano", "gpt-5.3-codex"], async ({ modelId }) => {
    attempts.push(`openai:${modelId ?? "none"}`);
    throw new Error("down");
  }).provider;
  const google = provider("google", ["gemini-3.1-flash", "gemini-3.1-pro"], async ({ modelId }) => {
    attempts.push(`google:${modelId ?? "none"}`);
    throw new Error("down");
  }).provider;

  await chooseProvider("Route generally.", "", [openai, google], {
    requestIntent: "general-text",
    routingRequestId: "test-control-plane-explicit-flagship-selection"
  });

  assert.ok(attempts.includes("openai:gpt-5.3-codex"));
  assert.equal(attempts.includes("openai:gpt-5.2-mini"), false);
  assert.equal(attempts.some((attempt) => attempt.startsWith("google:")), false);
});

test("control-plane selection skips dead blocked decision models", async () => {
  const selected = selectControlPlaneDecisionModels([
    {
      provider: provider("google", ["gemini-2.0-flash", "gemini-3.1-pro"]).provider,
      models: ["gemini-2.0-flash", "gemini-3.1-pro"]
    }
  ]);

  assert.deepEqual(selected.map((entry) => `${entry.provider.name}:${entry.modelId}`), []);
});

test("control-plane excludes incompatible google decision model variants", async () => {
  const selected = selectControlPlaneDecisionModels([
    {
      provider: provider("google", ["gemma-3-12b-it", "gemini-3.1-pro"]).provider,
      models: ["gemma-3-12b-it", "gemini-3.1-pro"]
    }
  ]);

  assert.deepEqual(selected.map((entry) => `${entry.provider.name}:${entry.modelId}`), []);
});

test("control-plane uses exactly one decision model per provider in fixed provider priority order", async () => {
  const attempts: string[] = [];
  const providers = [
    provider("grok", ["grok-4-0709"], async ({ modelId }) => {
      attempts.push(`grok:${modelId ?? "none"}`);
      throw new Error("down");
    }).provider,
    provider("anthropic", ["claude-4.5-sonnet"], async ({ modelId }) => {
      attempts.push(`anthropic:${modelId ?? "none"}`);
      throw new Error("down");
    }).provider,
    provider("openai", ["gpt-5.3-codex", "gpt-5.2-mini"], async ({ modelId }) => {
      attempts.push(`openai:${modelId ?? "none"}`);
      throw new Error("down");
    }).provider,
    provider("google", ["gemini-3.1-pro", "gemini-3.1-flash"], async ({ modelId }) => {
      attempts.push(`google:${modelId ?? "none"}`);
      throw new Error("down");
    }).provider
  ];

  const decision = await chooseProvider("Route generally.", "", providers, {
    requestIntent: "general-text",
    routingRequestId: "test-control-plane-provider-priority-order"
  });

  assert.deepEqual(attempts, [
    "openai:gpt-5.3-codex",
    "anthropic:claude-4.5-sonnet",
    "grok:grok-4-0709"
  ]);
  assert.equal(decision.explainer?.selected_source, "deterministic-fallback");
  assert.match(decision.explainer?.fallback_reason ?? "", /all_decision_providers_failed/);
});

test("dead or unsupported control-plane model failure does not break routing", async () => {
  const attempts: string[] = [];
  const googleMixed = provider("google", ["gemini-2.0-flash", "gemini-3.1-pro"], async ({ user, modelId }) => {
    attempts.push(`google:${modelId ?? "none"}`);
    if (user.includes("\"candidates\"")) {
      throw new Error("google reranker unavailable");
    }
    return { text: JSON.stringify({ intent: "technical-debugging", preferred_provider: null }), model: modelId ?? "gemini-3.1-pro", provider: "google" };
  }).provider;
  const openaiHealthy = provider("openai", ["gpt-5.3-codex"], async ({ user, modelId }) => {
    attempts.push(`openai:${modelId ?? "none"}`);
    const text = user.includes("\"candidates\"")
      ? JSON.stringify({ selected: { provider: "openai", model: "gpt-5.3-codex" } })
      : JSON.stringify({ intent: "technical-debugging", preferred_provider: null });
    return { text, model: modelId ?? "gpt-5.3-codex", provider: "openai" };
  }).provider;

  const decision = await chooseProvider("please fix this production exception", "", [googleMixed, openaiHealthy], {
    routingRequestId: "test-dead-model-skip-and-failover"
  });

  assert.equal(attempts.includes("google:gemini-2.0-flash"), false);
  assert.equal(decision.provider.name, "openai");
});

test("control-plane falls back to strongest compatible provider model when flagship is unavailable", async () => {
  const attempts: string[] = [];
  const openai = provider("openai", ["gpt-5.2-mini", "gpt-5.2-unified"], async ({ modelId }) => {
    attempts.push(`openai:${modelId ?? "none"}`);
    return {
      text: JSON.stringify({ selected: { provider: "openai", model: "gpt-5.2-unified" } }),
      model: modelId ?? "gpt-5.2-unified",
      provider: "openai"
    };
  }).provider;

  const decision = await chooseProvider("Route generally.", "", [openai], {
    requestIntent: "general-text",
    routingRequestId: "test-control-plane-flagship-fallback"
  });

  assert.deepEqual(attempts, ["openai:gpt-5.2-unified"]);
  assert.equal(decision.explainer?.selected_source, "llm-primary");
});

test("router uses upstream requestIntent as authoritative and skips local classification", async () => {
  delete process.env.OPENAI_API_KEY;
  const capturedLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    capturedLogs.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await chooseProvider(
      "Please debug this failing test suite.",
      "",
      [provider("openai", ["gpt-5.2-mini"]).provider, provider("google", ["gemini-3.1-pro"]).provider],
      {
        resolvedIntent: { intent: "rewrite", preferredProvider: "anthropic", intentSource: "upstream" },
        routingRequestId: "test-upstream-intent-authoritative"
      }
    );
  } finally {
    console.info = originalInfo;
  }

  const routeIntentLog = capturedLogs.find((line) => line.startsWith("[Route Intent] "));
  const routePolicyLog = capturedLogs.find((line) => line.startsWith("[Route Policy] "));
  assert.ok(routeIntentLog);
  assert.ok(routePolicyLog);
  assert.match(routeIntentLog ?? "", /caller_request_intent=rewrite/);
  assert.match(routeIntentLog ?? "", /classifier_intent=skipped/);
  assert.match(routeIntentLog ?? "", /effective_intent=rewrite/);
  assert.match(routeIntentLog ?? "", /intent_source=upstream/);
  assert.match(routePolicyLog ?? "", /intent=rewrite/);
});

test("chooseProvider returns resolved router intent for downstream propagation", async () => {
  const decision = await chooseProvider(
    "how are you feeling today?",
    "",
    [provider("openai", ["gpt-5.2-unified"]).provider],
    { routingRequestId: "test-resolved-intent-propagation" }
  );

  assert.equal(decision.resolvedIntent.intent, "social-emotional");
  assert.equal(decision.resolvedIntent.intentSource, "router-fallback");
});

test("explicit upstream override intent takes precedence over prompt-derived intent", async () => {
  delete process.env.OPENAI_API_KEY;
  const capturedLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    capturedLogs.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await chooseProvider(
      "Please debug this failing test suite.",
      "",
      [provider("openai", ["gpt-5.2-mini"]).provider, provider("google", ["gemini-3.1-pro"]).provider],
      { requestIntent: "web-search", routingRequestId: "test-upstream-override-precedence" }
    );
  } finally {
    console.info = originalInfo;
  }

  const routeIntentLog = capturedLogs.find((line) => line.startsWith("[Route Intent] "));
  assert.ok(routeIntentLog);
  assert.match(routeIntentLog ?? "", /effective_intent=web-search/);
  assert.doesNotMatch(routeIntentLog ?? "", /effective_intent=technical-debugging/);
});

test("router falls back to local classification only when upstream requestIntent is absent", async () => {
  delete process.env.OPENAI_API_KEY;
  const capturedLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    capturedLogs.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await chooseProvider(
      "Please debug this failing test suite.",
      "",
      [provider("openai", ["gpt-5.2-mini"]).provider, provider("google", ["gemini-3.1-pro"]).provider],
      { routingRequestId: "test-local-classification-fallback" }
    );
  } finally {
    console.info = originalInfo;
  }

  const routeIntentLog = capturedLogs.find((line) => line.startsWith("[Route Intent] "));
  assert.ok(routeIntentLog);
  assert.match(routeIntentLog ?? "", /caller_request_intent=none/);
  assert.doesNotMatch(routeIntentLog ?? "", /classifier_intent=skipped/);
  assert.match(routeIntentLog ?? "", /effective_intent=technical-debugging/);
  assert.match(routeIntentLog ?? "", /intent_source=router-fallback/);
});

test("control-plane misclassification to code-generation is sanitized for conversational prompts", async () => {
  const forceBadClassifier = provider("openai", ["gpt-5.3-codex"], async ({ modelId }) => ({
    text: JSON.stringify({ intent: "code-generation", preferred_provider: null }),
    model: modelId ?? "gpt-5.3-codex",
    provider: "openai"
  })).provider;

  const intent = await inferRequestIntent("develop a personality", false, {
    decisionProviders: [{ provider: forceBadClassifier, modelId: "gpt-5.3-codex" }]
  });
  const classified = await inferRequestClassification("what do you think of me?", false, {
    decisionProviders: [{ provider: forceBadClassifier, modelId: "gpt-5.3-codex" }]
  });

  assert.equal(intent, "social-emotional");
  assert.equal(classified.intent, "social-emotional");
});

test("resolved intent contract shape is identical for upstream and router-fallback paths", async () => {
  delete process.env.OPENAI_API_KEY;
  const capturedLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    capturedLogs.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await chooseProvider(
      "Please rewrite this paragraph.",
      "",
      [provider("openai", ["gpt-5.2-mini"]).provider],
      {
        resolvedIntent: { intent: "rewrite", preferredProvider: null, intentSource: "upstream" },
        routingRequestId: "test-resolved-intent-upstream-shape"
      }
    );
    await chooseProvider(
      "Please debug this failing test suite.",
      "",
      [provider("openai", ["gpt-5.2-mini"]).provider],
      { routingRequestId: "test-resolved-intent-fallback-shape" }
    );
  } finally {
    console.info = originalInfo;
  }

  const resolvedLogs = capturedLogs
    .filter((line) => line.startsWith("[Route Intent Resolved] "))
    .map((line) => JSON.parse(line.replace("[Route Intent Resolved] ", "")) as ResolvedRoutingIntent);

  const upstream = resolvedLogs.find((entry) => entry.intentSource === "upstream");
  const fallback = resolvedLogs.find((entry) => entry.intentSource === "router-fallback");
  assert.ok(upstream);
  assert.ok(fallback);
  assert.deepEqual(Object.keys(upstream!).sort(), ["intent", "intentSource", "preferredProvider"]);
  assert.deepEqual(Object.keys(fallback!).sort(), ["intent", "intentSource", "preferredProvider"]);
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
  assert.equal((anthropicBoosted?.score ?? 0) - (anthropicUnboosted?.score ?? 0), 8);
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

test("explicit Gemini preference is retained in social-emotional lane when Google final candidates exist", async () => {
  const decision = await chooseProvider(
    "gemini, what do you think about all of this?",
    "",
    [provider("google", ["gemini-3.1-pro"]).provider, provider("openai", ["gpt-5.2-mini"]).provider],
    {
      resolvedIntent: { intent: "social-emotional", preferredProvider: "google", intentSource: "upstream" },
      routingRequestId: "test-gemini-explicit-social-emotional"
    }
  );

  assert.equal(decision.resolvedIntent.preferredProvider, "google");
  assert.equal(decision.provider.name, "google");
});

test("google can be excluded from control-plane judges while still eligible as final response provider", async () => {
  const entries = [
    provider("google", ["gemini-3.1-pro"]),
    provider("openai", ["gpt-5.3-codex"])
  ];
  const controlPlane = selectControlPlaneDecisionModels(
    entries.map(({ provider: instance, models }) => ({ provider: instance, models })),
    undefined,
    "test-google-control-plane-excluded"
  );
  assert.equal(controlPlane.some((candidate) => candidate.provider.name === "google"), false);

  const decision = await chooseProvider(
    "gemini, help me think this through",
    "",
    entries.map(({ provider: instance }) => instance),
    {
      resolvedIntent: { intent: "social-emotional", preferredProvider: "google", intentSource: "upstream" },
      routingRequestId: "test-google-final-eligible"
    }
  );
  assert.equal(decision.provider.name, "google");
});

test("impossible preferred provider is cleared before ranking and logs why", async () => {
  const capturedLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    capturedLogs.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const decision = await chooseProvider(
      "please use gemini",
      "",
      [provider("openai", ["gpt-5.3-codex"]).provider],
      {
        resolvedIntent: { intent: "technical-debugging", preferredProvider: "google", intentSource: "upstream" },
        routingRequestId: "test-impossible-provider-cleared"
      }
    );

    assert.equal(decision.resolvedIntent.preferredProvider, null);
  } finally {
    console.info = originalInfo;
  }

  const clearLog = capturedLogs.find((line) => line.includes("[Provider Preference]") && line.includes("action=cleared"));
  assert.ok(clearLog);
  assert.match(clearLog ?? "", /original=google/);
  assert.match(clearLog ?? "", /remaining_providers=openai/);
});

test("router logs do not report contradictory preferred provider after clearing", async () => {
  const capturedLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    capturedLogs.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await chooseProvider(
      "use gemini for this debug request",
      "",
      [provider("openai", ["gpt-5.3-codex"]).provider],
      {
        resolvedIntent: { intent: "technical-debugging", preferredProvider: "google", intentSource: "upstream" },
        routingRequestId: "test-no-contradictory-preference-log"
      }
    );
  } finally {
    console.info = originalInfo;
  }

  const routeDecisionLog = capturedLogs.find((line) => line.startsWith("[Router] intent="));
  assert.ok(routeDecisionLog);
  assert.equal((routeDecisionLog ?? "").includes("google:"), false);
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

test("social-emotional routing avoids cheap fast small models by default without explicit provider request", async () => {
  const decision = await chooseProvider(
    "what do you think about everything going on right now?",
    "",
    [provider("openai", ["gpt-5.2-mini"]).provider, provider("anthropic", ["claude-4.5-sonnet"]).provider],
    { requestIntent: "social-emotional", routingRequestId: "test-social-emotional-quality-over-speed" }
  );

  assert.equal(decision.provider.name, "anthropic");
  assert.equal(decision.modelId, "claude-4.5-sonnet");
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

test("actor routing profile schema normalization clamps aggressive values", async () => {
  const normalized = normalizeActorRoutingProfile({
    providerBoosts: { openai: 8, google: -9, anthropic: 0.2, grok: 0 },
    tagBoosts: {
      coding: 10,
      debugging: -10,
      architecture: 0,
      writing: 0,
      "emotional-nuance": 0,
      conversational: 0,
      interpersonal: 0,
      empathy: 0,
      multimodal: 0,
      research: 0,
      reflection: 0
    },
    intentProviderBoosts: {
      general: { openai: 0, google: 0, anthropic: 0, grok: 0 },
      "technical-debugging": { openai: 8, google: 0, anthropic: 0, grok: 0 },
      "architecture-design": { openai: 0, google: 0, anthropic: 0, grok: 0 },
      "coding-implementation": { openai: 0, google: 0, anthropic: 0, grok: 0 },
      "writing-editing": { openai: 0, google: 0, anthropic: 0, grok: 0 },
      "research-analysis": { openai: 0, google: 0, anthropic: 0, grok: 0 },
      "emotional-support": { openai: 0, google: 0, anthropic: 0, grok: 0 }
    },
    summary: "test",
    generatedByModel: null,
    version: "v1"
  });

  assert.equal(normalized.providerBoosts.openai, 3);
  assert.equal(normalized.providerBoosts.google, -3);
  assert.equal(normalized.tagBoosts.coding, 3);
  assert.equal(normalized.tagBoosts.debugging, -3);
  assert.equal(normalized.intentProviderBoosts["technical-debugging"].openai, 3);
});

test("actor routing profile adds soft scoring bias for technical models", async () => {
  const profile = createNeutralActorRoutingProfile("technical");
  profile.providerBoosts.openai = 1.2;
  profile.providerBoosts.anthropic = 1.1;
  profile.providerBoosts.google = -0.8;
  profile.tagBoosts.coding = 1;
  profile.tagBoosts.debugging = 0.6;
  profile.intentProviderBoosts["technical-debugging"].openai = 0.8;

  const openai = scoreModelCandidateWithBreakdown("openai", "gpt-5.3-codex", "technical-debugging", { actorRoutingProfile: profile });
  const google = scoreModelCandidateWithBreakdown("google", "gemini-3.1-pro", "technical-debugging", { actorRoutingProfile: profile });

  assert.ok(openai.adjustments.some((adjustment) => adjustment.label === "actor_routing_bias"));
  assert.ok(openai.finalScore > google.finalScore);
});

test("actor routing bias remains additive and does not bypass capability constraints", async () => {
  const profile = createNeutralActorRoutingProfile("vision");
  profile.providerBoosts.openai = 2.5;
  profile.intentProviderBoosts["emotional-support"].openai = 1.5;

  const excluded = scoreModelCandidateWithBreakdown("openai", "gpt-5.2-mini", "safety-sensitive-vision", { actorRoutingProfile: profile });
  assert.equal(excluded.excluded, true);
  assert.match(excluded.exclusionReason ?? "", /intent_mismatch|score_below_zero/);
});

test("actor routing bias is visible in provider selection explainer", async () => {
  const profile = createNeutralActorRoutingProfile("coding actor");
  profile.providerBoosts.openai = 1.4;
  profile.tagBoosts.coding = 1.1;
  profile.intentProviderBoosts["coding-implementation"].openai = 0.8;

  const providers: LlmProvider[] = [
    {
      name: "openai",
      async listModels() {
        return ["gpt-5.3-codex"];
      },
      async generate() {
        return { provider: "openai", model: "gpt-5.3-codex", text: "{\"selected\":{\"provider\":\"openai\",\"model\":\"gpt-5.3-codex\"}}" };
      }
    },
    {
      name: "google",
      async listModels() {
        return ["gemini-3.1-pro"];
      },
      async generate() {
        return { provider: "google", model: "gemini-3.1-pro", text: "{\"selected\":{\"provider\":\"google\",\"model\":\"gemini-3.1-pro\"}}" };
      }
    }
  ];

  const decision = await chooseProvider("Patch this function", "context", providers, {
    resolvedIntent: { intent: "code-generation", preferredProvider: null, intentSource: "upstream" as ResolvedRoutingIntent["intentSource"] },
    actorId: "actor-test-1",
    actorRoutingProfile: profile
  });

  assert.equal(decision.explainer?.actor_routing?.applied, true);
  assert.equal(decision.explainer?.actor_routing?.actor_id, "actor-test-1");
  assert.ok((decision.explainer?.actor_routing?.adjustments?.length ?? 0) > 0);
});
