# Testing

## Run all tests
```bash
npm test
```

This command runs:
1. URL guard test (`tests/url-api.test.mjs`) directly with Node test runner.
2. TypeScript test compilation via `tsconfig.tests.json`.
3. Compiled Node tests in `.test-dist/tests/*`.

## Release/CI gate (required)
```bash
npm run ci:gate
```

This gate enforces:
1. `npm test`
2. `npm run check:url`
3. `npm run build`
4. `npm run smoke` (boots built app and validates startup response)

## Run targeted tests
Examples:
```bash
node --test tests/url-api.test.mjs

rm -rf .test-dist
npx tsc -p tsconfig.tests.json
node --test .test-dist/tests/persistence-store.test.js
node --test .test-dist/tests/policy-engine.test.js
```

## High-level coverage
- Persistence module behavior (`tests/persistence-store.test.ts`).
- Routing and policy behavior (`tests/google-routing.test.ts`, `tests/policy-engine.test.ts`, `tests/chat-video-routing.test.ts`).
- UI/state utility logic (`tests/chat-panel-guard.test.ts`, `tests/reasoning-*.test.ts`).
- API route behavior (`tests/actors-route.test.ts`).
- Inflight guards and starter chat idempotency.

## Obvious coverage gaps
- No end-to-end browser test suite in-repo.
- Provider integrations rely mostly on unit-level behavior; live provider integration tests are not present.


## CI suites
- `npm run test:vitest` runs the lightweight CI smoke suite for the vitest stage.
- `npm run test:integration` runs API startup checks with Postgres + Redis env wiring and mocked GitHub base URL.

## Collaboration timeout and strategy regressions

`tests/collaboration.test.ts` covers:
- 130-second research followed by 30-second critique bypasses a short lead-control pass and preserves both contributions, CSS and screenshot bytes.
- Lead-control timeout replaces only the lead; retrieval and independent critique run once.
- Final synthesis leaves 45 seconds for a replacement when at least 90 seconds remain. A synthesis attempt with less than its minimum window yields to request-local checkpoint recovery.
- Outer provider-error/refusal reroutes resume synthesis from the checkpoint, preserving completed work and delegation metadata. Checkpoints are scoped to a request ID and do not cross user turns.
- Structured conflict reconciliation distinguishes strategic objectives from evidence disputes and passes resolutions to final synthesis. Helpers, control and final synthesis receive explicit strategy-preservation and evidence-quality rules.

The full suite currently has nine unrelated failures in model-intent routing, long-term-memory editing and policy-engine tests, reproduced on the unchanged `52b8b6d` baseline. This change also corrects an existing collaboration metadata test failure: failed helpers are no longer listed as completed contributors. Targeted collaboration/website tests and the production build must still pass.
