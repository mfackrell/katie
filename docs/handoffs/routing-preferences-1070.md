# Routing preferences handoff — #1070

Base checkout: `e8321fda6100c6d23f0445877b8b1f425771b244`. Changes are uncommitted for the orchestration workflow to commit, test and review. No fetch, push, PR publication, deployment, production access or database migration was performed. The workflow must supply the final commit/tree and PR link; the assignment did not supply a separate subordinate issue number.

## Integration contract

`resolveRoutingPreferences(request: Pick<Request, 'headers'>, scope?: {actorId: string; chatId: string}): Promise<RoutingPreferences>` is exported from `lib/routing-preferences/server.ts`.

Result: `{global: RoutingMode, conversation: RoutingMode | null, effective: RoutingMode}`; `RoutingMode = 'best_answer' | 'best_value'`. Resolution is conversation override, then global, then `best_value`. Missing rows need no backfill. Passing no scope reads only the verified user's global preference. Never import the server module into a client component.

The Routing Engineer must call the resolver from the chat entry point **after existing authentication, actor/chat ownership and spending authorization**, and apply `effective` only to automatic selection. Explicit `overrideProvider` / `overrideModel` retain priority. Resolver failure is explicit, rather than silently choosing a potentially more expensive mode. The resolver does not grant budget, enroll scopes, select models, or bypass any ledger/approval checks. It uses the established `authorizeStandaloneCaller` ownership check, including that helper's audited legacy scope recovery. Anonymous sessions cannot persist preferences; integration should preserve their existing authorized chat behavior and default mode without treating a denied preference lookup as spending authorization. Executive/managed scopes without standalone authorization are denied, rather than inventing authority.

`components/chat-panel.tsx` sends `routing_mode` only with a successfully loaded preference and no manual model override. This is a hint; resolve durable preferences server-side so stale tabs and forged payloads cannot override stored scope. The existing chat handler currently ignores this additional field. This branch deliberately does not modify `lib/router/*` or `app/api/chat/route.ts`; routing behavior changes require the separate integration.

## REST and UI

- `GET /api/routing-preferences?actorId=<uuid>&chatId=<uuid>` returns the result above.
- `PATCH /api/routing-preferences` accepts exactly `{actorId, chatId, target: 'global' | 'conversation', mode: RoutingMode | null}`. Null clears a conversation override; null global is invalid.
- Both operations verify the session using the existing bearer/HttpOnly-cookie mechanism, reject anonymous sessions, and verify actor/chat scope. No caller-supplied owner identifier is accepted. Responses use `Cache-Control: no-store`; errors are 400 / 403 / 503 without database details.
- One automatic-routing dropdown contains exactly Best Answer / Best Value. A separate scope selector chooses conversation or global default. Clearing a conversation override restores inheritance. Manual model selectors are unchanged. Errors retain the last confirmed selection and offer reload; controls disable during requests. Conversation changes discard stale responses. Per-scope atomic upserts preserve other scopes; same-key writes use database commit order (last committed write wins).

## Migration and rollback

Apply `supabase/migrations/20261117140000_routing_preferences.sql` through the established migration workflow before enabling the preference API. It adds only `user_routing_preferences` and `conversation_routing_preferences`. Both have RLS enabled, no browser policies, explicit revocation from public/anon/authenticated and service-role grants. The API performs ownership checks before service-role queries; filters always include verified owner and the full actor/chat scope. Cost, approval, model registry and existing chat/actor tables are untouched.

Rollback application code first. Optional schema rollback: drop `public.conversation_routing_preferences`, then `public.user_routing_preferences`. This deletes only the new preferences and restores default Best Value; no existing data needs restoration. Clearing an override stores null, permitting atomic concurrent upserts without delete/reinsert races. User/actor/chat deletion cascades cleanup.

## Validation

Passed locally:

- `npm run build` (production compilation and page generation passed; production Storage smoke explicitly skipped outside production).
- Targeted Next lint for changed UI/API files, no warnings or errors.
- `npm run typecheck`
- `npx tsc -p tsconfig.tests.json`
- Preference regression file: 10 tests including parent, all passed (default, persistence/reload, override switch/clear, independent conversations, concurrent writes, invalid/spoofed input, unauthenticated/anonymous/other-user/other-actor denial, storage failure, grants and manual payload preservation).
- Existing `actors-route` tests: 4 passed.
- Existing `chat-recovery` tests: 7 passed.
- `git diff --check`.

Compiled tests use the repository's normal `.test-dist/node_modules/@ -> ..` alias. They can be run directly with `node --test --experimental-test-isolation=none .test-dist/tests/routing-preferences.test.js`.

The full `npm test` runner was attempted and stopped after sandbox `spawnSync ... EPERM` failures. `npm run check:url` likewise cannot spawn its shell subprocess here. The standalone browser acceptance harness `node --test --experimental-test-isolation=none tests/routing-preferences-browser.test.mjs` bundles the actual component and mocks only HTTP; it exercises desktop 1280px/mobile 390px, exact option labels, global persistence after reload, conversation isolation, override clear, and overflow. Chromium launch is blocked here (`sandbox_host_linux.cc: Operation not permitted`), so no browser pass or screenshots are claimed. This test now lives under `tests/` with the `.test.mjs` suffix, so the existing `npm test` discovery includes it in `ci:gate`. Database grant assertions are static; live RLS qualification still requires an isolated migrated test database. Independent review and cross-branch routing QA remain the orchestration/Director workflow's responsibility.


## Repair verification

The accounting browser fixture now handles the authenticated, actor/chat-bound preference GET with the default Best Value response. Its unexpected-route assertion remains intact. The preference browser test was moved into normal test discovery without changing its assertions or the runner.

Repair checks passed: test TypeScript compilation, all 10 preference regression tests (zero skipped), JavaScript syntax checks for both browser files, and `git diff --check`.

Repair attempts: both browser tests are blocked locally by sandbox restrictions (Chromium `sandbox_host_linux.cc` operation denied; localhost `listen EPERM`). `KATIE_TEST_PG_BIN=/usr/lib/postgresql/16/bin npm run ci:gate` passed typecheck but encountered sandbox `spawnSync ... EPERM` errors in the test runner. A passing browser run and full gate remain unresolved; they require a runner that permits browser launch, local sockets and child processes. No tests were skipped or weakened to bypass these restrictions.
