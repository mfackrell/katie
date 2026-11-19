import test from "node:test";
import assert from "node:assert/strict";
import { officialModelSpec, parseOfficialModelEvidence, fetchOfficialModelEvidence } from "../lib/models/provider-evidence";
import { computeRoutingEligibility, retainOfficialModelEvidence } from "../lib/models/registry";

const openaiDoc = [
  "# GPT-6.2 Astra",
  "Model ID: " + "\x60gpt-6.2-astra\x60",
  "## Model details",
  "- Input modalities: text, image",
  "- Output modalities: text",
  "- 1,050,000 context window",
  "- 128,000 max output tokens",
  "- Reasoning token support",
  "## Pricing",
  "### Text tokens",
  "| Metric | Price | Unit |",
  "| --- | ---: | --- |",
  "| Input | $8 | 1M tokens |",
  "| Output | $40 | 1M tokens |",
  "- For requests with more than 272K input tokens, rates increase.",
  "## Endpoints",
  "| Endpoint | Route | Support |",
  "| Responses | " + "\x60v1/responses\x60" + " | Supported |",
  "| Chat Completions | " + "\x60v1/chat/completions\x60" + " | Supported |",
  "## Supported features",
  "- structured_outputs",
  "- function_calling",
  "- web_search",
  "## Unsupported features",
  "- fine_tuning"
].join("\n");

const anthropicDoc = [
  "# Claude Opus 5.5",
  "Model ID: " + "\x60claude-opus-5-5\x60",
  "Context window: 1M tokens · Max output: 128K tokens · Input pricing: $4 / MTok · Output pricing: $20 / MTok",
  "## Specifications",
  "### Model IDs",
  "| Platform | Model ID |",
  "| Claude API | " + "\x60claude-opus-5-5\x60" + " |",
  "### Pricing",
  "| Feature | Value |",
  "| Input | $4 / MTok |",
  "| Output | $20 / MTok |",
  "### Capabilities",
  "| Feature | Value |",
  "| [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) | Adaptive (always on) |",
  "| Input → output | Text and images → text |",
  "### Availability"
].join("\n");

function syntheticRecord(nowIso: string) {
  return {
    provider_name: "openai",
    model_id: "gpt-6.2-astra",
    normalized_model_id: "gpt-6.2-astra",
    discovered_at: nowIso,
    last_seen_at: nowIso,
    is_active: true,
    discovery_status: "discovered",
    pricing_status: "estimated",
    capability_status: "heuristic",
    routing_eligibility: "restricted",
    confidence_score: 0.65,
    confidence_tier: "medium",
    source_metadata: { capability_source: "heuristic", pricing_source: "pricing_catalog" },
    pricing_input_per_1m: 8,
    pricing_output_per_1m: 40,
    supports_text: true,
    supports_vision: false,
    supports_web_search: false,
    supports_image_generation: false,
    supports_video: false,
    reasoning_tier: "medium",
    speed_tier: "medium",
    cost_tier: "high",
    capability_verified_at: null,
    pricing_verified_at: null,
    verification_updated_at: nowIso,
    failure_reason: null,
    last_exception_at: null
  } as Parameters<typeof retainOfficialModelEvidence>[0];
}

test("official OpenAI documentation independently validates exact ID, two base rates, modalities and real endpoint", () => {
  const spec = officialModelSpec("openai", "gpt-6.2-astra");
  assert.ok(spec);
  const evidence = parseOfficialModelEvidence(spec, openaiDoc);
  assert.ok(evidence);
  assert.equal(evidence.documentedModelId, "gpt-6.2-astra");
  assert.deepEqual(evidence.supportedEndpoints, ["responses", "chat_completions"]);
  assert.equal(evidence.pricingMatchesApprovedSchedule, true);
  assert.equal(evidence.contextWindowTokens, 1050000);
  assert.equal(evidence.maxOutputTokens, 128000);
  assert.equal(evidence.hasVariableLongContextRates, true);
  assert.equal(evidence.supportsWebSearch, true);
  assert.equal(parseOfficialModelEvidence(spec, openaiDoc.replace("gpt-6.2-astra", "other-model")), null);
  assert.equal(parseOfficialModelEvidence(spec, openaiDoc.replace("Supported |\n| Chat", "Not supported |\n| Chat")), null);
  assert.equal(parseOfficialModelEvidence(spec, openaiDoc.replace("- Input modalities: text, image", "- Input modalities: audio")), null);
});

test("a published price change never erases verified capabilities or claims new prices were preapproved", () => {
  const spec = officialModelSpec("openai", "gpt-6.2-astra")!;
  const changed = parseOfficialModelEvidence(spec, openaiDoc.replace("| Input | $8 |", "| Input | $9 |"))!;
  assert.equal(changed.pricingMatchesApprovedSchedule, false);
  const now = "2026-11-18T22:00:00.000Z";
  const row = retainOfficialModelEvidence(syntheticRecord(now), undefined, changed, now);
  assert.equal(row.capability_status, "verified");
  assert.equal(row.pricing_status, "estimated");
  assert.equal(row.routing_eligibility, "restricted");
  assert.equal(row.source_metadata.pricing_revalidation_status, "published_rates_changed_requires_review");
  assert.equal(computeRoutingEligibility({capability_status:"verified",pricing_status:"estimated",confidence_score:0.95}), "restricted");
});

test("Anthropic first-party documentation qualifies specific Opus and Sonnet, not invented Fable claims", () => {
  const spec = officialModelSpec("anthropic", "claude-opus-5-5")!;
  const evidence = parseOfficialModelEvidence(spec, anthropicDoc);
  assert.ok(evidence);
  assert.deepEqual(evidence.supportedEndpoints, ["messages"]);
  assert.equal(evidence.pricingMatchesApprovedSchedule, true);
  assert.equal(evidence.reasoningTier, "high");
  assert.equal(parseOfficialModelEvidence(spec, anthropicDoc.replace("Claude API |", "Other API |")), null);
  assert.equal(parseOfficialModelEvidence(officialModelSpec("anthropic", "claude-sonnet-5-5")!, anthropicDoc), null);
  assert.equal(officialModelSpec("anthropic", "claude-fable-5-2")?.modelId, "claude-fable-5-2");
  assert.equal(parseOfficialModelEvidence(officialModelSpec("anthropic", "claude-fable-5-2")!, anthropicDoc), null);
});

test("official source checks use public unauthenticated GET; no model inference or provider credentials", async () => {
  const spec = officialModelSpec("openai", "gpt-6.2-astra")!;
  const calls: Array<{url:string;options: RequestInit}> = [];
  const evidence = await fetchOfficialModelEvidence(spec, spec.modelId, async (url,options) => {
    calls.push({url: String(url),options: options!});
    return new Response(openaiDoc, {status: 200, headers: {"content-type":"text/markdown"}});
  });
  assert.ok(evidence);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, spec.documentUrl);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.method, undefined);
  assert.equal(JSON.stringify(calls[0].options).includes("Authorization"), false);
});

test("prior verified evidence survives a missing documentation response but expires from strict eligibility", () => {
  const spec = officialModelSpec("openai", "gpt-6.2-astra")!;
  const now = "2026-11-18T22:00:00.000Z";
  const evidence = parseOfficialModelEvidence(spec, openaiDoc)!;
  const fresh = retainOfficialModelEvidence(syntheticRecord(now), undefined, evidence, now);
  assert.equal(fresh.capability_status, "verified");
  assert.equal(fresh.pricing_status, "verified");
  assert.equal(fresh.routing_eligibility, "verified");
  assert.equal(fresh.capability_verified_at, now);
  assert.equal(fresh.source_metadata.inference_account_verified, false);

  const next = "2026-11-18T22:20:00.000Z";
  const retained = retainOfficialModelEvidence(syntheticRecord(next), fresh, null, next);
  assert.equal(retained.routing_eligibility, "verified");
  assert.equal(retained.capability_verified_at, now);
  assert.equal(retained.pricing_verified_at, now);

  const staleTime = "2026-11-20T22:00:00.000Z";
  const stale = retainOfficialModelEvidence(syntheticRecord(staleTime), fresh, null, staleTime);
  assert.equal(stale.capability_status, "verified");
  assert.equal(stale.routing_eligibility, "restricted");
  assert.equal(stale.pricing_status, "estimated");
  assert.equal(stale.capability_verified_at, now);
  assert.equal(stale.source_metadata.capability_evidence_current, false);
  assert.equal(stale.source_metadata.previous_pricing_verified_at, now);
});

test("a definitive, unsupported model does not become verified from a different model's page", () => {
  assert.equal(officialModelSpec("grok","made-up-model"), null);
  const spec = officialModelSpec("openai","gpt-5.5-pro-2026-04-23")!;
  assert.equal(spec.modelId,"gpt-5.5-pro");
  assert.equal(parseOfficialModelEvidence(spec,openaiDoc,"gpt-5.5-pro-2026-04-23"),null);
});

test("PostgREST numeric-string verified rates survive an ordinary documentation refresh", () => {
  const now = "2026-11-18T20:00:00.000Z";
  const prior = {
    ...syntheticRecord(now),
    capability_status: "verified",
    pricing_status: "verified",
    capability_verified_at: "2026-11-18T19:00:00.000Z",
    pricing_verified_at: "2026-11-18T19:00:00.000Z",
    pricing_input_per_1m: "8",
    pricing_output_per_1m: "40",
    source_metadata: {
      capability_evidence_basis: "first_party_model_documentation",
      capability_verification_source: "https://developers.openai.com/api/docs/models/gpt-6.2-astra.md",
      pricing_verification_source: "https://developers.openai.com/api/docs/models/gpt-6.2-astra.md"
    }
  } as unknown as Parameters<typeof retainOfficialModelEvidence>[1];
  const row = retainOfficialModelEvidence(syntheticRecord(now), prior, null, now);
  assert.equal(row.pricing_status, "verified");
  assert.equal(row.pricing_input_per_1m, 8);
  assert.equal(row.pricing_output_per_1m, 40);
  assert.equal(row.routing_eligibility, "verified");
  assert.equal(row.pricing_verified_at, "2026-11-18T19:00:00.000Z");
});

test("verified numeric rates reject invalid PostgREST values and accept canonical decimal strings", () => {
  const now = "2026-11-18T20:00:00.000Z";
  const evidence = parseOfficialModelEvidence(officialModelSpec("openai", "gpt-6.2-astra")!, openaiDoc)!;
  const trusted = retainOfficialModelEvidence(syntheticRecord(now), undefined, evidence, now);
  for (const [input, output] of [["0.10", "40"], ["8", "40"], [8, 40]] as const) {
    const prior = { ...trusted, pricing_input_per_1m: input, pricing_output_per_1m: output } as unknown as Parameters<typeof retainOfficialModelEvidence>[1];
    const row = retainOfficialModelEvidence(syntheticRecord(now), prior, null, now);
    assert.equal(row.pricing_status, "verified");
    assert.equal(row.pricing_input_per_1m, Number(input));
    assert.equal(row.pricing_output_per_1m, Number(output));
    assert.equal(row.routing_eligibility, "verified");
    assert.equal(row.pricing_verified_at, now);
  }
  for (const input of ["-8", "8e2", "08", "8.", "", "NaN", "Infinity", " 8", null, Number.POSITIVE_INFINITY, Number.NaN]) {
    const prior = { ...trusted, pricing_input_per_1m: input, pricing_output_per_1m: "40" } as unknown as Parameters<typeof retainOfficialModelEvidence>[1];
    const row = retainOfficialModelEvidence(syntheticRecord(now), prior, null, now);
    assert.equal(row.pricing_status, "estimated", String(input));
    assert.equal(row.routing_eligibility, "restricted", String(input));
    assert.equal(row.pricing_verified_at, null, String(input));
  }
});

test("first-party model parser contracts cover all accessible documented model cohorts", () => {
  const openaiCases = [
    { id: "gpt-6.2-astra", input: 8, output: 40, chat: true },
    { id: "gpt-6-astra", input: 10, output: 50, chat: true },
    { id: "gpt-6.2-sol", input: 2, output: 10, chat: true },
    { id: "gpt-6-sol", input: 2, output: 10, chat: true },
    { id: "gpt-5.5-pro", input: 30, output: 180, chat: false, snapshot: "gpt-5.5-pro-2026-04-23" },
    { id: "gpt-5.4-pro", input: 30, output: 180, chat: false, snapshot: "gpt-5.4-pro-2026-03-05" }
  ];
  for (const model of openaiCases) {
    const spec = officialModelSpec("openai", model.id)!;
    let fixture = openaiDoc.replaceAll("gpt-6.2-astra", model.id)
      .replace("| Input | $8 |", "| Input | $" + model.input + " |")
      .replace("| Output | $40 |", "| Output | $" + model.output + " |");
    if (!model.chat) fixture = fixture.replace(
      "| Chat Completions | " + "`v1/chat/completions`" + " | Supported |",
      "| Chat Completions | " + "`v1/chat/completions`" + " | Not supported |"
    );
    if ("snapshot" in model && model.snapshot) {
      fixture += "\n## Snapshots\n- " + "`" + model.snapshot + "`";
    }
    const published = parseOfficialModelEvidence(spec, fixture);
    assert.ok(published, model.id);
    assert.equal(published.pricingMatchesApprovedSchedule, true, model.id);
    assert.deepEqual(published.supportedEndpoints,
      model.chat ? ["responses", "chat_completions"] : ["responses"], model.id);
    if ("snapshot" in model && model.snapshot) {
      assert.ok(parseOfficialModelEvidence(spec, fixture, model.snapshot), model.snapshot);
      assert.equal(parseOfficialModelEvidence(spec, fixture, model.snapshot + "-invented"), null);
    }
  }
  const sonnet = officialModelSpec("anthropic", "claude-sonnet-5-5")!;
  const sonnetDoc = anthropicDoc.replaceAll("claude-opus-5-5", "claude-sonnet-5-5")
    .replace("$4 / MTok", "$2 / MTok").replace("$20 / MTok", "$10 / MTok")
    .replace("Adaptive (always on)", "Adaptive");
  const result = parseOfficialModelEvidence(sonnet, sonnetDoc);
  assert.ok(result);
  assert.equal(result.pricingMatchesApprovedSchedule, true);
  assert.deepEqual(result.supportedEndpoints, ["messages"]);
});
