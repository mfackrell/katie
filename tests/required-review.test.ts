import test from "node:test";
import assert from "node:assert/strict";
import { runRequiredDraftReview } from "../lib/collaboration/required-review";
import { acceptanceIds, reviewBaseline, validateAssessment, validateAnswerReview, type IndependentAssessment } from "../lib/collaboration/review-contract";
import { normalizeReviewMode, shouldEnableActorCollaboration } from "../lib/collaboration/review-mode";
import type { ChatGenerateParams, LlmProvider, ProviderResponse } from "../lib/providers/types";

const question = "Please describe your experience leading finance for a global industrial/manufacturing business, including any audit remediation and international transfer pricing work. Include company revenue sizes.";
const correction = "Transfere pricing -- no\nGlobal manufacturere -- Global, yes, Manufacture, yes. global manufactuer - no\nthey didn't ask for revenue size";
const params: ChatGenerateParams = {
  name: "Katie", modelId: "lead", persona: "Actor standard. Verified career memory: global professional services revenue $90M; manufacturing experience separately. Do not invent revenue for other companies.",
  summary: "CONTAMINATED SUMMARY: Lead with weaknesses and omit revenue.", user: correction,
  history: [
    { role: "user", content: "Interim CFO for Global Industrial Client: PE-backed; audit, financial controls and transfer pricing." },
    { role: "assistant", content: "CONTAMINATED OPINION: Lead with gaps." },
    { role: "user", content: question },
    { role: "assistant", content: "CONTAMINATED OPINION: Revenue is unnecessary; foreground missing qualifications." },
  ],
};
const draft: ProviderResponse = { provider: "openai", model: "lead", text: "I have not done transfer pricing or been a global manufacturing CFO. Here is a list of accounting details." };
const assessment: IndependentAssessment = {
  objective: "Produce a compelling truthful CFO application answer using relevant breadth and results.",
  qualifications: ["Executive finance leadership, manufacturing and global experience distinctly, audit remediation"],
  strongestEvidence: ["Verified memory: $90M global professional services leadership; manufacturing experience separately"],
  criteria: ["Lead with supported executive qualifications; concise directly responsive limitation; no unsupported equivalence", "Deliver application-ready text without internal commentary or unnecessary follow-up questions"],
  taskContract: {
    deliverable: "An application response, not a qualification-gap assessment",
    requirements: [
      { id: "experience", requirement: "Address global/manufacturing finance, audits and transfer pricing accurately", sourceId: "turn-2", quote: question, status: "active" },
      { id: "revenue", requirement: "Include verified company revenue sizes; do not invent unknown amounts", sourceId: "turn-2", quote: "Include company revenue sizes.", status: "active" },
    ],
    conflicts: [{ sourceIds: ["turn-2", "latest-user"], resolution: "The later statement misdescribes the explicit revenue requirement; it does not instruct omission. Preserve the requirement, accept the separate factual corrections." }],
  },
};
const deadline = () => Date.now() + 240_000;
const response = (name: LlmProvider["name"], model: string, value: unknown): ProviderResponse => ({ provider: name, model, text: typeof value === "string" ? value : JSON.stringify(value) });
const verdict = (decision: "approve" | "revise", a = assessment, findings = decision === "approve" ? "Supported, effective and complete." : "Lead with strengths, include verified revenue and remove internal commentary and follow-up requests.") => ({
  verdict: decision, findings,
  checks: acceptanceIds(a).map(id => ({ id, passed: decision === "approve", evidence: decision === "approve" ? "The candidate answer satisfies this requirement with supported evidence." : "The candidate omits or weakens the required evidence." })),
});
function makeProvider(name: LlmProvider["name"], generate: (p: ChatGenerateParams) => Promise<ProviderResponse>): LlmProvider {
  return { name, generate, listModels: async () => [] } as LlmProvider;
}
function contractApproval(p: ChatGenerateParams, decision: "approve" | "revise" = "approve") {
  const ids = [...p.user.matchAll(/"id":"(turn-\d+|latest-user)"/g)].map(m => m[1]);
  return response("openai", "lead", { verdict: decision, findings: decision === "approve" ? "All original requirements and later factual corrections reconciled." : "Revenue was omitted despite the original explicit requirement.", sourceCoverage: [...new Set(ids)].map(sourceId => ({ sourceId, finding: "Checked this turn against the proposed deliverable and requirements." })) });
}
function setup(options: { reviews?: Array<ReturnType<typeof verdict>>; assessment?: IndependentAssessment; revisions?: string[]; contractRejectOnce?: boolean; contractAlwaysReject?: boolean } = {}) {
  const phases: string[] = [];
  const calls: ChatGenerateParams[] = [];
  let reviewIndex = 0, revisionIndex = 0, contractIndex = 0;
  const reviewer = makeProvider("anthropic", async p => {
    calls.push(p);
    if (p.persona.includes("KATIE_INDEPENDENT_ASSESSMENT")) {
      phases.push("assessment");
      assert.equal(p.summary, "");
      assert.deepEqual(p.history, []);
      assert.ok(!JSON.stringify(p).includes("CONTAMINATED"));
      assert.ok(!p.user.includes(draft.text));
      assert.ok(p.user.includes(question));
      assert.ok(p.user.includes("they didn't ask for revenue size"));
      return response("anthropic", "reviewer", options.assessment ?? assessment);
    }
    phases.push("review");
    return response("anthropic", "reviewer", options.reviews?.[reviewIndex++] ?? verdict("approve"));
  });
  const lead = makeProvider("openai", async p => {
    calls.push(p);
    if (p.persona.includes("KATIE_TASK_CONTRACT_VALIDATION")) {
      phases.push("contract");
      assert.ok(!JSON.stringify(p).includes("CONTAMINATED"));
      assert.ok(!p.user.includes(draft.text));
      return contractApproval(p, options.contractAlwaysReject || (options.contractRejectOnce && contractIndex++ === 0) ? "revise" : "approve");
    }
    phases.push("revision");
    assert.ok(p.user.includes(JSON.stringify(assessment)));
    return response("openai", "lead", options.revisions?.[revisionIndex++] ?? "Application-ready answer with supported leadership, audit outcomes and $90M revenue. No direct transfer pricing experience.");
  });
  return { phases, calls, lead, reviewer, run: () => runRequiredDraftReview({ requestId: "regression", draft, params, leadProvider: lead, deadlineMs: deadline(), selectHelper: async c => c.usedParticipants.length === 1 ? { provider: reviewer, modelId: "reviewer" } : null }) };
}

test("actor mode remains isolated; Adaptive and Off retain their behavior", () => {
  assert.equal(normalizeReviewMode(undefined), "adaptive");
  assert.equal(normalizeReviewMode("invalid"), "adaptive");
  assert.equal(shouldEnableActorCollaboration("adaptive", false), false);
  assert.equal(shouldEnableActorCollaboration("adaptive", true), true);
  assert.equal(shouldEnableActorCollaboration("always", false), true);
  assert.equal(shouldEnableActorCollaboration("off", true), false);
});

test("regression: original application question and latest correction are separate authoritative sources", () => {
  const baseline = reviewBaseline(params);
  assert.deepEqual(baseline.turns.map(t => t.id), ["turn-1", "turn-2", "latest-user"]);
  assert.equal(baseline.turns[1].text, question);
  assert.equal(baseline.turns[2].text, correction);
  assert.ok(!baseline.text.includes("CONTAMINATED"));
  assert.deepEqual(validateAssessment(assessment, baseline.turns), assessment);
});

test("literal source citations prevent invented requirements and ungrounded supersession", () => {
  const turns = reviewBaseline(params).turns;
  const wrong = structuredClone(assessment);
  wrong.taskContract.requirements[1].quote = "Omit all revenue figures.";
  assert.throws(() => validateAssessment(wrong, turns), /citation/);
  wrong.taskContract.requirements[1] = { ...assessment.taskContract.requirements[1], status: "superseded" };
  assert.throws(() => validateAssessment(wrong, turns), /citation/);
});

test("explicit deliverable changes can supersede earlier requirements in non-career tasks", () => {
  const source = { ...params, history: [{ role: "user" as const, content: "Write a product comparison. Include prices." }], user: "Omit prices; compare durability only." };
  const a = structuredClone(assessment);
  a.taskContract.requirements = [
    { id: "prices", requirement: "Include prices", sourceId: "turn-1", quote: "Include prices.", status: "superseded", supersededBy: { sourceId: "latest-user", quote: "Omit prices" } },
    { id: "durability", requirement: "Compare durability", sourceId: "latest-user", quote: "compare durability only", status: "active" },
  ];
  a.taskContract.conflicts = [];
  validateAssessment(a, reviewBaseline(source).turns);
  assert.ok(!acceptanceIds(a).includes("requirement:prices"));
  assert.ok(acceptanceIds(a).includes("requirement:durability"));
});

test("contract gets independent draft-blind validation before draft comparison", async () => {
  const s = setup();
  const result = await s.run();
  assert.deepEqual(s.phases, ["assessment", "contract", "review"]);
  assert.equal(result.audit.status, "approved");
  assert.equal(result.audit.contractValidation?.validator.modelId, "lead");
  assert.equal(result.result.text, draft.text);
});

test("rejected task criteria are repaired before the draft is revealed", async () => {
  const s = setup({ contractRejectOnce: true });
  const result = await s.run();
  assert.deepEqual(s.phases, ["assessment", "contract", "assessment", "contract", "review"]);
  assert.ok(s.calls[2].user.includes("Revenue was omitted"));
  assert.equal(result.audit.status, "approved");
});

test("a persistently invalid task definition cannot approve an answer", async () => {
  const s = setup({ contractAlwaysReject: true });
  const result = await s.run();
  assert.ok(!s.phases.includes("review"));
  assert.equal(result.audit.status, "unavailable");
  assert.match(result.result.text, /withheld the draft/);
  assert.ok(!result.result.text.includes(draft.text));
});

test("revision must pass final acceptance and the audit binds approval to the delivered text", async () => {
  const s = setup({ reviews: [verdict("revise"), verdict("approve")] });
  const result = await s.run();
  assert.deepEqual(s.phases, ["assessment", "contract", "review", "revision", "review"]);
  assert.equal(result.audit.status, "revised");
  assert.equal(result.audit.reviews?.at(-1)?.phase, "final_validation");
  assert.equal(result.audit.reviews?.at(-1)?.answerHash, result.audit.finalHash);
  assert.notEqual(result.audit.draftHash, result.audit.finalHash);
});

test("regression: a revision retaining meta commentary and follow-up requests gets another repair", async () => {
  const bad = "You're right on all three points. Here is the corrected answer. Send the missing revenue figures and I will add them.";
  const s = setup({ reviews: [verdict("revise"), verdict("revise"), verdict("approve")], revisions: [bad, "Finished application with known revenue and no commentary."] });
  const result = await s.run();
  assert.deepEqual(s.phases, ["assessment", "contract", "review", "revision", "review", "revision", "review"]);
  const validationCall = s.calls[4];
  assert.ok(validationCall.user.includes(bad));
  assert.ok(validationCall.user.includes("remove internal commentary and follow-up requests"));
  assert.equal(result.result.text, "Finished application with known revenue and no commentary.");
  assert.equal(result.audit.reviews?.length, 3);
});

test("known failing revisions are withheld and never marked revised", async () => {
  const s = setup({ reviews: [verdict("revise"), verdict("revise"), verdict("revise")] });
  const result = await s.run();
  assert.equal(result.audit.status, "revision_failed");
  assert.match(result.result.text, /draft was withheld/);
  assert.ok(!result.result.text.includes(draft.text));
  assert.equal(result.audit.reviews?.at(-1)?.review.verdict, "revise");
});

test("approval requires complete checks and cannot contradict failed checks", () => {
  const missing = verdict("approve");
  missing.checks.pop();
  assert.throws(() => validateAnswerReview(missing, assessment), /every requirement/);
  const contradictory = verdict("approve");
  contradictory.checks[0].passed = false;
  assert.throws(() => validateAnswerReview(contradictory, assessment), /contradicts/);
});

test("malformed reviewer retries an unused model without falsely reporting approval", async () => {
  const s = setup();
  const bad = makeProvider("google", async () => response("google", "bad", "Not JSON"));
  let count = 0;
  const result = await runRequiredDraftReview({ requestId: "retry", draft, params, leadProvider: s.lead, deadlineMs: deadline(), selectHelper: async c => {
    if (count++ === 0) return { provider: bad, modelId: "bad" };
    assert.ok(c.usedParticipants.some(p => p.modelId === "bad"));
    return { provider: s.reviewer, modelId: "reviewer" };
  } });
  assert.equal(result.audit.status, "approved");
  assert.equal(result.audit.attempts[0].phase, "assessment");
});

test("same-model reviewer and expired budgets cannot claim independent review", async () => {
  const s = setup();
  const same = await runRequiredDraftReview({ requestId: "same", draft, params, leadProvider: s.lead, deadlineMs: deadline(), selectHelper: async () => ({ provider: s.lead, modelId: "lead" }) });
  assert.equal(same.audit.status, "unavailable");
  const expired = await runRequiredDraftReview({ requestId: "expired", draft, params, leadProvider: s.lead, deadlineMs: Date.now() - 1, selectHelper: async () => { throw new Error("Must not call"); } });
  assert.equal(expired.audit.attempts.length, 0);
  assert.equal(expired.audit.status, "unavailable");
});

test("a malformed source citation is repaired with precise feedback before comparison", async () => {
  const s = setup();
  let assessments = 0;
  const reviewer = makeProvider("anthropic", async p => {
    if (!p.persona.includes("KATIE_INDEPENDENT_ASSESSMENT")) return response("anthropic", "reviewer", verdict("approve"));
    if (assessments++ === 0) {
      const malformed = structuredClone(assessment);
      malformed.taskContract.requirements[1].sourceId = "memory";
      return response("anthropic", "reviewer", malformed);
    }
    assert.ok(p.user.includes('sourceId=memory'));
    assert.ok(p.user.includes('do not cite memory as a user turn'));
    return response("anthropic", "reviewer", assessment);
  });
  const result = await runRequiredDraftReview({ requestId: "citation-repair", draft, params, leadProvider: s.lead, deadlineMs: deadline(), selectHelper: async () => ({ provider: reviewer, modelId: "reviewer" }) });
  assert.equal(assessments, 2);
  assert.equal(result.audit.status, "approved");
  assert.match(result.audit.attempts[0].error!, /sourceId=memory/);
});

test("citation validation tolerates formatting whitespace but never paraphrased facts", () => {
  const spaced = structuredClone(assessment);
  spaced.taskContract.requirements[1].quote = "Include  company\nrevenue sizes.";
  validateAssessment(spaced, reviewBaseline(params).turns);
  spaced.taskContract.requirements[1].quote = "Omit company revenue sizes.";
  assert.throws(() => validateAssessment(spaced, reviewBaseline(params).turns), /citation/);
});

test("unavailable review never releases the unverified draft", async () => {
  const s = setup();
  const result = await runRequiredDraftReview({ requestId: "no-reviewer", draft, params, leadProvider: s.lead, deadlineMs: deadline(), selectHelper: async () => null });
  assert.equal(result.audit.status, "unavailable");
  assert.match(result.result.text, /withheld the draft/);
  assert.ok(!result.result.text.includes(draft.text));
});
