# Task 2B implementation checkpoint — incomplete

Baseline inspected: `dc074e982ab4318c64ee412bbb2bcad0c35e1f0a`.
This draft is not connected to execution. It must not be merged or described as
Task 2B completion. No proposal in this draft creates spending authority.

## Inspected contracts and intended reuse

| Contract | Existing responsibility | Required integration |
| --- | --- | --- |
| `scripts/benchmark/lifecycle-capacity.mjs`, `lib/projects/lifecycle-capacity.d.mts` | Task 2A pure lifecycle assessment; independent dimensions, minimums, observed estimates, unknown evidence | Consume structured output without changing methodology |
| `scripts/benchmark/native-capacity-forecast.mjs` | Read-only effective budget/exposure adapter; receipt-linked observations; two-read consistency check | Supply proposal snapshot from coherent authoritative state; retain unknown assessment calls |
| `lib/projects/resource-forecast.mjs`, `resource-economics.mjs` | Scope heuristics, verified pricing and optional calibration | Do not pass heuristics off as measured lifecycle evidence |
| `lib/projects/recovery-budget.ts` | Specification-only token proposal and project event | Reuse event/status conventions; cannot amend development grants |
| `middleware.ts`, `app/api/benchmark/715/continuation/route.ts` | Supabase owner authentication; explicit owner and origin validation in continuation route | Authenticate actual owner and bind decision to exact task/project/proposal |
| `components/benchmark-owner-approval.tsx`, `components/project-approval-card.tsx` | Existing owner approval surfaces | Display one consolidated immutable proposal and reject action; success only after committed backend response |
| `benchmark_full_continuations`, `benchmark_native_spending_approvals`, `benchmark_development_renewals`, `benchmark_development_resource_amendments` | Append-only authority, task identity, renewal lineage | Parameterized approved amendment, preserving historical records |
| `benchmark_effective_account_cap`, `benchmark_effective_mission_allowance`, `benchmark_effective_mission_call_limit` | Effective authorized ceilings | Resolve only valid committed amendment values |
| `benchmark_budget_calls`, `mission_calls`, `benchmark_dollar_exposures` | Historical usage, reservations and conservative exposure | No rewrites or counter resets; lock/recheck before amendment |
| `benchmark_dollar_admission`, native reserve RPCs, `benchmark_issue_execution_grant` | Authoritative per-call and grant enforcement | Remain enforcement boundary; dynamic values must come from validated immutable authority |
| `lib/agents/development.ts` | Verified terminal receipt, signed handoff, one-use dispatch claim | Continue same original task; distinguish queued, resumed and failed recovery |
| `scripts/benchmark/native-wip-recovery.mjs` | Authenticate artifact, scope, grant, checkpoint and completed phases before restoration | Keep proof requirements; never replay uncertain paid calls |
| `scripts/benchmark/native-development-host.mjs` | Forecast hooks, restoration, grants, billable phases, WIP preservation | Stop before affected phase, preserve diagnostics, resume after exact valid amendment |

## Draft proposal semantics

`lib/projects/lifecycle-authorization.mjs` is a pure, nonauthorizing contract.
It returns `not_required`, `evidence_required`, `admission_denied`, or
`awaiting_owner_approval`. Inputs must come from trusted server evidence, never
from a browser request. A hash identifies content; it is not authentication.

Proposals preserve task/project/baseline/scope/contract identity, checkpoint and
snapshot hash. They include current and proposed positions, completed and remaining
stages, protected reserves, uncertainties, and the evidence supporting estimates.
Output is cloned and frozen before returning its canonical SHA-256 identity.

Token ceilings are computed independently against the required remaining work.
A shared cumulative shortage does not imply the development sublimit is short.
Existing unused sublimits are not automatically funded by increasing the account
maximum. Call additions are nonnegative; the before/after protected reserve is
shown separately from additional native calls.

`proposed.ceilingMicrousd` replaces the cumulative maximum. It is not incremental
expected spending. `estimatedIncrementalMicrousd` remains an estimate, and may be
unknown. Monetary arithmetic retains decimal microUSD precision; display rounds
to dollars and cents. Outstanding uncertain exposure remains included.

Unknown assessment call authority remains null and unchanged. A minimum-only
shortage is explicitly marked; it is not represented as guaranteed lifecycle
capacity. When duration evidence is absent, a proposed renewal explicitly reuses
the prior owner-selected window and discloses unknown completion duration. Its
clock may begin only at authenticated commit. Proposal expiry is a separate bound.

## Blocking integration work

1. Read a coherent authoritative proposal snapshot, including historical approved
   ceilings and current conservative exposure when authorization has expired.
   The existing monetary RPC deliberately returns null when authority is not live.
   Revalidate all material quantities, receipts, reservations, grants, scope and
   checkpoint atomically; an identity hash alone does not prove quantity alignment.
2. Persist immutable proposal/version and append-only approval/rejection decisions
   through existing authorization/event infrastructure, with deduplication.
3. Connect authenticated owner UI and exact proposal decisions to an atomic
   amendment transaction. Test duplicate/concurrent/stale/wrong-owner cases in
   actual PostgreSQL, including an exposure race.
4. Extend existing continuation/amendment contracts consistently. Current v5/v6
   constraints, monetary admission ($10), host token checks (550k/625k), and
   dispatcher predecessor lineage are historical fixed allocations. Updating only
   the UI or a read RPC cannot authorize or safely resume a dynamic amendment.
5. Wire native forecast phase hooks to checkpoint-preserving pause and existing
   dispatcher/restoration, including renewal before host expiration denials.
   Verify all supported pause phases without replaying completed engineering.
6. Traverse actual amendment RPC, dispatcher, Task 1 restoration and synthetic
   repair in the historical eleven-exhausted-native/four-protected-completion
   fixture. Preserve counters and grants, and exercise failed continuation.
7. Complete UI/typecheck/build/full CI, final independent review, migration rollout,
   merge and production verification. Deliverable C and paid benchmarks are excluded.

## Review and validation to date

Independent review identified and prompted corrections for unknown assessment-call
capacity, shared-account token over-allocation, mutable proposal references and
negative displayed native-call additions during completion-reserve reallocation.
The expired-authority evidence and runtime integration findings remain unresolved.

The proposal test file also imports the existing forecasting fixture/test module:
31 tests comprise 14 proposal cases and 17 Task 2A tests. These do **not** qualify
authenticated approval, PostgreSQL races, grant issuance or same-task continuation.
Local TypeScript checking passed. Local PostgreSQL integration is unavailable:
the binaries are absent and package installation failed under the environment's
process identity restrictions. Hosted CI provides PostgreSQL for later integration
qualification; no database assertions have been weakened or replaced with mocks.

No paid inference or production database mutation was performed.
