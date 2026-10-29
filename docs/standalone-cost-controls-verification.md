# Standalone cost-control verification

All provider verification in this change is offline, with mocked HTTP responses. The database suite uses a new disposable local PostgreSQL 16 cluster and independent real SQL connections; it does not use Supabase production. Browser verification imports the real workspace/chat/usage components into a disposable Next application, traps external traffic, and uses synthetic owner state.

## Executed checks

| Check | Evidence |
|---|---|
| Complete local Node 22 run before cache integration | 1,907 Node tests passed in successful files and all 82 Vitest tests passed. Two existing sandbox-dependent files could not pass without prohibited user namespaces; strict runner correctly exited nonzero |
| TypeScript application and test compilation | Passed `tsc --noEmit` and `tsc -p tsconfig.tests.json` |
| New behavioral Node suites | Passed auth/workflow, approval API, daily/DST, provider boundary, automatic containment, unpriced dispatch, and memory scheduling suites |
| Pricing and reduction | 37 Vitest tests passed, including exact premium snapshots, context tiers, native function tools, immutable quotes, incompatible reductions, cheaper-model revisions and OpenAI/Claude cache integration |
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


## October 29 bounded review correction

Integrated main once at `6c80898` (merge `3352f1a`). Preserved ITM bounded compaction, attachment-selection rationale/audit diagnostics and the concurrent Developer Orchestrator recovery changes. The ITM conflict retains both the accounting-error propagation and main's compaction-failure stop; compaction admission errors also propagate rather than becoming generic retry failures.

| Review finding | Correction and behavioral evidence |
|---|---|
| Google SDK content unions serialized directly into REST | `lib/providers/google-transport.ts` converts string/Part/Part-array inputs into one user Content, preserves explicit Content turns/roles, and normalizes system instructions before the accounting fetch sees any bytes. Mixed Content/Part arrays, empty input and unscoped function parts fail locally. The real saved-attachment selector regression in `tests/standalone-provider-boundary.test.ts` pauses without sending, then transmits the approved canonical bytes/hash on resume and replays the receipt without another send. It also verifies the integrated rationale diagnostic survives. |
| Chat/agent deletion blocked by accounting bindings | Additive migration `20261029153000_standalone_deleted_scope_history.sql` retains historical binding IDs while transactional delete triggers revoke the scope. The isolated PostgreSQL test upgrades an already-used ledger and executes the existing `deleteChatById` / `deleteActorsById` functions against real SQL. Exact attempts, receipts, amounts, reservations, events and workflow history survive. New admission, old pending approval, pre-reserved dispatch, workflow resume and same-UUID rebind are rejected after deletion. Chat deletion preserves a sibling chat's authority; actor deletion revokes both. Rollback leaves live authority intact; a late receipt still settles an already-dispatched attempt. |

Executed locally on Node 22.23.4: 29 provider-boundary tests, 46 attachment/API/workflow/unpriced-path tests, 23 ITM tests, and the real PostgreSQL transaction/concurrency suite passed with zero failures/skips/todos. Application typecheck and full test compilation passed; `git diff --check` passed. PostgreSQL 16.14 used a temporary external UID/ownership shim because this executor maps only UID 0; SQL, transactions, constraints and assertions were unchanged. No shim or runtime package is committed. Hosted CI remains the canonical complete gate on its exact final SHA; its run and result are recorded on PR #822.

The original ledger migration is unchanged. Production migration authority remains `.github/workflows/migrate.yml` → `scripts/run-migrations.mjs`. No production migration, merge, configuration change, deployment or paid provider request was performed. Production release and owner configuration remain separately authorized release actions.

## PR #822 bounded review corrections (October 29, 2026)

Integrated `origin/main` once at merge `3352f1a`, including ITM/attachment diagnostics
`6c80898` and Developer Orchestrator recovery changes through `854bcff`.

- Google review finding: `google-transport.ts` normalizes SDK string, Part,
  Part-array and explicit Content inputs (including system instructions) before
  serialization reaches estimation, hashing, approval or HTTP. Invalid mixed
  inputs fail before admission. The behavioral attachment-selection regression
  pauses with zero HTTP sends, verifies the normalized quote and estimate, resumes
  with byte-identical approved/transmitted bodies and hashes, preserves the
  current attachment rationale, and replays the settled result without sending.
- Deletion review finding: new additive migration
  `20261029153000_standalone_deleted_scope_history.sql` removes only live-scope
  foreign keys from historical bindings and transactionally revokes bindings on
  chat/actor deletion. Verification requires live rows and an unrevoked binding;
  recreating the UUIDs cannot restore authority. Attempts, receipts, workflows,
  pending exposure and append-only events remain intact; late receipts can settle.
  The original ledger migration is unchanged. Production application remains
  exclusively through `migrate.yml` → `scripts/run-migrations.mjs`.
- Node 22.23.4: 49 focused provider-boundary, approval API, workflow and provider
  recovery tests passed; application typecheck and test compilation passed.
- Isolated PostgreSQL 16: actual application `deleteChatById` and
  `deleteActorsById` executed against real SQL through a thin persistence wire
  adapter. The suite upgrades an already-used ledger, checks exact history before
  and after deletion, transaction rollback, sibling-chat revocation boundaries,
  admission/approval/dispatch/resume denial, UUID reuse, late settlement and the
  unchanged Developer Orchestrator budget sentinel. Passed with no skipped tests.
  The local root-only executor uses the existing UID-reporting compatibility shim
  to launch the disposable PostgreSQL binary; SQL/transactions are unmodified.
  Hosted CI runs PostgreSQL as its normal non-root user.

No merge, production migration/deployment, or paid provider experiment was performed.
The final commit's hosted checks are the release gate; see the PR for their result.
