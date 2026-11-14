# Issue 1048: post-release management-loop correction

Baseline: `c1d9a5f1ac10396c3015a7d5ae5f22254502e5de` (merged PR #1047).
Assignment: https://github.com/mfackrell/katie/issues/1048.
This candidate is for independent QA. It grants no production release or recovery authorization.

## Evidence and cause

Read-only production inspection confirmed the original project `fe9d2658-41e3-44c1-ae8e-a0cba98371fe` is paused in development with 73/96 missions consumed, zero work packages, 13 existing organization nodes, a 600000-token allowance, and the unchanged `2026-11-15T18:00:00Z` cutoff. Its approved scope is `4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6`.

| Observation | Evidence | Engineering conclusion |
| --- | --- | --- |
| Root delegated capability and approved scope to existing Game Delivery | Completed mission `94e76e0a-34eb-42d4-9550-44ade4bcb071` | PR #1047 recovery worked; preserve it. |
| Game Delivery delegated only scope to Delivery Manager `a00de7ce-4159-49ac-9628-a070d5dbaffd` | Completed mission `d72af491-6d26-4f6a-bb1f-aa88967c4fbb`; manager tools remain `manage,analysis,repository_review` | Scope alone does not permit coding-worker commissioning. The actual parent must amend the delegated capability. |
| Manager tried evidence-free exception resolution twice | Blocked missions `4361ffcc-f7df-43f6-ba41-1c369ca40dc4` and `7ca7af08-4042-4fa7-b1ed-26269f7f8cb7`; PostgreSQL log errors at 20:14:53 and 20:17:56 UTC | The existing evidence guard correctly rejected these model proposals. Historical open exceptions are not fabricated completion evidence. |
| Parent replaced that manager twice | Completed decisions in `0fb838e8-94c8-430c-91cf-e54da4d70f7c` and `97a857b7-d46e-4cb1-90fa-25a4d2089015` | Installed `project_org_restructure` changes the agent but retains tools/scope. It had no progress requirement for repeated replacement. The underlying delegation defect remained. |
| Malformed dependency rejected | Mission `5436f7ca-cf77-42cb-81c2-3fd34e619a9b`, `immediate_reporting_authority`, command position 2, malformed `dependsOn` | Client reporting guard worked; this is a model-invalid command, not a SQL dependency defect. |
| Final manager assignment rejected | Mission `62cd8da3-1bcc-41ae-9470-574c6b05e420`: `SMART requires an explicit bounded file inventory within worker scope` | Keep the SMART fence. The manager's existing supervisor/assessment worker had no current scope grants. Rejected raw command text is not retained, so the specific attempted file path or command cannot be reconstructed honestly. |
| Approved milestone and previous decisions absent from model input | Baseline `executeManagementClaim` selects no `spec`, `milestone_index`, or decision rows; context claims decisions remain in the ledger but never projects them | The model receives inadequate implementation and recovery context. Completed replacement/ready decisions also hide previous failure diagnostics. This explains the opportunity for repeated bad decisions; it does not establish the provider's private reasoning. |

The three existing scope grants belong to Root, Game Delivery and Delivery Manager. They contain only `app/milestone-3-tic-tac-toe/`, `lib/milestone-3-tic-tac-toe/`, and `tests/milestone-3-tic-tac-toe/`. No identities are renamed or replaced by the migration.

## Correction

1. Project management input now carries the current approved milestone, original requirements and final acceptance contract, concise references to the latest two decisions per relevant node, the last replacement decision per direct report, and the latest failure even after a completed management decision. The existing 48000-character bound remains fail-closed. Only the current milestone is projected. Identical final/current acceptance contracts share a JSON reference; exception identity, ownership, text and dates are retained, without redundant project IDs or null resolutions. This is not a new continuity architecture.
2. The actual parent receives an explicit diagnosis when an active manager has the approved scope but lacks development capability. It must propose any amendment itself. Both QA identities and their descendants are excluded. Analysis-only delegations stay analysis-only. Open exceptions do not require evidence-free resolution before lawful work can proceed.
3. Resolution preflight reads proposed assignment IDs from the database, including older/deeper evidence omitted from the bounded prompt. It rejects missing, failed, foreign or wrongly owned evidence before command admission. The existing SQL still independently validates completed missions, subtree membership, evidence and the lease. Self-dependencies and unknown commands also fail closed.
4. A trigger blocks another leader replacement until a worker in that organization's subtree has completed technical execution since the preceding appointment. Management decisions, ready calls and failed jobs cannot reset this fence. Existing per-node retry accounting and parent escalation remain unchanged.
5. One additive, owner-bound recovery receipt permits the paused prework project to adopt a corrected exact release. It retains the blocked active mission for normal scheduler reconciliation. It does not reset failures, create a decision, dispatch work, renew deadlines, change scope, or increase allowances.

## Why a new recovery entry point is necessary

Installed `control_work_project(...,'resume')` rejects a blocked active mission. `project_provider_continue` rejects changing an existing continuation release. `project_org_renew_continue` requires a strictly later cutoff. The scoped-root retry recovery is limited to its already consumed root-appointment failure and single-root-grant state. None covers this paused subordinate-management failure without violating the assignment.

`project_org_resume_management(owner, project, newRelease, expectedRelease, scopeHash, sourceMission)` is service-role-only and verifies the authenticated owner binding, paused development state, idle leases/provider requests, exact source/window/current release/scope, post-ratification failed subordinate management, unexpired cutoff, remaining mission capacity, and absence of coding packages. Only one receipt per project/window is admitted. Receipts are RLS-protected, read-only to service workers, and append-only even through privileged updates. Window authorization accepts only the receipt's exact new SHA, including the existing PR #1047 release-rebind chain.

A later Director must independently verify the deployed release SHA and obtain explicit owner recovery approval before invoking this function. Its SQL SHA syntax and immutable binding do not independently prove a GitHub merge or Vercel deployment. No production invocation is part of this engineering assignment.

## Reproduction and qualification

Use the repository's pinned dependencies and native PostgreSQL. Tests use isolated synthetic records, mocked model transport and local repositories. They do not call a model or execute a live worker.

```sh
npm run typecheck
node --test tests/management-context.test.mjs tests/project-organization-runtime.test.mjs tests/agent-management-runtime.test.mjs tests/executive-management-ledger.test.mjs tests/executive-management-delivery.test.mjs
KATIE_TEST_PG_BIN=/usr/lib/postgresql/16/bin node --test --test-concurrency=1 tests/project-organization-postgres.test.mjs tests/project-organization-integration.test.mjs tests/organizational-contract-amendments-postgres.test.mjs
```

The new native helper `tests/helpers/assert-management-loop-recovery.mjs` runs through the actual TypeScript context builder and command validator, a deterministic model transport, and real PostgreSQL admission. It commissions one bounded package through existing parent → Manager → Supervisor → worker delegation, with distinct composition/review workers. It tests scope-only authority, repeated replacement, fabricated resolution, malformed/self dependencies, premature closure, invalid SMART inventories, owner/source/scope/release rejection, receipt rollback/replay/immutability, preservation of history and limits, and exact-release claims. Repeated model-invalid commands must reach the existing root retry stop within eight additional missions, not consume the whole allowance.

Read-only replay of all 12 live management contexts fits the unchanged bound: Root 38566, Game Delivery 30269, Delivery Manager 29031, and the largest QA context 46936 characters. No model call or decision admission occurs during replay.

Existing native integration qualification retains G6 appointment/closure fences for both QA designations, scope ratification, hierarchy recovery, worker SMART admission, immutable source/commit verification, native delegation and accounting/security regressions. The separate runtime tests verify approved-contract projection, retained failure/replacement diagnostics, both QA exclusions, and completed-evidence provenance.

The isolated branch is explicitly excluded from Vercel Git deployments in `vercel.json`. No deployment workflow or paid inference workflow is invoked.

## Independent QA and release hold

Verify the exact PR head, not a later branch tip. Reproduce the rejected commands against the baseline, run the listed native suites, challenge receipt binding and rollback, and inspect the unchanged historical records. A mocked model response proves the authorized path and failure fences; it cannot prove that a live provider will choose the correct next command. Live autonomous commissioning, delivered game code, same-commit independent QA and protected Preview acceptance remain unverified and require a separately authorized release/recovery. The original project must remain paused until then.
