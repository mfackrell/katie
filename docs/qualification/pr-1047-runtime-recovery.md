# PR #1047 runtime recovery — independent QA handoff

This change finishes the existing scoped-root recovery. It does not implement the game, dispatch production work, renew the execution deadline, or increase resources. Qualify the exact PR head; the production baseline remains `5b129f6de84a379f979dc8c838a8908a99b04273`.

## Read-only production evidence (November 14, 2026)

- Original project: `fe9d2658-41e3-44c1-ae8e-a0cba98371fe`; blocked in development with detail `Project management cannot achieve its objective within bounded retry authority`.
- Existing root Director: `c486ade1-2a9c-4cd5-a80b-90c032e4e03e`.
- Existing Game Delivery Functional Director: `9b62ae62-a499-490a-a7ac-6e6c5bb1229d`. Tools: `manage`, `analysis`, `repository_review`; no development capability or scope grant.
- Existing independent QA Functional Director: `4e6503c8-7723-49e7-ad30-22f633feb2f8`; area is `independent_qa`.
- Exactly one scope grant, held by the root: `4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6`.
- Granted paths: `app/milestone-3-tic-tac-toe/`, `lib/milestone-3-tic-tac-toe/`, `tests/milestone-3-tic-tac-toe/`.
- Scope approved at `2026-11-13T20:41:25.639795Z`.
- Five blocked root missions; four predate approval. The sole post-approval rejection is mission `ca01c248-e877-43ea-aebb-68d692e651a2`, created at `2026-11-14T17:06:40.025465Z`, with `director_appointment`, action `appoint`, position 6.
- Current owner window: `a837004e-75d3-497d-b05a-482886ed5a5f`; continuation decision `476981a7-0b19-453a-b9e9-f5a2dcf31248`; continuation release is the production baseline.
- Deadline remains November 15, 2026, noon Central (`2026-11-15T18:00:00Z`), mission cap 96, token allowance 600,000.

## Demonstrated defects and corrections

1. The scheduler counted pre-ratification failures against the approved development epoch. The existing PR confines the count to failures after immutable approval for provider-controlled development; other modes retain their prior retry semantics. A second scoped failure remains terminal.
2. The original PR recorded `p_new_release` only in an event. A native PostgreSQL reproduction against original head `2e93998aa650560a2f6e35d15dc4bfc8928ab269` fails the assertion that the new release can claim the scheduled retry. Recovery now appends a narrowly scoped receipt and atomically updates the continuation release. The original execution-window row, cutoff, decision and scope remain unchanged. The new receipt is checked against those exact identities in the existing continuation/window predicates. Claimant and assignment release checks remain intact.
3. The existing amendment guard recognized `quality_assurance` but missed the live `independent_qa` area. The added negative test initially failed with `Missing expected rejection`. The migration now applies the same recursive amendment fence to both names.

The root's model guidance requires `amend_delegation`, `grant_scope`, then `ready` for the existing Game Delivery node. No application code supplies a synthetic management decision. The ordinary client reporting checks and lease-bound SQL decision path still validate the returned commands.

## Qualification and reproducible checks

Run with Node 22 and native PostgreSQL 16 as in GitHub Actions:

```sh
npm ci
npm run typecheck
node --test tests/project-organization-runtime.test.mjs
node --test tests/project-organization-integration.test.mjs tests/organizational-contract-amendments-postgres.test.mjs
npm run test:review
npm run test:integration
npm run ci:gate
```

For hosts that prohibit Unix sockets, the existing fixture supports `KATIE_TEST_PG_TCP=1` and `KATIE_TEST_PG_BIN`; use `--test-concurrency=1` because the TCP fixture uses one fixed port. No test needs production credentials or inference.

The scoped-root fixture checks:

- Wrong owner, source, scope and expected release fail; anonymous/authenticated invocation is denied.
- A synthetic failure after receipt insertion rolls back both receipt and release change.
- Missions, assignments, organization, historical windows, active mission, scope and owner limits are unchanged by resumption.
- Recovery cannot be replayed; service role cannot forge or remove receipts; even privileged updates hit the immutable trigger.
- The normal scheduler reconciles the failed mission and schedules the existing root's second attempt.
- The old release cannot claim it; the new release claims it with the existing window and validates the continued-assignment predicate.
- A second post-ratification failure hits the bounded-retry stop.
- The claimed root commits an amendment and scope grant to the existing Game Delivery node through the real decision RPC.
- Independent QA cannot inherit development; no work package or coding worker is dispatched by recovery.

The runtime test uses a deterministic model response to verify actual prompt/context delivery and client command validation. This is not proof that a paid model will comply. Live model behavior and subsequent internal worker commissioning remain untested under this assignment's explicit prohibition.

## Security and release boundaries

The new receipt table has RLS enabled, no client policies, SELECT-only service-role access, and an append-only trigger. New SECURITY DEFINER functions pin their search path and revoke PUBLIC/anon/authenticated execution. The recovery RPC verifies the bound owner, exact source/window/release/scope, idle blocked state, remaining mission capacity, pending-provider exclusion and existing deadline under the existing advisory/row locks. No deadline or allowance is increased.

Production advisors were inspected read-only. Existing global advisories are not a clean security certification and are outside this patch. Independent QA must inspect the new SQL and verify the exact-head CI evidence; an automatically skipped project-integration review is not an independent PASS.

## Next authorized handoff

Independent QA should review this exact candidate and the native qualification logs, especially the release-rebinding predicate, atomic rollback, stale-claim rejection and QA alias test. Release approval, production migration, the owner-bound resume RPC, live scheduling and any paid inference are separate actions and were not performed. Recheck the live source mission, scope, window and deadline immediately before any subsequently authorized recovery; changed or expired authority must fail closed.
