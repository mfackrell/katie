import test from "node:test";
import assert from "node:assert/strict";
import { withProviderAttemptTimeout } from "@/lib/collaboration/attempt-policy";
import {
  readProviderResponseText, recordProviderTrace, runProviderAttemptTrace,
  safeFailureDetails, safeHttpErrorCode, type ProviderTraceEvent,
} from "@/lib/diagnostics/provider-attempt-timing";

const meta = {
  taskName: "routing-rerank",
  requestId: "safe-request-42",
  provider: "openai",
  modelId: "gpt-5-mini",
};

test("trace uses monotonic elapsed timing, preserves zero vs absent stages and never includes payload", async () => {
  const events: ProviderTraceEvent[] = [];
  const secret = "PRIVATE_PROMPT_DO_NOT_LOG";
  const result = await runProviderAttemptTrace(meta, async () => {
    recordProviderTrace("request_preparation_started");
    recordProviderTrace("request_preparation_completed");
    recordProviderTrace("dispatch_initiated");
    const data = new TextEncoder().encode(JSON.stringify({text: secret}));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(data); controller.close(); }
    });
    const response = new Response(stream, {status: 200});
    recordProviderTrace("response_headers_received", {httpStatus: response.status});
    const body = await readProviderResponseText(response);
    assert.equal(JSON.parse(body).text, secret);
    recordProviderTrace("response_parsing_completed");
    return body.length;
  }, event => events.push(event));

  assert.ok(result > 0);
  const phases = events.map(event => event.phase);
  assert.deepEqual(phases, [
    "attempt_started", "request_preparation_started", "request_preparation_completed",
    "dispatch_initiated", "response_headers_received", "first_response_chunk_received",
    "response_body_received", "response_parsing_completed", "attempt_finalized",
  ]);
  assert.ok(events.every(event => event.elapsedMs >= 0 && event.sincePreviousMs >= 0));
  assert.ok(events.every((event, index) => index === 0 || event.elapsedMs >= events[index - 1].elapsedMs));
  assert.equal(events.at(-1)?.observed?.firstChunk, true);
  assert.equal(events.at(-1)?.observed?.receipt, false, "no receipt must not be fabricated");
  assert.equal(events.at(-1)?.attemptId, null, "unassigned ID is missing, not zero");
  assert.equal(events[0].elapsedMs >= 0, true);
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test("empty response leaves first-chunk event absent and marks a complete body", async () => {
  const events: ProviderTraceEvent[] = [];
  await runProviderAttemptTrace(meta, async () => {
    const text = await readProviderResponseText(new Response(""));
    assert.equal(text, "");
  }, event => events.push(event));
  assert.equal(events.some(event => event.phase === "first_response_chunk_received"), false);
  assert.equal(events.at(-1)?.observed?.completeBody, true);
  assert.equal(events.at(-1)?.observed?.firstChunk, false);
});

test("structured diagnostic failure codes never include raw provider error messages or sensitive content", () => {
  const privateMessage = "secret-user-content-and-sk-private";
  const rateLimited = Object.assign(new Error(privateMessage), {status: 429, code: "rate_limit_exceeded"});
  assert.deepEqual(safeFailureDetails(rateLimited), {
    failureCategory: "provider_rate_limit", httpStatus: 429, errorCode: "rate_limit_exceeded",
  });
  assert.equal(safeHttpErrorCode(JSON.stringify({error:{status:"INVALID_ARGUMENT",message: privateMessage}})), "INVALID_ARGUMENT");
  assert.equal(safeHttpErrorCode(JSON.stringify({error:{code: privateMessage, message: privateMessage}})), undefined);
  assert.equal(JSON.stringify(safeFailureDetails(rateLimited)).includes(privateMessage), false);
  assert.equal(safeFailureDetails(Object.assign(new Error("no network"), {code:"ENOTFOUND"})).failureCategory, "connection_failure");
  assert.equal(safeFailureDetails(Object.assign(new Error("reset"), {code:"ECONNRESET"})).failureCategory, "network_interruption");
  assert.equal(safeFailureDetails(Object.assign(new Error("unresolved"), {code:"standalone_outcome_unknown"})).failureCategory, "unknown_outcome");
});

test("deadline records cancellation requested, not cancellation acknowledged without observable transport rejection", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const events: ProviderTraceEvent[] = [];
  let signal: AbortSignal | undefined;
  const result = runProviderAttemptTrace(meta, () =>
    withProviderAttemptTimeout(current => {
      signal = current;
      queueMicrotask(() => t.mock.timers.tick(17));
      return new Promise<never>(() => {});
    }, 17, "routing-rerank:openai:gpt-5-mini"), event => events.push(event));
  await assert.rejects(result, /billing outcome is unknown/);
  assert.equal(signal?.aborted, true);
  assert.equal(events.filter(e => e.phase === "cancellation_requested").length, 1);
  assert.equal(events.some(e => e.phase === "cancellation_acknowledged"), false);
  assert.equal(events.at(-1)?.outcome, "unknown");
  assert.equal(events.at(-1)?.observed?.headers, false);
});

test("HTTP 400 synthesized by Katie is explicitly separate from an upstream HTTP rejection", async () => {
  const events: ProviderTraceEvent[] = [];
  await runProviderAttemptTrace(meta, () => {
    recordProviderTrace("local_synthetic_response", {httpStatus: 400, failureCategory: "unknown_outcome"});
  }, event => events.push(event));
  assert.equal(events.some(event => event.phase === "provider_http_rejection"), false);
  assert.equal(events.find(event => event.phase === "local_synthetic_response")?.httpStatus, 400);
});

test("observability sink errors cannot change dispatch return values or error causes", async () => {
  const value = await runProviderAttemptTrace(meta, async () => {
    recordProviderTrace("dispatch_initiated");
    return "unchanged";
  }, () => { throw new Error("sink unavailable"); });
  assert.equal(value, "unchanged");
  const original = new Error("original provider error");
  await assert.rejects(runProviderAttemptTrace(meta, async () => {
    throw original;
  }, () => { throw new Error("sink unavailable"); }), error => error === original);
});
