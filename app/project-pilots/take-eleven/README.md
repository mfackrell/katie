# Take Eleven — original v1

Local two-human game at `/project-pilots/take-eleven`. The authoritative source is AGENT_REQUEST.md. `contract.mjs` records the rules and executable model/browser acceptance scenarios. `engine.ts` contains only deterministic rules; `persistence.ts` owns validated, game-specific localStorage access; `page.tsx` supplies the accessible UI. No network, account, bot or shared server state is used.

Implementation plan delivered: inspect existing pilot and game contract; define rules and acceptance; implement pure engine; add local persistence and UI; execute regression tests and production build; attempt registered browser acceptance; hand off to the existing independent workflow.

Run deterministic and storage tests:

```sh
node tests/game-development/take-eleven.test.mjs
```

Run the registered real Chromium scenarios against a built local route:

```sh
npm run build
TAKE_ELEVEN_BROWSER_ACCEPTANCE=1 node tests/game-development/take-eleven.test.mjs
```

For an already running local server, set `TAKE_ELEVEN_TEST_ORIGIN=http://127.0.0.1:PORT`. Browser scenarios use the existing restricted browser harness. They verify progress reload, A/B victory reload, reset reload, state display and disabled illegal controls.

Validation: three deterministic/persistence tests passed, exhaustive reachable-state exploration passed, existing Signal Sprint's seven regression tests passed, and the production build passed including lint/type validation. Browser acceptance was attempted but blocked: this sandbox denies listening on 127.0.0.1:31948 with `listen EPERM`. No browser proof or private Preview is claimed. See `evidence/` for actual logs, source SHA-256 hashes and base commit.

The implementation is recorded at commit `c07c3fc1eb1de611dfd17806696e967f71c4ff7e`. Independent tests/review, approval gates and private Preview publication remain owned by that workflow. No deployment, merge, push, PR creation, production access or orchestration changes were performed. Token/cost/backend model telemetry is unavailable and is recorded as unavailable rather than estimated.

Repair verification: the local production build and all three deterministic/persistence tests passed again. The registered browser test was retried but the server exited before Chromium execution; a direct server attempt confirmed `listen EPERM 127.0.0.1:31948`. New `evidence/repair-*.log` files preserve this attempt separately from the original logs. No gameplay changes were warranted. Browser proof, immutable private Preview acceptance, and final independent review remain blocked; no deployment is authorized in this repair.
