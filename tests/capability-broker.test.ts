import test from "node:test";
import assert from "node:assert/strict";
import { buildRequestCapabilityProfile, scoreCandidateForCapabilityProfile } from "../lib/router/capability-broker";
import { chooseProvider } from "../lib/router/master-router";
import type { LlmProvider } from "../lib/providers/types";

function fakeProvider(name: LlmProvider["name"], models: string[]): LlmProvider {
  return {
    name,
    async listModels() {
      return models;
    },
    async generate() {
      return { text: "{}", done: true } as never;
    }
  };
}

test("capability profile generation mappings and audit heuristics", () => {
  const social = buildRequestCapabilityProfile({ prompt: "Can we talk about how I feel?", intent: "social-emotional", hasImages: false, hasVideoInput: false, context: "" });
  assert.equal(social.prefersNaturalConversation, true);

  const web = buildRequestCapabilityProfile({ prompt: "find latest events", intent: "web-search", hasImages: false, hasVideoInput: false, context: "" });
  assert.equal(web.requiresWebSearch, true);

  const codeReview = buildRequestCapabilityProfile({ prompt: "review this repo diff", intent: "code-review", hasImages: false, hasVideoInput: false, context: "x".repeat(12000) });
  assert.equal(codeReview.requiresRepoReasoning, true);
  assert.equal(codeReview.contextShape, "repo-scale");

  const debug = buildRequestCapabilityProfile({ prompt: "debug failing API and return JSON schema payload", intent: "technical-debugging", hasImages: false, hasVideoInput: false, context: "" });
  assert.equal(debug.requiresStructuredOutputs, true);

  const imageGen = buildRequestCapabilityProfile({ prompt: "create image", intent: "image-generation", hasImages: false, hasVideoInput: false, context: "" });
  assert.equal(imageGen.requiresImageGeneration, true);

  const multimodal = buildRequestCapabilityProfile({ prompt: "analyze chart", intent: "multimodal-reasoning", hasImages: true, hasVideoInput: false, context: "" });
  assert.equal(multimodal.requiresVision, true);

  const audit = buildRequestCapabilityProfile({ prompt: "audit and reconcile financial accuracy for compliance", intent: "general-text", hasImages: false, hasVideoInput: false, context: "" });
  assert.equal(audit.precisionRequirement, "audit-grade");
  assert.equal(audit.riskProfile, "financial");
});

test("candidate capability scoring preferences", () => {
  const deepProfile = buildRequestCapabilityProfile({ prompt: "perform deep architecture review", intent: "architecture-review", hasImages: false, hasVideoInput: false, context: "" });
  const deepStrong = scoreCandidateForCapabilityProfile({ profile: deepProfile, providerName: "openai", modelId: "gpt-5.3-codex" });
  const deepFast = scoreCandidateForCapabilityProfile({ profile: deepProfile, providerName: "google", modelId: "gemini-3.1-flash" });
  assert.ok(deepStrong.total > deepFast.total);

  const cheapProfile = buildRequestCapabilityProfile({ prompt: "quick summary", intent: "general-text", hasImages: false, hasVideoInput: false, context: "" });
  cheapProfile.costSensitivity = "aggressive";
  const cheapFast = scoreCandidateForCapabilityProfile({ profile: cheapProfile, providerName: "google", modelId: "gemini-3.1-flash" });
  const cheapHeavy = scoreCandidateForCapabilityProfile({ profile: cheapProfile, providerName: "anthropic", modelId: "claude-4.6-opus" });
  assert.ok(cheapFast.total > cheapHeavy.total);

  const socialProfile = buildRequestCapabilityProfile({ prompt: "I need emotional support", intent: "social-emotional", hasImages: false, hasVideoInput: false, context: "" });
  const socialSmall = scoreCandidateForCapabilityProfile({ profile: socialProfile, providerName: "google", modelId: "gemini-3.1-flash" });
  const socialNuanced = scoreCandidateForCapabilityProfile({ profile: socialProfile, providerName: "anthropic", modelId: "claude-4.5-sonnet" });
  assert.ok(socialNuanced.total > socialSmall.total);

  const structuredProfile = buildRequestCapabilityProfile({ prompt: "return strict JSON schema", intent: "general-text", hasImages: false, hasVideoInput: false, context: "" });
  const structuredStrong = scoreCandidateForCapabilityProfile({ profile: structuredProfile, providerName: "openai", modelId: "gpt-5.2" });
  const structuredWeak = scoreCandidateForCapabilityProfile({ profile: structuredProfile, providerName: "google", modelId: "gemini-3.1-flash" });
  assert.ok(structuredStrong.total > structuredWeak.total);

  const repoProfile = buildRequestCapabilityProfile({ prompt: "refactor monorepo", intent: "code-generation", hasImages: false, hasVideoInput: false, context: "repo".repeat(2000) });
  const repoStrong = scoreCandidateForCapabilityProfile({ profile: repoProfile, providerName: "openai", modelId: "gpt-5.3-codex" });
  const repoSmall = scoreCandidateForCapabilityProfile({ profile: repoProfile, providerName: "google", modelId: "gemini-3.1-flash" });
  assert.ok(repoStrong.total > repoSmall.total);
});

test("router integration keeps override/video/fallback behavior", async () => {
  const google = fakeProvider("google", ["gemini-3.1-pro", "gemini-3.1-flash"]);
  const openai = fakeProvider("openai", ["gpt-5.2", "gpt-5.3-codex"]);

  const videoSelection = await chooseProvider("analyze this", "", [google, openai], {
    requestIntent: "multimodal-reasoning",
    hasVideoInput: true,
    routingTraceEnabled: false
  });
  assert.equal(videoSelection.provider.name, "google");

  const overrideSelection = await chooseProvider("debug this", "", [google, openai], {
    resolvedIntent: { intent: "technical-debugging", preferredProvider: "openai", intentSource: "upstream" },
    routingTraceEnabled: false
  });
  assert.equal(overrideSelection.provider.name, "openai");

  const fallbackSelection = await chooseProvider("write code", "", [openai], {
    requestIntent: "code-generation",
    routingTraceEnabled: false
  });
  assert.ok(fallbackSelection.fallbackChain.length >= 0);
});
