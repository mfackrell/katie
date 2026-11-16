# Task 4A — Consolidated native authorization repair, Phase 1

## Engineering-only scope
This candidate fixes original Task 4A ordinary/native admission and provides audited recovery for the **same** original development task and issue. The branch does not authorize spending, merge, deploy to production, or redispatch the task.

## Historical checkpoint (read-only production verification, Nov 3 2026)
- Original project: `6d1c29f1-b31e-47a5-aabb-cbcf1326f388`; task: `d0e41ff5-149e-4319-9e65-dcc605fb75da`; GitHub issue #969.
- Historical grant `ddccc7a1-743f-4031-8ecd-a6926568ca98` was an invalid, unbound `ordinary-developer` grant; its signed handoff was rejected without paid inference in run [41673059705](https://github.com/mfackrell/katie/actions/runs/41673059705). Original project and task remain blocked.
- Original Task 4A continuation `405ea82c-6f52-49e5-babf-891ecac64d14` expired **2026-11-03 18:43:35 UTC**. Historical native grant expires separately **2026-11-04 16:17:55 UTC**; this cannot revive continuation authority.
- Preserve original research/specification/approved scope, account, ledger, issue and all historical approvals; no migration should edit these rows.

## New security behavior
The original project cannot enter the ordinary Developer owner-proposal, decision, or dispatch-claim path. The signer only emits a continuation-bound `task4a-developer` proof after verifying live Task 4A authority; other projects retain their ordinary paths. The recovery mechanism permits only original issue #969 and exact run #41673059705, verifies historical signed proof, zero native WIP, original scope/contract/baseline, unused account, no execution grant/paid calls, and same limits. It requires a newly authenticated owner's exact proposal digest and commits the replacement grant and audit event in one transaction; rejected old grant is retained, marked revoked, never reclassified or deleted. All duplicate and expiry checks fail closed.

**Important:** With the continuation now expired, `task4a_native_recovery_proposal()` returns **not ready** and cannot be approved. The code deliberately cannot extend either historical deadline. A separate, newly justified, owner-authenticated continuation authorization must be engineered and qualified before any paid execution may be considered. Phase 1 does not implement new owner spending authority.

## Migration order for separately authorized Phase 2
1. Require independent security review of the exact SHA and green full CI, Task 4A, native-gateway (including Task 2C adequate/shortage), isolated PostgreSQL, and website qualification at that SHA.
2. Apply existing #976 `20261103173000_task4a_native_origin_guard.sql` followed by consolidated `20261103181500_task4a_pregrant_recovery.sql` through the approved migration pipeline. The separate #973 `20261103180500_task4a_ordinary_authority_guard.sql` is intentionally excluded (fails PostgreSQL syntax validation).
3. Reconcile function definitions/privileges, test failed ordinary admission and expired recovery, record pre/post snapshots of historical approvals, continuation, task, project, account, project ledger and issue. Stop on any unexplained delta.
4. Deploy only the approved SHA, verify nonbillable endpoints; **do not call recovery POST** or dispatch issue #969 or authorize paid inference in this release.
5. Separately propose and obtain explicit owner consent for any fresh continuation/new spending authority, bound model, deadline, tokens, calls, price and original-project constraints. Document the necessary new continuation-recovery engineering and audit controls before any future native execution.

## Rollback and uncertainty
If qualification or release verification fails, stop; retain existing historical rows and issue marker. Revert application routing at the reviewed SHA, and revoke (not delete) any future explicitly consented successor if necessary. Never reset ledger usage, weaken the signed native gate, or assume an unresolved provider attempt is free.
