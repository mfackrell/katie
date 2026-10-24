# Take Eleven controlled benchmark runner

Issue: #715. This is **infrastructure scaffolding**, not a live usable A/B benchmark yet.

## Identical inputs
Both arms use the original #650 game contract (11 stones, take 1–3, A/B alternating, last-taker win, invalid actions immutable, reset, persistent reload, accessible UI). Both start from baseline commit `0015bcdb8ac9ad94b7c74d1a4cd76737903b1319` in branches `benchmark/take-eleven-direct` and `benchmark/take-eleven-orchestrated`.

## Runner contract
Invoke `node scripts/benchmark/take-eleven-runner.mjs --config CONFIG.json --out OUTPUT_DIRECTORY`. Config requires `baselineSha`, `capTokens`, and exactly two `arms` entries with `id`, `branch`, `cwd`, executable `command` and string-array `args`.

The adapter MUST enforce cap before each provider request; the driver cannot stop a paid provider request after launch. It receives `BENCHMARK_ARM`, `BENCHMARK_TOKEN_CAP`, `BENCHMARK_RUN_ID`, `BENCHMARK_BASELINE_SHA`, `BENCHMARK_RECEIPT_PATH`. Write an atomic receipt JSON at the supplied path with:
```json
{"runId":"<from environment>","arm":"direct","baselineSha":"<from environment>","capEnforced":true,"usage":{"inputTokens":0,"outputTokens":0},"artifactSha":"<commit SHA or null>"}
```
A receipt is self-asserted by the adapter: production verification must reconcile it against provider billing logs. Do not substitute pre-reserved tokens for actual usage. Any missing or invalid receipt is a failure. The driver does not attest acceptance; private Preview browser and deterministic validation remain separate.

## Missing before real use
- Connect verified direct-agent and orchestrator adapters, both enforcing token authorization server side.
- Arrange independent clean worktrees for the two baseline branches, and confirm identical tool/model configurations where possible.
- Integrate provider-sourced usage/cost receipts and replayable step traces; do not trust adapter self-report alone.
- Run identical deterministic acceptance and private-browser suites on both immutable commits.
- Add tests exercising runner happy path, missing receipt, overspend, corrupted receipt, wrong baseline, and single-arm failure.
- Manual workflow currently gates but intentionally **does not launch inference**.

No new approval, inference, model spending, deployment, or resumption of existing Take Eleven project is implied by this PR.
