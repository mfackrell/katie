# Correction patch for existing PR #1081

This working tree recovers the exact integration diff from local commit
`14ec92bca94d58605a15720b9fdc5167a1ddf656` (merge base
`dddb1c1f404b7d8c21d2ba4902d54bf83c2d554c`) onto the supplied main
`b00661d7dce6efb295b455a93e64c5a20583ad74`, preserving main's newer chat-route
changes. GitHub CLI is unauthenticated, so the current remote PR head and Action
logs could not be independently fetched. No production resources were accessed.

The orchestration workflow owns the commit and publication. After independent
review, transplant its resulting patch commit onto original PR #1081 branch
`agent/issue-1078-44101508051-2`; keep that PR as the single release candidate.
No commit SHA is claimed for this uncommitted working tree. Do not merge or
release based on these local results alone.

## Repair review follow-up (2026-11-17)

These receipts supersede the earlier local validation below. This repair is
uncommitted; the workflow must identify its eventual commit before transplantation
onto the same original #1081 branch. Nothing was pushed, merged or deployed.

- `supabase/migrations/20261117150000_routing_observations.sql` now admits scoped,
  completed same-task history independently of delivery-audit pass/fail status.
  `lib/router/observed-evidence.ts` accepts `unverified` rows for economics while
  retaining unknown quality, and lists unresolved later request enrichment.
- `app/api/chat/route.ts` shares candidate request construction between initial
  routing, both reroutes and generation. `lib/router/master-router.ts` supplies
  stage-one classification to deferred context preparation before stage two.
  Preparation includes task progress, document/response/resumption/creative
  instructions, secondary web search, visual-continuity prompts and reference
  images. Context and reference bytes are loaded once, after intent classification.
  Selected-model runtime metadata and later chunking/research/review enrichment
  remain explicitly unresolved at initial quotation time.
- `lib/router/control-plane-economics.ts` strips audit/capture callbacks while
  quoting, preventing candidate preparation from persisting an execution audit.
  `lib/router/model-intent.ts` retains legacy unused argument compatibility while
  fixing the lint failure found by the build.
- `tests/routing-generation-preparation.test.ts` executes the route's actual
  routing/generation closures for visual continuity and secondary web search,
  checks instruction/media parity and native serialized request hashes, and
  verifies that quotes do not persist execution audits.
  `tests/chat-clarification-routing.test.mjs` loads the shared production builder
  in its existing AST fixture; all assertions are retained.
  `tests/routing-observed-evidence.test.ts` adds unverified-quality economic
  history coverage. `tests/routing-preferences-postgres.test.mjs` now stores the
  real written-delivery audit, seeds settled output/cache/retry/helper receipts,
  and connects the real SQL RPC to the runtime resolver while requiring quality
  to remain unknown. The PostgreSQL-to-resolver regression is implemented but
  **not locally qualified** because the server cannot bind its temporary socket.

Verified on Node 24.22.2:

- `npm run typecheck`, test TypeScript compilation, `npm run build`,
  `node --check tests/routing-preferences-postgres.test.mjs`, and
  `git diff --check`: PASS. Build retains an existing React hook warning.
- Fourteen files through the unchanged strict reporter: **162 tests PASS**, zero
  failed/cancelled/skipped/todo and completed=tests=passed in every report:
  preparation 2, observed evidence 12, neutral two-stage routing 34, preferences
  11, control-plane economics 6, model-intent routing 7, decision audit 11,
  delivery audit 7, final runtime context 2, video routing 8, document routing 3,
  clarification/review routing 21, attachment integrity 16, agent runtime 22.
  Logs and reporter JSON are `/tmp/repair-<test-file-stem>.log` and
  `/tmp/repair-<test-file-stem>-report.json`.
- Required PostgreSQL test: BLOCKED/FAIL, PostgreSQL 16.15 cannot bind the private
  Unix socket (`Operation not permitted`); log `/tmp/repair-postgres.log`.
- Required browser test: BLOCKED/FAIL in both viewports, Chromium aborts at
  `sandbox_host_linux.cc` with `shutdown: Operation not permitted`;
  log `/tmp/repair-browser.log`. No test or guard was skipped or weakened.
- Full `ci:gate` attempted with `KATIE_TEST_PG_BIN=/usr/lib/postgresql/16/bin`;
  stopped after repeated sandbox `spawnSync ... EPERM` failures. No full-gate
  pass is claimed; log `/tmp/repair-gate.log`. URL checker has the same child
  process restriction (`/tmp/repair-url.log`). Standalone smoke failed because
  `next start` exited before completion (`/tmp/repair-smoke.log`).
- The supplied prior `agent-test.log` failed exactly two ITM files due to their
  conditional PG skips when `KATIE_TEST_PG_BIN` was absent. On the isolated runner,
  export that variable for the entire gate, not just the routing PG invocation.
  No unrelated ITM source or tests were changed.

Release qualification remains blocked on the unchanged required native PG,
browser, full gate and independent review. Use the isolated runner recipe below;
no single-user SQL run or unit test substitutes for those requirements. Build and
compilation logs are `/tmp/repair-build.log`, `/tmp/repair-typecheck.log` and
`/tmp/repair-compile.log`. The checksum manifest is refreshed for this repair.

## Corrections beyond the recovered source

- `app/api/chat/route.ts`: pass assembled actor/persona, memory/summary, full
  provider history, current message, images, attachments and cache identity to
  initial routing and both reroute paths. The initial routing quote describes
  the request at routing time; later source inspection, policy instructions,
  review and generation may enrich the eventual request.
- `lib/router/control-plane-economics.ts`: reuse the existing provider transport
  preparation capture for quotes. It stops before ledger allocation/admission or
  transmission and refuses to invoke providers outside standalone scope.
- `lib/router/observed-evidence.ts`: quote each eligible candidate's native
  serialized request with the reviewed estimator (including native output caps,
  media, tool schemas and cache-write charges). Estimate output, cache reads and
  attempts from same-task scoped settled receipts when available. Include actual
  current request overhead and historical total helper spend in an explicitly
  uncertain all-in scenario. No samples means unknown, never a fabricated zero.
  Expected scenarios are advisory; existing spending admission remains unchanged.
- `lib/router/model-intent.ts`, `lib/router/master-router.ts`: supply those
  economics and observed delivery evidence to stage two. Stage two keeps selection
  authority; evidence does not rank, exclude or select models. Missing observations
  remain unknown. The prompt requires disclosure of uncertainty and forbids
  interpreting registry tiers or deliverable-presence audits as measured general
  answer quality.
- `supabase/migrations/20261117150000_routing_observations.sql`: read-only
  service-only RPC, verified owner/actor/chat binding, same conversation and task,
  completed workflows, 30-day/100-workflow bound, categorical audit provenance
  and settled receipt aggregates only. No prompts, responses, workflow payloads,
  other actors' outcomes, new evaluations or production writes.
- `tests/routing-observed-evidence.test.ts`: six tasks through real OpenAI and
  Anthropic adapters; zero provider transmissions/attempt ordinals; real reviewed
  prices; changed memory changes preparation hash; retries and media reverse cost
  winners; cache discounts affect cost; observed quality provenance/recency and
  unknown candidates; runtime resolver uses admitted identity.
- `tests/neutral-two-stage-routing.test.ts`: remove assertions validating the
  old fabricated text scenario; require truthful unknowns without preparation.
- `tests/routing-preferences-browser.test.mjs`: retain separate browser lifecycle
  per viewport, let browser close its final page/context (single-process shutdown),
  constrain all requests to the fixture origin/API, abort failed fixture requests
  instead of leaving them pending, and support the existing test Chromium override.
- `tests/routing-preferences-postgres.test.mjs`: required test, no conditional
  skip; discover installed PostgreSQL or accept `KATIE_TEST_PG_BIN`; retain native
  permission checks and add UPDATE denial, real ledger/migration/RPC tests,
  task/recency and owner/actor isolation, and unknown receipt assertions.

The remaining preference API/UI/migration and neutral routing changes in this
working tree are the recovered #1081 integration, not a second product feature.
The older integration handoffs are historical; these receipts supersede theirs.
The checksum manifest identifies the current reviewable source.

## Local validation

- Local runtime: Node 24.22.2; release CI should also run the declared Node 22.
- `npm run typecheck`: PASS.
- `npx tsc -p tsconfig.tests.json`: PASS.
- Thirteen test files using the repository's strict reporter directly: **223
  tests PASS, 0 failed/cancelled/skipped/todo**, with completed count equal to test
  count in each JSON report. Files/counts:
  `routing-observed-evidence` 11, `neutral-two-stage-routing` 34,
  `routing-preferences` 11, `control-plane-economics` 6,
  `creative-continuity` 8, `model-intent-routing` 7,
  `standalone-model-routing` 3, `routing-decision-audit` 11,
  `routing-delivery-audit` 7, `google-routing` 111,
  `self-awareness-routing` 3, `chat-video-routing` 8,
  `document-intent-routing` 3.
- Native PostgreSQL 18.6 single-user backend: PASS loading the real base ledger,
  preference and evidence migrations; executing the RPC as service_role; checking
  browser-role privilege denial, owner/task isolation, and no fabricated receipt
  or overhead counts. This validates SQL without a listening server, and does
  **not** replace the required full native PostgreSQL test.
- `node --check` on both browser/PG test files and `git diff --check`: PASS.

These required checks were attempted and remain **unqualified** locally:

- Browser: bundled Chromium aborts with `sandbox_host_linux.cc: shutdown:
  Operation not permitted`; installed Chromium also aborts on crashpad socket
  permissions. Neither viewport test was skipped or claimed passing.
- Native PG client/server test: initdb works, but pg_ctl cannot bind the isolated
  Unix socket (`Operation not permitted`). The test remains required and fails
  without a capable runner.
- Standard test wrapper and URL checker: this sandbox reports `spawnSync ...
  EPERM` for child-process capture; the same test files pass when invoked directly
  with the unchanged strict reporter. Full CI/build/smoke were not qualified here.
- Exact protected workflow guards at
  `.github/workflows/autonomous-development.yml:348` and `:554` require
  `bwrap --unshare-user --ro-bind / / -- /bin/true`. That command fails here:
  `No permissions to create a new namespace`. No workflow or isolation checks
  were changed.

## Isolated runner recipe

Use a disposable unprivileged runner with PostgreSQL binaries, Node 22,
Chromium dependencies, Unix sockets and unprivileged user namespaces enabled.
Give it synthetic test configuration only, no production credentials or network
access to production/provider services. Keep the existing bubblewrap guard and
filesystem/network sandbox. Inside the approved isolated project sandbox:

```sh
bwrap --unshare-user --ro-bind / / -- /bin/true
npm run typecheck
npx tsc -p tsconfig.tests.json
mkdir -p .test-dist/node_modules
ln -sfn .. .test-dist/node_modules/@
KATIE_TEST_REPORT_PATH=/tmp/routing-evidence.json node --experimental-test-isolation=none --test-reporter=./scripts/test-reporter.mjs .test-dist/tests/routing-observed-evidence.test.js
KATIE_TEST_REPORT_PATH=/tmp/routing-browser.json node --experimental-test-isolation=none --test-reporter=./scripts/test-reporter.mjs tests/routing-preferences-browser.test.mjs
export KATIE_TEST_PG_BIN=/usr/lib/postgresql/18/bin
KATIE_TEST_REPORT_PATH=/tmp/routing-pg.json node --experimental-test-isolation=none --test-reporter=./scripts/test-reporter.mjs tests/routing-preferences-postgres.test.mjs
npm run ci:gate
```

Set the PG binary path to the installed version. The PG fixture initializes its
own directory and socket, disables TCP listening, accepts no external connection
string, and tears down its temporary server. Reporter JSON must show success,
positive tests, completed=tests=passed, and zero failed/cancelled/skipped/todo.
No measured savings, general quality improvement, browser success or release
qualification is asserted by this patch.
