# Functional Director reporting correction

Baseline: PR #1030, released as `24a6ba2eaedfba6039940e101e7b5d7f82e38569`.
Production READY and the installed M1 migration checksum were confirmed before
implementation. This correction is a separate, additive migration; it does not
edit or replay the released migration or activate historical projects.

## Enforced organization

The Project Director commissions management-only Functional Directors. Every
worker reports to a manager below a Functional Director. Functional Directors and
subordinate managers retain the same recursive planning, appointment, delegation,
local repair, rejection, restructuring and evidence-evaluation capabilities within
their inherited authority. No fixed organization count or depth is introduced.

The database rejects root worker appointments (including reused agents), root work
assignments, cross-project parents and workers as parents. A row trigger covers
both insertion and reassignment, including privileged function paths. Immutable
roles and existing immediate-superior checks prevent role/restructuring bypasses.
The management dispatcher independently validates executive restrictions and the
immediate reporting relationship for target-bearing commands. Worker principals
remain unable to invoke management decisions.

The new migration refuses to install over an already-invalid reporting graph. It
never silently reparents an existing worker or changes delegated resources.

## Certification and independent superior acceptance

A Functional Director uses `submit_component` to certify its entire immutable
management contract after accepting its subordinate deliverables. The command is
bound to that director's live lease and cannot name another submitting node.
Every original criterion needs an evaluation backed by authenticated completed
execution evidence. Submission does not mark the directorate accepted.

The superior separately uses `certify`, with its own criterion evaluations. It
requires the responsible director's current submission, bound to leader, contract,
scope, head, unchanged source result and subordinate-state fingerprint. Accepted
worker tasks alone are insufficient. Rejection, leadership replacement, scope or
reporting changes invalidate submissions; changed subordinate work or source
receipts cannot reuse stale attestations. Acceptance retains both evaluations.

Existing financial admission, protected reserves, native gateway, independent QA,
final closure and historical-project gates remain in force. No provider transport,
parallel orchestration system or owner approval per internal action is added.

## Qualification

`project-organization-postgres.test.mjs` applies M1 and this migration to actual
PostgreSQL. It exercises allowed manager and worker chains, denied executive
worker creation/reuse/assignment, row-level reassignment and role bypasses, worker
management denial, lease concurrency, local repair without executive involvement,
manager submission followed by independent superior acceptance, missing/forged/
stale submissions and modified source evidence. Existing financial and QA closure
negative tests remain mandatory.

`project-organization-integration.test.mjs` applies both migrations after the real
native/ordinary-authority stack and retains historical snapshot comparisons and
two canonical native tasks using synthetic usage. Dynamic fixtures retain 2 and
24 functional areas and depth 10. Runtime tests verify dispatch restrictions.

All tests use deterministic provider outputs. They do not authorize paid inference,
new development dispatch, project activation, merge or deployment. Full CI and
independent security qualification must be attached to the exact draft candidate.
