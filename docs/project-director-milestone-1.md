# Project Director — Milestone 1

This additive slice gives each project a persistent accountable director and a
bounded management hierarchy. It does not qualify the complete autonomous
software-development platform or authorize a production release.

## Ownership and execution

`work_projects` inserts create exactly one director with a separate managed-agent
identity. A unique partial index prevents duplicate directors. Historical rows
receive ownership metadata with `organization_version=0`; their state, team,
missions, spending and Task 4A authority are not migrated into new execution.
New projects use version 1. Roles, reporting lines and delegated ceilings cannot
be rewritten. Deletion/reclassification cannot turn a manager into a worker.

The existing project controller schedules management sessions through existing
mission leases. Management dispatch only accepts a bounded JSON decision array;
database functions derive its principal from the live assignment and lease.
Agent-task and mission-assignment triggers reject technical work by managers.
Workers use the existing mission/model or native development infrastructure.
No new provider transport or alternative native spending ledger is introduced.

Executive routing intersects live provider discovery with fresh verified registry
capability and pricing. Only available OpenAI/Anthropic models with verified high
reasoning capability are eligible. No fallback model ID is guessed. Every routing
and execution call still requires atomic financial admission. Missing eligibility
or authority fails closed. No real inference is needed for deterministic tests.

## Delegation and exceptions

Managers appoint managers or workers with objectives, acceptance criteria,
deadlines, token allocations, tool boundaries and path grants. A project allows
at most 64 organization nodes, depth 6 from its initial root, and bounded child
counts. New projects default to 64 mission sessions (maximum 256); historical
mission limits remain unchanged. Sibling allocations and the manager's consumed
capacity cannot exceed the parent. Calls additionally check all ancestor limits
and the combined project monetary ceiling. Concurrency uses the existing mission
advisory lock, not an independent locking scheme.

The original owner grants one objective-bound monetary envelope through the
owner-authenticated `POST /api/projects/organization`. This supplements existing
financial authorization; it grants neither native execution nor publication.
The request requires `projectId`, SHA-256 of `objective + clarifications`,
`ceilingMicrousd`, and `perCallMicrousd`. Management waits until this exists.
No per-appointment owner consent is required. A complete owner-facing intake
approval interface remains outside this slice.

Scope approval creates a versioned root grant, invalidates stale acceptance,
and wakes the director. `grant_scope` propagates only approved parent paths and
reactivates child managers. Coding requires a current worker grant. Dependency
edges are acyclic and confined to organizations managed by their shared superior.
The scheduler selects eligible work while dependent work waits.

Worker failures wake their immediate manager. A manager can assign a bounded
replacement work package and resolve the local exception with authenticated
completed-work evidence. Exceptions move one reporting level at a time; routine
exceptions cannot be escalated to the owner. Failed management sessions receive
at most two local attempts before an objective exception reaches the superior.
All attempts and spending survive. Provider/session failures never recreate
financial authority or erase consumed claims.

## Acceptance and closure

Managers certify direct children using completed assignment evidence from their
subtree. Acceptance is bound to the worker contract and approved scope. Parents
are notified when their subordinate components are ready for certification.
QA cannot inherit development authority. Project closure requires a current
assessment reviewer in the independent QA subtree, different from the author,
with the actual QA assignment accepted against the final head and scope.

Only a live Project Director session can write a closure authorization. Missing
components, open exceptions, failed original-requirement checks, missing exposure
rows or unsettled calls prevent it. The existing source-bound project completion,
Preview and browser gates still run afterward. A component certificate or director
receipt does not bypass those gates.

Financial receipts distinguish actual recorded tokens, conservative verified-price
mission cost bounds and canonical native exposure. They do not claim supplier
invoice reconciliation. Uncertain calls retain their liability and block closure.
Actual overruns are recorded and block further project execution rather than
rejecting the provider's accounting receipt.

## Qualification coverage

* `project-organization-postgres.test.mjs`: actual PostgreSQL transactions for
  root uniqueness, three functional directors, recursive delegation, lease replay
  races, tool/scope/resource containment, local failed-worker repair, escalation,
  persisted ownership after reconnect, authenticated component evidence, native
  admission/settlement, failed-QA rejection and director-only closure authorization.
  Final acceptance fixtures seed technical outputs, then certify every functional
  organization through its live manager RPC. This is not a claim of an inferred
  application being built end to end.
* `project-organization-runtime.test.mjs`: verified executive eligibility,
  management-only dispatch, subordinate work completion and denied coding bypass.
* `project-organization-integration.test.mjs`: installs the new migration after
  the existing ordinary-authority/native financial stack; compares historical
  project/mission/financial snapshots and exercises canonical gateway admission
  and settlement. This combined path is historical version 0. Version 1 native
  guards are separately exercised with simplified ledger tables in real PostgreSQL.
* Existing project/mission/dispatch regressions remain mandatory. Full CI and build
  must pass on the candidate before release qualification can be claimed.

## Subsequent milestones

1. Complete the single owner intake/approval experience and generalized project
   requirements/architecture contracts beyond the existing application profiles.
2. Bind detailed specialist plans and component artifacts to executable work
   packages, including multiple independent coding packages and integration jobs.
3. Qualify a fully appointed version 1 project through the complete canonical
   native gateway and existing final completion controller, using deterministic
   providers before any separately authorized paid acceptance.
4. Extend recovery and organizational amendments without changing original scope,
   ceiling or accepted evidence; add richer dependency and delivery coordination.
5. Reconcile provider invoices where required and progressively qualify Task 4A,
   multi-component applications, persistence/authentication, external integrations
   and larger systems. Do not restart or dispatch historical Task 4A as part of M1.
