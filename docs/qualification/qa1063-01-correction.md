# QA1063-01: continuation membership before saved-ready recovery

This supplements the original #1061 engineering report. The original integrated
candidate `32429a90d31c7b16f3d7e5c9c8bbef48cafeb45e` (tree
`864b3fb3361ad83b7fbd46df6b8f957da3b69433`) failed Independent QA. Its earlier
green checks do not establish acceptance. Current main integrated here is
`f54a3aaf82d4e9b4ea0f4a55dbfaaaffd65acf50`, including all nine #1062 ITM files.

## Reproduced failure and minimum correction

The predecessor scheduler can return its commissioning wait through the ordinary
fallback when a provider-controlled project's continuation release or window is
invalid. That wait alone is not proof of valid continuation authority. The new
wrapper previously set `decision_needed` and admitted an unbound management
mission. Existing claim guards rejected that mission; paid execution was not
demonstrated.

Before its new recovery mutation, the wrapper now requires the existing
`project_provider_continued` predicate whenever a provider-execution authority
record exists. That predicate retains the existing owner, decision, release,
window and reviewed recovery-receipt relationships. No authority predicate,
predecessor scheduler, owner-control writer, SMART validator or provider claim
guard is rewritten. Projects without provider-controlled authority continue
through the ordinary scheduler. This migration has not been applied in production.

## Original independent probe: fail before, pass after

The exact independent patch is retained in
`qa1063-01-evidence/original-negative-probes.patch`, SHA-256
`dda3e45471eb7adcb8e58bcfa555fd88024b0fe6de5cc1d7dd6711b135beba8d`.
It was applied unchanged in a separate checkout of the failed candidate.
The first run exits 1 on `invalid-release-membership: no recovery mission`.
Only the corrected migration was copied into that checkout for the second run;
the original independent assertions were unchanged. The second run exits 0,
passes both invalid-membership negatives, the valid recovery, all additional
eligibility negatives, diagnostics/context, all-table installation snapshots,
ACLs, ordinary-authority and owner/provider/QA regressions.

QA's original strict failure and two-case characterization logs are also retained
unchanged. The characterization records both invalid release and invalid window
admissions on the failed candidate; its zero exit is not an acceptance verdict.
SHA-256 values are recorded in the evidence manifest. Original independent source
and context: PR #1063 comments 6925519728, 6925548862 and 6925576140.

Both runs used Node 22.23.5 and isolated PostgreSQL 18.6 over loopback TCP:

```sh
export KATIE_TEST_PG_BIN=/path/to/postgresql/bin KATIE_TEST_PG_TCP=1
export KATIE_TEST_COMPLETION_CONTROLS=1 KATIE_TEST_AMENDMENT_SUCCESSOR=1
export KATIE_TEST_CAPACITY_RENEWAL=1 KATIE_TEST_LIFECYCLE_AUTHORIZATION=1
export KATIE_TEST_ORDINARY_AUTHORITY=1 KATIE_TEST_PROJECT_ORGANIZATION=1
export KATIE_TEST_DIRECTOR_ONE_SHOT=1 KATIE_TEST_ORG_AMENDMENTS=1
CI=1 node --test tests/benchmark-renewal-postgres.test.mjs
```

The committed regression tests retain the independent negatives and add a full
public-table before/after comparison for each invalid membership case: zero
recovery-state, mission, assignment, history or allowance mutation. An ordinary
project without provider authority must still recover one bounded management
mission after the existing ordinary owner financial authorization, and preserve
its contracts/history/scope/caps. Without that financial authorization, the
ordinary scheduler must still wait without mutation. Valid authorized recovery,
replay, rollback and all prior fences remain exercised.

## Scope and remaining gates

No production change, live activation, new cutoff, resource expansion, provider
retrieval/inference/replay or worker dispatch. The historical rejected SMART field
remains unverified. The blocked, expired original project has no usable existing
renewal/resume transition; see PR #1063 comment 6925493035. This correction does
not provide that transition or a new execution window.

The final exact candidate/tree, full hosted CI results and Independent QA retest
must be read from the PR continuation receipts. This report does not itself close
QA1063-01 or authorize release. The old candidate's CI is not reused as corrected
candidate qualification. Unrelated repository-wide lint errors inherited from
main remain outside this correction; affected TypeScript files passed lint.
