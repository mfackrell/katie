import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync("lib/router/model-intent.ts", "utf8");
const parserStart = source.indexOf("const parseRoutingJudgeResponse = (raw: string) => {");
const parserEnd = source.indexOf("\n  const judgeBrief", parserStart);
assert.ok(parserStart >= 0 && parserEnd > parserStart, "exercise the real production routing parser");
const parserScript = ts.transpileModule(
  source.slice(parserStart, parserEnd) + "\nglobalThis.parseJudge = parseRoutingJudgeResponse;",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

const selection = {
  selected: { provider: "openai", model: "gpt-5.5-pro" },
  selection_justification: "For this complex request, the selected model is judged to offer stronger reasoning depth, while direct comparative outcomes remain unverified.",
  alternatives: [
    { provider: "openai", model: "gpt-5.4", why_not_selected: "Potentially lower cost, but the quality tradeoff is uncertain." },
    { provider: "anthropic", model: "claude-sonnet-5", why_not_selected: "Capable alternative; task-specific outcome superiority is unverified." },
    { provider: "google", model: "gemini-2.5-pro", why_not_selected: "Potential cost benefit, but no direct evidence establishes equal performance on this task." },
  ],
};
// Shape reconstruction from incident 2aad69a7-ac9d-4208-aaeb-a8b722c099df,
// NOT the original logged response bytes (which were not preserved in this fixture).
const qualification = {
  required_quality: "Accurately resolve a complex, context-sensitive question with complete reasoning.",
  selected_fit: "Reported reasoning capability supports the material task requirements.",
  evidence_basis_kind: "reasoned_inference",
  evidence_basis: "Model capability documentation is available; no verified per-model outcome comparison was supplied.",
  comparative_uncertainty: "Actual comparative task quality is unknown without matched outcome evidence.",
  cost_after_qualification: "Compare expected price only among models that can satisfy the quality requirements.",
};
const candidateKeys = [
  "openai:gpt-5.5-pro", "openai:gpt-5.4", "anthropic:claude-sonnet-5", "google:gemini-2.5-pro",
];
const candidates = candidateKeys.map(key => {
  const [providerName, modelId] = key.split(":");
  return { providerName, modelId };
});

function parse(payload, options = {}) {
  const optionsCandidates = options.candidates ?? candidates;
  const context = vm.createContext({
    neutral: true,
    bestValueRequiresQualification: optionsCandidates.length > 1,
    args: { candidates: optionsCandidates, routing_mode: "best_value", requestEvidence: options.requestEvidence },
    candidateKeySet: new Set(optionsCandidates.map(c => c.providerName + ":" + c.modelId)),
    isProviderName: name => ["openai", "anthropic", "google", "grok"].includes(name),
    extractJsonObject: raw => raw,
    console,
  });
  vm.runInContext(parserScript, context);
  return context.parseJudge(JSON.stringify(payload));
}

test("full Best Value qualification and eligible comparisons are accepted", () => {
  const result = parse({ ...selection, quality_qualification: qualification });
  assert.equal(result?.selectedProvider, "openai");
  assert.equal(result?.selectedModel, "gpt-5.5-pro");
  assert.equal(result?.selectionComparisons.length, 3);
});

test("November 20 incident shape is rejected specifically for missing qualification", () => {
  assert.equal(parse(selection), null, "missing entire quality_qualification must fail closed");
  assert.equal(parse({ ...selection, quality_qualification: qualification })?.selectedModel, "gpt-5.5-pro",
    "adding ONLY the absent qualification must make the otherwise valid shape acceptable");
});

test("noncritical missing alternatives normalize only for a trusted single-candidate inventory", () => {
  const lone = { selected: selection.selected, selection_justification: selection.selection_justification };
  const single = parse(lone, { candidates: [candidates[0]] });
  assert.ok(single, "no alternative exists in the trusted single-candidate inventory");
  assert.equal(single.selectionComparisons.length, 0);
  assert.equal(parse(lone), null, "cannot manufacture alternatives when multiple candidates exist");
  assert.equal(parse({ ...selection, quality_qualification: qualification, alternatives: "missing" }), null,
    "malformed alternative arrays cannot pass the multi-candidate contract");
});

test("missing required qualification evidence, unsupported direct outcomes and false feedback are rejected", () => {
  assert.equal(parse({ ...selection, quality_qualification: { ...qualification, selected_fit: "" } }), null);
  assert.equal(parse({ ...selection, quality_qualification: { ...qualification, evidence_basis_kind: "verified_outcome" } }), null,
    "verified outcome requires selected-model observation provenance");
  assert.equal(parse({ ...selection, quality_qualification: { ...qualification, evidence_basis_kind: "attributed_feedback" } }), null,
    "attributed feedback requires selected-model source IDs");
  assert.equal(parse({
    ...selection,
    selection_justification: "The user praised the selected model.",
    quality_qualification: { ...qualification, evidence_basis_kind: "documented_capability" },
  }), null, "unsourced praise must not be laundered as documentation");
  assert.equal(parse({ ...selection, quality_qualification: { ...qualification,
    comparative_uncertainty: "Both models are equal." } }), null,
    "reasoned inference cannot claim comparison is established");
});

test("ineligible selections and empty or nonexistent comparisons are rejected", () => {
  assert.equal(parse({ ...selection, selected: { provider: "openai", model: "fabricated-pro" },
    quality_qualification: qualification }), null);
  assert.equal(parse({ ...selection, alternatives: [], quality_qualification: qualification }), null);
  assert.equal(parse({ ...selection, alternatives: [
    { provider: "openai", model: "fabricated-pro", why_not_selected: "Made up model." },
  ], quality_qualification: qualification }), null);
  assert.equal(parse({ ...selection, selection_justification: "", quality_qualification: qualification }), null);
});

test("required qualification appears in PRIMARY prompt schema and parser agrees", () => {
  assert.match(source, /const neutralResponseShape = \{/);
  assert.match(source, /\.\.\.\(bestValueRequiresQualification \? \{ quality_qualification: \{/);
  assert.match(source, /MANDATORY COMPLETE RESPONSE SHAPE/);
  assert.match(source, /JSON\.stringify\(neutralResponseShape\)/);
  assert.match(source, /if \(bestValueRequiresQualification\) \{/);
  assert.match(source, /singleAttempt: true/);
  assert.match(source, /Promise\.allSettled\(judges\.map\(/);
});
