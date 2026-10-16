import test from "node:test";
import assert from "node:assert/strict";
import { decideResponsePolicy, shouldEscalateConversationResponse } from "../lib/chat/response-policy";
import { inferRequestClassification, parseIntentClassifierResponse } from "../lib/router/model-intent";
import { chooseProvider } from "../lib/router/master-router";
import type { LlmProvider } from "../lib/providers/types";

const actualReply = "i do not have specific distribution, wholesale experience, i dont know what sporsor reporting is.";

test("Oct 16 mixed fact and terminology answer does not start substantive processing", () => {
  assert.equal(actualReply.length, 97);
  const result = decideResponsePolicy({ message: actualReply, hasPendingDeliverable: true, intent: "general-text" });
  assert.equal(result.purpose, "conversation");
  assert.equal(result.requiresSubstantiveProcessing, false);
  assert.match(result.generationInstruction ?? "", /Not knowing a term does not establish a lack of experience/);
  assert.match(result.generationInstruction ?? "", /Keep the active substantive task pending/);
});

test("terminology interruptions remain conversational across topics and wording", () => {
  for (const message of [
    "No, I haven't done wholesale. What do you mean by sponsor reporting?",
    "I have used spreadsheets, but I don't understand what idempotency means.",
    "What is sponsor reporting?",
    "What does accrual mean?",
    "Could you explain what you mean by reconciliation?",
  ]) {
    const result = decideResponsePolicy({ message, hasPendingDeliverable: true, responsePurpose: "deliverable" });
    assert.equal(result.purpose, "conversation", message);
  }
});

test("short authorization still triggers substantive processing even with a wrong conversation hint", () => {
  for (const message of ["yes, draft it", "Go ahead", "make these changes", "please proceed", "No, rewrite it.", "Please share a relevant example of owning FP&A."]) {
    const result = decideResponsePolicy({ message, responsePurpose: "conversation", hasPendingDeliverable: true });
    assert.equal(result.requiresSubstantiveProcessing, true, message);
  }
});

test("a definition plus an explicit production instruction still requires review", () => {
  const result = decideResponsePolicy({
    message: "I don't know what sponsor reporting is; explain it, then draft my application answer.",
    responsePurpose: "conversation", hasPendingDeliverable: true,
  });
  assert.equal(result.purpose, "deliverable");
});

test("a negated draft instruction does not turn a terminology question into a deliverable", () => {
  const result = decideResponsePolicy({
    message: "Don't draft anything yet. What does sponsor reporting mean?",
    hasPendingDeliverable: true,
  });
  assert.equal(result.purpose, "conversation");
});

test("facts and bare confirmations that can complete pending work are not skipped for being short", () => {
  for (const message of ["$25 million", "Yes", "No", "I led the team.", "London"]) {
    const result = decideResponsePolicy({ message, hasPendingDeliverable: true, intent: "general-text" });
    assert.equal(result.requiresSubstantiveProcessing, true, message);
  }
});

test("gratitude and greetings are lightweight while simple substantive work still receives review", () => {
  for (const message of ["Thanks", "Okay, thank you.", "Got it", "Hello Katie!"]) {
    assert.equal(decideResponsePolicy({ message, hasPendingDeliverable: true }).requiresSubstantiveProcessing, false, message);
  }
  for (const message of ["Analyze the cash flow", "Write a one-line formula", "Please give me a relevant work example."]) {
    assert.equal(decideResponsePolicy({ message, intent: "general-text" }).requiresSubstantiveProcessing, true, message);
  }
});

test("unclassified ambiguous requests default to substantive work, independent of short length", () => {
  assert.equal(decideResponsePolicy({ message: "25", intent: "general-text" }).requiresSubstantiveProcessing, true);
  assert.equal(decideResponsePolicy({ message: "Your thoughts?", intent: "general-text" }).requiresSubstantiveProcessing, true);
});

test("diagnostic and analytical questions are not mistaken for terminology interruptions", () => {
  for (const message of [
    "What is wrong with this code?",
    "What is the best capital allocation strategy?",
    "What are the risks in this contract?",
    "I don't understand why the API fails.",
  ]) {
    assert.equal(decideResponsePolicy({ message, hasPendingDeliverable: true }).requiresSubstantiveProcessing, true, message);
  }
});

test("contextual conversational classification can request a clarification without an extra model call", () => {
  const result = decideResponsePolicy({
    message: "I'm not sure which period you need.", responsePurpose: "conversation", hasPendingDeliverable: true,
  });
  assert.equal(result.purpose, "conversation");
});

test("attachments, tool work, and explicit saved review retries cannot bypass substantive review", () => {
  for (const flags of [{ hasAttachments: true }, { requiresTools: true }, { explicitReviewRetry: true }]) {
    assert.equal(decideResponsePolicy({ message: "What does this mean?", responsePurpose: "conversation", ...flags }).requiresSubstantiveProcessing, true);
  }
});

test("brief useful explanation passes the output guard without reviewer work", () => {
  const result = decideResponsePolicy({ message: actualReply });
  const responseText = "Sponsor reporting means providing the private equity owner with financial results, forecasts, cash flow, and explanations of performance. You may have done this work without using that label. In a PE-backed role, did you prepare or present those updates for the owner or board?";
  assert.equal(shouldEscalateConversationResponse({ policy: result, responseText }), false);
});

test("unexpected application drafts are escalated even when short", () => {
  const result = decideResponsePolicy({ message: actualReply });
  for (const responseText of [
    "For 25 years, including more than 15 as an interim and fractional CFO, I have led finance teams. Four examples follow.",
    "Unverified draft (independent review incomplete):\n\nHere are four work examples.",
    "Here is your revised application answer: I led the recovery of a multinational finance function.",
    "Please accept my application. I bring finance and operating leadership across PE-backed companies.",
    "## Application response\nI restored reporting and completed the audit.",
    "I led financial reporting for a PE-backed company and built the forecasting process.",
  ]) {
    assert.equal(shouldEscalateConversationResponse({ policy: result, responseText }), true, responseText);
  }
});

test("unplanned code, structured analysis, tool results, and oversized responses escalate", () => {
  const result = decideResponsePolicy({ message: "What does accrual mean?" });
  for (const responseText of [
    "```ts\nconst revenue = 25000000;\n```",
    "| Item | Value |\n| --- | --- |\n| Revenue | 25 |",
    "1. First work example\n2. Second work example\n3. Third work example",
    "# Executive summary\nDetails\n## Recommendations\nDetails",
    Array.from({ length: 161 }, () => "word").join(" "),
  ]) {
    assert.equal(shouldEscalateConversationResponse({ policy: result, responseText }), true, responseText.slice(0, 70));
  }
  assert.equal(shouldEscalateConversationResponse({ policy: result, responseText: "Done.", usedTools: true }), true);
});

test("purpose and project metadata parse without breaking old classifier responses", () => {
  const parsed = parseIntentClassifierResponse(JSON.stringify({
    intent: "general-text", response_purpose: "conversation", project_relation: "same_project",
  }), ["general-text"], "test");
  assert.equal(parsed.response_purpose, "conversation");
  assert.equal(parsed.project_relation, "same_project");
  const old = parseIntentClassifierResponse('{"intent":"general-text"}', ["general-text"], "test");
  assert.deepEqual(old, { intent: "general-text", preferred_provider: null });
  const invalid = parseIntentClassifierResponse(JSON.stringify({
    intent: "general-text", response_purpose: "skip", project_relation: "all_projects",
  }), ["general-text"], "test");
  assert.equal(invalid.response_purpose, undefined);
  assert.equal(invalid.project_relation, undefined);
});

function classifierProvider(onClassify: (payload: string) => void): LlmProvider {
  return {
    name: "openai",
    async listModels() { return ["gpt-5.6-sol"]; },
    async generate(params) {
      if (!params.user.includes("Intent Classifier")) throw new Error("Reranker unavailable in fixture");
      onClassify(params.user);
      return {
        text: JSON.stringify({ intent: "general-text", complexity: "low", response_purpose: "conversation", project_relation: "same_project" }),
        model: "gpt-5.6-sol", provider: "openai",
      };
    },
  };
}

test("the existing classifier call carries output purpose and task relationship through inference", async () => {
  let classifierCalls = 0;
  const provider = classifierProvider(payload => {
    classifierCalls += 1;
    assert.match(payload, /response_purpose/);
    assert.match(payload, /project_relation/);
    assert.match(payload, /most recent actual user project/);
  });
  const result = await inferRequestClassification(actualReply, false, {
    decisionProviders: [{ provider, modelId: "gpt-5.6-sol" }],
    conversationContext: "Katie just asked about distribution or sponsor reporting experience.",
  });
  assert.equal(classifierCalls, 1);
  assert.equal(result.responsePurpose, "conversation");
  assert.equal(result.projectRelation, "same_project");
});

test("master router preserves purpose and project metadata when model selection falls back", async () => {
  let classifierCalls = 0;
  const provider = classifierProvider(() => { classifierCalls += 1; });
  const result = await chooseProvider(actualReply, "Current question: do you have sponsor reporting experience?", [provider], {
    modelRegistrySnapshot: new Map(), routingRequestId: "response-purpose-regression",
  });
  assert.equal(classifierCalls, 1);
  assert.equal(result.resolvedIntent.responsePurpose, "conversation");
  assert.equal(result.resolvedIntent.projectRelation, "same_project");
  assert.equal(result.resolvedIntent.intentSource, "llm");
});
