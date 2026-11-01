# Task 2C qualification — resumed, not accepted

Original baseline: `05d46db95c1123b87731159909bc9419180491f7` (Task 2B merge).
Reconciled baseline: `37582024733d7c012cfafa2f57c9021644058d9f` (ordinary first-shortage extension, PR #925).
Work is preserved in draft PR #924. This document is a qualification status report, not a completion receipt. This PR adds no production implementation or migration beyond its merged baseline.

## First-shortage extension delivered

The owner authorized the architecture correction below. PR #925 was independently reviewed, passed full CI and actual PostgreSQL/SDK/host qualification, and merged at `37582024733d7c012cfafa2f57c9021644058d9f` from final commit `f208c9b61a950052a1fd5512b84c9d8d2f12ba55`. Production deployment `dpl_GVnBsgxb4EF2v2XLGVsYpou1Upq8` is READY at that merge commit. The normal migration pipeline applied the ordinary authority migration; nonmutating health and accounting checks passed. Full delivery evidence is retained in PR #925.

The preserved Task 2C work has been reconciled with that main commit. Ordinary authority support and generalized Task 2C host options are both retained. The historical architectural blocker is resolved; the qualification gaps listed below still require implementation and execution. Extension acceptance does not establish Task 2C acceptance.

## Historical architecture finding (resolved by PR #925)

At the original baseline, the reusable pure planner was connected at runtime only to the existing Full benchmark amendment chain. It is not connected to an ordinary Developer project's first resource shortage.

The authoritative `benchmark_lifecycle_snapshot` function in `supabase/migrations/20261101123639_lifecycle_owner_authorization.sql`, lines 43–59, requires all of:

- A latest Full benchmark continuation with plan version 5, 6, or 7.
- A benchmark native spending approval and budget account.
- A benchmark production qualification binding the owner and actor.
- Full benchmark task provenance.
- A pre-existing development resource amendment with the current continuation's plan hash.

Missing first-task authority fails with `Lifecycle task binding unavailable`; missing amendment history fails with `Lifecycle amendment history unavailable`. This denial is correct for the existing restricted contract. It cannot be removed to manufacture generic task support.

The owner route at `app/api/projects/lifecycle-approval/route.ts`, lines 25–30, also discovers tasks and verifies ownership through `benchmark_native_spending_approvals`. An ordinary project authorization is not sufficient for this endpoint.

Consequently, even a successful benchmark-bound synthetic continuation would not prove the requested reusable Developer Orchestrator workflow from initial authorization through its first proactive amendment. Current qualification fixtures first construct the prior benchmark continuation/amendment chain. They must not be reported as independent evidence of ordinary first-shortage support.

An independent reviewer separately confirmed this finding. Supporting that missing path requires an explicit architectural extension of the authority/snapshot/decision/grant interfaces, with owner and scope binding preserved. Task 2C permits narrow corrections but instructs us to stop for a material redesign. No security fence has been relaxed.

Resolved owner decision: the owner authorized a focused extension of Task 2B to support first-shortage amendments for ordinary authorized Developer projects, reusing existing ledgers and admission mechanisms. After that extension is qualified, resume Task 2C. Restricting Task 2C to benchmark-bound renewals would change its acceptance scope and would not meet the current assignment.

## Preserved qualification work

- A hosted PostgreSQL/native SDK job with isolated database fixtures, empty paid-provider credentials, and retained CI artifacts.
- A synthetic `/pilot` assignment with frozen acceptance: `#state` must display `Recovered`.
- Real native host/provider-admission execution using controlled, nonbillable provider transport; planned eleven additional requests across implementation and initial independent review, followed by repair shortage and same-task continuation.
- Real owner component → actual route → PostgreSQL transport bridge; synthetic identity is isolated test identity, not owner consent.
- Actual Developer dispatcher wiring and a two-connection decision barrier.
- Historical call and exposure comparisons.

These additions are incomplete qualification code, not passing end-to-end acceptance evidence. The twelve-scenario matrix, actual worker reconciliation, final completion/assessment receipt, and final browser acceptance remain unqualified. No completion or merge is authorized by their presence.

## Observed execution and review

The first hosted run, Actions `41319324158`, job `124885981042`, failed before native work because the synthetic objective did not meet the existing benchmark identity guard (`Full benchmark task identity mismatch`). The fixture label was corrected to identify the issue #715 regression without changing the production guard or original Take Eleven source. A subsequent hosted run was started at `41319868753`; this document does not claim it passed.

A local scratch SQL diagnostic reached the native-host boundary, which could not start its required bubblewrap namespace in this environment. That run is not PostgreSQL concurrency or native-host qualification evidence; hosted CI remains required.

Independent review also identified:

1. Direct post-host state updates bypass actual worker reconciliation; replace these with `claim_mission_work` → `executeClaim` → `runProjectBatch` before acceptance.
2. A concurrent approval test needed a barrier; added, but not yet demonstrated in a passing hosted run.
3. Rejection must compare checkpoint refs/content and frozen scope explicitly, in addition to accounting. This remains outstanding.
4. Historical monetary exposure must be compared after continuation; assertion added, not yet demonstrated in a passing hosted run.
5. GitHub transport argument validation needs tightening.

These Task 2C qualification gaps remain blocking until verified. Independent review after PR #925 also confirmed that the preserved harness still uses benchmark setup, lacks ordinary-dispatch adapter methods, and does not prove a final project assessment receipt. No final independent Task 2C approval has been obtained.

## Safety and deployment status

Zero paid inference was initiated. No Take Eleven benchmark was restarted. No production synthetic approval, grant, task, or accounting record was created. No spending ceilings, historical counters, protected reserves, production scope, or model capability were changed. No Task 3 work was performed.

PR #924 remains draft and unmerged. There is no Task 2C merge commit, migration, or production deployment. Current production verification of Task 2B is not Task 2C acceptance evidence. The seven-day recovery diagnostic retention boundary and abrupt-termination limitations remain unchanged and are not newly qualified here.
