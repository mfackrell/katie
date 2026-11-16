# Task 3A: adaptive autonomous repair

Baseline: `43345347f6ea2b55c42d36fda9356db8f102a32d`.

The ordinary Developer host already calls the shared native lifecycle and enables deterministic verification. The lifecycle previously stopped after a failed repaired verifier or a final review requesting changes. It now repeats repair, deterministic verification and fresh read-only review within the same assignment and execution grant.

Each new repair reopens repair, verification and final-review forecast stages, including restored completion flags. The existing Task 2 capacity readers and owner-shortage path remain authoritative. Each phase rechecks live execution authority; every provider call still passes the existing atomic admission and settlement gateway. No ledger, reservation, ceiling, reserve or grant mutation was added. Historical observation IDs now use settled operation identities rather than repeated phase labels.

The worker's `attempts < 2` guards govern new missions after native completion or deployed assessment; they do not constrain internal native repair rounds. They and authoritative project cycle limits remain unchanged.

## State and evidence

Implementation → candidate checkpoint → pending deterministic verification → verification → independent review → repair admission → repair → candidate checkpoint → pending verification → verification → independent re-review. Failed verification or an actionable re-review returns to repair admission. All-pass advances to the existing completion workflow.

Every reviewer is a fresh process with read-only source and the frozen request; trusted host attestation binds its verdict to the inspected commit. Missing or mismatched bindings fail closed. Each re-review receives previous findings and current deterministic results. Completion preserves the initial review and separately records review-triggered or deterministic-triggered repair proof. A narrow workflow receipt extension accepts final-review-triggered repairs without falsifying the initial verdict.

The bounded checkpoint state retains repair number, candidate-bound current review and verification, initial review, failure fingerprints, no-progress streak, and continuation/stop reason. Diagnostics retain the latest 64 iteration receipts with source trees, candidate commits, tests, outstanding/resolved/new finding lines and review verdicts. Full history remains in Git and existing run artifacts. Current scope, grant and accounting remain in existing authoritative records.

Unchanged source with unsuccessful verification/review stops after the ineffective repair, regardless of reworded findings. Repeated source/failure combinations and three consecutive identical unresolved failure sets also stop with a specific no-progress diagnosis; there is no total repair-count ceiling. Resource denial preserves unfinished work for the existing owner approval workflow. Pending verification is rerun on recovery; completed implementation and repairs are not replayed. Infrastructure failure never becomes a PASS. Existing bounded process-interruption retries remain unchanged.

## Nonbillable qualification

`tests/native-adaptive-repair.test.mjs` runs the actual controller against real temporary Git source. Frozen executable assertions require correct transaction total, non-void transaction count and maximum. The initial implementation contains three distinct defects. A fixture implementer fixes one genuine defect per repair. Separate Node subprocesses inspect each candidate by executing the frozen assertions; verdicts are derived from failures, not prescribed PASS values.

`task3a-adaptive-trace.json` preserves candidate/tree hashes, the original executable assertions, source, verification results and separate reviewer evidence. Required trace: three repairs, failures 3 → 2 → 1 → 0, final independent PASS. This demonstrates orchestration control with synthetic providers, not paid-model engineering competence.

Additional tests cover first-pass success, one repair, later final-review findings, failed repaired verification, reopened regressions, no progress including varying reviewer prose, mismatched/missing review identity, resource denial, same-task repair continuation and pending verifier recovery. Existing recovery, capacity, protected-reserve, authorization and accounting tests remain required. A frozen accounting object in the synthetic source fixture is only a control nonmutation check; real ledger/authorization claims depend on the existing integration suites.

Task 3B comprehensive interruption qualification and Task 3C full engineering qualification are deferred. No Take Eleven execution, paid inference, spending amendment or synthetic owner consent was performed.
