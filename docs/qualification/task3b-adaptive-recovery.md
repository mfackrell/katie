# Task 3B investigation

Baseline: `38b45d2e2c5a1033819ffebcb9b52bc7561ea70b`.

Inspection before implementation identified these integration deficiencies:

* The lifecycle recovery selector uses coarse `review`/`final-review` checkpoint phases. It cannot distinguish an interrupted reviewer from a completed reviewer whose findings are already retained, and reruns completed review on restoration.
* After committing a repair, the saved review still refers to the previous candidate. Pending verification can recover, but a precise next-action marker is missing; completion and reviewer validity must be decided from candidate-bound evidence, not the presence of any review object.
* The controller publishes completed verification/review state in memory. The host does not durably checkpoint each published transition, leaving a gap until another provider request or graceful cleanup.
* Restored diagnostics retain capacity observations but discard the previous attempt's bounded adaptive iteration receipts. The counters survive in the checkpoint, but resolved/new finding evidence is lost from the successor artifact.
* Recovery previously reconstructed semantic failure evidence from 1,600-byte display summaries. Long actionable tails could disappear and unchanged failures could reset stagnation. Full bounded evidence now remains in existing authenticated diagnostics, referenced by checkpoint digests; missing, altered or cross-candidate evidence fails closed.
* Forecast progress previously used the coarse original recovery phase, which could repeat completed work estimates or restore an old candidate PASS after a new failed repair. Forecasts now consume the latest durably published adaptive state.
* No-progress stops are stored but not enforced on restart; the `repair` recovery shortcut can bypass a saved terminal no-progress decision.

Existing authenticated Git restoration, scope gates, historical-call reconciliation, live phase authority and atomic provider admission are reused. No new authority or accounting mechanism is required. Seven-day trusted diagnostic retention and loss of changes preceding a durable checkpoint remain unchanged.

Qualification and final limitations will be recorded here after execution; this document is not a passing qualification receipt.

## Corrections and security boundary

Adaptive state version 2 records the next unfinished action and candidate identity. A pending repair binds its prior source tree, deterministic verdict, findings and target iteration. Candidate commits invalidate earlier review approval. Completed review is checkpointed before fallible iteration bookkeeping; restored bookkeeping never repeats the review. Duplicate iteration receipt publication is idempotent. Entering repair publishes the failure fingerprint and pending repair together. A completed stagnation limit is never waived by recovery.

The host retains full bounded verification/current-review/initial-review evidence in existing diagnostics and keeps display summaries plus digests in the unchanged 24KB checkpoint envelope. Recovery rehydrates exact evidence before any grant or provider request. The host checkpoints every published lifecycle transition and carries the previous artifact's bounded 64 iteration receipts forward. Recovery validates action/verification/reviewer coherence and rejects unverified modifications at a completed candidate boundary. Existing scope checks, append-only accounting and per-call admission remain authoritative.

An ordinary failed attempt can retain adequate capacity but have consumed its single-use grant. The existing proposal adapter now recognizes the authenticated blocked task/run, consumed latest approval and matching historical grant. It offers explicit owner renewal through the existing transaction. It never reissues a grant or increases a limit by recovery alone. The synthetic qualification approves each new attempt using isolated owner-bound SQL; it is not production consent.

## Reproducible coverage

| Required boundary | Qualification |
|---|---|
| Three repairs, two destroyed runners, same task, exact two-file edits and new file | `qualify-adaptive-recovery.mjs`, actual host/SDK/PostgreSQL job |
| Pending candidate verification, completed verification, failed review and completed PASS | `native-adaptive-repair.test.mjs`, interruption at every durable transition |
| Interrupted iteration bookkeeping | Completed verdict persisted first; dedicated restart regression |
| Findings, resolved findings, iteration and no-progress history | Adaptive pending-repair tests and actual-host artifact trace |
| Additions/modifications/deletions and exact raw bytes | Existing `native-wip-recovery.test.mjs` and actual host Task 1 qualification |
| Candidate mismatch, corruption, scope/project/task mismatch | Existing trusted recovery negative tests plus adaptive next-action validation |
| Missing/ambiguous/expired diagnostics | Existing trusted artifact provenance tests |
| Expired/revoked authority, uncertain charges, protected resources | Existing real PostgreSQL/native admission and Task 1–2 qualification jobs |
| Shortage and rejected amendment | Existing Task 2 adequate/shortage full lifecycle and owner transaction qualification |
| Recovery retry and pre-checkpoint loss | Fresh-environment retry and explicit never-checkpointed source loss tests |

The new actual-host assignment freezes total/count/largest operations for non-void integer-cent transactions and the `/pilot` browser acceptance. Review messages are derived from executable assertion failures, not predetermined PASS values. Synthetic provider transport performs genuine source edits and reviewers run separately in the existing read-only sandbox. Initial implementation, first review and completed repairs must not replay.

## Limits

Trusted diagnostics retain the existing approximately seven-day lifetime. Missing/expired diagnostics fail closed even if Git checkpoints remain. Abrupt termination before source and trusted evidence are durably saved can lose those newer changes; no recovery guarantee is made for them. A failed partial restore may be discarded and retried from the same immutable evidence in a fresh environment; dirty environments are not silently overwritten.

This is controlled nonbillable qualification, not evidence of paid-model engineering competence, Task 3C, full delivery reliability, or production synthetic consent. Final CI, independent review and hosted qualification results remain required before this document can be treated as acceptance evidence.
