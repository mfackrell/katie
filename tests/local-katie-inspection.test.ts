import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSystemPromptRequest } from "../lib/chat/local-katie";
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
