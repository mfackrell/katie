# Developer Orchestrator lifecycle continuity

This change extends the existing project worker, not its architecture. PRs #792
(specification recovery), #794 (Full accounting binding), and #797 (durable
specialist dispatch recovery) remain intact. No production record,
benchmark contract, approval, deadline, budget or Builder branch is changed.

## Reproduced defects and corrections

1. A completed independent final assessment could reject an original requirement
   after browser acceptance, yet the controller blocked instead of using its
   existing bounded implementation repair. It now repairs only the final
   milestone, from its verified head, when the assessment has completed failed
   acceptance checks. Current scope approval, final scoped run, passed preview,
   remaining coding cycles and fewer than two attempts at that milestone are
   required. Failed coordination and optional suggestions still block or remain
   nonblocking; they cannot authorize coding. The existing SQL repair transition
   retains prior results and charges, and the next child admission enforces
   resources and deadlines. Repaired code must pass fresh browser acceptance and
   a new independent whole-project assessment.
2. A stopped development mission with retained review findings could trigger a
   new coding repair. Automatic repair and research recovery now require a
   **blocked**, not stopped, mission. Explicit stops remain stops.

3. The later eight-assignment-capacity migration replaced `commit_mission_work`
   without its original parent-project completion fence. The SQL fixture now
   includes that production migration in order. A surgical migration restores
   the parent running/current-mission/deadline check and rejects missing lease or
   deadline fields. The eight-assignment capacity, accounting and review gates
   are preserved. No existing project rows or permissions are rewritten.

4. The existing six-package structured forecast and provisional specialist plan
   exceed the legacy 4,000-character rationale field (4,811 characters in the
   three-milestone fixture), preventing specification from reaching approval.
   The fixture now installs the production resource-estimate constraints. A
   storage-only migration permits up to 16,000 characters, preserving complete
   JSON and a finite bound. No spending allowance or authorization changes.
   Regression coverage verifies the retained full forecast, unchanged allowance,
   and refusal of 16,001 characters.

All four defects were reproduced before correction. Production changes are
limited to `lib/projects/worker.ts` and the two surgical migrations.

## Reproducible integration evidence

```sh
node --test tests/projects-sql.test.mjs
node --test tests/projects-runtime.test.mjs tests/development-dispatch-recovery.test.mjs tests/missions-runtime.test.mjs
npm run typecheck
npm run ci:gate
```

The SQL test initializes its own disposable PostgreSQL 16 database. It includes
`tests/helpers/project-lifecycle-postgres.mjs`, which runs the actual project
worker, mission worker, stores, GitHub dispatch/reconciliation/evidence readers,
preview verifier and installed lifecycle RPCs. Its Supabase transport adapter
executes SQL, rather than reimplementing transitions. Test-only time changes
advance availability or expire leases; they never extend authorization deadlines.
A fresh worker module graph is loaded between ticks. The optional
`KATIE_TEST_PG_TCP=1` uses loopback instead of a Unix socket for restricted test
containers; CI defaults to the existing Unix socket.

The inventory project exercises:

- Planning two independent specialist research/analysis assignments and a third
  that depends on both. Real database claims permit the independent pair and
  withhold dependent work until both artifacts exist.
- Specification composition and independent review; one exact scope approval.
- Three sequential cumulative development milestones: stock model, persistence,
  and integrated report. Each uses the preceding verified commit. Coding remains
  serialized by the existing architecture; no new concurrent coding scheduler is
  introduced.
- Real dispatch admission, task receipts, immutable head checks, composition and
  independent review. All external GitHub API responses are controlled fixtures.
- A substantive final assessment rejection, bounded revision/review, one targeted
  final implementation repair, fresh browser checks and a successful final
  assessment. Earlier successful milestones are retained.
- Final completion published to the originating conversation; later ticks create
  no more work.

The test asserts faults actually fired at specialist receipt persistence,
completed specialist commit, independent review commit, child creation,
parent milestone advancement, preview integration, browser entry/browser commit,
and final completion. It also expires controller and specialist leases and
rejects stale commits. Resumption preserves project identity, approved scope,
head lineage and call records. Completed provider work is not repeated, and only
four coding issues exist: three milestones plus the permitted repair.

The existing #797 SQL/runtime tests additionally cover unsent transient dispatch,
uncertain external acceptance, exact-marker reconciliation, no duplicate POST,
missing/stale leases, uncertain charges, disabled/changed specialist identity,
expired approval/deadline, resource exhaustion and permanent blockers. New SQL
regressions also refuse commits for blocked/expired/unbound parents and null
assignment leases, lease deadlines or mission deadlines without changing the
saved child row. Existing
project SQL tests enforce concurrent reservations, pause/stop, approval binding,
review checkpoints and completion gates. New runtime regressions reject repair
with missing/wrong-scope final evidence, exhausted cycles/attempts, stopped
missions, optional advice and failed assessment coordination.

## Evidence limits

Model responses, repository/workflow/deployment metadata and implementation source
are fixtures. PostgreSQL transitions and Chromium DOM interaction/reload checks
are real. The preview transport maps the fixture deployment to an isolated local
inventory page; it does not contact a live Preview. The fixture does not prove
provider judgment quality, arbitrary complex-application decomposition, or live
Take Eleven acceptance. The Builder retains exclusive ownership of production
execution and benchmark #715. No paid benchmark inference is launched.
