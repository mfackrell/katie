# Work Package 1: Restore a Trustworthy Testing Baseline

## Final status

The complete integrated CI gate passed: **456 tests across 57 files**, comprising
**449 Node tests in 51 files** and **7 Vitest tests in 6 files**. There were
**0 failed, cancelled, skipped or todo tests** and **no excluded test files**.
Strict TypeScript checking, the URL guard, production build and localhost smoke
also passed. Intentional compiler errors were rejected by the CI gate and every
TypeScript test command. The earlier execution-approval blocker is resolved.

Work remains on `codex/wp1-testing-baseline` for independent review. No merge
into main, deployment, production resource access or production credential
access was performed.

## Main integration and behavior preservation

The original work reviewed the architecture and repository hygiene documents at
`1d37a08609e6d7ad7e97a4adfbe1fe8d1f74a868`, then branched from main at
`e9e3c20239a056a85bd5f2c4900ba12877903734`.

For the continuation, main was
`84baaab4e70122cd5807c54ee06359efbac9bbf0`, **13 commits ahead** of that baseline.
The branch's GitHub head was `ec5f91b19dbb8fc324968a11cc67e62ad87bd62e`.
The shell's Git proxy remained unavailable; GitHub connector reads supplied the
commit metadata and files. The 13 main commits and branch head were reconstructed
and their hashes verified. Main's exact tree was verified as
`fdca8c08089fa86bcb8bd058ef5680357e1e90c5` before merging.

The branch was merged with main while preserving both histories. Conflicts occurred in `.gitignore`, `package.json`,
`tests/google-routing.test.ts` and `tests/policy-engine.test.ts`:

- Retained strict WP1 test commands, full typechecking and ignored test output.
- Retained main's expanded routing and policy tests, including its intentional
  URL-search fallback fix; corrected the overlapping model-intent test to that
  updated contract without changing runtime code.
- Added main's visual-review test to the focused website runner and preserved
  browser preparation before real-browser tests.
- Preserved all visual-review, website evidence, task progression, reviewer
  eligibility, timeout, API, schema and deployment-configuration changes from main.

Main advanced by two additional commits during validation. Before opening a
PR, those objective-first prompt changes and their new regression tests were
also incorporated from **`79d7e61cdc4ab10f16c0975af1014ce6e5237ff5`**. The exact
latest-main tree was verified as `5a6d9b02457b68bb5f8537f2c70fc2fb173750eb`.
The focused review runner retains the added objective-first tests. The complete
CI gate and focused suites were rerun against this newer version; results below
are for the final integration.

Production implementation, migrations, dependency versions and Vercel
configuration match that latest main exactly. The PR changes only test
fixtures, test tooling/configuration, type declarations, CI and documentation.
No runtime behavior was changed to satisfy tests.

## Pre-existing failures and corrections

On the original unchanged baseline, full TypeScript checking exited 2 with
**24 diagnostics**. Diagnostic emission followed by direct per-file Node
execution registered **414 tests: 402 passed, 12 failed**, plus two files that
failed to load because emitted imports still ended in `.ts`. Ten file processes
failed overall. Vitest registered **7 tests: 6 passed, 1 failed**.

| Defect | Evidence and correction |
| --- | --- |
| Three obsolete retrieval tests | `74f1400` introduced `rankCandidates`, `embedQuery`, normalization and application zero-vector validation. The subsequently merged `58a2faa` implementation uses `search`, `embed` and database ranking. Correct tests to the current contract; preserve the service. |
| TypeScript imports and generic DB fixture | Remove emitted `.ts` import suffixes; implement the query fixture's generic row contract at the mock boundary. |
| XLSX declaration and PDF fixtures | Use the installed XLSX types instead of the incomplete ambient declaration; model PDF callback overloads and the actual data shape. |
| Webhook signature fixture | Call the existing object-parameter API instead of the obsolete positional signature. |
| Routing and policy expectations | Original assertions lacked a control-plane classifier or misread verified metadata. Retain main's newer routing/policy corrections and expanded regressions; provide a mocked classifier where required. |
| Repository audit assertion | Limit the no-Katie-specific-path check to generic repository discovery; unrelated Katie runtime context in the same route is legitimate. |
| Workbook output assertion | Preserve the existing used-range disclosure in extracted text. |
| Native test execution | Initial FFmpeg and Chromium runs failed with sandbox process errors. Permitted local subprocess execution passed the real tests without skipping or weakening them. |

The current retrieval API is `new RetrievalService(db, embeddingProvider)` and
`search(queryText, limit = 10)`. It embeds the query, binds text/vector/limit, and
returns database rows unchanged. SQL ranks by
`0.45 * keyword_score + 0.55 * vector_score` descending. The service does not
normalize scores or reject zero vectors itself. Tests cover those boundaries and
propagation of embedding/database errors without claiming live pgvector coverage.

## Complete test execution

The runner discovers every test file under `tests/` and `packages/`, classifies
Node versus Vitest tests, and fails on unrecognized files. Strict compilation
uses `noEmitOnError: true` and freshly cleared output directories. Missing emitted
files, empty test files, missing/partial reports, assertion failures, early exits,
cancelled/skipped/todo tests, signals and timeouts fail the command. Vitest
completion validation checks every selected file and assertion; exclusive tests
are rejected. Eight runner regressions verify these failure modes.

The final inventory checked **all 56 test files on main**, including the newly
added `tests/visual-review.test.ts` and `tests/objective-first-prompts.test.ts` and every modified regression file. The full
gate executes those 56 files plus WP1's `tests/test-runner.test.mjs`.

The formerly excluded API startup test is now self-contained and part of the
full gate. It starts Next.js and mock persistence on ephemeral localhost ports,
requires HTTP 200 and exact response bodies for models/actors/chats, and confirms
actor/chat requests traverse the real persistence adapter. Its former
Postgres/Redis/GitHub environment checks did not actually test those services.
The fixture disables provider keys, uses dummy local credentials, and awaits
cleanup of its server process group. Production implementation is unchanged.

## Exact final verification

Executed with **Node 22.23.3**, localhost placeholder service configuration and
mocked providers. `VERCEL_ENV=development` ensured the existing production
Storage postbuild probe was skipped.

| Command/check | Result |
| --- | --- |
| `npm run ci:gate` on the final integrated code | **Exit 0**. Full typecheck, all tests, URL guard, production build and smoke completed in order. |
| Full suite within that gate | **449/449 Node tests**, 51 files; **7/7 Vitest tests**, 6 files. **456/456 total**, 57 files; no failures/cancellations/skips/todos/exclusions. |
| `npm run typecheck` within the gate | Exit 0, no TypeScript diagnostics. |
| `npm run check:url` within the gate | Exit 0: no legacy `url.parse` usage in tracked source files. |
| `npm run build` within the gate | Exit 0, including TypeScript/lint validation. Existing `module.createRequire failed parsing argument` webpack tracing warnings remain. |
| `npm run smoke` within the gate | Exit 0: HTTP **200** from `http://127.0.0.1:3100/`. |
| `npm run test:website` | **159/159 passed**, 14 files, exit 0; includes real local Chromium capture and FFmpeg decoding. |
| `npm run test:review` | **73/73 passed**, 6 files, exit 0. |
| `npm run test:video-fallback` | **10/10 passed**, 1 file, exit 0; RunPod and provider calls mocked. |
| `npm run test:integration` | **1/1 passed**, exit 0; also passed within the final full suite. |
| Main test inventory | All 56 main test files included; no exclusions. |
| Production behavior preservation | No diff against integrated main in production implementation, migrations, dependency versions or Vercel configuration. |

The complete final suite was run after the integration fixture and all
code/test corrections. Targeted passes were not used as a substitute for that
full run.

### Intentional compiler-failure verification

Temporarily appended `const wp1CompilerErrorProbe: string = 123;` to an existing
included test fixture, then restored its original bytes in a `finally` block.
Each command reported **TS2322** and stopped before test execution:

| Command with injected error | Exit |
| --- | --- |
| `npm run ci:gate` | **2** |
| `npm test` | **1** |
| `npm run test:website` | **1** |
| `npm run test:review` | **1** |
| `npm run test:video-fallback` | **1** |

For every test command, the old emitted test file was absent after rejection:
compilation errors could not be hidden by stale JavaScript. No injected error
remains. The fixture was restored byte-for-byte to the version used by the
complete passing gate, and strict TypeScript checking passed again afterward.

## Remaining limitations

There are **no remaining test failures or execution-approval blockers**.
The pre-existing webpack tracing warnings remain visible. Tests use mock/local
dependencies and do not validate live provider APIs, real Postgres/Redis,
pgvector, production Storage, migrations or RLS. No production validation was
attempted. GitHub-hosted CI will independently rerun the checks on the draft PR.
