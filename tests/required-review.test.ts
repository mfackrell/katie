import test from "node:test";
import assert from "node:assert/strict";
import { runRequiredDraftReview } from "../lib/collaboration/required-review";
import { normalizeReviewMode, shouldEnableActorCollaboration } from "../lib/collaboration/review-mode";
import type { ChatGenerateParams, LlmProvider, ProviderResponse } from "../lib/providers/types";

const params: ChatGenerateParams = {
  name: "Katie", modelId: "lead", persona: "Actor standard. Career evidence.",
  summary: "Employer needs accounting leadership.", user: "Draft the application answer. I have eight years of system experience.",
  history: [{ role: "user", content: "I have ten years of comparable industry experience." }],
};
const draft: ProviderResponse = { provider: "openai", model: "lead", text: "Original complete draft." };
const assessment = { objective: "Establish depth of experience", qualifications: ["Accounting leadership"], strongestEvidence: ["Current user: eight years of system experience"], criteria: ["Represent career breadth and supported duration"] };
function provider(name: LlmProvider["name"], generate: LlmProvider["generate"]): LlmProvider {
  return { name, generate: async (p: ChatGenerateParams) => p.persona.includes("KATIE_INDEPENDENT_ASSESSMENT")
    ? { provider: name, model: p.modelId!, text: JSON.stringify(assessment) }
    : generate(p), listModels: async () => [] } as unknown as LlmProvider;
}
const lead = provider("openai", async () => ({ ...draft, text: "Corrected final answer." }));
const deadline = () => Date.now() + 180_000;

test("actor mode is isolated and preserves Adaptive defaults", () => {
  assert.equal(normalizeReviewMode(undefined), "adaptive");
  assert.equal(normalizeReviewMode("invalid"), "adaptive");
  assert.equal(shouldEnableActorCollaboration("adaptive", false), false);
  assert.equal(shouldEnableActorCollaboration("adaptive", true), true);
  assert.equal(shouldEnableActorCollaboration("always", false), true);
  assert.equal(shouldEnableActorCollaboration("off", true), false);
});

test("reviewer receives the complete draft, actor instructions and current user evidence before revision", async () => {
  const calls: string[] = [];
  const reviewer = provider("anthropic", async p => {
    calls.push("review");
    assert.ok(p.persona.includes(params.persona));
    assert.deepEqual(p.history, params.history);
    assert.equal(p.summary, params.summary);
    assert.ok(p.user.includes(params.user));
    assert.ok(p.user.includes(draft.text));
    return { provider: "anthropic", model: "reviewer", text: JSON.stringify({ verdict: "revise", findings: "Include the user-confirmed duration." }) };
  });
  const revisionLead = provider("openai", async p => {
    calls.push("revise");
    assert.ok(p.user.includes("Include the user-confirmed duration."));
    return { ...draft, text: "Revised with supported duration." };
  });
  const result = await runRequiredDraftReview({ requestId: "1", draft, params, leadProvider: revisionLead, deadlineMs: deadline(),
    selectHelper: async c => {
      assert.deepEqual(c.usedParticipants, [{ provider: "openai", modelId: "lead" }]);
      return { provider: reviewer, modelId: "reviewer" };
    } });
  assert.deepEqual(calls, ["review", "revise"]);
  assert.equal(result.audit.status, "revised");
  assert.equal(result.result.text, "Revised with supported duration.");
  assert.notEqual(result.audit.draftHash, result.audit.finalHash);
});

test("approval delivers the reviewed draft without an unnecessary rewrite", async () => {
  const reviewer = provider("google", async () => ({ provider: "google", model: "reviewer", text: '{"verdict":"approve","findings":"Supported and complete."}' }));
  const result = await runRequiredDraftReview({ requestId: "2", draft, params,
    leadProvider: provider("openai", async () => { throw new Error("Must not rewrite approved draft"); }), deadlineMs: deadline(),
    selectHelper: async () => ({ provider: reviewer, modelId: "reviewer" }) });
  assert.equal(result.audit.status, "approved");
  assert.equal(result.result.text, draft.text);
});

test("malformed reviewer output retries a different model", async () => {
  const first = provider("google", async () => ({ provider: "google", model: "bad", text: "No structured review" }));
  const second = provider("anthropic", async () => ({ provider: "anthropic", model: "good", text: '{"verdict":"approve","findings":"Complete."}' }));
  let count = 0;
  const result = await runRequiredDraftReview({ requestId: "3", draft, params, leadProvider: lead, deadlineMs: deadline(),
    selectHelper: async c => {
      if (count++ === 0) return { provider: first, modelId: "bad" };
      assert.ok(c.usedParticipants.some(p => p.modelId === "bad"));
      return { provider: second, modelId: "good" };
    } });
  assert.equal(result.audit.status, "approved");
  assert.equal(result.audit.attempts.length, 2);
  assert.equal(result.audit.reviewer?.modelId, "good");
});

test("same-model review is rejected and failure is disclosed", async () => {
  const result = await runRequiredDraftReview({ requestId: "4", draft, params, leadProvider: lead, deadlineMs: deadline(),
    selectHelper: async () => ({ provider: lead, modelId: "lead" }) });
  assert.equal(result.audit.status, "unavailable");
  assert.match(result.result.text, /has not been independently reviewed/);
});

test("no eligible reviewer does not claim review occurred", async () => {
  const result = await runRequiredDraftReview({ requestId: "5", draft, params, leadProvider: lead, deadlineMs: deadline(), selectHelper: async () => null });
  assert.equal(result.audit.status, "unavailable");
  assert.equal(result.audit.reviewer, undefined);
  assert.match(result.result.text, /Independent review was unavailable/);
});

test("reviewer timeout retries and revision failure preserves original with an explicit status", async () => {
  let attempts = 0;
  const hung = provider("google", async () => new Promise(() => {}));
  const good = provider("anthropic", async () => ({ provider: "anthropic", model: "good", text: '{"verdict":"revise","findings":"Fix an unsupported assertion."}' }));
  const result = await runRequiredDraftReview({ requestId: "6", draft, params, deadlineMs: deadline(), participantTimeoutMs: 5,
    leadProvider: provider("openai", async () => { throw new Error("Provider unavailable"); }),
    selectHelper: async () => attempts++ === 0 ? { provider: hung, modelId: "hung" } : { provider: good, modelId: "good" } });
  assert.equal(result.audit.status, "revision_failed");
  assert.match(result.result.text, /original draft/);
  assert.ok(result.result.text.startsWith(draft.text));
});

test("exhausted budget discloses unavailable review without starting calls", async () => {
  const result = await runRequiredDraftReview({ requestId: "7", draft, params, leadProvider: lead, deadlineMs: Date.now() - 1,
    selectHelper: async () => { throw new Error("Must not call after deadline"); } });
  assert.equal(result.audit.status, "unavailable");
  assert.equal(result.audit.attempts.length, 0);
});


test("assessment is a separate draft-blind call and comparison uses its fixed criteria", async () => {
  const phases: string[] = [];
  const source = { ...params, history: [...params.history, { role: "user" as const, content: "JOB DESCRIPTION: multi-service-line accounting leadership" }] };
  const collaboratorParams = { ...params, user: "SYNTHESIS CONTAMINATION", history: [{ role: "assistant" as const, content: draft.text }] };
  const reviewer = {
    name: "anthropic", listModels: async () => ["reviewer"],
    generate: async (p: ChatGenerateParams) => {
      if (p.persona.includes("KATIE_INDEPENDENT_ASSESSMENT")) {
        phases.push("assessment");
        assert.ok(!JSON.stringify(p).includes(draft.text));
        assert.ok(!JSON.stringify(p).includes("SYNTHESIS CONTAMINATION"));
        assert.deepEqual(p.history, source.history);
        assert.ok(p.persona.includes(source.persona));
        assert.equal(p.summary, source.summary);
        assert.ok(p.user.includes(source.user));
        assert.ok(p.user.includes("not a request for you to produce the final answer"));
        assert.ok(p.user.endsWith("No current draft has been supplied."));
        return { provider: "anthropic", model: "reviewer", text: JSON.stringify(assessment) };
      }
      phases.push("comparison");
      assert.deepEqual(phases, ["assessment", "comparison"]);
      assert.ok(p.user.includes(JSON.stringify(assessment)));
      assert.ok(p.user.includes(draft.text));
      return { provider: "anthropic", model: "reviewer", text: JSON.stringify({ verdict: "revise", findings: "Establish the recurring career pattern before the recent example." }) };
    },
  } as LlmProvider;
  const revision = provider("openai", async p => {
    phases.push("revision");
    assert.ok(p.user.includes(JSON.stringify(assessment)));
    assert.ok(p.user.includes("Establish the recurring career pattern"));
    return { ...draft, text: "Career-level answer with representative evidence." };
  });
  const result = await runRequiredDraftReview({ requestId: "blind", draft, params: collaboratorParams,
    assessmentParams: source, leadProvider: revision, deadlineMs: deadline(),
    selectHelper: async () => ({ provider: reviewer, modelId: "reviewer" }) });
  assert.deepEqual(phases, ["assessment", "comparison", "revision"]);
  assert.deepEqual(result.audit.independentAssessment, assessment);
  assert.equal(result.audit.status, "revised");
});

test("an invalid independent assessment cannot proceed to draft comparison", async () => {
  let firstCalls = 0;
  const invalid = { name: "google", listModels: async () => ["invalid"], generate: async (p: ChatGenerateParams) => {
    firstCalls++;
    assert.ok(!p.user.includes(draft.text));
    return { provider: "google", model: "invalid", text: '{"objective":"Invented","criteria":[]}' };
  } } as LlmProvider;
  const valid = provider("anthropic", async () => ({ provider: "anthropic", model: "valid", text: '{"verdict":"approve","findings":"Meets independent criteria."}' }));
  let selections = 0;
  const result = await runRequiredDraftReview({ requestId: "invalid-assessment", draft, params, leadProvider: lead, deadlineMs: deadline(),
    selectHelper: async () => selections++ === 0 ? { provider: invalid, modelId: "invalid" } : { provider: valid, modelId: "valid" } });
  assert.equal(firstCalls, 1);
  assert.equal(result.audit.attempts[0].phase, "assessment");
  assert.equal(result.audit.status, "approved");
  assert.deepEqual(result.audit.independentAssessment, assessment);
});
