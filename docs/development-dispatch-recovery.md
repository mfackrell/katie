# Generic Developer dispatch recovery

The existing `runProjectBatch` maintenance call to `project_dispatch_recovery_candidates` now repairs eligible stranded development assignments before the normal mission worker acquires a fresh lease. It keeps the same project, mission, task, request, approved input, acceptance binding, execution marker, attempts, coding cycles and accounting rows.

A live worker is never preempted. Recovery requires the exact current project scope/binding, active mission, frozen agent definition and task/repository identity, original deadlines and approved development payload. Remaining project/mission coordination headroom uses `max(actual_tokens,reserved_tokens)`; uncertain calls stay charged. Recovery does not issue new authorization. Native benchmark-bound tasks remain with their existing bound executor; no Full binding, signing, host or staging code is changed.

GitHub owner/workflow preflight precedes final atomic POST admission. A transient preflight failure therefore retains positive evidence that no issue POST was attempted. The existing task may retry after fenced recovery. After `attempted=true`, workers only reconcile the exact task marker and trusted receipt; they never submit another issue. Ambiguous legacy/expired acceptance becomes an explicit blocker requiring reconciliation of the accepted issue identity. Trusted blocked receipts and permanent integration failures stop without another coding dispatch.

Recovery is deduplicated by saved task/scope/request/execution/failure state, capped at two recoveries per task, and never resets worker attempts. Repeated polling of an already queued recovery does not cancel it. Blocked candidates are deferred fifteen minutes so a bounded scan cannot starve newer tasks. Every blocker records its reason and minimum action. Mission-worker observation writes are fenced by the current lease and exact parent binding; a lost worker cannot overwrite a newer checkpoint.

Verification commands (offline, no paid providers):

```bash
npm run typecheck
node --test tests/development-dispatch-recovery.test.mjs tests/agent-management-runtime.test.mjs tests/missions-runtime.test.mjs tests/projects-runtime.test.mjs tests/specification-lifecycle.test.mjs
# Existing isolated PostgreSQL fixture server used by CI:
node --test tests/projects-sql.test.mjs
npm run ci:gate
```

Runtime regressions use the saved Take Eleven requirements and contract, mock external GitHub responses, and execute the existing project and mission workers through recovery to the next assignment stage. SQL regressions use the actual admission/claim/save/commit RPCs for live/stale leases, duplicate POST admission, uncertain charges, unchanged identity/attempts/approval, parent progression and explicit unsafe-state blockers. No historical production project is resumed by these tests or this migration.
