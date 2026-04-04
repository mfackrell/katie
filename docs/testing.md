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
