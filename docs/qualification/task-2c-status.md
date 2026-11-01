# Task 2C investigation and qualification record

Original baseline: `05d46db95c1123b87731159909bc9419180491f7` (Task 2B merge).
Extension baseline: `37582024733d7c012cfafa2f57c9021644058d9f` (ordinary first-shortage extension, PR #925).
Final reconciliation also preserves main `74a4136697a6c74ee624de829dbc412681e6aaaf` and its unrelated document corrections.
Work is preserved in PR #924. This document records the investigation; the exact-head CI artifacts and final PR acceptance report determine delivery status. This PR contains narrowly scoped forecast corrections identified by qualification; it introduces no database migration.

## First-shortage extension delivered

The owner authorized the architecture correction below. PR #925 was independently reviewed, passed full CI and actual PostgreSQL/SDK/host qualification, and merged at `37582024733d7c012cfafa2f57c9021644058d9f` from final commit `f208c9b61a950052a1fd5512b84c9d8d2f12ba55`. Production deployment `dpl_GVnBsgxb4EF2v2XLGVsYpou1Upq8` is READY at that merge commit. The normal migration pipeline applied the ordinary authority migration; nonmutating health and accounting checks passed. Full delivery evidence is retained in PR #925.

The preserved Task 2C work has been reconciled with that main commit. Ordinary authority support and generalized Task 2C host options are both retained. The historical architectural blocker is resolved. The historical qualification gaps and their repairs are recorded below. Extension acceptance does not establish Task 2C acceptance.

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

Consequently, even a successful benchmark-bound synthetic continuation would not prove the requested reusable Developer Orchestrator workflow from initial authorization through its first proactive amendment. The original qualification fixtures first constructed a prior benchmark continuation/amendment chain; those historical fixtures alone were not evidence of ordinary first-shortage support. The current integrated fixture starts a separately authorized ordinary task and preserves benchmark fixtures as regressions.

An independent reviewer separately confirmed this finding. Supporting that missing path requires an explicit architectural extension of the authority/snapshot/decision/grant interfaces, with owner and scope binding preserved. Task 2C permits narrow corrections but instructs us to stop for a material redesign. No security fence has been relaxed.

Resolved owner decision: the owner authorized a focused extension of Task 2B to support first-shortage amendments for ordinary authorized Developer projects, reusing existing ledgers and admission mechanisms. After that extension is qualified, resume Task 2C. Restricting Task 2C to benchmark-bound renewals would change its acceptance scope and would not meet the current assignment.

## Preserved qualification work

- A hosted PostgreSQL/native SDK job with isolated database fixtures, empty paid-provider credentials, and retained CI artifacts.
- A synthetic `/pilot` assignment with frozen acceptance: `#state` must display `Recovered`.
- Real native host/provider-admission execution using controlled, nonbillable provider transport; planned eleven additional requests across implementation and initial independent review, followed by repair shortage and same-task continuation.
- Real owner component → actual route → PostgreSQL transport bridge; synthetic identity is isolated test identity, not owner consent.
- Actual Developer dispatcher wiring and a two-connection decision barrier.
- Historical call and exposure comparisons.

These additions are not yet passing end-to-end acceptance evidence. Actual worker reconciliation and original assignment approval are wired and have reached the owner proposal in hosted execution. The final completion/assessment receipt and full twelve-scenario matrix still require a passing integrated run. Their presence alone is not completion evidence.

## Observed execution and review

The first hosted run, Actions `41319324158`, job `124885981042`, failed before native work because the synthetic objective did not meet the existing benchmark identity guard (`Full benchmark task identity mismatch`). The fixture label was corrected to identify the issue #715 regression without changing the production guard or original Take Eleven source. A subsequent hosted run was started at `41319868753`; this document does not claim it passed.

A local scratch SQL diagnostic reached the native-host boundary, which could not start its required bubblewrap namespace in this environment. That run is not PostgreSQL concurrency or native-host qualification evidence; hosted CI remains required.

Independent review also identified:

1. Direct post-host state updates bypassed worker reconciliation. Replaced with `claim_mission_work` → `executeClaim` → `runProjectBatch`; hosted execution now reaches the real blocked task and project states.
2. A concurrent approval test needed a barrier; added, but not yet demonstrated in a passing hosted run.
3. Rejection now compares the exact saved task and checkpoint records as well as accounting; the actual browser/transaction run must pass these assertions.
4. Historical monetary exposure must be compared after continuation; assertion added, not yet demonstrated in a passing hosted run.
5. External GitHub/Vercel metadata is explicitly synthetic, with repository/head assertions and actual host/browser receipts; it cannot establish actual deployment networking.

Unverified Task 2C qualification gaps remain blocking. The ordinary-dispatch adapters and original-authority fixture now exist; their final project assessment receipt still needs a passing hosted run. No final independent Task 2C approval has been obtained.

## Safety and deployment status

Zero paid inference was initiated. No Take Eleven benchmark was restarted. No production synthetic approval, grant, task, or accounting record was created. No spending ceilings, historical counters, protected reserves, production scope, or model capability were changed. No Task 3 work was performed.

At the time of this investigation PR #924 was draft and unmerged. The final PR report records merge and production verification separately. There is no new migration in Task 2C. Task 2B production verification alone is not Task 2C acceptance evidence. The seven-day recovery diagnostic retention boundary and abrupt-termination limitations remain unchanged and are not newly qualified here.

## Repair of run 41330983960

Job `124920833772`, step 8 failed at `qualify-resource-lifecycle.mjs:77` with `2 !== 4`. The retained initial diagnostics contain implementation (six requests) and initial review (five requests), but omit the six authenticated predecessor phase observations. The host copied those observations only when a WIP source record existed; an accepted clean-baseline predecessor returns no source record. The owner planner therefore correctly used uncertain one-call minima for repair and final review.

Commit `10dada7898a194a091caa8217df78bfb501a78b7` preserves observations from authenticated clean-baseline diagnostics before the record-only source-restoration branch. Receipt, model, cohort, and accounting validation remain in the capacity adapters. The four-call assertion is retained, and the harness now checks that each predecessor observation survives. Independent review confirmed this root cause and the unchanged security boundary.

Commit `e15b3360a24e01ad33a06a98d7ff6000780e48ab` replaces direct pause-status updates with the real mission claim/execution and project worker. It also checks unchanged task/checkpoint records and actual native-admission denial after rejection. Hosted results remain required before acceptance.

## Current repairs after ordinary-path integration

The integrated fixture now establishes the coding-assignment approval through `prepare_mission_development` (via the commit contract), `control_mission`, and `mission_development_task`, in addition to the distinct authenticated resource approval. It does not insert a replacement task to bypass the worker's saved-input identity check. A short simulated polling lease checks proposal stability without preventing the real project worker from claiming the fixture later.

The fresh native inspection profile declares two minimum requests for each unfinished native phase: one request to inspect authoritative files with a tool, and one to consume the tool result. This applies only to fresh native host phases. It preserves generic planner defaults and larger measured requirements; it is not a guarantee of completion. The controlled eleven-call assignment uses five implementation and six review requests so the corrected planner has enough minimum capacity to begin review, then detects the repair shortage.

Qualification identified a monetary-adapter defect: known repair/review estimates were discarded from shortage detection whenever later costs were unknown. The correction retains a partial known estimate separately from the unknown whole-lifecycle total. A proposal may cover the known estimated subtotal while explicitly naming unestimated stages. No unknown cost becomes zero, no estimate becomes guaranteed funding, and all existing snapshot, owner, transaction and admission checks remain authoritative.

Local verification at `42f13b384f8f65075ea7a87664161c107beda7c1`: 109 lifecycle/recovery regressions plus three actual-adapter monetary regressions passed; TypeScript passed. Hosted PostgreSQL ordinary authorization passed. Integrated host execution and full CI remain under repair; no final pass is claimed here.

The final project test uses real worker/assessment code, canonical reservations and settlement, and fresh local Chromium against the immutable repaired candidate. GitHub workflow/PR and Vercel publication/HTTP responses remain explicit synthetic transports. This fixture does not qualify actual deployment protection, deployed-mode browser networking, production task publication, or paid-model performance. The synthetic project receipt is never a production completion claim.

Hosted run `41338771363`, job `124944106225`, passed the actual PostgreSQL token-only, monetary-only and expired-window amendment cases, including usable amended native reservations. These SQL fixtures explicitly supply synthetic terminal checkpoint records; they are not substitutes for the integrated host's authenticated Git checkpoint test.

The integrated owner browser exposed a fixture security error: the bundled Chromium's `--disable-web-security` flag suppressed the Origin header, so the production route correctly rejected the POST. The qualification browser now retains web security and asserts Chromium's actual same-origin header. A local real-Chromium transport regression passes; the backend origin guard is unchanged.

## Ordinary initial verification correction

Run `41339137066`, job `124945207865`, completed approval and fresh-host repair but failed on absent `repairVerification.after`. The initial ordinary host had not opted into the existing deterministic lifecycle: it saved the legacy placeholder `passed:true` before review. Commit `81409264bf16604223ba10203b20eb45d4fafd0e` opts authenticated ordinary executions into the same verifier used by qualified continuations. The saved checkpoint now contains an actual initial test result; the strict failed-before/passed-after proof remains required. Infrastructure failures stop before model repair. No authorization, grant, accounting or admission contract changes.

Independent review found this to be a genuine evidence defect and accepted the narrow correction. Exact-head local verification passed 101 lifecycle/authorization/recovery tests, 38 focused tests (some imported forecast tests overlap), and TypeScript. The clean-baseline observation regression executes the actual host source fragment, including authentication failure, so conversion of the main scenario to ordinary first-shortage cannot hide the original defect.

See [the twelve-scenario matrix](task-2c-matrix.md) for initial state, triggering event, required observations, artifact locations and explicit limits. Hosted `ordinary-developer-authority`, `ordinary-native-continuation`, and `native-gateway` passed on `8140926`; complete integrated/final-head qualification remains a separate required gate in the PR report.
