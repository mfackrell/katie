# Issue #1050 — paused expired-window renewal candidate

## Root cause and verified baseline

Engineering baseline: `26c7098450ee63106e0d3dc68488818ced3771b2` (PR #1049 merge). Read-only production inspection on November 15, 2026 confirmed Vercel deployment `dpl_E3da4TPdFmy4g5EeLx6PkhQHZXTa` READY on that exact SHA and Supabase migration `20261115181555 / management_loop_recovery` installed.

The original project `fe9d2658-41e3-44c1-ae8e-a0cba98371fe` remained paused in development, with deadline `2026-11-15T18:00:00Z`, 73/96 historical missions, zero packages, all 13 nodes and 600000 tokens. There were no pending provider requests or queued/running/waiting-external assignments. Its approved scope is `4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6`.

The existing management-resume RPC requires more than five minutes of remaining authority. The ordinary renewal RPC accepts blocked projects, not this paused project. Updating only the project deadline would break the provider/window/organization equality. The database continuation still names `c1d9a5f1ac10396c3015a7d5ae5f22254502e5de`; deploying #1049 did not rewrite that historical authority. The old window `a837004e-75d3-497d-b05a-482886ed5a5f` names an earlier release, authenticated by the immutable #1047 rebind receipt.

Six installed authority function body fingerprints are retained in `tests/fixtures/paused-window-installed-authority.json`. Native qualification compares the reconstructed migration stack to those production-read fingerprints before installing the additive candidate migration.

## Change and compatibility

The additive migration provides `project_org_renew_paused_window`. It locks the existing mission-state boundary and original rows, verifies the authenticated owner/actor/chat, exact prior window, source, release, approved scope and state hash, a precise 24-hour extension, unused renewal, remaining capacity, a valid active 13-node hierarchy and no active/provider work. It requires the existing 96-mission and 600000-token limits. It does not accept budget, tool, scope, repository or mission-count changes.

The owner HTTP action `renew_paused_window` is pinned to this original project, source, scope, old window and old continuation release, and ONLY the approved `2026-11-16T18:00:00Z` cutoff (November 16 at noon Central). It requires the authenticated owner session and an exact match to the currently executing production deployment SHA. SQL is service-role-only; anonymous/authenticated database roles and workers cannot invoke it. As with existing owner RPCs, the service role is trusted to supply the verified owner. No new client table writes are granted.

Renewal appends a new execution window, an immutable renewal receipt and 13 contract change receipts. It updates only current execution deadlines/window and project update time. The project remains paused, with its blocked source pointer intact. No decisions, agents, work packages, assignments, claims or provider calls are created by renewal.

A narrowly bound receipt bridge then allows the existing #1049 one-shot `project_org_resume_management` to recognize the historical source without rewriting it. Resume must name the exact release recorded by renewal. Its old direct-source path remains unchanged for windows without a renewal receipt. The renewed window temporarily retains the historical continuation release while paused; resume appends the existing management-resume receipt and rebinds to the approved new release. New assignments inherit the new window and exact release. Old failed assignments never become claimable.

No context assembly, model routing, spending, scheduler retry counters, tool delegation or QA-isolation rules change. The #1047 historical rebind chain remains intact. No further renewal of this project is permitted through the new one-shot receipt.

## Reproducible qualification

All local tests use native PostgreSQL and synthetic identities/data, with no live providers. Expired fixtures are constructed only in disposable databases; triggers and normal role permissions are restored before every tested operation. The production migration itself contains no data mutation outside the uninvoked RPC.

```sh
npm run typecheck
node --test tests/paused-window-renewal.test.mjs tests/management-context.test.mjs tests/director-recovery-control.test.mjs
KATIE_TEST_PG_TCP=1 KATIE_TEST_PG_BIN=/path/to/postgresql/bin node --test --test-concurrency=1 tests/project-organization-integration.test.mjs tests/project-organization-postgres.test.mjs tests/organizational-contract-amendments-postgres.test.mjs
```

Coverage includes owner/actor/chat, wrong source/window/scope/release, stale state, exact 24-hour cutoff, still-live source window, expired renewed cutoff, pending requests/work, hierarchy and QA corruption, changed limits, append-only windows/contracts/receipts, 13-node deadline inheritance, unchanged source/history, final-write failure rollback, a real competing RPC blocked on the transaction lock, replay, and normal scheduler/claim admission for the exact new release with stale/mismatched releases rejected. The competitor is deliberately timed out while the first transaction holds the lock; replay after renewal is tested separately.

The existing native suite re-runs #1049 context-to-SQL bounded commissioning, repeated-replacement prevention and bounded invalid-command recovery, #1047 release rebinding, both independent-QA aliases, same-source closure rules, provider continuation and historical financial/native controls. This is engineering qualification; the separate Independent QA verdict is still required.

## Hosted checks and release boundary

The branch-specific `vercel.json` entry disables deployments for `fix/paused-expired-window-renewal-1050` before its first push. Existing production/other branch configuration is preserved. The native hierarchy workflow now includes the additive renewal migration and new tests. Full PR CI, native PostgreSQL qualification and website regression results are linked in the PR handoff on the exact candidate SHA.

Independent QA should verify the exact SHA, the baseline fingerprints, atomic rollback and immutable source bridge, permission boundaries, exact owner cutoff/release binding, no authority expansion, stale release rejection, #1049 regressions and absence of a Vercel Preview deployment.

Engineering has not applied the migration to production, renewed the live deadline, resumed the project, dispatched workers, merged/deployed code or initiated paid inference. This candidate does not constitute TTT completion; internal coding-worker commissioning and independently accepted TTT Preview remain downstream acceptance work.
