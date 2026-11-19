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


test("B-TQA1: every error metadata getter may throw without replacing the provider failure", () => {
  const secret = "PRIVATE-provider-error-not-for-logs";
  for (const field of ["name", "code", "status", "type"] as const) {
    const original = new Error(secret);
    Object.defineProperty(original, field, { get() { throw new Error("hostile accessor " + secret); } });
    const details = safeFailureDetails(original);
    assert.equal(typeof details.failureCategory, "string");
    assert.equal(JSON.stringify(details).includes(secret), false, field);
  }
  const partlyKnown = new Error(secret);
  Object.defineProperties(partlyKnown, {
    status: {get() { throw new Error("status unavailable"); }},
    code: {value: "standalone_outcome_unknown"},
    name: {get() { throw new Error("name unavailable"); }},
  });
  assert.deepEqual(safeFailureDetails(partlyKnown), {
    failureCategory: "unknown_outcome", errorCode: "standalone_outcome_unknown",
  });
  const partialStatus = Object.defineProperties(new Error(secret), {
    status: {value: 429},
    code: {get() { throw new Error("code unavailable"); }},
    type: {get() { throw new Error("type unavailable"); }},
  });
  assert.deepEqual(safeFailureDetails(partialStatus), {
    failureCategory: "provider_rate_limit", httpStatus: 429,
  });
});

test("B-TQA1: hostile proxies, revoked proxies and primitive errors produce bounded nonthrowing metadata", () => {
  const hostile = new Proxy(new Error("PRIVATE"), {
    get() { throw new Error("getter trap must not escape diagnostic code"); },
  });
  const revoked = Proxy.revocable(new Error("PRIVATE"), {});
  revoked.revoke();
  for (const error of [hostile, revoked.proxy, null, undefined, "provider rejected", 17, Symbol("private"), Object.create(null)]) {
    assert.deepEqual(safeFailureDetails(error), { failureCategory: "unknown" });
  }
});

test("B-TQA1: synchronous failures preserve the identical original thrown value with throwing getters and sink errors", () => {
  const original = new Error("original provider cause");
  for (const field of ["name", "code", "status", "type"] as const) {
    Object.defineProperty(original, field, { get() { throw new Error("diagnostic getter failed"); } });
  }
  let executions = 0;
  const phases: string[] = [];
  assert.throws(() => runProviderAttemptTrace(meta, () => {
    executions++;
    throw original;
  }, event => phases.push(event.phase)), error => error === original);
  assert.equal(executions, 1, "no duplicated provider attempt");
  assert.deepEqual(phases, ["attempt_started", "attempt_failed", "attempt_finalized"]);
  assert.throws(() => runProviderAttemptTrace(meta, () => {
    executions++;
    throw original;
  }, () => { throw Error("logging sink failed"); }), error => error === original);
  assert.equal(executions, 2, "each separate invocation executes exactly once");
});

test("B-TQA1: asynchronous rejection preserves error identity and uncertain-outcome classification", async () => {
  const original = Object.defineProperties(new Error("original asynchronous provider failure"), {
    code: {get() { throw new Error("unreadable code"); }},
    status: {get() { throw new Error("unreadable status"); }},
    name: {get() { throw new Error("unreadable name"); }},
    type: {value: "uncertain_exposure_retained"},
  });
  let dispatched = 0;
  const events: ProviderTraceEvent[] = [];
  const rejected = runProviderAttemptTrace(meta, () => {
    dispatched++;
    recordProviderTrace("dispatch_initiated");
    return Promise.reject(original);
  }, event => events.push(event));
  await assert.rejects(rejected, error => error === original);
  assert.equal(dispatched, 1);
  assert.equal(events.at(-1)?.phase, "attempt_finalized");
  assert.equal(events.at(-1)?.outcome, "unknown");
  assert.equal(events.at(-1)?.observed?.dispatched, true);
  assert.equal(events.at(-1)?.observed?.headers, false);
  assert.equal(events.find(event => event.phase === "attempt_failed")?.failureCategory, "unknown_outcome");
  assert.equal(JSON.stringify(events).includes(original.message), false);
  await assert.rejects(runProviderAttemptTrace(meta, async () => {
    throw original;
  }, () => { throw new Error("sink failed during rejection"); }), error => error === original);
});

test("B-TQA1: rejected revoked proxy and primitive reasons remain exactly unchanged", async () => {
  const proxy = Proxy.revocable(new Error("hidden provider failure"), {});
  proxy.revoke();
  for (const original of [proxy.proxy, "original rejection text", null, undefined]) {
    let runs = 0;
    const events: ProviderTraceEvent[] = [];
    const failure = runProviderAttemptTrace(meta, () => {
      runs++;
      return Promise.reject(original);
    }, event => events.push(event));
    // Node's assert.rejects itself reads rejection.name, which throws on a
    // revoked Proxy. Observe the Promise directly instead of testing Node's
    // assertion implementation.
    let rejected = false;
    let observed: unknown;
    try {
      await failure;
    } catch (reason) {
      rejected = true;
      observed = reason;
    }
    assert.equal(rejected, true, "provider Promise must reject");
    assert.equal(Object.is(observed, original), true, "exact original rejection must survive");
    assert.equal(runs, 1);
    assert.equal(events.at(-1)?.phase, "attempt_finalized");
    assert.equal(events.at(-1)?.outcome, "failed");
  }
});

test("B-TQA1: successful paths and disabled diagnostic branch invoke work exactly once", async () => {
  let sends = 0;
  const events: ProviderTraceEvent[] = [];
  const result = await runProviderAttemptTrace(meta, () => {
    sends++;
    recordProviderTrace("dispatch_initiated");
    recordProviderTrace("response_headers_received", {httpStatus: 200});
    recordProviderTrace("response_body_received");
    return Promise.resolve({ok: true});
  }, event => events.push(event));
  assert.deepEqual(result, {ok: true});
  assert.equal(sends, 1);
  assert.equal(events.at(-1)?.outcome, "completed");
  assert.equal(events.at(-1)?.observed?.headers, true);
  assert.equal(events.at(-1)?.observed?.receipt, false);
});
