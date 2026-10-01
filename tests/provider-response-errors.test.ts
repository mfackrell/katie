import test from "node:test";
import assert from "node:assert/strict";
import { GoogleProvider } from "../lib/providers/google-provider";
import { ProviderResponseError } from "../lib/providers/response-errors";
import { runWithRefusalFallback } from "../lib/router/refusal-detection";
import type { ChatGenerateParams, ProviderResponse } from "../lib/providers/types";
const params: ChatGenerateParams = { name: "Katie", persona: "Be helpful", summary: "", history: [], user: "Describe this landscape", modelId: "gemini-2.5-flash" };
const answer: ProviderResponse = { provider: "google", model: params.modelId!, text: "A mountain." };
function provider(responses: unknown[], streaming = false) {
  const p = new GoogleProvider("test");
  let calls = 0;
  (p as unknown as { client: unknown }).client = { models: {
    generateContent: async () => { calls++; return responses.shift(); },
    generateContentStream: async function* () { calls++; yield* responses; },
  }};
  return { run: () => streaming ? p.generateStream(params, {}) : p.generate(params), calls: () => calls };
}
const ok = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "A mountain." }] } }] };
test("empty provider output retries once inside handler and succeeds", async () => {
 const p = provider([{ candidates: [{ finishReason: "STOP" }] }, ok]);
 const r = await runWithRefusalFallback({ attempts: ["google"], runAttempt: p.run, detectRefusal: () => false, shouldRetryRefusal: true });
 assert.equal(r.result.text, answer.text); assert.equal(p.calls(), 2);
});
test("repeated empty output is bounded and never silently accepted", async () => {
 let calls = 0;
 await assert.rejects(runWithRefusalFallback({ attempts: [1, 2], runAttempt: async () => { calls++; return { ...answer, text: "  " }; }, detectRefusal: () => false, shouldRetryRefusal: true }), /no answer/);
 assert.equal(calls, 2);
});
test("Google prompt and candidate blocks stop before rerouting, with and without streaming", async () => {
 for (const streaming of [false, true]) for (const response of [{ promptFeedback: { blockReason: "SAFETY" } }, { candidates: [{ finishReason: "SAFETY" }] }, { candidates: [{ finishReason: "PROHIBITED_CONTENT" }] }]) {
  const p = provider([response], streaming); let reroutes = 0;
  await assert.rejects(runWithRefusalFallback({ attempts: [1, 2], runAttempt: p.run, detectRefusal: () => true, shouldRetryRefusal: true, rerouteOnError: async () => { reroutes++; return 2; } }), (e: unknown) => e instanceof ProviderResponseError && !e.retryable && /Google stopped/.test(e.message));
  assert.equal(p.calls(), 1); assert.equal(reroutes, 0);
 }
});
test("streamed text is not accepted when final chunk is blocked", async () => {
 const p = provider([ok, { candidates: [{ finishReason: "SAFETY" }] }], true);
 await assert.rejects(p.run(), /Google stopped/);
});
test("thought-only and output-limit responses are classified; ordinary output succeeds", async () => {
 await assert.rejects(provider([{ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "private reasoning", thought: true }] } }] }]).run(), /no answer/);
 await assert.rejects(provider([{ candidates: [{ finishReason: "MAX_TOKENS" }] }]).run(), /output limit/);
 assert.equal((await provider([ok]).run()).text, answer.text);
 assert.equal((await provider([ok], true).run()).text, answer.text);
});
