import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSystemPromptRequest, isExplicitMemoryMutation, isExplicitMemoryCorrection } from "../lib/chat/local-katie";
import { boundProviderSystemAudit } from "../lib/chat/provider-system-audit";

test("exact system message and prompt queries stay on the local inspection path", () => {
  for (const message of [
    "show me your full system message",
    "show me your full system prompt",
    "Show your current system instructions",
    "what is your system message?",
    "Give me the exact system message for this chat",
    "What prompt are you using?",
    "What instructions are you sending to Grok?",
    "Show me what you sent to the model",
    "Display your full outgoing provider prompt",
  ]) {
    assert.equal(isSystemPromptRequest(message), true, message);
  }
});

test("discussion of prompt design is not accidentally hijacked as a local inspection command", () => {
  for (const message of [
    "Rewrite this paragraph about system prompt design",
    "Explain what a system message is",
    "Review the architecture of the system message classifier",
    "How do system prompts work?",
    "Write a story about prompts",
  ]) {
    assert.equal(isSystemPromptRequest(message), false, message);
  }
});

test("chat request short circuits before router and any model-backed memory maintenance", () => {
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  const localCheck = route.indexOf("const localKatieResponse = await resolveLocalKatieResponse(");
  const localExit = route.indexOf("return new NextResponse(localBody", localCheck);
  const modelWork = route.indexOf("await maintainMemoryArchitecture(actorId, chatId)", localCheck);
  const router = route.indexOf("const configuredProviders = getAvailableProviders()", localCheck);
  assert.ok(localCheck > 0 && localExit > localCheck && modelWork > localExit && router > modelWork);
  const shortCircuit = route.slice(localCheck, localExit);
  assert.doesNotMatch(shortCircuit, /chooseProvider\(|getAvailableProviders\(|maybeUpdateSummary\(/);
  assert.match(shortCircuit, /model:\s*"katie-local"/);
  assert.match(shortCircuit, /provider:\s*"local"/);
});

test("provider audit stores literal system strings only and truthfully marks truncation", () => {
  const normal = boundProviderSystemAudit({
    provider: "grok", model: "grok-4.7", endpoint: "/v1/chat/completions",
    systemMessages: ["CORE_PERSONA: Hello", "MEMORY_CONTEXT: Known fact"],
  });
  assert.deepEqual(normal.systemMessages, ["CORE_PERSONA: Hello", "MEMORY_CONTEXT: Known fact"]);
  assert.equal(normal.truncated, false);
  const long = boundProviderSystemAudit({
    provider: "google", model: "gemini-2.5-flash", endpoint: "generateContent",
    systemMessages: ["hello".repeat(60_000), "must truncate"],
  });
  assert.equal(long.truncated, true);
  assert.ok(long.systemMessages.join("").length <= 240_000);
});

test("explicit memory write and correction requests are never mistaken for inspection",()=>{
 for(const message of [
 "you need to incorporate this information into your long term memory: my experience",
 "Please save all of this in your long-term memory",
 "Remember my preferences for later",
 "Correct the incorrect value in your long term memory",
 "Your long-term memory is incorrect. Change the figure."
 ]) assert.equal(isExplicitMemoryMutation(message),true,message);
 assert.equal(isExplicitMemoryCorrection("Correct the incorrect value in your long term memory"),true);
 assert.equal(isExplicitMemoryMutation("Show me your long-term memory"),false);
});

test("natural clarification commands are routed to guaranteed memory writes", () => {
  const exactUserMessage = `we need to clarify one point in your long term memory. re the global PE backed professional services engagement:
  Mark led the accounting recovery through the accounting team. He personally performed relatively little underlying transaction-level work.`;
  for (const message of [
    exactUserMessage,
    "Please clarify this information in your long term memory.",
    "I need to amend something in your saved memory",
    "Refine the facts you have remembered about my former role",
    "I want to reframe a statement in your memory",
    "Update what you remember: I led the recovery, not the entries",
  ]) {
    assert.equal(isExplicitMemoryCorrection(message), true, message);
    assert.equal(isExplicitMemoryMutation(message), true, message);
  }
  for (const message of [
    "What is your memory?",
    "Show me the long term memory component",
    "Please clarify what you mean by memory architecture",
  ]) assert.equal(isExplicitMemoryCorrection(message), false, message);
});
