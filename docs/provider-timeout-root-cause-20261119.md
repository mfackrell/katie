# Katie routing-provider timeout: diagnostic evidence and comparison procedure

Baseline: mfackrell/katie main commit 5bce48dcbb2e27bd4c9ed2c93ce2e58a5b9c5ec5 (2026-11-19). Scope: instrumentation, safe evidence collection and comparison **only**. Paid direct-provider and paid Katie-provider tests, production changes, deployment, merge, accounting changes, routing changes, and timeout changes are **not authorized**.

## Verified existing production evidence
Read-only Vercel production logs from project katie, deployment dpl_7h6HYUdzwbtHNMdSkADvwuDDFKuA, source SHA 5bce48dcbb2e27bd4c9ed2c93ce2e58a5b9c5ec5:

- 2026-11-19 15:49:08 UTC: routing-rerank openai:gpt-5-mini returned HTTP 400 with type uncertain_exposure_retained, without an upstream request ID.
- 2026-11-19 15:49:09 UTC: routing-rerank google:gemini-2.5-flash returned HTTP 400 from the Google adapter; the existing log does not expose safe upstream error code or establish whether an original request was made.
- 2026-11-19 15:28:26 UTC: another gpt-5-mini uncertain_exposure_retained HTTP 400.
- 2026-11-19 15:28:27 UTC: another Gemini 2.5 Flash HTTP 400.
- 2026-11-19 15:28:35 UTC: a gpt-4.1-mini routing response reached structured response validation and was rejected. This is not evidence of a 17-second model timeout.

Code in lib/standalone-accounting/dispatch.ts confirms that unavailableUncertainResponse() **locally synthesizes** HTTP 400 with uncertain_exposure_retained when a previous attempt has an unresolved outcome. Do not attribute these particular HTTP 400 responses to an upstream OpenAI rejection. An absent receipt does NOT prove the provider never processed or billed the earlier attempt.

## Verified code lifecycle

1. lib/router/model-intent.ts uses 12,000 ms + a 5,000 ms standalone extension. The timer encloses candidate.provider.generate(), not just upstream provider processing.
2. lib/collaboration/attempt-policy.ts aborts locally at the deadline and races the provider promise; that does not confirm remote cancellation.
3. lib/standalone-accounting/dispatch.ts performs request preparation, pricing/ledger admission and a dispatch claim before calling the actual HTTP transport. After HTTP body receipt, it checkpoints and reconciles the receipt. All these stages may consume the provider-generation budget.
4. lib/providers/google-transport.ts converts Google non-2xx HTTP responses into generic errors. Detailed safe HTTP error status was not observable in existing logs.
5. lib/providers/openai-provider.ts uses the OpenAI SDK with Katie's accounting transport injection.

Existing logs lack stage-level timing. Therefore the precise contribution from preparation, ledger operations, network and provider inference is not yet established.

## New timeline trace

After separate deployment approval, enable KATIE_PROVIDER_TIMEOUT_DIAGNOSTICS=true. Structured log marker: [ProviderTiming]; event: katie_provider_attempt_timing, version 1.

Per attempt: trace ID, trusted request ID, task, provider, model, endpoint path, deployment commit, attempt ordinal and eventual ledger attempt ID; monotonic elapsed and interval milliseconds with UTC timestamps for joining records. Observable stages: preparation started/completed; HTTP dispatch; headers; first nonempty body chunk; full body; provider parsing; local timeout/cancellation request and observable local transport abort rejection; provider HTTP rejection; locally synthesized response; receipt observed/missing/settled; final outcome and stage-presence flags.

Missing events are *not* zero elapsed time. Receipt observed is not equivalent to receipt settled. A locally observed transport abort is not proof that the remote provider canceled inference. The first body chunk is a local Node stream observation, not a direct measurement of the provider's first token.

No prompts, user content, response bodies, arbitrary error messages, credentials or headers are logged. Error codes use an explicit allowlist. Diagnostic event logging exceptions are swallowed so they do not control provider execution. The diagnostic branch does not change timeout, model settings, fallback, routing, retry, idempotency, spending or ledger semantics.

## Offline comparison (authorized now)

Run npm run typecheck and npm test (includes tests/provider-attempt-timing.test.ts and standalone-provider-boundary mock integration). If available run npm run ci:gate. Test synthetic upstream responses using injected mock fetch transports; no real provider requests or API keys. Katie's mock path keeps its existing exact-payload accounting and receipt handling. The separate direct mock path sends the identical post-preparation serialized body, bypassing Katie layers only in the isolated test. Compare stage presence and timing, verify payload-byte equivalence, and test rate limiting, malformed or absent receipts, local abort, local deadline, redaction and trace error containment.

**Offline tests cannot establish live provider latency.**

## Live direct-versus-Katie experiment (NOT APPROVED YET)

Only after the owner explicitly approves live paid inference and sets a budget/sample limit:

1. Use a synthetic, non-user fixture in an isolated approved environment. Do not use live customer prompts, modify production database records or change configured models/parameters.
2. Verify the **actual configured** model availability via each provider's read-only model catalog. Required models: OpenAI gpt-5-mini and Google gemini-2.5-flash. Stop if unavailable instead of substituting.
3. Prepare each fixture once. Run an independent direct call with the exact same serialized provider payload, endpoint and output constraints as the corresponding Katie request. Capture the payload only in isolated test memory; never log or upload it. Document unavoidable adapter or region differences.
4. Run serial, paired and alternating direct/Katie samples for each model within explicit authorization. Preserve Katie's 17-second deadline and stop on unknown outcome, an approval hold or authorization exhaustion. Do not retry an uncertain request.
5. Tabulate per-attempt preparation, dispatch delay, HTTP headers, first chunk, full body, parse completion, cancellation, sanitized HTTP status and provider receipt. Distinguish dispatch-to-headers from pre-dispatch; correlate by trace/attempt and exact deployment SHA.

## Evidence-based interpretation

| Observation | Supported conclusion | Possible correction (NOT implemented) |
| --- | --- | --- |
| 17 seconds spent before actual dispatch; direct provider fast | Katie pre-dispatch delay | Correct measured preparation/admission bottleneck |
| Direct and Katie both dispatched early but both wait for headers | Provider/network remains ambiguous without additional transport evidence | Investigate provider/network with external trace |
| Same payload directly fast, Katie dispatch-to-body slow | Katie transport or network path | Correct measured transport bottleneck |
| Headers/body fast, parse or receipt slow | Katie post-response work | Correct measured parser or reconciliation bottleneck |
| Upstream HTTP 400 with safe provider error | Rejected provider request, not model timeout | Correct demonstrated request/eligibility incompatibility |
| Local HTTP 400 uncertain_exposure_retained | Earlier attempt uncertain, current call may not have been retransmitted | Inspect earlier attempt receipt chain and fix misleading attribution |
| Local cancellation requested but no transport rejection | Provider state unknown | Obtain authorized upstream receipt/provider telemetry |

## Current determination
The 17-second timeout **does not measure model latency alone**, and some observed HTTP 400 failures are Katie-local synthetic outcomes. The dominant source of the 17-second delay remains **unresolved** without stage timings. Minimum next evidence after owner-approved diagnostics activation: one request with preparation/dispatch/headers/body events, and, if ambiguity remains, one authorized same-payload paired direct-provider run per model. No correction is implemented.
