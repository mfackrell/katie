import test from "node:test";
import assert from "node:assert/strict";
import {
  isCreativeNarrativeTurn, preferredClaudeCreativeModel,
  looksLikeFictionalPassage, assessCreativeRepetition,
  improveCreativeOriginality, CREATIVE_CONTINUITY_INSTRUCTIONS,
  CREATIVE_REWRITE_INSTRUCTIONS,
} from "../lib/chat/creative-continuity";

const fictionalPassage = [
  "I walk into the deserted station, listening to the last train rattle away.",
  "",
  "She reaches for the brass key, hesitates, and looks up at the darkened windows.",
  "",
  "“You said you would come before midnight,” she whispers. I turn toward the clock and feel the floor shiver beneath us.",
  "",
  "The ticket clerk appears from the next doorway and points to an old map.",
  "",
  "“There is one more train,” he says. “But it will not stop here again.” We look at each other, and I take the map.",
].join("\n").repeat(3);

test("direct creative prompts and established narrative continuations route to fiction", () => {
  const history = [{ role: "assistant" as const, content: JSON.stringify({ text: fictionalPassage }) }];
  assert.equal(looksLikeFictionalPassage(history[0].content), true);
  assert.equal(isCreativeNarrativeTurn("Continue the scene.", []), true);
  assert.equal(isCreativeNarrativeTurn("Write a story about friendship", []), true);
  assert.equal(isCreativeNarrativeTurn("Again! Keep going.", history), true);
  assert.equal(isCreativeNarrativeTurn("And then she opens the door.", history), true);
  assert.equal(isCreativeNarrativeTurn("What happens next?", history), true);
});

test("factual questions, attachments, tool work, and user model overrides preserve existing routing", () => {
  const history = [{ role: "assistant" as const, content: fictionalPassage }];
  for (const prompt of ["Review the latest Vercel logs", "Why is the deployment failing?",
                        "What time is it?", "Actually, new topic: tax planning",
                        "Fix the errors", "How do I reset my password?"]) {
    assert.equal(isCreativeNarrativeTurn(prompt, history), false, prompt);
  }
  assert.equal(isCreativeNarrativeTurn("Keep going", history, { hasVideoInput: true }), false);
  assert.equal(isCreativeNarrativeTurn("Keep going", history, { hasVisualInput: true }), false);
  assert.equal(isCreativeNarrativeTurn("Keep going", history, { hasRepoContext: true }), false);
  assert.equal(isCreativeNarrativeTurn("Continue the scene", history, { hasManualOverride: true }), false);
  assert.equal(isCreativeNarrativeTurn("Again", [{ role: "assistant", content: "Tax bracket: 24%." }]), false);
});

test("Fable 5.1 is preferred when actually available; absent Fable Claude can be preferred", () => {
  assert.equal(preferredClaudeCreativeModel(["claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5"]), "claude-fable-5-1");
  assert.equal(preferredClaudeCreativeModel(["claude-sonnet-5-5", "claude-opus-5"]), "claude-sonnet-5-5");
  assert.equal(preferredClaudeCreativeModel(["grok-4.7", "gpt-6"]), null);
  assert.match(CREATIVE_CONTINUITY_INSTRUCTIONS, /perspective/);
  assert.match(CREATIVE_CONTINUITY_INSTRUCTIONS, /new development/);
  assert.match(CREATIVE_REWRITE_INSTRUCTIONS, /same beat|same gestures|earlier sentences/i);
});

const narrativeA = Array.from({ length: 18 }, (_, i) =>
  `I walk to the lantern and turn it carefully. She watches the doorway and points to the silver key. Scene ${i}.`
).join(" ");
const narrativeB = Array.from({ length: 18 }, (_, i) =>
  `The mountain path opens beneath the moon. We climb past the frozen river while the wind shakes the trees. Moment ${i}.`
).join(" ");

test("repetition detector finds copy-heavy prose but not a genuinely new scene", () => {
  const repeated = assessCreativeRepetition(narrativeA, [narrativeA]);
  assert.equal(repeated.repetitive, true);
  assert.ok(repeated.maxOverlap > 0.9);
  assert.equal(assessCreativeRepetition(narrativeB, [narrativeA]).repetitive, false);
  assert.equal(assessCreativeRepetition("Short reply", [narrativeA]).repetitive, false);
});

test("high repetition gets exactly one rewrite and the lower overlap wins", async () => {
  let calls = 0;
  const answer = await improveCreativeOriginality({
    text: narrativeA,
    priorAssistantTexts: [narrativeA],
    rewrite: async () => { calls++; return narrativeB; },
  });
  assert.equal(calls, 1);
  assert.equal(answer.revised, true);
  assert.equal(answer.text, narrativeB);
  assert.ok(answer.finalOverlap < answer.originalOverlap);
});

test("failed, refused/empty and more repetitive rewrites cannot corrupt successful response", async () => {
  const failed = await improveCreativeOriginality({
    text: narrativeA, priorAssistantTexts: [narrativeA],
    rewrite: async () => { throw new Error("provider temporarily unavailable"); },
  });
  assert.equal(failed.text, narrativeA);
  assert.equal(failed.revised, false);
  const empty = await improveCreativeOriginality({
    text: narrativeA, priorAssistantTexts: [narrativeA],
    rewrite: async () => "",
  });
  assert.equal(empty.text, narrativeA);
  const same = await improveCreativeOriginality({
    text: narrativeA, priorAssistantTexts: [narrativeA],
    rewrite: async () => narrativeA,
  });
  assert.equal(same.text, narrativeA);
});

test("chat route wires creative routing, continuity context, and originality checks", async () => {
  const { readFileSync } = await import("node:fs");
  const chatRoute = readFileSync("app/api/chat/route.ts", "utf8");
  assert.match(chatRoute, /isCreativeNarrativeTurn\(/);
  assert.match(chatRoute, /preferredClaudeCreativeModel\(/);
  assert.match(chatRoute, /CREATIVE_CONTINUITY_INSTRUCTIONS/);
  assert.match(chatRoute, /improveCreativeOriginality\(/);
  assert.match(chatRoute, /CREATIVE_REWRITE_INSTRUCTIONS/);
  assert.match(chatRoute, /Grok secondary fallback retained/);
  assert.match(chatRoute, /fallbackChain\.push\(\{ provider: grok, modelId: grokModel/);
});
