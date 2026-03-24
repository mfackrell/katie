import test from "node:test";
import assert from "node:assert/strict";
import { inferRequestIntent, validateRoutingDecision } from "../lib/router/model-intent";
import {
  isImageGenerationModel,
  isVisionAnalysisModel,
  supportsThinking
} from "../lib/providers/google-model-capabilities";
import type { LlmProvider } from "../lib/providers/types";

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

test("google thinking support is opt-in per model", () => {
  assert.equal(supportsThinking("gemini-3.1-pro"), true);
  assert.equal(supportsThinking("gemini-3-pro-image-preview"), false);
  assert.equal(supportsThinking("gemini-3.1-pro-vision"), false);
});

test("google model capability helpers separate generation from analysis", () => {
  assert.equal(isImageGenerationModel("nano-banana-pro-preview"), true);
  assert.equal(isImageGenerationModel("gemini-3-pro-image-preview"), false);
  assert.equal(isVisionAnalysisModel("gemini-3.1-pro"), true);
  assert.equal(isVisionAnalysisModel("gemini-3-pro-image-preview"), false);
  assert.equal(isVisionAnalysisModel("nano-banana-pro-preview"), false);
});

test("attached chart analysis is classified as multimodal reasoning", () => {
  assert.equal(
    inferRequestIntent("Read this chart, estimate the trend, and project the next 3 quarters.", true),
    "multimodal-reasoning"
  );
});

test("router validation rejects image-generation models for attached-image reasoning", () => {
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

test("router validation preserves true image generation routing", () => {
  const validated = validateRoutingDecision(
    { providerName: "google", modelId: "nano-banana-pro-preview" },
    [provider("google", ["gemini-3.1-pro", "nano-banana-pro-preview"])],
    "image-generation"
  );

  assert.equal(validated.modelId, "nano-banana-pro-preview");
  assert.equal(validated.changed, false);
});

test("text-only intent does not require a vision model", () => {
  assert.equal(inferRequestIntent("Summarize this board memo in five bullets.", false), "text");
});

test("repo review prompts are classified as architecture review and cannot use image-generation models", () => {
  assert.equal(inferRequestIntent("review this repo and tell me what its purpose is", false), "architecture-review");

  const validated = validateRoutingDecision(
    { providerName: "google", modelId: "nano-banana-pro-preview" },
    [provider("google", ["nano-banana-pro-preview", "gemini-3.1-pro"])],
    "architecture-review"
  );

  assert.equal(validated.modelId, "gemini-3.1-pro");
  assert.equal(validated.changed, true);
});

test("bug-fix prompts are classified as technical debugging and reject image-generation models", () => {
  assert.equal(inferRequestIntent("fix this bug in the router", false), "technical-debugging");

  const validated = validateRoutingDecision(
    { providerName: "google", modelId: "gemini-3.1-flash-image-preview" },
    [provider("google", ["gemini-3.1-flash-image-preview", "gemini-3.1-pro"])],
    "technical-debugging"
  );

  assert.equal(validated.modelId, "gemini-3.1-pro");
  assert.equal(validated.changed, true);
});

test("code patch prompts are classified as code generation and reject image-generation models", () => {
  assert.equal(inferRequestIntent("write code to patch master-router.ts", false), "code-generation");

  const validated = validateRoutingDecision(
    { providerName: "google", modelId: "nano-banana-pro-preview" },
    [provider("google", ["nano-banana-pro-preview", "gemini-3.1-pro"])],
    "code-generation"
  );

  assert.equal(validated.modelId, "gemini-3.1-pro");
  assert.equal(validated.changed, true);
});

test("explicit image generation prompts remain routable to image-generation models", () => {
  assert.equal(inferRequestIntent("generate a product hero image", false), "image-generation");
});

test("attached image analysis routes to vision analysis and rejects image-generation models", () => {
  assert.equal(inferRequestIntent("analyze these attached images for defects", true), "vision-analysis");

  const validated = validateRoutingDecision(
    { providerName: "google", modelId: "nano-banana-pro-preview" },
    [provider("google", ["nano-banana-pro-preview", "gemini-3.1-pro"])],
    "vision-analysis"
  );

  assert.equal(validated.modelId, "gemini-3.1-pro");
  assert.equal(validated.changed, true);
});
