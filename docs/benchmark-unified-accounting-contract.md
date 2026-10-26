# Three-arm accounting integration contract

The canonical charge is one `benchmark_budget_calls` operation owned by exactly one trial, experiment, replicate, arm, account and provider attempt. Full Katie's `mission_calls` is a projection of the same operation, not another billable charge.

Admission for linked work must use one transaction containing the existing mission/lease/project predicates and account cap. Settlement, uncertain reconciliation and late receipts must update canonical and legacy projections atomically. Generic benchmark settle/reconcile endpoints must reject linked calls. No gateway may independently reserve the same operation after the mission bridge has already reserved it.

Existing direct/orchestrated accounts are historical and must not be relabeled. New native/thin/full trial accounts require explicit trial IDs and schema migration after all upstream migration dependencies have been verified. Existing holds are immutable liabilities until evidenced reconciliation.

No paid execution, owner grant, provider identity or accepted benchmark outcome is created by this document.
