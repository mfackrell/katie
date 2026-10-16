import test from "node:test";
import assert from "node:assert/strict";
import { runRequiredDraftReview } from "../lib/collaboration/required-review";
import { getDeliverableStandardInstruction } from "../lib/chat/deliverable-standard";
import { createReviewClarification, buildReviewResumptionContext } from "../lib/collaboration/review-completion";
import { acceptanceIds, reviewBaseline, validateAssessment, validateAnswerReview, type AnswerReview, type IndependentAssessment } from "../lib/collaboration/review-contract";
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
  synthesis: {
    conclusion: "Experienced executive with manufacturing leadership and separate global audit remediation capability",
    dimensions: [{ dimension: "Finance leadership", supportedScope: "Career-level capability across manufacturing and global businesses", evidence: ["Verified career memory and direct user clarifications"] }],
    emphasis: "Establish breadth and responsibility; use representative outcomes. Valuation figures do not add value to requested revenue sizes.",
  },
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
  assert.equal(result.audit.status, "completed_with_review_notes");
  assert.match(result.result.text, /Unverified draft/);
  assert.ok(result.result.text.includes(draft.text));
  assert.equal(result.audit.pendingClarification, undefined);
  assert.equal(s.phases.filter(p => p === "contract").length, 2);
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

test("exhausted nonessential review returns the draft with transparent review notes, never a fabricated question", async () => {
  const s = setup({
    reviews: [verdict("revise"), verdict("revise"), verdict("revise"), verdict("revise")],
    revisions: ["Improved application draft 1.", "Improved application draft 2.", "Improved application draft 3."],
  });
  const result = await s.run();
  assert.equal(result.audit.status, "completed_with_review_notes");
  assert.equal(result.audit.pendingClarification, undefined);
  assert.match(result.result.text, /Improved application draft 3/);
  assert.match(result.result.text, /Review note \(not part of the deliverable\)/);
  assert.doesNotMatch(result.result.text, /can you clarify this outstanding requirement/i);
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
  assert.equal(same.audit.status, "completed_with_review_notes");
  assert.match(same.result.text, /Unverified draft/);
  const expired = await runRequiredDraftReview({ requestId: "expired", draft, params, leadProvider: s.lead, deadlineMs: Date.now() - 1, selectHelper: async () => { throw new Error("Must not call"); } });
  assert.equal(expired.audit.attempts.length, 0);
  assert.equal(expired.audit.status, "completed_with_review_notes");
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

test("unavailable reviewer returns transparently unverified draft without asking for retry", async () => {
  const s = setup();
  const result = await runRequiredDraftReview({ requestId: "no-reviewer", draft, params, leadProvider: s.lead, deadlineMs: deadline(), selectHelper: async () => null });
  assert.equal(result.audit.status, "completed_with_review_notes");
  assert.match(result.result.text, /Unverified draft/);
  assert.ok(result.result.text.includes(draft.text));
  assert.equal(result.audit.pendingClarification, undefined);
  assert.match(result.audit.completionNote ?? "", /not been approved/);
});


test("latest standalone application request cannot inherit old screening requirements", () => {
  const latest = "Please share 3 to 5 examples of your relevant experience.";
  const newParams: ChatGenerateParams = {
    ...params, user:latest,
    history:[
      {role:"user",content:"Interim CFO for global industrial business; prior questions concern audits and carve-outs."},
      {role:"user",content:"Please describe your experience with business carve-outs, including revenue sizes."}
    ],
  };
  const progress = {version:1 as const,objective:{text:latest,userMessageId:"new"},
    stage:"working" as const,nextAction:"continue_original_goal" as const,
    pending:[],answered:[],lastAssistantMessageId:null,lastUserMessageId:"new",
    lastUserIntent:"new_task" as const};
  const baseline=reviewBaseline(newParams,progress);
  assert.equal(baseline.activeNewTask,true);
  const oldRequired=structuredClone(assessment);
  oldRequired.taskContract.requirements=[{id:"old",sourceId:"turn-2",
    requirement:"Only discuss carve-outs and revenue sizes.",status:"active"}];
  assert.throws(()=>validateAssessment(oldRequired,baseline.turns,{activeNewTask:true}),/completed earlier questions/);
  const newRequired=structuredClone(assessment);
  newRequired.taskContract.requirements=[{id:"examples",sourceId:"latest-user",
    quote:latest,requirement:"Give 3-5 relevant experience examples.",status:"active"}];
  newRequired.taskContract.conflicts=[];
  assert.doesNotThrow(()=>validateAssessment(newRequired,baseline.turns,{activeNewTask:true}));
});

test("optional contract suggestions cannot stop draft verification",async()=>{
  const s=setup();
  const reviewer=makeProvider("anthropic",async p=>{
    if(p.persona.includes("KATIE_INDEPENDENT_ASSESSMENT"))return response("anthropic","reviewer",assessment);
    return response("anthropic","reviewer",verdict("approve"));
  });
  const lead=makeProvider("openai",async p=>{
    if(p.persona.includes("KATIE_TASK_CONTRACT_VALIDATION")){
      return response("openai","lead",{
        verdict:"revise",issueType:"optional_improvement",
        findings:"A shorter opening might be stylistically nicer, but the task is valid.",
        sourceCoverage:[...new Set([...p.user.matchAll(/"id":"(turn-\d+|latest-user)"/g)].map(x=>x[1]))]
          .map(sourceId=>({sourceId,finding:"Checked."})),
      });
    }
    throw new Error("No revision necessary");
  });
  const result=await runRequiredDraftReview({requestId:"optional-contract",
    draft,params,leadProvider:lead,deadlineMs:deadline(),
    selectHelper:async()=>({provider:reviewer,modelId:"reviewer"})});
  assert.equal(result.audit.status,"approved");
  assert.equal(result.audit.contractFindings?.[0].verdict,"revise");
  assert.equal(result.result.text,draft.text);
});

test("bounded validation falls back before comparing after two material rejections",async()=>{
  const s=setup({contractAlwaysReject:true});
  const result=await s.run();
  assert.deepEqual(s.phases,["assessment","contract","assessment","contract"]);
  assert.equal(result.audit.status,"completed_with_review_notes");
  assert.equal(result.audit.contractFindings?.length,2);
  assert.equal(result.audit.reviews,undefined);
  assert.match(result.result.text,/Unverified draft/);
  assert.ok(result.result.text.includes(draft.text));
  assert.equal(result.audit.pendingClarification,undefined);
});

test("full BTG context: old carve-out-only contract cannot overwrite broad relevant-experience question", async()=>{
  const project = "Interim CFO for Global Industrial Client. A PE-backed industrial business needs senior finance leadership during transition, multi-entity and multinational oversight, audits and controls, manufacturing operating finance, business-separation reporting and systems/data transition.";
  const original="Please share 3 to 5 examples of your relevant experience.";
  const correction="no. answer this question: "+original;
  const history=[
    {role:"user" as const,content:project},
    {role:"user" as const,content:"Please share examples of carve-outs or business separations. Include revenue sizes."},
    {role:"user" as const,content:"The four separation examples should be Conscious Discipline, Komodo Cloud, Vitamin Health and Inovus; do not use audit recovery for that specific carve-out question."},
    {role:"user" as const,content:original},
    {role:"assistant" as const,content:"Previous answer focused only on carve-outs."},
  ];
  const parent={text:project,userMessageId:"job"};
  const progress={
    version:1 as const,objective:{text:original,userMessageId:"correction"},
    projectContext:parent,stage:"working" as const,nextAction:"continue_original_goal" as const,
    pending:[],answered:[],lastAssistantMessageId:null,lastUserMessageId:"correction",
    lastUserIntent:"new_task" as const,
  };
  const input:ChatGenerateParams={
    name:"Katie",modelId:"lead",
    persona:getDeliverableStandardInstruction()+"\nVerified: $90M multinational accounting recovery, PE sale and interim CFO for education company, industrial CFO/operating leadership, solar business leadership, business-line carve-outs.",
    summary:"",history,user:correction,
  };
  const originalDraft="1. PE multinational accounting recovery and ten-week audit. 2. Industrial manufacturing CFO and operations. 3. PE sale and year of Interim CFO responsibility. 4. Solar operating leadership. 5. Financial business-line separation.";
  const broad=structuredClone(assessment);
  broad.objective="Provide 3-5 representative examples demonstrating the whole PE-backed industrial Interim CFO mandate.";
  broad.taskContract.deliverable="Examples covering the full project rather than only carve-outs";
  broad.taskContract.requirements=[{id:"examples",requirement:"Provide 3 to 5 examples of relevant experience.",sourceId:"latest-user",quote:original,status:"active"}];
  broad.taskContract.conflicts=[];
  broad.synthesis={
    conclusion:"Broad interim CFO capability across multinational close recovery, manufacturing, cross-functional operating leadership, PE transactions, and business-line separations.",
    dimensions:[
      {dimension:"multinational recovery",supportedScope:"PE-backed $90M recovery",evidence:["Job history"]},
      {dimension:"industrial leadership",supportedScope:"Manufacturing CFO roles",evidence:["Career record"]},
      {dimension:"operating and ownership transition",supportedScope:"Interim CFO and solar operations",evidence:["Career record"]},
      {dimension:"separation",supportedScope:"Segment economics",evidence:["User-stated examples"]},
    ],
    emphasis:"Choose distinct examples representing all major project requirements.",
  };
  const bad=structuredClone(broad);
  bad.objective="Four carve-out examples only; audit recovery and industrial leadership are irrelevant.";
  bad.taskContract.requirements=[
    {id:"old",requirement:"Use only the four named carve-out examples",sourceId:"turn-3",status:"active"},
    {id:"examples",requirement:"Give 3 to 5 examples",sourceId:"latest-user",quote:original,status:"active"},
  ];
  const baseline=reviewBaseline(input,progress);
  assert.equal(baseline.activeNewTask,true);
  assert.equal(baseline.broadProjectQuestion,true);
  assert.match(baseline.text,/BROAD RELEVANCE CHECK/);
  assert.throws(()=>validateAssessment(bad,baseline.turns,{activeNewTask:true}),/completed earlier questions/);
  assert.doesNotThrow(()=>validateAssessment(broad,baseline.turns,{activeNewTask:true}));
  let attempts=0;
  const reviewer=makeProvider("anthropic",async p=>{
    if(p.persona.includes("KATIE_INDEPENDENT_ASSESSMENT")){
      assert.match(p.user,/BROAD RELEVANCE CHECK/);
      assert.match(p.user,/global industrial/i);
      assert.ok(!p.user.includes(originalDraft),"Assessment must remain draft-blind");
      return response("anthropic","reviewer",attempts++===0?bad:broad);
    }
    assert.match(p.user,/BROAD RELEVANCE CHECK/);
    assert.match(p.user,/multinational recovery/);
    const check={
      verdict:"approve",findings:"The distinct examples cover the entire industrial Interim CFO engagement.",
      checks:acceptanceIds(broad).map(id=>({id,passed:true,evidence:"The draft covers distinct project capabilities and factual examples."})),
    };
    return response("anthropic","reviewer",check);
  });
  const lead=makeProvider("openai",async p=>{
    if(!p.persona.includes("KATIE_TASK_CONTRACT_VALIDATION"))throw new Error("Unexpected revision");
    return contractApproval(p);
  });
  const result=await runRequiredDraftReview({
    requestId:"btg-whole-project",draft:{provider:"openai",model:"lead",text:originalDraft},
    params:input,taskProgress:progress,leadProvider:lead,deadlineMs:deadline(),
    selectHelper:async()=>({provider:reviewer,modelId:"reviewer"}),
  });
  assert.equal(attempts,2);
  assert.equal(result.audit.status,"approved");
  assert.equal(result.result.text,originalDraft);
  assert.match(result.audit.attempts[0].error??"",/completed earlier questions/);
  assert.equal(result.audit.independentAssessment?.objective,broad.objective);
});

test("a generated rubric cannot omit the synthesis and economy acceptance gates", () => {
  const reduced = structuredClone(assessment);
  reduced.criteria = ["Accurate facts"];
  const ids = acceptanceIds(reduced);
  assert.ok(ids.includes("scope-and-sufficiency"));
  assert.ok(ids.includes("evidence-economy"));
  assert.ok(ids.includes("metric-meaning"));
  assert.ok(ids.includes("contextual-content-selection"));
  assert.ok(ids.includes("audience-appropriate-expression"));
  const rubberStamp = verdict("approve", reduced);
  rubberStamp.checks = rubberStamp.checks.filter(c => c.id !== "evidence-economy");
  assert.throws(() => validateAnswerReview(rubberStamp, reduced), /every requirement/);
  const noSynthesis = { ...reduced, synthesis: undefined };
  assert.throws(() => validateAssessment(noSynthesis, reviewBaseline(params).turns), /Invalid independent task contract/);
});

test("source references preserve provenance without requiring models to recopy user text", () => {
  const referenced = structuredClone(assessment);
  for (const requirement of referenced.taskContract.requirements) delete requirement.quote;
  validateAssessment(referenced, reviewBaseline(params).turns);
  referenced.taskContract.requirements[0].sourceId = "validator-feedback";
  assert.throws(() => validateAssessment(referenced, reviewBaseline(params).turns), /citation/);
});

test("essential missing evidence produces a resumable question rather than losing the draft", async () => {
  const final: AnswerReview = verdict("revise");
  final.clarification = { question: "Do you know the annual revenue figures for your earlier manufacturing employers? If not, say unknown.", missingFact: "Earlier manufacturing employer revenue figures", essential: true };
  const s = setup({ reviews: [verdict("revise"), verdict("revise"), final], revisions: ["Improved application draft 1.", "Improved application draft 2."] });
  const result = await s.run();
  assert.equal(result.audit.status, "needs_user_input");
  assert.equal(result.result.text, final.clarification.question);
  assert.equal(result.audit.pendingClarification?.candidate, "Improved application draft 2.");
  assert.deepEqual(result.audit.pendingClarification?.requirementIds, assessment.taskContract.requirements.map(r => r.id));
  const resumed = buildReviewResumptionContext(result.audit.pendingClarification!, "Unknown. Use the verified revenues.");
  assert.ok(resumed.includes("Improved application draft 2."));
  assert.ok(resumed.includes("Unknown. Use the verified revenues."));
  assert.match(resumed, /Return the complete finished deliverable/);
});

test("nonessential reviewer suggestions are never treated as user-owned blockers", () => {
  const optional: AnswerReview = verdict("revise");
  optional.clarification = { question: "Can you give an optional number?", missingFact: "Optional detail", essential: false };
  const pending = createReviewClarification({ assessment, review: optional, candidate: "Saved draft", now: "2026-10-12T00:00:00Z" });
  assert.equal(pending, null);
});

test("production regression: a review saying no clarification required cannot ask the user for revenue figures", async () => {
  const nonblocking = verdict("revise", assessment,
    "The answer is strong. Earlier manufacturing revenues are unverified. Change failed ERP to problematic ERP. No clarification from the user is required.");
  assert.equal(createReviewClarification({ assessment, review: nonblocking, candidate: "Supported application answer." }), null);
  const s = setup({
    reviews: [nonblocking, nonblocking, nonblocking, verdict("approve")],
    revisions: [
      "The finance recovery was led through the team and revenue was approximately $90M.",
      "The global company had a problematic ERP implementation; annual revenue was approximately $90M.",
      "I led the recovery in a global $90M company despite a problematic ERP implementation.",
    ],
  });
  const result = await s.run();
  assert.equal(result.audit.status, "revised");
  assert.equal(result.audit.pendingClarification, undefined);
  assert.match(result.result.text, /problematic ERP/);
  assert.equal(result.audit.reviews?.length, 4);
  assert.doesNotMatch(result.result.text, /can you clarify/i);
});


test("context and expression checks cannot be silently omitted or approved by a factual-only rubric", () => {
  const weak = structuredClone(assessment);
  weak.criteria = ["All factual claims accurate."];
  const ids = acceptanceIds(weak);
  assert.ok(ids.includes("contextual-content-selection"));
  assert.ok(ids.includes("audience-appropriate-expression"));
  const factualOnly = verdict("approve", weak);
  factualOnly.checks = factualOnly.checks.filter(c => c.id !== "contextual-content-selection");
  assert.throws(() => validateAnswerReview(factualOnly, weak), /every requirement/);
  const failedContent = verdict("approve", weak);
  failedContent.checks.find(c => c.id === "contextual-content-selection")!.passed = false;
  assert.throws(() => validateAnswerReview(failedContent, weak), /contradicts/);
  const failedLanguage = verdict("approve", weak);
  failedLanguage.checks.find(c => c.id === "audience-appropriate-expression")!.passed = false;
  assert.throws(() => validateAnswerReview(failedLanguage, weak), /contradicts/);
});

test("editorial regression: accurate but peripheral restructuring example is removed rather than reworded", async () => {
  const relevantDraft = {
    ...draft,
    text: "I led audit recovery for a global $90M business and worked through a Chapter 11 restructuring. I have manufacturing experience.",
  };
  const improved = "I led audit remediation for a global $90M company, restoring financial reporting and completing the audit in ten weeks. My manufacturing finance background includes international sales and marketing responsibilities. I have not personally done transfer pricing work.";
  const calls: ChatGenerateParams[] = [];
  const reviewer = makeProvider("anthropic", async p => {
    calls.push(p);
    if (p.persona.includes("KATIE_INDEPENDENT_ASSESSMENT")) {
      assert.match(p.persona, /PRIMARY task is independent content\/context selection/);
      assert.ok(!p.user.includes(relevantDraft.text), "Assessment must remain draft blind");
      return response("anthropic", "reviewer", assessment);
    }
    assert.match(p.persona, /true but peripheral anecdote must be REMOVED/);
    assert.match(p.user, /contextual-content-selection/);
    const match = p.user.match(/<answer_to_review>\n([\s\S]*?)\n<\/answer_to_review>/);
    assert.ok(match, "Review must receive the exact draft");
    if (match[1].includes("Chapter 11")) {
      const bad: AnswerReview = verdict("revise");
      bad.findings = "REMOVE the true but tangential Chapter 11 example. Preserve the manufacturing background and global audit evidence. Improve opening and phrasing. Do not volunteer unavailable early-company revenues.";
      bad.checks.find(c => c.id === "contextual-content-selection")!.evidence = "The Chapter 11 example adds little to this global manufacturing finance screening answer; delete it, not just rephrase it.";
      bad.checks.find(c => c.id === "audience-appropriate-expression")!.evidence = "Weak chronology and opening bury the strongest audit recovery proof.";
      return response("anthropic", "reviewer", bad);
    }
    assert.ok(match[1].includes("international sales and marketing"));
    assert.ok(!match[1].includes("unavailable"), "No defensive unknown-revenue disclosure");
    return response("anthropic", "reviewer", verdict("approve"));
  });
  const lead = makeProvider("openai", async p => {
    calls.push(p);
    if (p.persona.includes("KATIE_TASK_CONTRACT_VALIDATION")) return contractApproval(p);
    assert.match(p.persona, /Remove peripheral examples/);
    assert.match(p.user, /Chapter 11/);
    return response("openai", "lead", improved);
  });
  const result = await runRequiredDraftReview({
    requestId: "editorial-chapter11-relevance",
    draft: relevantDraft,
    params, leadProvider: lead, deadlineMs: deadline(),
    selectHelper: async () => ({ provider: reviewer, modelId: "reviewer" }),
  });
  assert.equal(result.audit.status, "revised");
  assert.equal(result.result.text, improved);
  assert.ok(!result.result.text.includes("Chapter 11"));
  assert.ok(result.result.text.includes("international sales and marketing"));
  assert.equal(result.audit.reviews?.[0].review.checks.find(c => c.id === "contextual-content-selection")?.passed, false);
  assert.equal(result.audit.reviews?.at(-1)?.review.verdict, "approve");
});

test("editorial standards apply beyond applications and do not impose marketing copy on reports", () => {
  const source = {
    ...params,
    persona: "Internal risk reporting actor",
    history: [{ role: "user" as const, content: "Prepare a neutral incident report about the payment outage. Include the timeline, impact and mitigation." }],
    user: "Use a factual executive summary; exclude the team's fundraising story.",
  };
  const baseline = reviewBaseline(source);
  assert.equal(baseline.turns.length, 2);
  assert.ok(baseline.text.includes("neutral incident report"));
  assert.ok(baseline.text.includes("exclude the team's fundraising story"));
  const checks = acceptanceIds(assessment);
  assert.ok(checks.includes("contextual-content-selection"));
  assert.ok(checks.includes("audience-appropriate-expression"));
});


test("live website evidence reaches assessment, validation, revision and final review as text and image inputs", async () => {
  const image = "data:image/jpeg;base64,bGl2ZS1ldmlkZW5jZQ==";
  const researchEvidence: NonNullable<ChatGenerateParams["researchEvidence"]> = {
    kind: "web", retrievedBy: { provider: "katie", modelId: "browser" },
    query: "Review website", summary: "LIVE_CAPTURE_MARKER", sources: [{ url: "https://example.com/" }], retrievedAt: "2026-10-12T00:00:00Z",
    website: { capturedAt: "2026-10-12T00:00:00Z", limitations: [], pages: [{
      requestedUrl: "https://example.com/", url: "https://example.com/", title: "Example", html: "<h1>Example</h1>", htmlTruncated: false, stylesheets: [], limitations: [],
      views: [{ device: "desktop", viewport: { width: 1440, height: 900 }, document: { width: 1440, height: 900, horizontalOverflow: false }, text: "Example", elements: [], images: [], limitations: [], screenshot: { dataUrl: image, width: 1440, height: 900, truncated: false } }],
    }] },
  };
  // Identical frames still occupy separate evidence image indices.
  researchEvidence.website!.pages[0].views.push({ ...researchEvidence.website!.pages[0].views[0], device: "mobile" });
  const s = setup({ reviews: [verdict("revise"), verdict("approve")] });
  const result = await runRequiredDraftReview({ requestId: "live-evidence", draft,
    params: { ...params, researchEvidence }, assessmentParams: { ...params, researchEvidence },
    leadProvider: s.lead, deadlineMs: deadline(), selectHelper: async c => {
      assert.equal(c.hasImages, true);
      return { provider: s.reviewer, modelId: "reviewer" };
    },
  });
  assert.equal(result.audit.status, "revised");
  assert.deepEqual(s.phases, ["assessment", "contract", "review", "revision", "review"]);
  for (const call of s.calls) {
    assert.ok(call.user.includes("LIVE_CAPTURE_MARKER"));
    assert.ok(call.user.includes("RENDERED_WEBSITE_EVIDENCE"));
    assert.deepEqual(call.images, [image, image]);
    assert.ok(!call.user.includes(image), "image bytes belong in image inputs, not text");
    assert.ok(!call.user.includes("CONTAMINATED"));
  }
});

test("objective-first standard reaches independent assessment, comparison, revision and final verification without new stages", async () => {
  const calls: ChatGenerateParams[] = [];
  const rebuilt = "I have 25 years of finance and accounting leadership across manufacturing and global businesses. I led audit remediation for a $90M global professional services company. My manufacturing and multinational experience are separate; I have not performed international transfer pricing work.";
  const reviewer = makeProvider("anthropic", async p => {
    calls.push(p);
    assert.match(p.persona, /KATIE_OBJECTIVE_FIRST_STANDARD/);
    if (p.persona.includes("KATIE_INDEPENDENT_ASSESSMENT")) {
      assert.match(p.persona, /Define an excellent response independently BEFORE seeing the draft/);
      assert.match(p.persona, /compare materially different evidence selections or approaches and their consequences/);
      assert.ok(!p.user.includes(draft.text));
      return response("anthropic", "reviewer", assessment);
    }
    if (p.user.includes(rebuilt)) {
      assert.match(p.persona, /FINAL VERIFICATION: Reassess the complete revised response/);
      assert.match(p.persona, /not merely that earlier requested edits were applied/);
      assert.match(p.persona, /Do not fail any check merely because suggested wording/);
      assert.match(p.persona, /strongest effective response is not a mandate for endless stylistic optimization/);
      return response("anthropic", "reviewer", verdict("approve"));
    }
    assert.match(p.persona, /DRAFT COMPARISON: Compare the draft with the independently established ideal approach/);
    assert.match(p.persona, /identify the specific requested answer that cannot be completed truthfully/);
    assert.match(p.persona, /editorial uncertainty or another fit assessment is not a completion blocker/);
    return response("anthropic", "reviewer", verdict("revise"));
  });
  const lead = makeProvider("openai", async p => {
    calls.push(p);
    assert.match(p.persona, /KATIE_OBJECTIVE_FIRST_STANDARD/);
    if (p.persona.includes("KATIE_TASK_CONTRACT_VALIDATION")) return contractApproval(p);
    assert.match(p.persona, /Rebuild the argument when its strategy is wrong/);
    assert.match(p.persona, /Treat reviewer findings as observations to investigate, not instructions to execute/);
    assert.match(p.persona, /Compare preserving the original, making a targeted improvement and taking a substantially different approach/);
    return response("openai", "lead", rebuilt);
  });
  const result = await runRequiredDraftReview({ requestId: "objective-first-transport", draft,
    params, leadProvider: lead, deadlineMs: deadline(),
    selectHelper: async () => ({ provider: reviewer, modelId: "reviewer" }) });
  assert.equal(result.audit.status, "revised");
  assert.equal(result.result.text, rebuilt);
  assert.equal(calls.length, 5, "Existing assessment, contract validation, comparison, revision and verification only");
});


test("comparative review can preserve a sound original without requiring correction activity", async () => {
  const s = setup({ reviews: [verdict("approve")] });
  const result = await runRequiredDraftReview({ requestId: "comparative-preserve", draft, params,
    leadProvider: s.lead, deadlineMs: deadline(),
    selectHelper: async () => ({ provider: s.reviewer, modelId: "reviewer" }) });
  assert.equal(result.audit.status, "approved");
  assert.equal(result.result, draft);
  assert.deepEqual(s.phases, ["assessment", "contract", "review"]);
  const reviewCall = s.calls.find(call => call.persona.includes("KATIE_REQUIRED_DRAFT_REVIEW"));
  assert.ok(reviewCall);
  assert.match(reviewCall.persona, /do not mistake isolated compliance for improvement/);
  assert.match(reviewCall.persona, /implementing feedback is not itself evidence of improvement/);
});


/**
 * These model-double regressions verify that the existing draft-blind reviewer
 * receives capability-inference instructions, fails materially under/overstated
 * conclusions, and validates a corrected answer. They do not substitute for
 * live-model inference quality evaluations.
 */
const inferenceScenarios = [
  {
    name: "financial carve-out analysis without a project bearing that label",
    question: "Describe my experience with financial carve-out analysis.",
    evidence: "The user segregated revenue by business line, traced direct expenses, allocated shared costs with drivers, assessed stand-alone economics, prepared business-line reporting, and supported sell-side diligence. No verified legal-entity separation execution.",
    wrong: "I have never done carve-out analysis because no engagement was formally titled a carve-out.",
    correct: "I have performed substantive financial carve-out analysis within wider finance and transaction engagements, including revenue separation, cost attribution, shared-cost allocation, and stand-alone reporting. These facts do not establish that I executed an entire legal or operational separation.",
  },
  {
    name: "prevent overclaim of complete operational separation",
    question: "What scope of business separation work can I support?",
    evidence: "The user separated reporting by unit, allocated shared costs and modeled independent profitability. The record contains no execution of corporate legal separation or operational disentanglement.",
    wrong: "I led complete legal-entity carve-outs and disentangled all operations.",
    correct: "My demonstrated work supports financial separation analysis and stand-alone reporting. A complete legal-entity separation or operational disentanglement is not established by these facts.",
  },
  {
    name: "cross-domain technical capability without its industry shorthand",
    question: "Assess whether this engineer has data pipeline integration experience.",
    evidence: "The engineer built scheduled jobs extracting sales files from an API, validated and standardized fields, joined them with database records, and loaded the results into an analytics warehouse. The project never used the label ETL.",
    wrong: "The engineer has no ETL experience because their history never says ETL.",
    correct: "The engineer has substantively demonstrated extract-transform-load integration experience by implementing extraction, transformation and warehouse loading, even though the project never used the label ETL.",
  },
  {
    name: "related accounting is not proof of a specialized transfer-pricing process",
    question: "Assess whether the user's multinational finance experience establishes direct transfer-pricing execution.",
    evidence: "The user managed multi-entity accounting, intercompany reconciliation, foreign-currency consolidation, and advisor coordination. The user explicitly states they have not directly performed international transfer-pricing work.",
    wrong: "Managing intercompany reconciliations proves I personally executed international transfer-pricing studies.",
    correct: "The user demonstrates transferable multinational accounting and advisor-coordination capability, but those activities do not establish direct execution of transfer-pricing studies; the explicit clarification rules out that claim.",
  },
] as const;

for (const scenario of inferenceScenarios) {
  test("capability-inference regression: " + scenario.name, async () => {
    const source: ChatGenerateParams = {
      name: "Katie", modelId: "lead",
      persona: getDeliverableStandardInstruction() + "\nVerified evidence: " + scenario.evidence,
      summary: "", user: "Answer the question using the established evidence.",
      history: [{ role: "user", content: scenario.question }],
    };
    const initial: ProviderResponse = { provider: "openai", model: "lead", text: scenario.wrong };
    const scenarioAssessment: IndependentAssessment = {
      objective: "Answer accurately based on the substantive work described in the evidence.",
      qualifications: ["Work establishes capabilities within demonstrated boundaries."],
      strongestEvidence: [scenario.evidence],
      criteria: ["Represent the substantive capability without understating or inventing experience."],
      synthesis: {
        conclusion: "Identify the demonstrated work and distinguish adjacent work from unsupported full-process claims.",
        dimensions: [{
          dimension: "Scope of actual capability",
          supportedScope: scenario.evidence,
          evidence: [scenario.evidence],
        }],
        emphasis: "Reason from activities rather than project labels while preserving limits.",
      },
      taskContract: {
        deliverable: "Direct, evidence-grounded answer to the user's question.",
        requirements: [{
          id: "capability",
          requirement: "Evaluate the user-provided evidence substantively.",
          sourceId: "turn-1",
          quote: scenario.question,
          status: "active",
        }],
        conflicts: [],
      },
    };
    const phases: string[] = [];
    const reviewer = makeProvider("anthropic", async p => {
      if (p.persona.includes("KATIE_INDEPENDENT_ASSESSMENT")) {
        phases.push("assessment");
        assert.match(p.persona, /INDEPENDENT CAPABILITY INFERENCE/);
        assert.match(p.persona, /Distinguish direct performance, substantively demonstrated components/);
        assert.ok(!p.user.includes(scenario.wrong), "Capability interpretation is draft-blind");
        assert.ok(p.persona.includes(scenario.evidence));
        return response("anthropic", "reviewer", scenarioAssessment);
      }
      phases.push("comparison");
      assert.match(p.persona, /EVIDENCE-BASED CAPABILITY REASONING/);
      assert.match(p.user, /evidence-to-conclusion-reasoning/);
      const textToCheck = p.user.match(/<answer_to_review>\n([\s\S]*?)\n<\/answer_to_review>/)?.[1];
      assert.ok(textToCheck);
      const check = verdict("approve", scenarioAssessment);
      if (textToCheck === scenario.wrong) {
        check.verdict = "revise";
        check.findings = "This answer incorrectly infers the scope from a label or overstates work not established. Re-evaluate the underlying components and factual boundaries.";
        const inferenceCheck = check.checks.find(x => x.id === "evidence-to-conclusion-reasoning");
        assert.ok(inferenceCheck);
        inferenceCheck.passed = false;
        inferenceCheck.evidence = "The draft materially misrepresents the demonstrated scope of experience.";
      } else {
        assert.equal(textToCheck, scenario.correct);
        check.findings = "Corrected: the conclusion represents underlying activities without claiming unperformed work.";
      }
      return response("anthropic", "reviewer", check);
    });
    const lead = makeProvider("openai", async p => {
      if (p.persona.includes("KATIE_TASK_CONTRACT_VALIDATION")) {
        phases.push("contract");
        return contractApproval(p);
      }
      phases.push("revision");
      assert.match(p.user, /evidence-to-conclusion|materially misrepresents|incorrectly infers/);
      return response("openai", "lead", scenario.correct);
    });
    const result = await runRequiredDraftReview({
      requestId: "capability-" + scenario.name,
      draft: initial, params: source, leadProvider: lead,
      deadlineMs: deadline(),
      selectHelper: async () => ({ provider: reviewer, modelId: "reviewer" }),
    });
    assert.equal(result.audit.status, "revised");
    assert.equal(result.result.text, scenario.correct);
    assert.deepEqual(phases, ["assessment", "contract", "comparison", "revision", "comparison"]);
    assert.equal(result.audit.reviews?.[0].review.checks.find(c => c.id === "evidence-to-conclusion-reasoning")?.passed, false);
    assert.equal(result.audit.reviews?.at(-1)?.review.checks.find(c => c.id === "evidence-to-conclusion-reasoning")?.passed, true);
  });
}

test("capability-inference gate cannot approve an explicitly failed reasoning check", () => {
  const invalid = verdict("approve");
  const index = invalid.checks.findIndex(c => c.id === "evidence-to-conclusion-reasoning");
  assert.ok(index >= 0);
  invalid.checks[index].passed = false;
  invalid.checks[index].evidence = "The answer wrongly concludes no capability from an absent label.";
  assert.throws(() => validateAnswerReview(invalid, assessment), /Approval contradicts failed acceptance checks/);
});


test("new explicit application question isolates contract negotiation from completed earlier questions", async () => {
  const parent = "FP&A/P&L Advisor for a PE-backed distribution company. The role needs executive financial partnering, P&L insight, PE ownership experience, and broader industrial experience.";
  const priorQuestion = "Please share a relevant example of owning FP&A or P&L responsibilities in a PE-backed industrial company.";
  const priorCorrection = "Use the education engagement as the primary example and keep the industrial experience separate.";
  const latest = "Please share 3 to 5 examples of your relevant experience.";
  const progress = {
    version: 1 as const,
    objective: { text: latest, userMessageId: "latest" },
    projectContext: { text: parent, userMessageId: "job" },
    stage: "working" as const,
    nextAction: "continue_original_goal" as const,
    pending: [],
    answered: [],
    lastAssistantMessageId: null,
    lastUserMessageId: "latest",
    lastUserIntent: "new_task" as const,
  };
  const source: ChatGenerateParams = {
    name: "Katie",
    modelId: "lead",
    persona: "Executive application advisor. Verified career evidence is available in memory.",
    summary: "",
    history: [
      { role: "user", content: parent },
      { role: "user", content: priorQuestion },
      { role: "user", content: priorCorrection },
    ],
    user: latest,
  };
  const baseline = reviewBaseline(source, progress);
  assert.deepEqual(baseline.contractTurns, [{ id: "latest-user", text: latest }]);
  assert.match(baseline.text, /ACTIVE CONTRACT SOURCES/);
  assert.match(baseline.text, /BACKGROUND USER EVIDENCE/);
  assert.match(baseline.text, /PE-backed industrial company/);
  assert.ok(!baseline.text.includes('"id":"turn-1"'), "Completed earlier turns must not retain contract source IDs.");

  const a: IndependentAssessment = {
    objective: "Provide 3 to 5 representative examples of the user's relevant experience for the current opportunity.",
    qualifications: ["Executive financial partnership, P&L analysis, PE-backed leadership, and industrial finance."],
    strongestEvidence: ["Use the strongest distinct examples supported by the career record."],
    criteria: ["Select 3 to 5 distinct examples that collectively demonstrate the opportunity's major needs."],
    synthesis: {
      conclusion: "Show broad, representative fit rather than repeating one earlier subtopic.",
      dimensions: [{ dimension: "Relevant breadth", supportedScope: "PE-backed leadership plus industrial and operating finance", evidence: ["Verified career evidence"] }],
      emphasis: "Each example should add a distinct capability.",
    },
    taskContract: {
      deliverable: "Three to five examples of relevant experience.",
      requirements: [{ id: "examples", requirement: "Provide 3 to 5 examples of relevant experience.", sourceId: "latest-user", quote: latest, status: "active" }],
      conflicts: [],
    },
  };
  const draftText = "1. PE-backed interim CFO leadership. 2. Industrial P&L ownership. 3. Multinational finance recovery. 4. Operating leadership in a growing products company.";
  const candidate: ProviderResponse = { provider: "anthropic", model: "lead", text: draftText };
  const phases: string[] = [];
  const reviewer = makeProvider("openai", async p => {
    if (p.persona.includes("KATIE_INDEPENDENT_ASSESSMENT")) {
      phases.push("assessment");
      assert.ok(!p.user.includes('"id":"turn-1"'));
      assert.match(p.user, /BACKGROUND USER EVIDENCE/);
      return response("openai", "reviewer", a);
    }
    phases.push("review");
    return response("openai", "reviewer", verdict("approve", a));
  });
  const lead = makeProvider("anthropic", async p => {
    if (!p.persona.includes("KATIE_TASK_CONTRACT_VALIDATION")) throw new Error("Unexpected revision");
    phases.push("contract");
    return response("anthropic", "lead", {
      verdict: "approve",
      findings: "The contract faithfully captures the active broad examples question.",
      issueType: "none",
      sourceCoverage: [{ sourceId: "latest-user", finding: "This is the sole active contract source for the new deliverable." }],
    });
  });
  const result = await runRequiredDraftReview({
    requestId: "active-contract-isolation",
    draft: candidate,
    params: source,
    taskProgress: progress,
    leadProvider: lead,
    deadlineMs: deadline(),
    selectHelper: async () => ({ provider: reviewer, modelId: "reviewer" }),
  });
  assert.equal(result.audit.status, "approved");
  assert.deepEqual(phases, ["assessment", "contract", "review"]);
  assert.equal(result.audit.contractValidation?.sourceCoverage.length, 1);
  assert.equal(result.audit.contractValidation?.sourceCoverage[0].sourceId, "latest-user");
});
