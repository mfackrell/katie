import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGrokImageContextSource, composeGrokImagePrompt, grokImageCondensationInstructions,
  needsGrokImageContext, GROK_IMAGE_PROMPT_MAX_CHARS
} from "../lib/providers/grok-image-context";
import type { ChatGenerateParams } from "../lib/providers/types";

const input: ChatGenerateParams = {
  name: "Katie", persona: "LONG_TERM_MEMORY: visual actor profile with durable image anchors",
  summary: "They have been friends since childhood.",
  history: [
    { role: "user", content: "Jess trains for marathons." },
    { role: "assistant", content: "Katie is the bookkeeper." },
  ],
  user: "Create an image of Jess and Katie at the house",
  modelId: "grok-imagine-image-quality",
};

test("context source includes persona / LTM, older summary, and verbatim role-labelled recent history", () => {
  const source = buildGrokImageContextSource(input);
  assert.ok(source.indexOf("LONG_TERM_MEMORY") < source.indexOf("They have been friends"));
  assert.match(source, /USER: Jess trains for marathons/);
  assert.match(source, /ASSISTANT: Katie is the bookkeeper/);
  assert.match(source, /CURRENT IMAGE REQUEST/);
  assert.equal(needsGrokImageContext(input), true);
});

test("scene instructions remain first and byte-exact; context fits maximum image endpoint budget", () => {
  const draft = composeGrokImagePrompt(input.user, "Jess is an avid marathon runner. Katie keeps the books.");
  assert.ok(draft.prompt.startsWith(input.user + "\n\n"));
  assert.match(draft.prompt, /Katie keeps the books/);
  assert.ok(draft.prompt.length <= GROK_IMAGE_PROMPT_MAX_CHARS);
  assert.equal(draft.backgroundTruncated, false);
});

test("even a long memory condensation cannot exceed Grok's 1024-character prompt limit", () => {
  const long = composeGrokImagePrompt(input.user, "Visual trait. ".repeat(1000));
  assert.ok(long.prompt.length <= GROK_IMAGE_PROMPT_MAX_CHARS);
  assert.equal(long.backgroundTruncated, true);
});

test("long user requests require image-task condensation rather than silent truncation", () => {
  const prompt = "A".repeat(1050);
  assert.throws(() => composeGrokImagePrompt(prompt, ""), /condensation required/);
  const compact = composeGrokImagePrompt(prompt, "Scene with all requested characters and lighting.");
  assert.equal(compact.backgroundIncluded, true);
  assert.ok(compact.prompt.length <= GROK_IMAGE_PROMPT_MAX_CHARS);
  assert.match(grokImageCondensationInstructions(prompt), /complete single-image prompt/);
});

test("no-memory simple prompts avoid unnecessary additional model requests", () => {
  assert.equal(needsGrokImageContext({ ...input, persona: "Be helpful.", summary: "", history: [] }), false);
});

test("character memory synthesis instructions prioritize established facts and exclude unrelated history", () => {
  const text = grokImageCondensationInstructions(input.user);
  assert.match(text, /relevant facts/);
  assert.match(text, /Jess/);
  assert.match(text, /no more than \d+ characters/);
});
