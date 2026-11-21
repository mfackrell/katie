import test from "node:test";
import assert from "node:assert/strict";
import { rankBestValueFallbackCandidates } from "@/lib/router/best-value-fallback";
import { getModelPrice } from "@/lib/standalone-accounting/pricing";
import {
  bestValueEvidenceCost, buildCandidateMetadata, compareBestValueQualifiedJudgments,
  type ProviderName, type RequestComplexity, type RequestIntent,
} from "@/lib/router/model-intent";

/** Every model uses real reviewed prices on main, never mock invented rates. */
const providerModels: Array<[ProviderName, string]> = [
  ["anthropic", "claude-sonnet-4-6"],
  ["anthropic", "claude-haiku-5-5"], // PR 1155 owns its missing verified price
  ["openai", "gpt-5-mini"],
  ["openai", "gpt-5.4"],
  ["google", "gemini-2.5-flash"],
  ["grok", "grok-4.3"],
];
const prompts: Array<{message: string; intent: RequestIntent; complexity: RequestComplexity; context?: string}> = [
  {message: "Good morning Katie", intent: "general-text", complexity: "low"},
  {message: "He was very gentle", intent: "social-emotional", complexity: "low", context: "Continue a relaxed personal conversation naturally."},
  {message: "Indeed", intent: "social-emotional", complexity: "low"},
  {message: "My goat is acting like he runs the farm", intent: "social-emotional", complexity: "low", context: "Playful dog and goat stories."},
  {message: "Katie, that was wrong. Don't lecture me.", intent: "assistant-reflection", complexity: "low"},
  {message: "Explain a painful relationship dynamic carefully, acknowledging uncertainty and context", intent: "social-emotional", complexity: "high"},
  {message: "Compare complex theological arguments about grace and free will", intent: "general-text", complexity: "high"},
  {message: "Diagnose a distributed transaction race in a financial payment service", intent: "technical-debugging", complexity: "high"},
];
function rank(message: string, intent: RequestIntent, complexity: RequestComplexity | null, context = "") {
  const candidates = providerModels.map(([providerName, modelId]) => ({
    providerName, modelId, metadata: buildCandidateMetadata(providerName, modelId, intent),
  }));
  return rankBestValueFallbackCandidates(candidates, {prompt: message, context, intent, complexity});
}

for (const {message, intent, complexity, context} of prompts) {
  test(`Best Value fallback: ${message}`, () => {
    const ranking = rank(message, intent, complexity, context);
    assert.ok(ranking.length, "at least one capability-qualified fallback exists");
    assert.ok(ranking[0].modeledCostMicrousd !== null, "reviewed price is required for a quantitative cost conclusion");
    assert.ok(BigInt(ranking[0].modeledCostMicrousd!) > 0n, "cost is not invented as zero");
    if (complexity === "low") {
      assert.equal(ranking[0].modelId, "gpt-5-mini",
        "a routine conversational request does not require premium capacity");
      assert.ok(ranking.some(c => c.modelId === "claude-sonnet-4-6"),
        "premium models remain qualified, but cannot outrank a cheaper sufficient fit on reputation alone");
    } else {
      assert.ok(!ranking.some(c => /mini|haiku|flash/.test(c.modelId)),
        "materially demanding tasks must not be won by low-tier models just because they cost less");
      assert.equal(ranking[0].requiredDepth, "high");
    }
  });
}

test("unknown complexity is treated conservatively; short text does not prove easy context", () => {
  const result = rank("Indeed", "social-emotional", null, "Long unresolved emotional conversation");
  assert.equal(result[0].requiredDepth, "medium");
  assert.ok(!result.some(candidate => /mini|haiku|flash/.test(candidate.modelId)));
});

test("Haiku stays qualified and uses only independently reviewed pricing from PR 1155", () => {
  const result = rank("Good morning Katie", "general-text", "low");
  const haiku = result.find(candidate => candidate.modelId === "claude-haiku-5-5");
  assert.ok(haiku);
  assert.equal(haiku.modeledCostMicrousd === null,
    getModelPrice("anthropic", "claude-haiku-5-5") === undefined,
    "Before PR 1155, its quote must be unknown; after that independent price merges, use the new verified rate without changing this PR");
});

test("all four providers are compared on equal price and capability rules", () => {
  const result = rank("Good morning Katie", "general-text", "low");
  assert.deepEqual(new Set(result.map(candidate => candidate.providerName)),
    new Set(["anthropic", "openai", "google", "grok"]));
  const priced = result.filter(candidate => candidate.modeledCostMicrousd !== null);
  assert.ok(priced.every((item, i) => i === 0 || BigInt(priced[i - 1].modeledCostMicrousd!) <= BigInt(item.modeledCostMicrousd!)));
});

const cheap = {key:"openai:gpt-5-mini", votes:1, qualityEvidence:0, estimatedCostMicrousd:"500"};
const premium = {key:"anthropic:claude-sonnet-4-6", votes:3, qualityEvidence:0, estimatedCostMicrousd:"5000"};
test("qualified routine arbitration chooses economical fit, not premium majority", () => {
  assert.ok(compareBestValueQualifiedJudgments(cheap, premium, true) < 0);
  assert.ok(compareBestValueQualifiedJudgments(premium, cheap, true) > 0);
});
test("genuine task-specific quality evidence or complex-task consensus prevents a bad cheap win", () => {
  assert.ok(compareBestValueQualifiedJudgments(cheap, {...premium,qualityEvidence:1}, true) > 0);
  assert.ok(compareBestValueQualifiedJudgments({...cheap,qualityEvidence:-1}, premium, true) > 0);
  assert.ok(compareBestValueQualifiedJudgments(cheap, premium, false) > 0);
});
test("unknown prices are not treated as free or as a disqualifying quality claim", () => {
  const unknown = {...cheap, estimatedCostMicrousd:null};
  assert.ok(compareBestValueQualifiedJudgments(unknown, premium, true) > 0);
  assert.equal(bestValueEvidenceCost({}),null);
  assert.equal(bestValueEvidenceCost({serialized_request:{status:"unverified",estimatedCostMicrousd:"0"}}),null);
  assert.equal(bestValueEvidenceCost({serialized_request:{status:"estimated",estimatedCostMicrousd:"1200"}}),"1200");
  assert.equal(bestValueEvidenceCost({expected_all_in_micro_usd:"1500"}),"1500");
});
