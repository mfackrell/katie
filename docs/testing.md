# Testing

Use Node 22 and install the locked dependencies with `npm ci`.

```bash
npm run typecheck
npm test
npm run test:website
npm run test:review
npm run test:video-fallback
npm run test:vitest
```

`npm test` discovers test files under `tests/` and `packages/`. TypeScript tests
are compiled with `noEmitOnError: true` into a freshly cleared `.test-dist`.
Every discovered offline test is classified as Node or Vitest; an unrecognized
test file fails the gate. This includes the retrieval package tests and the
previously omitted upload, routing, security and repository tests.

Each Node file runs in its own process with a completion reporter. A file must
register and finish at least one test, exit successfully, and report all tests
passed. Failed, cancelled, skipped and todo tests, missing reports, missing
emitted files, early successful exits, signals and 180-second process timeouts
fail the command. The runner continues through other files to report additional
failures, then exits nonzero. Vitest's JSON report must contain every selected
file and only passed assertions; exclusive tests are rejected.

The focused website and review suites clear `.website-test-dist` before strict
compilation. The video fallback suite clears `.test-dist`. Do not run commands
sharing one output directory concurrently.

The local Chromium and FFmpeg regressions require permission to spawn subprocesses.
They use local test fixtures and must pass rather than being skipped when their
native dependencies are unavailable. Provider and persistence tests use mocks;
live production resources are not needed.

The separate legacy `tests/integration/api-stack.test.mjs` is explicitly excluded
from the offline gate and printed as excluded. It requires `DATABASE_URL`,
`REDIS_URL`, a local GitHub API mock at `http://127.0.0.1:9090`, and a local
Supabase setup capable of serving the application endpoints. Run it only with
that local stack configured:

```bash
node tests/integration/api-stack.test.mjs
```

This integration test is not covered by an existing CI service-stack job. Its
requirements must not be replaced with production credentials.

```bash
npm run ci:gate
```

The CI gate runs full TypeScript checking, all offline Node and Vitest tests,
the legacy URL guard, the production build and a localhost startup smoke check.
GitHub Actions also runs the focused review, website and video fallback suites.
Job timeouts prevent incomplete execution from remaining indefinitely pending.

For local build verification use placeholder Supabase credentials and ensure
`VERCEL_ENV` is not `production`: the existing `postbuild` hook writes a real
Storage probe when invoked in a production Vercel environment. The localhost
smoke check does not deploy the application.

See [Work Package 1 results](work-package-1-testing-baseline.md) for the baseline
failures, contract evidence, corrections, exact completed checks and remaining
verification limitation.
