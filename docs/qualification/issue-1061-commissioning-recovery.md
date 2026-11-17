# Issue 1061 — commissioning recovery engineering evidence

Assignment: [EPD v3 directive](https://github.com/mfackrell/katie/issues/1061#issuecomment-6923133961), [continued offline correction](https://github.com/mfackrell/katie/issues/1061#issuecomment-6923486239), and [single-read authorization](https://github.com/mfackrell/katie/issues/1061#issuecomment-6923564866).

## Historical finding and retrieval limitation

The rejected Delivery Manager assignment `53bc4f6b-a74e-4ce0-9ddd-3538f83be3b3` has no saved decision. The SQL transaction rolled back its insertion and retained only the combined SMART predicate error. The subsequent Functional Director decision `112a2d83-cd05-47c0-ba82-87d458781782` was exactly `[{"action":"ready"}]`; its owned exception remained open while all management scheduling flags were cleared. These are separate confirmed defects. There is no evidence that SMART enforcement itself rejected a valid contract.

The one authorized authenticated GET of completed OpenAI response `resp_0b21d6e7fccc965c016afb3518052487d2b13ae494e5e2b71c` executed once and returned **HTTP 404, invalid_request_error, response not found**. [Execution receipt](https://github.com/mfackrell/katie/issues/1061#issuecomment-6923650984). No retry, regeneration, inference or replay occurred. The credential was not logged or saved in plaintext; temporary transfer material was removed. **The exact historical rejected SMART field remains UNVERIFIED.** Synthetic test cases below do not reconstruct that missing response.

## Correction

- Diagnostic preflight identifies bounded structural field paths and hashes the proposed command batch. The existing terminal failure writer retains those diagnostics for the next management turn. Raw model prose is not archived. Known definitive SQL SMART rejections are classified; unknown/transport outcomes are not represented as safe rejections or retried.
- Runtime and lease-bound SQL reject ready-only batches with an owned open exception. Substantive corrections, authenticated resolutions and escalation still use existing admission.
- The scheduler first runs its unchanged predecessor. Only its specific commissioning-wait state is eligible for recovery: running development project, valid lease/window, no active mission, active management owner with no scheduling flag, latest assignment and mission completed, saved decision exclusively ready, and an open exception predating that decision. It then requests one normal management turn. A newer assignment supersedes the old ready evidence. Existing failure counts, dependency checks, mission cap, continuation/release membership and provider fences remain authoritative.
- Migration installation changes no historical rows. Original scheduler and decision bodies remain byte-identical beneath the wrappers. SMART SQL, owner renewal/resume functions, scope grants, QA boundaries, project identity, mission/token limits and deadline are not rewritten. Public/authenticated callers cannot invoke wrappers or predecessors; only the existing service boundary can invoke the guarded wrappers.

## Reproduce without live services

Use Node 22, installed lockfile dependencies, native PostgreSQL 16 or later, a C compiler and Chromium prerequisites. All model outputs are fixtures; PostgreSQL is disposable. Never run these fixture setup statements against production.

```sh
node --test tests/management-commissioning-diagnostics.test.mjs tests/project-organization-runtime.test.mjs tests/management-context.test.mjs
npm run typecheck
KATIE_TEST_PG_BIN=/path/to/postgresql/bin node --test --test-concurrency=1 tests/organizational-contract-amendments-postgres.test.mjs tests/owner-management-activation-postgres.test.mjs tests/project-organization-integration.test.mjs
```

Use `KATIE_TEST_PG_TCP=1` where local Unix sockets are unavailable. Owner-control tests freeze their disposable environment's clock; they do not extend production authority. Run PostgreSQL suites sequentially because they share a fixture port.

Fail-before reproduction: check out baseline `acf85ca0da68621f263197f8397a116337215f7c` in a separate worktree, copy only `tests/management-commissioning-diagnostics.test.mjs` from this candidate, provide the unchanged lockfile dependencies, then run:

```sh
node --test --test-name-pattern='malformed SMART response|ready-only decision|definitive SQL SMART' tests/management-commissioning-diagnostics.test.mjs
```

All three selected tests fail on that baseline. The complete focused candidate suite passes 36 tests. TypeScript passes. Native evidence includes:

- Actual predecessor reproduces the stranded ready/open-exception wait; corrected scheduler admits exactly one management mission, preserves historical rows and contracts, and rolls back atomically.
- Replay, null/stale lease, paused/expired project, resolved/later exception, latest failed assignment, mission limit, and public/authenticated/predecessor ACL negatives.
- Four unchanged SQL structural rejections (parent objective, estimate uncertainty, inventory context size, assignment limit), matching exact runtime field paths, lease-bound durable failure records and hashes, then one valid bounded package admitted with no worker dispatch.
- Repeated invalid dependency and ready-only model responses each stop within **seven additional fixture missions**, without replacing leaders or resetting failure counts.
- Existing scope/continuation/replay/release controls, QA isolation and owner renewal/resume regressions, including the native mobile browser → HTTP → authenticated API → PostgreSQL flow and 13 preserved contract identities.

The pre-publication logs in `issue-1061-evidence/` record actual local execution on Node 22.23.5 / PostgreSQL 18.6. The source manifest binds implementation and test contents. The exact published candidate SHA and hosted checks are recorded on the PR/issue; independently qualify that SHA, not an earlier local commit. The hierarchy workflow also runs native PostgreSQL 16 and uploads owner-browser/database evidence for its exact checked-out source.

## Acceptance boundary

Engineering qualification is not independent QA or live project acceptance. The historical field remains unavailable. No production mutation, migration application, deployment, live inference, replay, worker dispatch or manual game coding was performed. The original project `fe9d2658-41e3-44c1-ae8e-a0cba98371fe`, 96-mission limit, 600000-token allowance, approved scope and **2026-11-16 18:00:00Z cutoff** remain unchanged. The correction does not reactivate a paused or expired project. Separate QA and authorized release/live acceptance remain required; an autonomous coding package and worker are not claimed.
