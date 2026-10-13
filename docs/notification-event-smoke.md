# Event notification smoke test

This documentation-only change exercises Katie's protected build → independent
tests → independent review (and repair/review when needed) → completion receipt →
event-driven notification flow. The orchestration workflow opens a draft PR;
this smoke test does not merge or deploy it.

The autonomous workflow publishes a versioned `agent-completion` artifact with
the task issue, draft PR, check outcomes and run ID. On GitHub
`workflow_run.completed`, **Katie event-driven notifications** runs trusted
`main` code, validates the receipt and owner-authorized task/PR provenance, and
reports READY or BLOCKED on the task and
[operations notification issue #427](https://github.com/mfackrell/katie/issues/427).
A successful workflow conclusion and a READY receipt are both required for
READY. Missing or invalid completion data cannot imply success. BLOCKED results
with a valid receipt create a linked follow-up review issue without authorizing
another coding run. Per-run markers prevent duplicate notification comments.

The listener also reports combined CI and migration results for the same
main-branch commit after both workflows complete; those checks do not establish
production readiness. Notification jobs do not merge or deploy code.

Delivery uses normal GitHub issue notifications, subject to subscriptions and
GitHub notification settings. No ChatGPT push messaging or delivery into an
inactive ChatGPT conversation is implied. Live smoke-test success requires an
actual new comment on #427; local tests alone do not verify delivery. The draft
PR is intended to be closed after that comment is verified.
