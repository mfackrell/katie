import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewSourceTurns } from "../lib/chat/review-sources";
import { acceptanceIds, reviewBaseline, type IndependentAssessment } from "../lib/collaboration/review-contract";
import { runRequiredDraftReview } from "../lib/collaboration/required-review";
import { emptyTaskProgress } from "../lib/chat/task-progress";
import type { ChatGenerateParams, LlmProvider } from "../lib/providers/types";

const latestMessage = "i do not have specific distribution, wholesale experience, i dont know what sporsor reporting is.";
const currentProject = "FP&A/P&L Advisor for PE-Backed Distribution Company. Partner with the President on performance improvement.";
const currentTask = "Please share a relevant example of owning FP&A or P&L responsibilities in a PE-backed industrial company.";

test("the exact current user source is preserved separately from saved work and observed evidence", () => {
  const history: ChatGenerateParams["history"] = [
    { role: "user", content: currentProject },
    { role: "assistant", content: "UNTRUSTED OPINION: You have no relevant experience. Do you have sponsor-reporting experience?" },
  ];
  const progress = {
    ...emptyTaskProgress(),
    projectContext: { userMessageId: "project", text: currentProject },
    objective: { userMessageId: "task", text: currentTask },
  };
  const sourceTurns = buildReviewSourceTurns({ history, latestMessage, progress });
  const source: ChatGenerateParams = {
    name: "Katie", modelId: "test", persona: "Katie", summary: "UNTRUSTED SUMMARY",
    history, user: "This turn answers a previous clarification. SAVED CANDIDATE\nMEASURED VIDEO EVIDENCE",
  };
  const baseline = reviewBaseline(source, progress, sourceTurns);
  assert.equal(latestMessage.length, 97);
  assert.deepEqual(baseline.turns.at(-1), { id: "latest-user", text: latestMessage });
  assert.equal(baseline.activeQuestion, latestMessage);
  assert.ok(baseline.turns.some(turn => turn.text === currentProject));
  assert.ok(baseline.turns.some(turn => turn.text === currentTask));
  assert.equal(baseline.turns.filter(turn => turn.text === currentProject).length, 1);
  assert.doesNotMatch(baseline.text, /UNTRUSTED OPINION|UNTRUSTED SUMMARY|SAVED CANDIDATE|MEASURED VIDEO EVIDENCE/);
  assert.deepEqual(baseline.params.history, []);
  assert.equal(baseline.params.summary, "");
});

test("a matched saved retry recovers firsthand original sources without reviving legacy synthetic wrappers", () => {
  const sourceTurns = buildReviewSourceTurns({
    history: [{ role: "user", content: "Correct the revenue to $90M." }],
    latestMessage: "yes, retry verification",
    savedSourceTurns: [
      { id: "turn-1", text: currentProject },
      { id: "turn-2", text: currentTask },
      { id: "latest-user", text: "This turn answers a previous clarification. SAVED CANDIDATE" },
    ],
  });
  assert.deepEqual(sourceTurns.map(turn => turn.text), [currentProject, currentTask, "Correct the revenue to $90M.", "yes, retry verification"]);
  assert.equal(new Set(sourceTurns.map(turn => turn.id)).size, sourceTurns.length);
  assert.equal(sourceTurns.at(-1)?.id, "latest-user");
});

test("measured media evidence reaches every actual review stage without becoming a user source or leaking the draft", async () => {
  const source: ChatGenerateParams = {
    name: "Katie", modelId: "lead", persona: "Explain the current question accurately.",
    summary: "UNTRUSTED SUMMARY",
    history: [
      { role: "user", content: currentTask },
      { role: "assistant", content: "UNTRUSTED OPINION: You lack reporting experience. What reporting have you done?" },
    ],
    user: "This turn answers a previous clarification. SYNTHETIC RESUME PROMPT TO EXCLUDE",
  };
  const sourceTurns = buildReviewSourceTurns({ history: source.history, latestMessage });
  const observedEvidence = "Video 1, source recording-1: Server decoder measured duration: 24s. Decoded sample positions: 0s, 12s, 24s. The chart is visible at 12s.";
  const savedCandidate = "SAVED CANDIDATE: Sponsor reporting means providing financial results and forecasts to the PE owner. Have you prepared those updates?";
  const assessment: IndependentAssessment = {
    objective: "Explain the unfamiliar term and preserve the unanswered experience question.",
    qualifications: ["Plain, accurate explanation in context"],
    strongestEvidence: ["The user does not know what the term means; measured source observations are separate supporting evidence."],
    criteria: ["Acknowledge supplied facts without interpreting unfamiliar terminology as no experience."],
    synthesis: {
      conclusion: "The next response should explain the term and ask about the underlying work.",
      dimensions: [{ dimension: "Understanding", supportedScope: "Explain the term", evidence: ["latest-user"] }],
      emphasis: "Answer the immediate clarification.",
    },
    taskContract: {
      deliverable: "A brief explanation and a targeted experience question",
      requirements: [{ id: "explain", requirement: "Explain sponsor reporting", sourceId: "latest-user", status: "active" }],
      conflicts: [],
    },
  };
  const phases: string[] = [];
  const checkSources = (params: ChatGenerateParams) => {
    assert.ok(params.user.includes(observedEvidence), "source-grounded media reaches this review stage");
    assert.match(params.user, /OBSERVED EVIDENCE AVAILABLE TO ALL REVIEW STAGES:/);
    assert.ok(params.user.includes(JSON.stringify({ id: "latest-user", text: latestMessage })));
    assert.doesNotMatch(JSON.stringify(params), /UNTRUSTED OPINION|UNTRUSTED SUMMARY|SYNTHETIC RESUME PROMPT/);
    assert.equal(params.summary, "");
    assert.deepEqual(params.history, []);
  };
  const reviewer: LlmProvider = {
    name: "anthropic", async listModels() { return []; },
    async generate(params) {
      checkSources(params);
      if (params.persona.includes("KATIE_INDEPENDENT_ASSESSMENT")) {
        phases.push("assessment");
        assert.ok(!params.user.includes(savedCandidate));
        return { text: JSON.stringify(assessment), provider: "anthropic", model: "reviewer" };
      }
      phases.push("comparison");
      assert.ok(params.user.includes(savedCandidate));
      return {
        text: JSON.stringify({ verdict: "approve", findings: "The explanation answers the current question without inventing experience.",
          checks: acceptanceIds(assessment).map(id => ({ id, passed: true, evidence: "Satisfied by the contextual explanation." })) }),
        provider: "anthropic", model: "reviewer",
      };
    },
  };
  const lead: LlmProvider = {
    name: "openai", async listModels() { return []; },
    async generate(params) {
      checkSources(params);
      phases.push("contract_validation");
      assert.ok(!params.user.includes(savedCandidate));
      return {
        text: JSON.stringify({ verdict: "approve", findings: "The current clarification governs the response.",
          sourceCoverage: sourceTurns.map(turn => ({ sourceId: turn.id, finding: "Read and reconciled with the current clarification." })) }),
        provider: "openai", model: "lead",
      };
    },
  };
  const result = await runRequiredDraftReview({
    requestId: "observed-evidence-regression", params: source, sourceTurns, observedEvidence,
    draft: { text: savedCandidate, provider: "openai", model: "lead" },
    leadProvider: lead, deadlineMs: Date.now() + 240_000,
    selectHelper: async context => context.usedParticipants.length === 1 ? { provider: reviewer, modelId: "reviewer" } : null,
  });
  assert.equal(result.audit.status, "approved");
  assert.deepEqual(phases, ["assessment", "contract_validation", "comparison"]);
  assert.deepEqual(result.audit.sourceTurns?.at(-1), { id: "latest-user", text: latestMessage });
  assert.equal(result.audit.sourceTurns?.at(-1)?.text.length, 97);
  assert.ok(result.audit.sourceTurns?.every(turn => !turn.text.includes(observedEvidence)));
});
