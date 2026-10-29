# Standalone Qwen still-image observation

Ordinary standalone images use the approved RunPod Qwen3-VL-8B-Instruct endpoint first. The conversational model receives labelled textual observation evidence with source hash, question, version, timestamp and coverage. Valid immutable attachment observations are reused. Image creation/editing, video processing and Developer Orchestrator retain their existing paths.

## Accounting and release configuration

`lib/standalone-accounting/runpod-policy.ts` contains the reviewed immutable policy `standalone-runpod-qwen-still-v1`: **20,000 microUSD ($0.02) reserved per bounded image analysis**, provider RunPod, model `Qwen/Qwen3-VL-8B-Instruct`, endpoint `yafwsm98e8m9lv`. This is estimated infrastructure exposure, not an exact bill or a guaranteed ceiling. No token catalog lookup is required for this policy. Existing owner scope, per-call and cumulative original-request guards remain mandatory. At the approved $0.50/$2.00 limits a normal $0.02 call can proceed without a separate approval unless the request's cumulative exposure requires one.

The existing server-only `RUNPOD_API_KEY` is required. No browser credential, endpoint selection or automatic ownership claim is introduced. The additive migration `20261029210000_standalone_qwen_infrastructure.sql` must run via `migrate.yml` → `scripts/run-migrations.mjs`; never apply it manually to production. `/api/version` provides a non-paid runtime policy/configuration probe without exposing the key.

Each attempt is saved and claimed before submission. The provider job ID is stored immediately after acceptance; reconnects poll that job. Terminal outputs/rejections are durably replayed. Complete infrastructure attempts without monetary evidence enter `estimated`, keep the full reservation in request totals and appear separately in daily usage; actual cost stays null. Authoritative later monetary evidence can settle through the existing service-only ledger exactly once; conflicting evidence retains the existing conflict handling. Worker timing, token counts and arbitrary worker `cost` fields are not monetary receipts. The documented RunPod job-status contract has timing/output but no authoritative per-job monetary receipt, so this release retains estimates rather than calculating an invented actual.

## Bounds, escalation and limitations

Up to five images are inspected independently and labelled. The approved Qwen path accepts one JPEG/PNG/WebP data URL per job, at most 8,000,000 characters, a 1,800-character prompt and 1,400 output tokens. Worker execution is limited to 60 seconds, queue TTL to 15 minutes and each poll window to 90 seconds. A still-running accepted job can be checked again without another submission.

A failed, empty or insufficient observation, or a task requiring stronger detail/cross-image capability, permits one capability-qualified, exact-payload-priced premium escalation. Unpriceable image models are excluded before attempt creation; ordinary raw-image Gemini→Grok fallback loops are bypassed. If no eligible model exists, the request ends with a clear technical limitation rather than another unchanged Resume action. Model observations remain fallible evidence, never user-authored facts or source instructions.

If submission acceptance is lost before any job ID can be saved, the attempt remains uncertain with full exposure and is never automatically resubmitted. If a provider result has expired, its missing output is not fabricated. User cancellation/revoked access still blocks further work. No paid live test is required or performed for this release.

## Verification

- `tests/still-image-observations.test.ts`: Qwen-first default, text-only reasoning, reuse, multi-image association, qualified priceable escalation, terminal no-candidate behavior.
- `tests/runpod-still-vision.test.ts`: policy reservation before transmission, exact payload, one POST, completion replay, reconnect polling, timeout, rejection, lost acceptance, scope denial and job mismatch.
- `tests/standalone-runpod-infrastructure-postgres.test.mjs`: isolated PostgreSQL admission/thresholds, same-job continuation, retained exposure, service-only transitions, late actual settlement/conflicts and unchanged DO sentinel.
- `tests/standalone-accounting-browser.test.mjs`: Chromium daily estimated infrastructure, persistent state, same-job polling, technical blockers without false continuation and status rail stages.
- Existing video, FLUX, ownership and provider accounting tests remain in the full required CI gate. All provider regression traffic is mocked.

Production confirmation consists of the deployed exact SHA, successful migration/checksum, runtime policy probe and configured-key presence. Mocked regressions are not described as live provider inference.
