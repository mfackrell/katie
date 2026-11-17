# Routing integration for #1070

Status: working code integrated locally; **not release-qualified**. No commit, push, draft PR, merge, production access or paid inference was performed. The enclosing orchestration owns the commit and independent review. This candidate supersedes the source branches for qualification; neither source PR is accepted.

## Fresh-context repair verification (2026-11-17)

Reviewed `AGENT_REQUEST.md`, `AGENT_REPAIR_CONTEXT.md`, `agent-test.log` and
`agent-review.json` against checkout `5d8b885aae80afe7c884aec64c90e16b1e9b14a1`.
**All three reviewer blockers remain unresolved.** This follow-up changes only
this evidence record; it supplies no application fix or qualification verdict.

The cost finding is an implementation gap: `buildNeutralDecisionEvidence` still
uses characters/4, 1024 output tokens, zero cache hits and one attempt. The real
`createParams` in the chat route is assembled after initial routing and includes
persona, history, response-policy instructions, document guidance, restored
website evidence and media. The existing preparation-only accounting mechanism
in `lib/router/control-plane-economics.ts` prices helper requests, not those final
generation requests. Reusing its helper quote would not satisfy full-request
cost evidence. Candidate-specific final request preparation, cache/retry
scenarios and choice-changing regressions remain required implementation work.

The quality finding also remains: no comparative observations enter stage two.
The checked-in objective-first synthetic evaluation describes same-model prompt
comparisons, expressly without a statistical quality claim; it is not a
cross-model task-quality corpus. A supported offline historical corpus with
provenance and independent assessments is needed, together with its evidence
path and replay tests. Neither mock-selected winners nor registry tiers were
substituted for this requirement. No paid evaluation or production access was
performed.

Fresh local checks used Node `22.23.4` (the shell defaults to `24.22.2`):

- Typecheck passed in the Node 22 gate attempt; test TypeScript compilation also
  completed.
- Direct compiled routing/preference suites passed **197 tests**, zero failures,
  skips, cancellations or todos: neutral-two-stage-routing, routing-preferences,
  creative-continuity, google-routing, model-intent-routing,
  control-plane-economics, standalone-model-routing, routing-decision-audit and
  chat-video-routing. These verify contracts and mocked behavior only.
- Browser acceptance: both viewport tests failed before assertions at Chromium
  launch, `sandbox_host_linux.cc:41`, `shutdown: Operation not permitted (1)`.
  This does not diagnose or resolve the original qualified-runner timeout.
- All three required native PostgreSQL files were invoked with
  `KATIE_TEST_PG_BIN=/usr/lib/postgresql/16/bin`: 2 source checks passed, 4 native
  checks failed, zero skipped. PostgreSQL is installed and initialization works;
  the preference fixture records `could not bind Unix address ... Operation not
  permitted` and `FATAL: could not create any Unix-domain sockets`.
- The unmodified full gate repeatedly reported `spawnSync .../node EPERM`.
  Interrupted at file 64/414 with exit 130. This is an incomplete failing attempt,
  not a full-gate result; its URL/build/smoke stages were not reached.
- A separate URL guard attempt failed at `spawnSync /bin/sh EPERM` while running
  `git ls-files`.
- The separate production build passed, including compilation, lint/type checks,
  static generation and normal postbuild. It reported the existing
  `components/chat-workspace.tsx` effect-dependency warning. The normal Storage
  probe declined production access. An initial smoke attempt lacked
  `.next/BUILD_ID`; rerunning after the successful build still failed when the
  runtime exited before the smoke check completed. No smoke pass is claimed.
- `bwrap` is absent. No replacement isolation mechanism, launcher changes,
  workflow edits, relaxed checks or skip allowances were introduced.

Diagnostic logs: `/tmp/repair-{gate,browser,pg,targeted,url,build,smoke}-node22.log`.
The post-build smoke log is `/tmp/repair-smoke-after-build-node22.log`.
These temporary logs are not durable CI artifacts. Exact-tree complete CI,
native security/browser execution and independent review remain blocked. Live
remote heads and GitHub workflow authorization were not verified in this
restricted environment. No push, merge, deployment or PR publication occurred.

## Previous repair follow-up (2026-11-17)

Repair base: `21dafd31d76bee8825454cc107d3b587ee5de466`. Read the request,
repair context, supplied full-gate log and reviewer findings before editing.
The supplied gate completed with four failing files; the intentionally failing
fixtures printed by `test-runner.test.mjs` are not additional gate failures.

Changed only the preference browser harness and this handoff. Desktop and mobile
now run as separately named tests, each with its own Chromium lifecycle, a
75-second test deadline, 10-second browser-operation deadlines and a browser
JavaScript-error assertion. This avoids reopening a context after closing the
last context of bundled Chromium's `--single-process` instance. All original
persistence, reload, conversation-switch, clear-override and overflow assertions
remain. This is a lifecycle/diagnostic repair, **not a verified resolution of the
reported CI timeout**: this environment cannot launch the browser. The fixture's
scope resets on reload as intended; no preference-scope application defect was
established.

Local verification used Node `22.23.4` explicitly (the shell defaults to Node 24):

- Typecheck and `tsc -p tsconfig.tests.json`: passed.
- Compiled `neutral-two-stage-routing`: 34 passed; compiled
  `routing-preferences`: 11 passed; zero skipped in both. These verify routing
  contracts and mocked behavior, not measured comparative model quality.
- Browser test syntax and `git diff --check`: passed.
- Both repaired browser cases fail at launch, before application assertions:
  `sandbox_host_linux.cc:41`, `shutdown: Operation not permitted (1)`.
- All three required native PostgreSQL files were explicitly invoked with
  `KATIE_TEST_PG_BIN=/usr/lib/postgresql/16/bin`. None skipped. Preference
  migration: one failure; ITM one-shot: two source checks pass, one native failure;
  ITM recovery exposure: two native failures. Servers cannot start. The preference
  fixture captures `could not bind Unix address ... Operation not permitted`,
  `FATAL: could not create any Unix-domain sockets` and `pg_ctl EPERM`.
- `npm run check:url`: fails at `spawnSync /bin/sh EPERM` for `git ls-files`.
- `npm run ci:gate` was attempted with the same Node and PostgreSQL settings.
  Typecheck passed; the test phase encountered repeated subprocess/browser
  permission failures. Interrupted at file 31/414 (exit 130) after collecting
  those failures. This is an incomplete, failing gate attempt; build and smoke
  were not reached or rerun in this repair. No exact-tree full-gate pass exists.
- `bwrap` is absent in this repair environment (`command not found`). No
  isolation control, workflow, skip policy or browser launch flags were changed.

Diagnostic logs for this session are under `/tmp/routing-repair-{targeted,
preferences,browser,postgres,exposure,preferences-pg,gate}.log`; these temporary
files are not durable CI artifacts.

All three reviewer findings remain blocking. Cost and quality are **unfinished
implementation requirements**, separately from runner restrictions:

- `buildNeutralDecisionEvidence` still prices a character/4, 1024-output-token
  illustration, not the actual final request. The existing
  `estimatePreparedRequest` supports frozen provider payloads, tools/media and
  cache-write allowances; `rankControlPlaneByActualCost` captures real helper
  payloads. Neither supplies the reply candidates' final payloads to Stage 2.
  Chat calls `chooseProvider` before constructing final reply parameters.
  Connecting candidate-specific preparation, output limits and cache/retry
  scenarios remains necessary. Pricing helper requests alone cannot satisfy it.
- `RegistryRoutingModel` exposes capabilities and reasoning/speed tiers, but no
  comparative task-outcome observations or their provenance. No supported
  comparative observation corpus was found in this repair. Empty observations
  remain explicitly unknown. Approved offline historical outputs and independent
  quality assessments, followed by an implemented evidence path and meaningful
  replay regressions, are still needed. Mock-selected winners and registry tiers
  cannot substitute for them; no observations or savings were fabricated.
- Native browser/security execution, complete exact-SHA CI and independent
  reviewer PASS remain required on a qualified isolated runner. Live remote
  heads and the precise GitHub `action_required` reason remain unverified.

No application behavior was substituted for these missing requirements. The
candidate remains **BLOCKED**, and this repair does not authorize release,
publication, production access, paid inference or changes to protective CI.

Source provenance:

- Workspace HEAD and cached origin/main: `dddb1c1f404b7d8c21d2ba4902d54bf83c2d554c`, preserving #1068.
- #1074 cached source head: `e1f7ca265558cfb293e6fd4d06d1e1eadbabf741`; working commits `53ff58f4` and `e1f7ca26`.
- #1073 cached source head: `84dedd225982ed9c9ad1518e3f1a8fc846929e5a`; working commits `f6e0cb90` and `84dedd22`.
- Applied each source branch's diff against that main to the existing workflow branch. Changes are limited to the six routing source files and ten preference source files, plus integration repairs/tests and this handoff. No workflow changes.
- `git ls-remote origin refs/heads/main refs/heads/agent/issue-1071-44092341665-1 refs/heads/agent/issue-1072-44092345219-1` failed: `Could not resolve host: github.com`. Cached refs match the request exactly; current remote state and GitHub action_required reasons remain unverified. Stop qualification if the live refs differ.

## Architecture and repairs

Standalone chat admission authenticates the caller, binds owner/actor/chat in PostgreSQL, and supplies a durable workflow context, including internal replay. Preference resolution uses that context, verifies the requested actor/chat match, reads rows filtered by that owner and exact conversation, and checkpoints the resolved mode for retry consistency. It does not reauthenticate an expired browser token during replay. The public preference API retains independent authentication and scope authorization on every read/write. Anonymous sessions cannot persist preferences; admitted guests with no rows receive Best Value without a sign-in requirement.

Precedence: explicit manual model bypasses automatic preference reads; otherwise conversation row overrides global row, then Best Value. The client routing_mode field is accepted for compatibility but never used as authority. All three chat routing calls, including refusal/error reroutes, receive the same resolved mode. Preference read failures remain explicit, rather than silently inventing an effective mode. Manual models continue without a preference database read.

The recovered routing implementation removes standalone actor/provider boosts and quality scoring, presents all eligible models to Stage 2, and keeps legacy orchestration behavior isolated. Existing media capability, accounting, provider-price eligibility and replay controls remain in place. Stage 1 requires objective, grounded message quotes, complexity, response purpose, refusal risk, context influence, selection justification, and now an explicit quality-requirements assessment. Invalid responses receive one correction across eligible helpers; exhausted helpers produce a disclosed fallback. Stage 2 cannot run on an unvalidated fallback category. Reroutes can reuse validated Stage 1 evidence. Stage 2 also requires a nonempty selection justification. Terminal accounting failures in Stage 1 propagate instead of becoming local routing fallback.

The preference browser harness and repaired standalone-accounting fixture are reused from #1073. The browser harness is under normal tests/ discovery. Added a native PostgreSQL migration regression covering service/browser role permissions, RLS flags, mode checks, override clearing and cascade cleanup. API regressions cover cross-owner/actor/chat scope, guest defaults, precedence, forged hints and manual selection during preference-store failure.

## Current validation

Direct offline test commands use the repository's compiled aliases and `node --experimental-test-isolation=none`, without changing the normal runner:

- `npm run typecheck`: passed.
- `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`: passed.
- `neutral-two-stage-routing`: 34 passed, zero skipped. Mocked historical task/continuation replays cover both modes and every provider as a possible winner; these are control-flow simulations, not quality evaluations.
- `routing-preferences`: 11 passed, zero skipped.
- Existing `model-intent-routing`: 7; `standalone-model-routing`: 3; `creative-continuity`: 8; `routing-decision-audit`: 11; `chat-video-routing`: 8. All passed, zero skipped.
- Accounting API: 22; context preflight: 9; native Grok accounting: 4. All passed. Pricing ran through its native Vitest runner: 40 passed. Total directly verified: 157 tests, zero skipped. A first attempt to execute the compiled pricing test with Node was an invalid harness invocation (it imports Vitest); the corrected Vitest invocation passed.
- Production build passed, including type/lint, all 76 static pages, and normal postbuild (the existing production-only Storage probe declines to contact production).
- `git diff --check`: passed.

Required execution remains blocked, not passed:

- `KATIE_TEST_PG_BIN=/usr/lib/postgresql/18/bin npm run ci:gate` attempts the unmodified full test runner; subprocess launches report `spawnSync /opt/hostedtoolcache/node/24.22.2/x64/bin/node EPERM`. The environment has Node 24 rather than package.json's Node 22. The run stopped making progress at file 210/413 (`native-wip-recovery`); it was interrupted with exit 130 after the repeated permission failures. This attempt began before the final repairs and added PostgreSQL test, so it is not exact-final-tree CI. No skip allowance or runner controls were changed.
- `npm run check:url`: `spawnSync /bin/sh EPERM`, invoking `git ls-files`.
- `npm run smoke`: `next start exited before smoke test completed (code 1)`; no runtime smoke pass.
- Direct preference browser acceptance: Chromium launches then exits SIGTRAP at `content/browser/sandbox_host_linux.cc:41`, `shutdown: Operation not permitted (1)`. No desktop/mobile persistence pass claimed.
- The repaired standalone-accounting browser fixture was also invoked directly and remains blocked at `listen EPERM: operation not permitted 127.0.0.1`, before browser assertions.
- Native PostgreSQL tests were invoked with KATIE_TEST_PG_BIN set (not skipped). Initdb works, but pg_ctl cannot start: `could not bind Unix address .../.s.PGSQL.55496: Operation not permitted`, `FATAL: could not create any Unix-domain sockets`. Existing one-shot PostgreSQL test also fails to start its isolated server. The exposure test file was also invoked directly with the fixture binary set and fails to start its isolated servers. Native security assertions still require qualified execution.
- `bwrap --unshare-user --ro-bind / / true`: `No permissions to create a new namespace`. No unsandboxed fallback was introduced.

The existing `.github/workflows/ci.yml` gate is the repository's configured executable runner: Ubuntu 24.04, Node 22, PostgreSQL fixtures and filesystem isolation setup, followed by strict ci:gate and browser/security acceptance. This worker cannot dispatch or inspect it because GitHub DNS is unavailable. Its configuration is evidence of the intended runner, not proof that a particular run executed or passed. An authorized owner/admin must inspect the exact GitHub action_required run and authorize execution through existing controls; its precise remote reason is unknown here. Do not treat a zero-job run as passing. Final exact-SHA independent review, full native security/browser signoff and CI remain required after the workflow commits these changes.

## Unverified quality and cost requirements

The recovered cost evidence applies reviewed tiered token prices and exposes input/output/cache rates and context limits. Its scenarios still approximate text input by characters/4 and assume 1024 output tokens, no cache hits and one attempt. They do **not** represent the fully serialized final provider request, media/tool payloads, actual output, cache writes, retry distributions or total routing overhead. Comparative quality observations are explicitly unknown, not measured. These are outstanding #1070 qualification/implementation requirements; do not claim actual full-request cost optimization or reliable comparative outcome evidence from this candidate. No savings or quality uplift is asserted. Actual spend remains governed by existing accounting preflight/approval/ledger controls.

## Migration, rollback and review handoff

Apply additive `20261117140000_routing_preferences.sql` in a qualified isolated database before rolling out application code, after native permission tests pass. It adds only service-accessible preference tables with RLS enabled and browser/public privileges revoked. Existing actor/chat/accounting schemas and protected autonomous workflow are unchanged. Application code must not run before the tables exist. Roll back application code first; retain preference tables to preserve user choices. Optional later removal drops conversation preferences before global preferences and deletes only the new preference data.

No final tested commit/tree SHA or independent reviewer verdict exists in this uncommitted worker workspace. The orchestration must assign the SHA, run exact-tree CI, obtain the separate reviewer PASS, and prepare one combined draft PR referencing #1070, #1073 and #1074 with these limitations. Do not publish either original as approved or merge separately.
