# PR #1047 — G6 QA identity compatibility handoff

**Disposition: local engineering PASS; held for Director-coordinated independent QA.** No remote branch, PR, production database, deployment, mission or provider was changed. This is a narrow follow-on to `48f6c8f42bd7390bcf045e5e257e3182e737529e`, not a replacement for its active review or a production release approval.

The candidate is the local commit containing this document on `local/g6-qa-compatibility`, in `/workspace/scratch/1436f243fc58/katie-g6`. PR #1047 remained open at the original qualified SHA when checked. Production baseline remains `5b129f6de84a379f979dc8c838a8908a99b04273`.

## Verified defect and exact correction

Read-only `pg_get_functiondef` inspection of the installed `public.project_org_decide_hierarchy(uuid,uuid,jsonb)` confirmed four predicates recognizing only `quality_assurance`. The same predicates remain in the effective migration stack at the qualified PR head. The live database reports PostgreSQL **17.6**.

The original project `fe9d2658-41e3-44c1-ae8e-a0cba98371fe` has one QA manager with the relevant designation:

| Field | Installed value |
| --- | --- |
| QA node | `4e6503c8-7723-49e7-ad30-22f633feb2f8` |
| Parent Project Director | `c486ade1-2a9c-4cd5-a80b-90c032e4e03e` |
| Area | `independent_qa` |
| Tools | `manage`, `analysis`, `research`, `repository_review` |

New migration `20261114183104_g6_qa_identity_compatibility.sql` changes only these checks to recognize both established names:

| Existing predicate | Purpose |
| --- | --- |
| `c->>'area'='quality_assurance'` | Block development authority on direct QA appointment |
| `select 1 from ancestors where area='quality_assurance'` | Block development authority below any QA ancestor, including neutral-area descendants |
| `and area='quality_assurance' and status='accepted'` | Recognize the accepted direct QA directorate at closure |
| `and qa.area='quality_assurance' and qa.kind='manager'` | Recognize its source-bound independent review evidence |

Each textual anchor must occur exactly once or the migration raises an exception. No records are inserted, renamed or updated. Existing management leases, reporting boundaries, director attestations, scope/head binding, assessment/preview binding, six successful checks, separate author/reviewer requirement and completion/exposure controls remain intact. The existing PR's dual-name amendment fence is untouched. The installed production amendment definition still has the older single-name fence because PR #1047 has not been deployed; the test checks preservation of the corrected PR definition.

The compatibility test compares the complete function body before and after reversing these four substitutions; it must be byte-for-byte identical. It also compares function ACLs, SECURITY DEFINER setting, search-path configuration, owner and volatility, the complete amendment function, and historical project/mission/financial and organization records across migration installation.

## Regression evidence

Two disposable probes against the qualified baseline's historical hierarchy fixture reproduce the defects without installing the correction:

- Appointment: an `independent_qa` appointment carrying development authority produces **Missing expected rejection**.
- Valid closure: changing the fixture QA designation to `independent_qa`, then exercising its otherwise-valid source-bound closure, produces **Organizations or exceptions remain incomplete**. Earlier rollback-only negative probes were omitted to reach that positive closure directly. The fixture patch is retained with the evidence.

The new current-stack helper exercises both names independently. For each name, actual scheduling and lease-bound decision RPCs perform valid appointment, worker delegation, responsible-director component submission, superior certification and successful source-bound closure. Technical completion/review outputs are synthetic; no inference runs.

Each designation also passes **24 negative cases**:

- Four authority checks: direct appointment, existing amendment guard, QA ancestry through a neutral-area descendant, and delegation from a safely bounded QA parent.
- One identity check: even a privileged attempted QA rename hits the immutable-identity guard.
- Nineteen closure/attestation checks: premature component acceptance, missing director submission, wrong lease, unaccepted QA, open exception, unapproved scope, stale QA head/scope, foreign evidence, review outside the QA subtree, stale assessment scope, changed final contract/preview, failed/missing review criterion, failed verdict, incomplete assessment/author, and same author/reviewer. Invalid author mutations are rejected by the earlier component-completeness guard.

Adversarial legacy ancestry exists only inside a rolled-back synthetic savepoint. Each successful fixture has exactly one QA directorate of its selected designation; all final identities and reporting relationships are compared unchanged. No real organization is renamed or duplicated.

## Executed qualification

Local environment: Node **24.22.1**, native PostgreSQL **17.6**, TCP fixture mode. The database engine matches production. Hosted CI uses its repository-defined Node/PostgreSQL matrix and has **not** run for this unpushed candidate.

| Check | Result |
| --- | --- |
| TypeScript, `npm run typecheck` | PASS |
| Organization + projects runtime tests | **88 passed**, zero failures/skips |
| `npm run test:review` | **180 passed**, zero failures/skips |
| Full PostgreSQL stack with completion, ordinary authority, organization, one-shot recovery and contract-amendment flags | **1 top-level test passed**, including both G6 designations and all 48 new negative cases |
| Organization integration + historical hierarchy PostgreSQL files, sequential | **2 top-level tests passed**, zero failures/skips |
| `git diff --check` | PASS |

The full-stack log also records `SCOPED_ROOT_RETRY_RELEASE_CLAIM_DELEGATION_PASS`, `PROJECT_SCOPE_RATIFICATION_POSTGRES_PASS`, `PROJECT_HIERARCHY_RECOVERY_POSTGRES_PASS`, `DIRECTOR_ONE_SHOT_POSTGRES_PASS`, `PROVIDER_PROJECT_CONTINUATION_POSTGRES_PASS`, `ORGANIZATIONAL_CONTRACT_AMENDMENTS_POSTGRES_PASS`, `SMART_MANAGEMENT_PASS`, `PROJECT_ORGANIZATION_NATIVE_DELEGATION_PASS` and `PROJECT_ORGANIZATION_COMBINED_SCHEMA_PASS`. Existing native execution and Chromium checks ran locally with synthetic inputs, without live worker dispatch or paid providers.

Raw logs and read-only installed predicate evidence are in `/workspace/scratch/1436f243fc58/g6-evidence`: `baseline-appointment.log`, `baseline-valid-closure.log`, `baseline-closure-probe.patch`, `installed-qa-predicates.json`, `full-stack-security.log`, `integration-historical.log`, `runtime-regression.log`, `review-regression.log`, and `typecheck.log`. Earlier harness-development failures are not candidate qualification results.

Reproduce from the candidate checkout with installed dependencies and native PostgreSQL:

```sh
export KATIE_TEST_PG_TCP=1
export KATIE_TEST_PG_BIN=/workspace/scratch/262a5889adf6/tooling/node_modules/@embedded-postgres/linux-x64/native/bin
npm run typecheck
node --test tests/project-organization-runtime.test.mjs tests/projects-runtime.test.mjs
npm run test:review
KATIE_TEST_COMPLETION_CONTROLS=1 KATIE_TEST_AMENDMENT_SUCCESSOR=1 KATIE_TEST_CAPACITY_RENEWAL=1 KATIE_TEST_LIFECYCLE_AUTHORIZATION=1 KATIE_TEST_ORDINARY_AUTHORITY=1 KATIE_TEST_PROJECT_ORGANIZATION=1 KATIE_TEST_DIRECTOR_ONE_SHOT=1 KATIE_TEST_ORG_AMENDMENTS=1 node --test tests/benchmark-renewal-postgres.test.mjs
node --test --test-concurrency=1 tests/project-organization-integration.test.mjs tests/project-organization-postgres.test.mjs
git diff --check
```

Use the appropriate local PostgreSQL binary path on another host. Keep native TCP fixture files sequential because they share a fixed port. The existing `organizational-contract-amendments-postgres.test.mjs` wrapper supplies the same flags as the explicit full-stack command above.

## Coordinated handoff and remaining gates

The authorized engineering correction is complete locally. The remaining gates are Director coordination with the active independent review, independent review of this exact local candidate, and CI on the eventual coordinated PR head. If that head differs from the stated base, reconcile and rerun qualification before claiming an exact-head result. Do not treat prior CI on `48f6c8f...` as CI for this new commit.

No broader continuity implementation, live model behavior, production recovery, game commissioning or application delivery is claimed. Production merge, migration, deployment and live dispatch remain outside this assignment.
