# Routing integration for #1070

Status: working code integrated locally; **not release-qualified**. No commit, push, draft PR, merge, production access or paid inference was performed. The enclosing orchestration owns the commit and independent review. This candidate supersedes the source branches for qualification; neither source PR is accepted.

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
