# Task 4A Phase 2 — successor authorization and original project recovery

## Engineering-only scope
This candidate provides a new, separately owner-authorized, append-only successor to the expired Task 4A continuation. It does not approve spending, create a project or task, modify historical accounting, resume development, deploy an app, or merge code.

Original project: 6d1c29f1-b31e-47a5-aabb-cbcf1326f388
Original mission: d3fd3d95-7287-4bfc-8c97-c105fde46c36
Original development task: d0e41ff5-149e-4319-9e65-dcc605fb75da
Original GitHub issue: #969
Expired continuation: 405ea82c-6f52-49e5-babf-891ecac64d14
Invalid original native approval: ddccc7a1-743f-4031-8ecd-a6926568ca98

## Read-only historical financial checkpoint, November 3, 2026

The original continuation provided 440,326 incremental tokens, 53 calls and $15 of incremental ceiling, including 60,000 assessment and 60,000 completion token reserves and six calls each. It expired November 3, 2026 at 18:43:35 UTC.

Under that authorization: 16 completed calls, 70,583 actual tokens, 123,843 reserved call tokens, and $4.086819 conservative reserved dollar exposure. This exposure is NOT a settled actual bill. Earlier unbound research includes 9 completed calls, 76,519 actual tokens, and 89,921 reserved tokens.

All project history: 25 completed calls, 147,102 actual tokens, and 213,764 reserved call tokens. The 600,000-token project allowance leaves at most 386,236 tokens conservatively unencumbered, before any new reservations. Actual prices and account usage are rechecked on demand; these values are only historical observations, not authority to spend.

As inspected, live model pricing for gpt-5.3-codex and gpt-5.6-sol is marked ESTIMATED, not source-VERIFIED. The successor proposal must return a hard refusal until verified, fresh provenance exists. Never silently convert estimated prices to verified.

## Schema and boundaries

Exactly one new migration: supabase/migrations/20261103225000_task4a_successor_continuation.sql

It adds predecessor_id as a self-referencing FK. The previous unique project constraint is replaced by exactly one root per project and at most one child per predecessor; each successor consent digest is unique. The original immutable historical grant remains in place, unchanged. Only the original Task 4A project can append an owner-authenticated successor, and only after the predecessor expires or is revoked. Current-tip lookup must yield precisely one unambiguous authorization; old or mismatched IDs fail closed.

The current-tip check is applied at project mission-call reservations, native mission financial trigger, original-task native authority readiness, native live checks, GitHub dispatch claim, Phase 1 recovery proposal and confirmation, and native redispatch. Existing signed issue and native-host checks are unchanged. No parallel orchestrator or paid-execution route is added.

Owner-entered tokens, calls, money, stage reserves, allowed models and expiration are digest-bound to original scope, project, mission, task, issue, predecessor, account, baseline, historical accounting, and current pricing. The SQL checks exact digest again under a transaction-wide advisory lock, inserts an immutable successor and audit event together, and leaves the task blocked.

## Release sequence: separate owner code-release authorization required

1. Confirm exact final candidate SHA, its compatibility with current main, required full CI, isolated PostgreSQL Task 4A, website, ordinary Developer, native gateway and Task 2C adequate/shortage checks. Obtain an independent security assessment of that exact SHA. Do not transfer prior green checks.
2. Preserve read-only snapshots and checksums of original project/mission/task/assignment, prior continuation and source mission, budget account, native approval, project ledger, call reservation and provider usage, original issue #969, and all audit events. Capture existing migrations and roles. Before installing the new schema, the old continuation has no predecessor_id column.
3. Apply ONLY supabase/migrations/20261103225000_task4a_successor_continuation.sql through the authorized migration process, following both already-applied Phase 1 migrations. Check functions, old-row equality, unique indexes, grants and RLS boundary; check that no successor row, execution grant or provider call was created by migration.
4. Deploy exact authorized SHA. Confirm owner-only successor GET and rejection of unauthenticated/invalid/stale proposals. Do not invoke any live consent POST as a release smoke test.
5. Confirm project/task remain blocked, issue #969 remains open, original owner decisions remain immutable, old native approval remains unconsumed, and no new budget calls or recovery events exist. Stop if any unexplained delta.

### Verification SQL (read-only only)

Before migration:
SELECT id,project_id,deadline,authorized_at,revoked_at,approval_digest,incremental_tokens,incremental_calls,incremental_microusd FROM public.project_continuation_authorizations WHERE project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';

After migration:
SELECT id,project_id,predecessor_id,deadline,authorized_at,revoked_at,approval_digest,incremental_tokens,incremental_calls,incremental_microusd FROM public.project_continuation_authorizations WHERE project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' ORDER BY authorized_at;

SELECT public.task4a_current_continuation_id('6d1c29f1-b31e-47a5-aabb-cbcf1326f388');

SELECT count(*) FROM public.benchmark_budget_calls WHERE account_id='8d94b8e8-0b7e-487b-83a7-d78fe6eded51';

SELECT count(*) FROM public.benchmark_native_spending_approvals WHERE previous_developer_approval_id='ddccc7a1-743f-4031-8ecd-a6926568ca98';

SELECT status FROM public.work_projects WHERE id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';

## Three separately gated owner decisions after an approved release

A. Successor continuation approval. Owner chooses fresh exact tokens, calls, micro-USD ceiling, assessment/completion reserves, verified eligible model list, and lifetime; reviews explicit conservative historical spending/reservations and a SHA-256 proposal digest, then approves affirmatively. This creates ONLY an append-only successor authorization and audit receipt. It does not reuse or extend the expired approval, create calls, or resume the task.

B. Separate native authority approval. The existing Phase 1 Task 4A native recovery screen and RPC must present an independently checked digest bound to the CURRENT successor, the invalid original native grant, the same task, account, issue #969, failed run #41673059705, scope, contract, model, and unchanged original native account limits. Explicit owner consent creates a single successor native grant and original-task recovery audit. The historic invalid approval remains retained/revoked, not rewritten or deleted. Original work is only eligible for the existing native gated dispatch afterwards.

C. Paid execution / original issue #969 redispatch. A separately explicit approval is required to actually invoke provider inference, under the live continuation, native financial account and reserve admission. No payment, issue rewrite or GitHub dispatch is authorized by this engineering change or deployment. The disposable app must never be published to production; protected Preview acceptance requires additional permission and evidence.

## Rollback and evidence preservation

On any qualification or release failure, STOP further steps. Preserve pre/post database snapshots, immutable approval rows, call/ledger records, issue #969, and migration receipts. Roll the application back to its prior approved SHA; leave new owner POST endpoints inaccessible if necessary. Keep original Task 4A fail-closed native guard intact. Do not delete successor rows if any owner authorizations already exist or edit the immutable predecessor. Database schema reversal requires a separately reviewed exact rollback script that proves no successor row or usage can be orphaned; never blindly restore the unsafe project_id uniqueness or drop security checks.

## Phase 2 qualification

The Task 4A deterministic workflow runs real isolated PostgreSQL with both legacy Phase 1 pregrant and new successor fixtures, negative replay/revocation/stale-owner tests, original native authority restoration, and no new provider calls. Full CI, Native gateway/ordinary Developer and website regressions must all pass on the SAME immutable candidate SHA, followed by independent security signoff.

Stop at release-ready engineering candidate. Production migration, deployment, owner consent, financial grants, original issue redispatch and paid inference are strictly excluded without separate owner authorization.
