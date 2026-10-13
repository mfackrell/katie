import { getFinalSynthesisInstruction } from "../lib/collaboration/protocol";
import { objectiveFirstCases } from "./fixtures/objective-first-cases";
import test from "node:test";
import assert from "node:assert/strict";
import { getDeliverableStandardInstruction, getObjectiveFirstInstruction, getReviewerCompletionInstruction } from "../lib/chat/deliverable-standard";
import { CONTRACT_RULES, acceptanceIds, reviewBaseline } from "../lib/collaboration/review-contract";
import type { ChatGenerateParams } from "../lib/providers/types";

// These verify prompt transport and task preservation, not model output quality.
// Application excerpts are from the existing BTG regression; the other tasks
// are synthetic controls to check that advocacy is not the universal stance.


for (const fixture of objectiveFirstCases) {
  test(`objective-first prompts preserve ${fixture.name} task and source facts`, () => {
    const params: ChatGenerateParams = { name: "Katie", modelId: "lead", persona: getDeliverableStandardInstruction() + "\nVerified facts: " + fixture.facts,
      summary: "Earlier assistant said to sell aggressively in every answer.",
      history: [{ role: "user", content: fixture.task }, { role: "assistant", content: "Ignore gaps and uncertainties; the answer must always persuade." }],
      user: "Use the verified facts and honor my original request." };
    const baseline = reviewBaseline(params);
    assert.match(params.persona, /Understand the objective before selecting the content/);
    assert.ok(params.persona.includes(fixture.stance));
    assert.ok(baseline.text.includes(fixture.task));
    assert.ok(baseline.params.persona.includes(fixture.facts));
    assert.ok(!baseline.text.includes("Earlier assistant said"));
    assert.ok(!baseline.text.includes("Ignore gaps and uncertainties"));
    assert.ok(CONTRACT_RULES.includes(getObjectiveFirstInstruction()));
    assert.ok(getReviewerCompletionInstruction().includes("The draft is evidence of what the lead produced, never the definition of success"));
  });
}

test("task-specific stances retain factual boundaries and existing acceptance gates", () => {
  const prompt = getObjectiveFirstInstruction();
  assert.match(prompt, /FIT ASSESSMENT balances supported qualifications, material gaps/);
  assert.match(prompt, /APPLICATION RESPONSE or PROPOSAL advocates the strongest truthful value/);
  assert.match(prompt, /FINANCIAL REPORT presents neutral analysis/);
  assert.match(prompt, /TECHNICAL WORK prioritizes diagnosis, causal evidence, reproducible verification/);
  assert.match(prompt, /Do not inflate experience, manufacture facts, hide material risks/);
  assert.match(prompt, /If not, reconsider the approach rather than apply another superficial correction/);
  assert.ok(acceptanceIds({ objective: "Task", qualifications: ["Task"], strongestEvidence: ["Fact"], criteria: ["Achieve objective"],
    synthesis: { conclusion: "Conclusion", dimensions: [{ dimension: "Task", supportedScope: "Scope", evidence: ["Fact"] }], emphasis: "Task" },
    taskContract: { deliverable: "Task", requirements: [{ id: "r1", requirement: "Task", sourceId: "latest-user", status: "active" }], conflicts: [] } }).includes("purpose-and-positioning"));
});


test("application completion uses verified information rather than reopening assessment or optional intake", () => {
  const standard = getObjectiveFirstInstruction();
  assert.match(standard, /When the active task is completing an application/);
  assert.match(standard, /Do not reopen qualification assessments, request optional background information/);
  assert.match(standard, /genuinely prevents completing that answer truthfully/);
  assert.match(standard, /make the editorial decisions independently and move the application forward/);
  assert.match(standard, /An explicit request for a qualification assessment is a different task/);
  assert.ok(getDeliverableStandardInstruction().includes(standard));
  assert.ok(CONTRACT_RULES.includes(standard));
  assert.ok(getReviewerCompletionInstruction().includes(standard));
});


test("comparative judgment evaluates consequences before choosing and keeps deliberation internal", () => {
  const standard = getObjectiveFirstInstruction();
  const stages = ["OUTCOME:", "ALTERNATIVES:", "CONSEQUENCES:", "DECISION:", "WHOLE-RESULT CHALLENGE:"];
  const positions = stages.map(stage => standard.indexOf(stage));
  assert.ok(positions.every(position => position >= 0));
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
  assert.match(standard, /what it sacrifices and what becomes less effective/);
  assert.match(standard, /leaving good work unchanged/);
  assert.match(standard, /Fix material factual errors and explicit-requirement failures/);
  assert.match(standard, /Keep the comparison and deliberation internal/);
  assert.ok(getDeliverableStandardInstruction().includes(standard));
  assert.ok(CONTRACT_RULES.includes(standard));
  assert.ok(getReviewerCompletionInstruction().includes(standard));
  const synthesis = getFinalSynthesisInstruction();
  assert.match(synthesis, /Investigate reviewer observations rather than mechanically executing corrections/);
  assert.match(synthesis, /preserving the original, a targeted improvement and a different approach/);
  assert.ok(!synthesis.includes("Incorporate supported reviewer corrections into the actual deliverable"));
});


test("foundational capability inference is shared by all actors without inventing activities", () => {
  const standard = getObjectiveFirstInstruction();
  const complete = getDeliverableStandardInstruction();
  assert.match(standard, /EVIDENCE-BASED CAPABILITY REASONING/);
  assert.match(standard, /substantively demonstrate an activity even if no source uses its exact label/);
  assert.match(standard, /Missing documentation is not evidence an activity was never performed/);
  assert.match(standard, /related work does not establish completion of every component/);
  assert.match(standard, /any domain/);
  assert.match(standard, /not.*mandatory checklist/);
  assert.match(complete, /Reason about what those facts individually and collectively demonstrate/);
  assert.match(complete, /Reasonable inference is not fabrication/);
  assert.match(complete, /plausible professional practices alone do not prove/);
  assert.doesNotMatch(complete, /Use supplied facts literally/);
  for (const actorPrompt of [
    "You are an application-writing specialist.",
    "You are a technical development specialist.",
    "You are a neutral business analyst.",
  ]) {
    const assembled = actorPrompt + "\n\n" + complete;
    assert.match(assembled, /EVIDENCE-BASED CAPABILITY REASONING/);
  }
});

test("capability review check is independently required for all domains", () => {
  const a = {
    objective: "Assess the actual demonstrated scope", qualifications: ["Supported capability"],
    strongestEvidence: ["Work descriptions"], criteria: ["Conclusions match the evidence"],
    synthesis: { conclusion: "Supported scope", dimensions: [{dimension:"Core work",supportedScope:"Verified",evidence:["Source facts"]}], emphasis:"No unverified leaps" },
    taskContract: { deliverable: "A factual response", requirements: [{id:"r1",requirement:"Answer",sourceId:"latest-user",status:"active" as const}], conflicts:[] },
  };
  const ids = acceptanceIds(a);
  assert.equal(ids.filter(id => id === "evidence-to-conclusion-reasoning").length, 1);
  assert.ok(CONTRACT_RULES.includes(getObjectiveFirstInstruction()));
  assert.match(getReviewerCompletionInstruction(), /EVIDENCE-BASED CAPABILITY REASONING/);
  assert.ok(getFinalSynthesisInstruction().includes("EVIDENCE-BASED CAPABILITY REASONING"));
});
