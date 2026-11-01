# Lifecycle resource authorization and same-task continuation

Baseline inspected: `dc074e982ab4318c64ee412bbb2bcad0c35e1f0a`. PR #923 extends the existing authenticated v5/v6 development authority with version 7; it does not start a benchmark or confer production consent. Qualification and delivery evidence belongs in the PR acceptance report.

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

## Runtime integration

Before each affected native phase, the host consumes Task 2A's structured forecast. A confirmed shortage preserves an immutable Task 1 checkpoint and blocks further execution. Unknown estimates remain unknown; the existing per-request admission still decides whether a paid request can run. Terminal-task reconciliation prepares the nonbillable proposal. The owner sees it in the originating Builder conversation and the existing Home attention area. Polling refreshes changed blocked-task snapshots; unchanged pending and rejected proposals are deduplicated.

`benchmark_lifecycle_snapshot` takes the existing mission advisory lock and row locks, then reads immutable owner limits, current receipts/reservations, conservative monetary exposures, grants, pricing, frozen scope and current task state. Expired authority remains visible as history. Missing or inconsistent records fail closed. The server additionally authenticates the terminal workflow artifact and latest immutable Git checkpoint using Task 1 provenance checks.

`benchmark_lifecycle_offer` stores an immutable content-addressed proposal and checkpoint. It binds the task, project, scope/acceptance, snapshot and expiration. The fingerprint excludes display expiry so repeat views do not generate equivalent decisions. Expired proposals may be replaced; rejection of an unchanged proposal remains recorded.

The browser POST accepts only task ID, proposal ID and explicit approve/reject. The route verifies the Supabase session with the production auth service, rejects anonymous/wrong owners and cross-origin requests, verifies exact task ownership, and rechecks the latest checkpoint. Resource amounts never come from browser input. Ordinary chat remains unauthenticated where it was previously allowed.

`benchmark_lifecycle_decide` serializes approval with authoritative admission using `katie.mission.state`, revalidates the snapshot and expiration under lock, and atomically appends the decision, continuation, task approval, renewal and existing resource-amendment record. A unique proposal decision and existing single-use dispatch/grant links prevent duplicate capacity. Rejection appends only a decision/event. No response creates no authority. Historical counters, receipts, original grants, original scope and acceptance requirements are not reset or rewritten. Old grants are stopped when an amendment commits and cannot be reused.

## Compatible execution authority

Version 7 requires its immutable approved proposal and exact amendment/approval links. Legacy v5/v6 paths retain their original fixed contracts. The existing effective account, mission-token, mission-call and monetary-ceiling functions recognize validated version 7 limits. Native admission leaves the displayed completion calls/tokens protected; shared account admission additionally protects assessment tokens. All reservations continue through the same account locks and conservative pricing/exposure guards.

The existing development dispatcher validates the terminal receipt, predecessor signed handoff and frozen task contract, claims the existing single-use amendment dispatch, and signs a handoff for the same original task. Task 1 restores the latest authenticated durable state before issuing the new grant. Missing, revoked or expired authority and uncertain provider accounting still deny execution. A failed continuation retains its checkpoint and accounting; it does not issue a duplicate grant or authorize an automatic paid retry.

Version 2 boundary checkpoints also represent clean pauses before implementation, review, final review or DO completion. They retain completed verification and independent review evidence, including deterministic before/after repair proof. Restoration verifies the same immutable Git tree, ancestry and scope gates. The clean-baseline exception requires authenticated tree equality and applies only to pre-implementation boundaries. Completed implementation/review are skipped on continuation; unfinished repair is reverified and independently reviewed.

## Owner-visible states and errors

The card distinguishes pending, rejected, stale, expired, committed/queued, restored/resumed and subsequent engineering failure. Approval success is displayed only after the decision transaction returns successfully. Unknown commit outcomes instruct the owner to refresh before retrying. Duplicate clicks return the prior committed decision. Material task/accounting/checkpoint changes require a fresh proposal. Dollar displays round to cents using exact integer arithmetic; backend microUSD decimals remain precise.

## Qualification and limits

- Pure proposal/Task 2A tests cover independent shortages, simultaneous shortages, expiration, uncertainty, protected reserves and exact arithmetic.
- Actual PostgreSQL qualification covers immutable decisions, ownership, staleness, NULL/expired decisions, duplicate/concurrent approvals, single-use dispatch/grant issuance, native admission and both shared protected-token guards.
- The actual-host fixture uses isolated PostgreSQL, disposable Git, synthetic owner sessions/provider responses, the real native host and Task 1 restoration, unchanged deterministic verification and Chromium. Its consent is synthetic only. It starts from eleven exhausted native calls plus four protected completion calls in the retained allocation.
- Browser and API tests cover exact displayed identity, authenticated owner/origin enforcement, pending decisions, commit errors, rejection and reload.

Sparse history can establish a minimum native-call shortage while token/cost/duration requirements remain unknown. Such a proposal explicitly discloses its minimum-only nature and never guarantees completion. Future unmeasured work can require another forecast. Unknown assessment call authority remains unchanged. Seven-day artifact expiry and lost/unanchored durable evidence retain Task 1's fail-closed behavior. Ambiguous paid calls must be reconciled before amendment/continuation. This integrates the existing authenticated v5/v6 contract family; it does not create authority for unsupported contracts.

Deliverable C's broader qualification suite and any new paid Take Eleven execution are excluded. No synthetic decision is production owner consent.
