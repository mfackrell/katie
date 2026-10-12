# Work Package 1: Restore a Trustworthy Testing Baseline

## Scope and baseline

Reviewed the architecture and repository hygiene documentation present at
`1d37a08609e6d7ad7e97a4adfbe1fe8d1f74a868` (`docs/architecture.md` and
`docs/repo-hygiene-audit.md`), then inspected latest main before changing code.
Main was `e9e3c20239a056a85bd5f2c4900ba12877903734`, one commit ahead, including
the new task-progress regressions. Work is isolated on
`codex/wp1-testing-baseline`.

The shell's GitHub proxy was unavailable. GitHub connector reads supplied the
latest files and signed commit metadata; both the local tree
(`80f778aab8f4487c0578c33845d774ec68ad5140`) and commit hash were verified against
GitHub before branching. No production resources were accessed or modified.

## Pre-existing failures reproduced

- Full TypeScript checking: exit 2, **24 diagnostics** across test imports,
  outdated retrieval and webhook APIs, generic database fixtures, PDF callback
  fixtures and a partial ambient XLSX declaration hiding the dependency's types.
- A broad diagnostic compilation emitted tests despite errors. Executing the
  resulting Node files directly registered **414 tests: 402 passed, 12 failed,
  0 cancelled/skipped/todo**, across 47 files. Two additional files failed to
  load because emitted imports still ended in `.ts`; ten file processes failed
  overall. This diagnostic compilation was only for reproducing the baseline.
- Vitest repository-index suite: **7 tests: 6 passed, 1 failed**, across six files.
  The failing webhook test called the current object-parameter API positionally.
- The existing `npm test` suppressed compilation failure, omitted multiple test
  files, and stopped before later suites when an earlier invocation failed.
  In this restricted environment, Node's isolated runner also reported some
  files as passing without individual test events. Per-file execution reproduced
  the actual registered test results above.

| Failure | Evidence and correction |
| --- | --- |
| Three retrieval tests | `74f1400` introduced `rankCandidates`, `embedQuery`, score normalization and zero-vector validation. `58a2faa` introduced the current database-backed `search` API; subsequent merged main retained that implementation and both sets of tests. Update tests to the current contract, with no service changes. |
| Retrieval package import and generic mock | Remove the `.ts` import suffix; explicitly implement the generic query mock and confine its row assertion to the mock DB boundary. |
| Runtime-context import | Remove the `.ts` suffix so emitted CommonJS resolves the emitted module. |
| XLSX fixture compilation | Remove the incomplete ambient XLSX module declaration; use the installed dependency's bundled types. |
| PDF fixture compilation | Model the parser's event overloads and actual PDF data shape rather than `unknown[]`. |
| Google routing expectation | Current search signals recognize URLs and explicit search terms, not video words; signals do not force fallback classification. Assert signal detection separately from fallback behavior. |
| Two model-intent expectations | Supply a mocked control-plane classifier for the intended `code-review` decision. The old test lacked a classifier and actually used the existing `code-generation` fallback for its `routing` cue. URL-only summaries are signals, not forced search decisions. |
| Policy metadata expectation | The fixture verifies every policy dimension; `metadataMissing` is correctly false. |
| Repository audit expectation | Restrict the no-Katie-specific-path check to generic repository discovery; unrelated Katie runtime context elsewhere in the route is legitimate. |
| Workbook output expectation | Preserve the existing used-range disclosure in expected extracted text. |
| Two FFmpeg tests and one Chromium test | Initial execution failed with sandbox process errors (`EPERM` and Chromium shutdown permission failure). They passed when local subprocess execution was allowed. No native test was skipped or weakened. |

The current retrieval contract is `new RetrievalService(db, embeddingProvider)`
and `search(queryText, limit = 10)`. It calls `embed(queryText)`, binds the text,
vector and limit, and returns database rows unchanged. SQL ranks by
`0.45 * keyword_score + 0.55 * vector_score` descending. The service neither
normalizes result scores nor rejects zero embeddings itself. Updated tests
cover these boundaries and propagation of embedding/database failures. They do
not claim to execute pgvector against a real database.

## Gate corrections

Compiler suppression was removed from the test scripts and `noEmitOnError` is
enabled. The full test config includes every TypeScript test and the required
ambient types. A shared runner discovers offline tests and validates execution
using actual test events and completion reports. It rejects failures, missing
files/reports, zero tests, skipped/todo/cancelled tests, early successful exits,
signals and timeouts. Vitest report validation also checks complete file and
assertion execution. Eight test-runner regressions exercise successful execution
and deliberate failure/incompletion cases. CI now includes full `typecheck`,
and workflows have bounded job timeouts.

Only test code, test tooling/configuration, type declarations, CI and documentation
changed. No production implementation, schema, runtime behavior or dependency
version changed. No deployment or merge was performed.

## Completed verification and remaining limitation

Checks used Node **22.23.3**, local placeholder service credentials and mocked
providers. `VERCEL_ENV=development` ensured the existing production Storage
postbuild probe was skipped.

| Check | Exact result |
| --- | --- |
| Full TypeScript check | Passed, exit 0, no diagnostics after corrections. |
| Full offline suite, first implementation run | Node: 428 tests registered, 427 passed, 1 failed, 0 cancelled/skipped/todo; Vitest: 7 passed, 0 failed, six files. The one failure was the model-intent fixture described below. |
| Corrected model-intent file, targeted rerun | 7 passed, 0 failed/cancelled/skipped/todo, exit 0; strict TypeScript compilation also passed. |
| Website suite | 150 passed, 0 failed/cancelled/skipped/todo, 13 files, exit 0; includes real local Chromium capture and FFmpeg decoding. |
| Required-review suite | 65 passed, 0 failed/cancelled/skipped/todo, five files, exit 0. |
| Video fallback suite | 10 passed, 0 failed/cancelled/skipped/todo, exit 0. RunPod and provider calls were mocked. |
| Production build | Passed, exit 0, including TypeScript/lint checking. Existing `module.createRequire failed parsing argument` webpack tracing warnings remain. Production Storage verification was explicitly skipped by the existing postbuild hook outside production. |
| Local production startup smoke | Passed, exit 0, HTTP 200 from `http://127.0.0.1:3100/`. |
| Legacy URL guard | Attempted, exit 1 because the sandbox rejected its `spawnSync /bin/sh` call with `EPERM`; no URL-rule failure was reported. Rerun with permitted local subprocess execution. |

The first full run failed one routing fixture that incorrectly assumed the
heuristic fallback would classify the prompt as `technical-debugging`. The
existing implementation returns `code-generation`; the corrected test now
supplies a mocked classifier and verifies the intended control-plane
`code-review` contract. That file's seven tests and compilation passed in a
targeted rerun. All other files passed in the first full run.

**The final full-suite rerun is still pending.** Automatic approval review
rejected its execution because a review usage limit was reached, not because
the action was determined unsafe. The requested command was not executed.
The planned additional compiler-error injection probe was part of that same
blocked command and also was not executed. Completed guard regressions already
verify assertion failures, missing/partial reports, no tests, skipped/todo,
cancelled tests, early exits, signals and timeouts.

No known failing assertion remains after the targeted correction, but there is
no green full-suite result for the final tree yet. A pull request has not been
opened because the assignment requires changes to be ready first. Rerun
`npm test` and the compiler rejection probe when local subprocess approval review
is available, then open the pull request for independent review. Do not merge
or deploy.

The separate legacy API-stack integration test was not run: no local
Postgres/Redis/GitHub-mock/Supabase stack was provisioned. Its exclusion from the
offline gate is explicit in the runner and testing documentation. It must not
use production resources to satisfy this work package.
