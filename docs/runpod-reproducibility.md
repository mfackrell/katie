# RunPod results reproduction

These artifacts represent the deployment evidence supplied in AGENT_REQUEST.md:
35 columns, nine constraints, six indexes, RLS enabled with no policies, and
service-role access; webhook version 2 with JWT verification disabled. No live
project was queried. The snapshot fixture is evidence, not a live drift assertion.

## Architecture and compatibility

`lib/runpod/durable-results.ts` defines all 35 fields, stores only the private
attachment path, creates the receipt/proof hash before submission, and conditionally
registers the provider job. `video-orchestration.ts` uses the correlation and fallback
columns for Grok leases and actor-scoped delivery. The reconciliation route polls
active jobs, enforces the existing Qwen deadline, and schedules delivery through
`video-delivery-reconciliation.ts`. Those application files are unchanged.

The webhook is the supplied deployed source, with only module scoping and a local
Deno type declaration added for repository TypeScript checks. It preserves existing
error codes, response statuses, timeouts, output projection and terminal mappings.
A valid terminal replay acknowledges success without writing; a wrong proof or
provider ID still fails before the terminal shortcut. A concurrent completion is
protected by the PATCH active-state predicate. Do not change retries to return an
error, consume proofs, add `rejected` to the DB status constraint, or substitute the
application polling output sanitizer without a separate compatibility review.

The webhook discards the original payload input and unknown output fields. It
retains the deployed model/choices/usage projection verbatim; it does not scan
model-generated content or usage for URLs. It never logs or stores the original
signed video input. Existing Gemini/Qwen/Grok sequencing, uploads, routing and actor
checks are unchanged.

## Disposable database verification

Install PostgreSQL 16 server binaries and run as a non-root user in an environment
with local server binaries available:

```sh
node --experimental-test-isolation=none tests/runpod-schema.test.mjs
node --experimental-test-isolation=none tests/runpod-webhook.test.mjs
npm run ci:gate
```

Set `KATIE_TEST_PG_BIN` if server binaries are outside
`/usr/lib/postgresql/16/bin`. The schema test creates and destroys its own cluster;
it ignores `DATABASE_URL` and runs the real PostgreSQL standalone backend with
no network or socket listeners. SQL is supplied through a temporary file descriptor. It requires no Supabase bootstrap, auth service, live
credentials or provider calls. Minimal prerequisites are `public.actors(id uuid
primary key)`, `public.chats(id uuid primary key)`, PostgreSQL's `gen_random_uuid()`
and roles `anon`, `authenticated`, `service_role` (the last with BYPASSRLS).
The test also simulates client default privileges so migration grants are explicit.
These stub tables are only for this isolated contract test, not application bootstrap.

The test applies `202610130001_video_analysis_jobs.sql`, compares catalog output to
`tests/fixtures/runpod-deployed-schema.json`, checks service/client permissions,
status/content/ID/path constraints, uniqueness, FK rejection and ON DELETE SET NULL,
then reruns twice and checks that rows and catalogs remain unchanged. It also checks
that an existing divergent table is untouched. Missing binaries or failed assertions
are failures, not skipped acceptance checks.

The migration creates objects atomically only when the table is absent. It does
not alter or repair an existing installation, including its grants or policies.
Historical migrations and checksum validation remain unchanged. A fresh application
installation still needs the existing application schema; this isolated test proves
only the RunPod table contract after the documented prerequisites.

## Reproduction and drift review checklist

1. Run the disposable tests above. Compare every column (type, nullability, default),
   constraint definition, index definition and RLS/policy setting against the fixture.
2. For an independently authorized target comparison, obtain read-only catalog
   output using the catalog queries in `tests/runpod-schema.test.mjs` (excluding its
   disposable bootstrap and write assertions). Compare named
   constraints/indexes and all columns, not merely object existence. Check role ACLs
   and default privileges separately. Deployment evidence specified service-role
   grants but did not enumerate the complete live ACL; exact live ACL parity remains
   a review item. No source-controlled test contacts that target.
3. Treat any drift as a blocker. This append-only migration intentionally leaves
   existing tables unchanged; it must not silently repair an incompatible schema.
4. Confirm the deployment's webhook entrypoint matches the source and that its
   function configuration has `verify_jwt=false`. The receipt UUID and 64-hex proof
   are mandatory; the proof's SHA-256 must match the registered receipt hash.
5. Confirm service-role environment configuration in the intended isolated project.
   The function accepts `SUPABASE_SERVICE_ROLE_KEY`, or the `default` field of
   `SUPABASE_SECRET_KEYS`, alongside `SUPABASE_URL`. Never put keys in source.
6. Run webhook regressions with provider/storage mocks; check no original input,
   callback credentials or signed source URL is persisted, returned or logged.

## Deployment instructions for a later authorized operator

No deployment is part of this work. After independent compatibility approval, use
the normal checksum-enforcing migration process for the intended environment.
Do not edit an already-applied migration or bypass its ledger. Supabase CLI deployment
uses the committed function configuration:

```sh
supabase functions deploy katie-runpod-result-webhook --project-ref <approved-project-ref> --no-verify-jwt
```

Do not run this command from tests or CI. JWT verification must be off because
RunPod authenticates through the per-receipt proof rather than a Supabase JWT.
The current application callback URL is hardcoded to the existing project in
`durable-results.ts`; a different project's end-to-end application wiring is outside
this schema/source reproduction change and requires separate review. This source
export alone does not claim cross-project application portability.

## Verification in the implementation sandbox

- Full `npm run typecheck`: passed.
- Offline webhook tests: passed (eight tests).
- Disposable Postgres test: passed against PostgreSQL 16.15 using the standalone
  backend. Catalog comparison, constraints, permissions, RLS, FK behavior and
  idempotent reruns all passed. The original socket-based approach was denied by
  the sandbox; standalone mode removes that dependency.
- Existing RunPod fallback tests: 10 passed; delivery reconciliation tests: 6 passed
  when run directly from the emitted test files.
- Full CI gate: failed in the existing test runner (55 failed files/suites), which
  reported sandbox `EPERM` child-process failures even for processes returning exit
  zero. The chained URL/build/smoke stages did not run. A separate URL check also
  failed on `spawnSync /bin/sh EPERM`. Full acceptance requires a successful
  independent gate in the orchestration environment.
- Separate production build: passed, including lint/type validation and the
  non-production postbuild check (real Storage verification correctly skipped).
- Separate runtime smoke: blocked by `listen EPERM` on local port 3100;
  `next start` exited with code 1 before readiness.
- Deno/Supabase deployment execution, live drift comparison, independent reviewer
  approval and draft PR creation: not performed in this implementation workspace.
  The orchestration workflow owns commit, independent test, review and repair.
