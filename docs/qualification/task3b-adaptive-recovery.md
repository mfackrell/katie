# Task 3B investigation

Baseline: `38b45d2e2c5a1033819ffebcb9b52bc7561ea70b`.

Inspection before implementation identified these integration deficiencies:

* The lifecycle recovery selector uses coarse `review`/`final-review` checkpoint phases. It cannot distinguish an interrupted reviewer from a completed reviewer whose findings are already retained, and reruns completed review on restoration.
* After committing a repair, the saved review still refers to the previous candidate. Pending verification can recover, but a precise next-action marker is missing; completion and reviewer validity must be decided from candidate-bound evidence, not the presence of any review object.
* The controller publishes completed verification/review state in memory. The host does not durably checkpoint each published transition, leaving a gap until another provider request or graceful cleanup.
* Restored diagnostics retain capacity observations but discard the previous attempt's bounded adaptive iteration receipts. The counters survive in the checkpoint, but resolved/new finding evidence is lost from the successor artifact.
* No-progress stops are stored but not enforced on restart; the `repair` recovery shortcut can bypass a saved terminal no-progress decision.

Existing authenticated Git restoration, scope gates, historical-call reconciliation, live phase authority and atomic provider admission are reused. No new authority or accounting mechanism is required. Seven-day trusted diagnostic retention and loss of changes preceding a durable checkpoint remain unchanged.

Qualification and final limitations will be recorded here after execution; this document is not a passing qualification receipt.
