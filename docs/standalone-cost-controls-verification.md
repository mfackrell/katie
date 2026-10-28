# Standalone cost-control verification

All provider verification in this change is offline, with mocked HTTP responses. The database suite uses a new disposable local PostgreSQL 16 cluster and independent real SQL connections; it does not use Supabase production. Browser verification imports the real workspace/chat/usage components into a disposable Next application, traps external traffic, and uses synthetic owner state.

## Executed checks

| Check | Evidence |
|---|---|
| TypeScript application and test compilation | Passed `tsc --noEmit` and `tsc -p tsconfig.tests.json` |
| New behavioral Node suites | Passed auth/workflow, approval API, daily/DST, provider boundary, automatic containment, unpriced dispatch, and memory scheduling suites |
| Pricing and reduction | 27 Vitest tests passed, including exact premium snapshots, context tiers, native function tools, immutable quotes, incompatible reductions and cheaper-model revisions |
| Real PostgreSQL | Passed the actual migration and production TypeScript adapter against independent local connections; atomic admission/claims, exact approvals, ownership/ACLs, unknown/cancel fences, overruns, immutable prices, conflicts, response/provider-ID recovery, partial usage and late settlement |
| Real browser | Passed integrated settings, scope switching, approval→saved request resume, reduction/reapproval, cancellation, reload and mobile controls. External requests rejected. Resume sends no replacement message |
| Existing compatibility | Passed provider/native tool suites, 40 memory protocol tests, 28 PDF integrity/storage tests, 32 chat/EO routing tests, 11 deletion tests and RunPod protocol/recovery tests after preserving their offline dependency boundaries |
| Source/PDF/timeline regressions | Passed 99 PDF scope/lifecycle/timestamp tests and timeline fingerprint checks |
| URL compatibility | Passed `npm run check:url` |
| Optimized build | Passed `npm run build` with dummy local Supabase configuration. Production Storage verification was not run |
| Production server smoke | Passed local `npm run smoke`, HTTP 200 |
| Local API integration | Passed core application endpoints against local mock persistence |
| Diff integrity | Passed `git diff --check` |

The strict complete repository runner is mandatory; a focused pass is not a substitute. Use the PR's hosted CI checks for the canonical Node 22 complete result. Earlier local runs exposed test fixture imports affected by the new accounting boundary; the existing assertions were retained, the fixtures updated, and the affected suites rerun. Compatibility tests that exercise provider protocol formatting use explicit trusted orchestration scope or dependency mocks; separate standalone tests exercise the real admission/denial boundary without those mocks.

## Local environment limits

The supplied primary runtime is Node 24.22.1; the declared Node 22 runtime was also obtained and used for the final complete run. This executor prohibits Unix-domain sockets, user namespaces and interface enumeration. An external temporary runtime adapter used real loopback TCP for existing PostgreSQL fixtures and supplied loopback interface metadata only when enumeration failed. It does not modify test assertions or database transactions. Sandbox-dependent tests remain strict and cannot be made passing here by removing their isolation. They require the hosted CI environment's actual bubblewrap support. No sandbox protection or skipped-test rejection was weakened.

`npm run lint` also reports pre-existing `no-explicit-any` violations in unchanged `lib/projects/*.d.mts` declarations. The new usage component passes its focused lint with no warnings/errors. Required application build validation remains enabled.

## Acceptance coverage

- Missing identity, saved ownership, configuration, price or accounting blocks before provider HTTP transmission.
- Browser/API approval cannot authorize another owner, conversation, payload, model, pricing/formula version or attempt.
- Owner row locking serializes concurrent reservations; one dispatch claim wins across independent connections.
- Approvals authorize one exact exposure. Additional calls and increased exposure are reevaluated at admission and dispatch.
- SDK retries are disabled; transport redirects cannot create hidden sends. Timeouts and incomplete provider streams retain exposure and stop automatic replacements.
- Full/partial receipts and identifiers are durable. Late supported receipts replace reserved exposure once; conflicting receipts are rejected with retained reconciliation events.
- Known overruns are recorded without capping the charge and prevent further request admission.
- Durable input/context/provider-response checkpoints support refresh, reconnect and restart without replaying completed or unresolved paid work.
- Reduction preserves the original and tool chains, changes a supported cost lever, reestimates, and requests new approval.
- Daily totals include hidden activities, distinguish unknown usage/cost, handle DST and local midnight, and retain earlier unresolved exposure separately.
- Existing Developer Orchestrator/benchmark accounting remains separate; its SQL/runtime regression suites are included in complete CI.

## Release limitations

No paid live provider test was authorized or performed. No production merge, deployment, migration, owner binding or configuration change was made. Thresholds and timezone remain unset until explicitly configured. Unsupported billing dimensions/models—including an unreviewed provider-resolved model—stop visibly instead of producing guessed financial totals. Streaming is buffered for durable receipt capture. Cancellation is best effort and does not prove that billing stopped.

Implementation-agent billing receipts are unavailable; no development spending figure is invented. Rollback and production approval actions are in `standalone-cost-controls.md`; the complete transmission inventory and official pricing evidence are adjacent documents.
