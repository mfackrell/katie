# Original TTT owner renewal and management-resume controls

Assignment: https://github.com/mfackrell/katie/pull/1053#issuecomment-6917034796.
Current integrated main: `68d6ae20b70d9cae992f1398ae3b56ada747644d`, including the separately released PR #996 composer-height correction. Initial implementation/inspection baseline was `b01ee96944b7bef12bc30e308958267ff29ac11d`. The unrelated ITM, accounted web-search and composer changes are preserved unchanged.

## Confirmed gap and read-only production evidence

The existing `renew_paused_window` API had no owner-facing control. `project_org_resume_management` had no runtime API caller. The previous continuation UI therefore could not perform the required separate operations.

Read-only GitHub/Vercel/PostgreSQL inspection on November 16 confirmed:

- Original project `fe9d2658-41e3-44c1-ae8e-a0cba98371fe` remains paused on its old November 15 noon Central cutoff.
- 73 historical missions, cap 96; token allowance 600000; 13 nodes; zero packages; blocked source `62cd8da3-1bcc-41ae-9470-574c6b05e420`.
- Approved scope `4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6`.
- Initial production deployment `dpl_87QfoqLJwDNh5NVogVhygPHErgFq` was READY at the initial baseline. Subsequent read-only verification confirms `dpl_DbqUxULSktnqVmALnA3fM8adDg3m` READY at current main `68d6ae20b70d9cae992f1398ae3b56ada747644d`.
- Installed migration ledger contains `management_loop_recovery` and `paused_expired_window_renewal`. Installed recovery definitions, permissions and search paths were inspected directly. Existing native fixtures reconstruct these definitions before applying the new additive functions.

No production write or activation is part of this assignment. The only approved cutoff remains **November 16, 2026, noon Central (`2026-11-16T18:00:00Z`)**. Runtime controls fail closed when that cutoff expires or fewer than five minutes remain; they cannot select another cutoff.

## Implementation

The original chat's authenticated recovery projection now selects a dedicated control instead of legacy continuation. `GET /api/projects/organization?projectId=...` provides an uncached owner preflight containing current source/window identity, state fingerprint, active release, preserved limits and transition stage.

The visible mobile control has two explicit buttons, shown in sequence:

1. **Renew to approved noon Central cutoff** calls the existing reviewed renewal RPC. The project stays paused. The browser then reads the durable state again and requires a verified receipt and all 13 preserved contracts before showing resume.
2. **Resume approved project management** uses a separate owner-authenticated POST action. A small SQL adapter obtains the same management lock, verifies the exact renewal and displayed state fingerprint, then calls the existing #1049 guarded resume function. It does not dispatch a worker itself.

The additive migration creates two functions and no tables: a read-only offer and a receipt/fingerprint adapter around the existing resume writer. It leaves both reviewed writer definitions intact. The offer verifies the original owner binding, paused terminal management source, current scope/window/release, no pending work, 13 inherited contracts, unchanged mission/token allowances, renewal source hash, deadline-only receipts and QA capability isolation. Both functions revoke PUBLIC/anonymous/authenticated execution; only service workers may call them through the owner endpoint.

All mutations use the actual `verifiedProjectOwnerSession`, same-origin POST check and production release SHA. Client input never supplies an owner ID. Tokens stay inside the browser session and Authorization header; they are never rendered or exported. No action occurs on load, refresh or login. Double clicks are fenced. Lost responses trigger a read of recorded state. Recorded renewal retries must match the original fingerprint and receipt; resume retries must refresh the current fingerprint and cannot restart work. Stale state, wrong release/owner/project/scope/cutoff or changed work/contracts fail closed with a refresh instruction.

## Qualification result

Local engineering PASS: 39 focused runtime/security/browser tests, all three native organization suites, TypeScript and the production build. Local runtime was Node 24.22.1 with PostgreSQL 18.6; hosted qualification uses the repository's Node 22/PostgreSQL 16 configuration. The four reconstructed installed recovery definitions and ACLs match read-only production inspection and remain unchanged after installing this additive migration. Exact head/tree and hosted results are recorded in the PR handoff.

## Reproducible qualification

Requires Linux, Node 22 or 24, a C compiler, repository dependencies, Chromium and native PostgreSQL binaries. The C helper is test-only: it supplies the same November 16 wall clock to disposable Node, PostgreSQL and Chromium processes. It never changes CLOCK_MONOTONIC, application code, SQL definitions or production time. This allows independent QA to reproduce the fixed approved date later. The fixture prepares synthetic production-shaped identities with triggers temporarily disabled, restores all triggers, then executes the actual routes and guarded functions. Every fixture change rolls back.

```sh
npm ci --ignore-scripts
npm run typecheck
node --test tests/owner-management-activation.test.mjs tests/paused-window-renewal.test.mjs tests/director-recovery-control.test.mjs tests/project-organization-runtime.test.mjs tests/management-context.test.mjs
KATIE_TEST_PG_BIN=/usr/lib/postgresql/16/bin node --test --test-concurrency=1 tests/project-organization-postgres.test.mjs tests/project-organization-integration.test.mjs tests/owner-management-activation-postgres.test.mjs
```

`KATIE_TEST_PG_TCP=1` may be used where Unix sockets are unavailable. Native suites share fixed fixture ports and must run sequentially.

The hosted recovery workflow retains four mobile screenshots and a commit/tree-bound qualification manifest in `owner-management-activation-evidence`.

The new browser suite compiles the actual React control and Tailwind styles, renders at 390px width, and makes real HTTP requests to the actual organization route. The existing owner-session verifier calls a local synthetic auth endpoint; PostgreSQL RPCs use a real service-role connection and real transactions. No model, provider or worker dispatch is invoked. Tests cover:

- Absent/wrong owner, wrong origin, nonproduction runtime, wrong project/source/window/release, stale fingerprint and alternate cutoff.
- Read-only offer, no activation on page load/refresh, no arbitrary deadline field, mobile touch size and horizontal overflow.
- Double clicks, one renewal receipt, exactly 13 contract receipts, persistent paused state and unchanged history/limits.
- Reload after renewal; resume unavailable before verified renewal; changed contracts cannot expose resume.
- Injected final-write failure rolls back resume while retaining renewal; a later separate click succeeds.
- Stale resume replay rejected; refreshed receipt returns status without restarting; lost renewal response is reconciled through GET with no automatic resume.
- Expired approved cutoff rejected; browser token absent from rendered text.

Existing PostgreSQL suites retain renewal concurrency/rollback/replay/RLS tests, immutable source and window history, exact release claims, G6 appointment and final-closure isolation for both QA identities, 13-contract renewal, scope ratification, replacement progress fence, SMART admission, original seven-mission invalid-command bound, native worker artifact verification and accounting regressions.

## Independent QA and later release

Review the exact candidate SHA and integrated tree in the PR. Reproduce the mobile browser flow through both real routes and native PostgreSQL. Challenge the receipt/source/fingerprint binding and verify no pending provider work can slip between preflight and resume. Branch Git deployment is explicitly disabled before publication.

A later release still requires independent QA and the Director's release gate. The running production SHA must be verified again; neither the old baseline nor this candidate SHA may be assumed deployed. No control can extend the fixed cutoff. Successful engineering tests do not prove live autonomous coding, game delivery or same-commit protected Preview acceptance.
