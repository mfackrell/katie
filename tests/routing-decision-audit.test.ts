import test from "node:test";
import assert from "node:assert/strict";
import {
  guardExplicitWrittenObjective,
  parseIntentClassifierResponse,
  type RequestClassification,
  type RequestIntent
} from "../lib/router/model-intent";

const intents: RequestIntent[] = [
  "rewrite", "image-generation", "general-text", "vision-analysis", "social-emotional", "architecture-review"
];
const mistaken: RequestClassification = {
  intent: "image-generation",
  preferred_provider: null,
  secondary_intents: ["rewrite"],
  complexity: "medium",
  response_purpose: "deliverable"
};

test("November 16 incident preserves explicit biography-writing objective despite playful visual context", () => {
  const message = "FB is about as far down the rabbit hole i'm willing to go. write me a revised bio that will land! and get me the chick like the one GPT made....😏😂";
  const result = guardExplicitWrittenObjective(message, mistaken);
  assert.equal(result.overridden, true);
  assert.equal(result.classification.intent, "rewrite");
  assert.deepEqual(result.classification.secondary_intents, []);
  assert.equal(result.reason, "explicit_written_objective_with_image_reference");
});

test("explicit image-generation requests remain image generation", () => {
  for (const message of [
    "Generate a new portrait of the woman we discussed.",
    "Create an image of the couple at the beach.",
    "Draw an illustration of the profile photo."
  ]) {
    assert.deepEqual(guardExplicitWrittenObjective(message, mistaken), {
      classification: mistaken, overridden: false, reason: null
    });
  }
});

test("image critique without a writing command is not converted to rewrite by guard", () => {
  const input: RequestClassification = { intent: "vision-analysis", preferred_provider: null };
  assert.deepEqual(
    guardExplicitWrittenObjective("What would you change about that generated picture?", input),
    { classification: input, overridden: false, reason: null }
  );
});

test("explicit image editing is not mistaken for rewriting", () => {
  const input: RequestClassification = { intent: "image-generation", preferred_provider: null };
  assert.equal(guardExplicitWrittenObjective("Edit the background of that portrait.", input).classification.intent, "image-generation");
});

test("genuine compound request retains image generation as a secondary objective", () => {
  const result = guardExplicitWrittenObjective(
    "Write a short dating bio and generate an accompanying portrait.",
    mistaken
  );
  assert.equal(result.classification.intent, "rewrite");
  assert.deepEqual(result.classification.secondary_intents, ["image-generation"]);
  assert.equal(result.reason, "written_objective_precedes_explicit_image_objective");
});

test("image-first compound instructions preserve image-first classification", () => {
  const result = guardExplicitWrittenObjective(
    "Generate a portrait, then write a short dating bio.",
    mistaken
  );
  assert.equal(result.overridden, false);
  assert.equal(result.classification.intent, "image-generation");
});

test("other explicit written deliverables take precedence over incidental images", () => {
  for (const message of [
    "Draft me an email about the image we made yesterday.",
    "Write a caption about this photograph.",
    "Revise my profile description to mention my hobby of photography.",
    "Compose a letter inspired by the painting."
  ]) {
    assert.equal(guardExplicitWrittenObjective(message, mistaken).classification.intent, "rewrite", message);
  }
});

test("brief conversational follow-up remains unchanged", () => {
  const input: RequestClassification = { intent: "social-emotional", preferred_provider: null };
  assert.equal(guardExplicitWrittenObjective("That's hilarious 😂", input).classification.intent, "social-emotional");
});

test("classification evidence is bounded, parsed and preserved for private checkpoint auditing", () => {
  const parsed = parseIntentClassifierResponse(JSON.stringify({
    intent: "rewrite",
    preferred_provider: null,
    primary_objective: "Draft a concise profile bio",
    objective_evidence: ["write me a revised bio"],
    context_influence: "Reference to a previously generated image is background context",
    alternative_intents: ["image-generation", "not-an-intent"],
    selection_justification: "An explicit written deliverable is the user's requested outcome",
    secondary_objectives: []
  }), intents, "test");
  assert.equal(parsed.intent, "rewrite");
  assert.equal(parsed.decision_evidence?.primary_objective, "Draft a concise profile bio");
  assert.deepEqual(parsed.decision_evidence?.objective_evidence, ["write me a revised bio"]);
  assert.deepEqual(parsed.decision_evidence?.alternative_intents, ["image-generation"]);
  assert.deepEqual(parsed.decision_evidence?.secondary_objectives, []);
});

test("legacy classification without diagnostic metadata remains backward compatible", () => {
  const parsed = parseIntentClassifierResponse(
    JSON.stringify({ intent: "general-text", preferred_provider: "openai" }),
    intents, "test"
  );
  assert.deepEqual(parsed, { intent: "general-text", preferred_provider: "openai" });
});
