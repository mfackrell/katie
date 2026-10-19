# Beacon Relay Duel v1 — implementation evidence

Source: `AGENT_REQUEST.md`, managed task `f8d12c82-3070-43e1-9846-45599098cccd`, definition 3, original user-approved design. Rules were recorded before implementation in `beacon-relay.rules.json` using `lib/game-development/GAME_CONTRACT.md`. No unresolved gameplay questions. No randomness, hidden information, AI, network game services, or external assets.

Artifact: `/project-pilots/beacon-relay`. Two humans share the browser. Move to an empty orthogonal neighbor, then End Turn; landing on 5 or 10 scores one point during resolution. First to two wins. Reset restores the full initial game. The namespaced versioned save includes positions, scores, active player, turn, phase, and winner. Storage failure falls back to memory and displays a message. Hydration finishes before controls accept input; accepted actions save synchronously to prevent losing RESOLVE on immediate navigation. Shared application code is unchanged.

## Executed checks (2026-10-19)

- Five `node:test` tests passed, zero failed/skipped/todo. Tests transpile and import the actual production `engine.ts`, not a duplicate engine. The exact-state contract model receipt passes and correctly reports `browserChecks=NOT_RUN`, `readyToRelease=false`.
- Exhaustive movement test checks both players, every pair of distinct board positions, and valid/invalid destinations, including row wrapping, collision, nonintegers and out-of-range inputs. Frozen inputs detect mutation. Scoring checks both actors at all 16 cells for scores 0 and 1. Complete alternating playthroughs reach Red and Blue victory.
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`: passed.
- `node node_modules/next/dist/bin/next build`: passed, including lint/type checks, static page generation and build tracing. Route output: static `/project-pilots/beacon-relay`, 2.42 kB / 108 kB first load. Invoked Next directly to avoid unrelated `postbuild` production smoke activity.
- Existing test reporter invoked directly (command below). The shared `runNodeFile` launcher itself encountered `spawnSync ... EPERM`; its direct reporter successfully executed every focused test. No runner modifications.

## Browser infrastructure blocker — live validation incomplete

The existing `scripts/project-browser-engine.mjs` harness is used by `beacon-relay.browser.mjs`. The committed browser contract validates under the existing harness's 100-step limit. It covers initial selectors, invalid movement, MOVE End Turn no-op, RESOLVE movement lock, full-page RESOLVE reload, alternation, both beacon scores, Red victory, terminal freeze, reset and reset reload.

The actual built server was attempted with `next start --hostname 127.0.0.1 --port 3100` and failed: `listen EPERM: operation not permitted 127.0.0.1:3100`. Bundled Chromium extracted successfully, but the real harness launch also failed with `FATAL:content/browser/sandbox_host_linux.cc:41 ... shutdown: Operation not permitted (1)` / SIGTRAP. No browser interaction or rendered assertion executed. This is a sandbox infrastructure failure, not evidence of a gameplay defect. No environment, permissions, orchestration or server configuration was changed to work around it. The platform test stage must run the supplied browser check in its authorized environment.

The initial implementation workspace had no immutable committed patch SHA; its base was `016f65251815d583de26e259d2f39f4b81c1856a` (not the tested patch). The repair checkout now contains immutable commit `3e113ed70dd737b2a32c6e10e406b2657568d487`. The local repair verification below tested that commit's unchanged game source and acceptance files. `beacon-relay.source-sha256` also binds those files. No private Preview was tested. Draft PR delivery and Preview verification remain with the owning workflow. No commit, push, merge, deployment or production access was performed here. A passing model/build is not a completed live validation.

## Repair verification (2026-10-19)

Classification: TOOL/TEST INFRASTRUCTURE. The supplied CI log completed successfully; the independent review identified missing executed browser evidence, not a proven gameplay defect. No gameplay or test changes were warranted.

Tested commit: `3e113ed70dd737b2a32c6e10e406b2657568d487`. All seven entries in `beacon-relay.source-sha256` matched before verification. Only this evidence document was updated afterward.

- Focused reporter command in Reproduce: **5 passed**, zero failed, cancelled, skipped or todo.
- `node node_modules/next/dist/bin/next build`: **passed**, including lint/type validation and static generation of `/project-pilots/beacon-relay`.
- Built server command in Reproduce: **blocked**, exit 1, `listen EPERM: operation not permitted 127.0.0.1:3100`.
- `BEACON_RELAY_ORIGIN=http://127.0.0.1:3100 node tests/game-development/beacon-relay.browser.mjs`: **blocked**, exit 1 before page creation. Packaged Chromium failed at `content/browser/sandbox_host_linux.cc:41`, `shutdown: Operation not permitted (1)`, then SIGTRAP. **Zero browser interactions or rendered assertions executed.**

The blocking finding remains unresolved. The platform owner must run the existing browser command against this immutable source in an authorized environment that permits the local server and Chromium, and retain its receipt. Required movement, scoring, RESOLVE reload, victory freeze and reset persistence browser results are still NOT_RUN; model/build success does not substitute for them. Shared infrastructure, permissions and runners were not changed.

## Rule traceability

All rule IDs cite `user-design`, the explicit edition in the rules JSON; all reference invariant `state-integrity`.

| Rule | Executed model/regression evidence | Browser contract (not executed) |
| --- | --- | --- |
| setup | exact initial snapshots, fresh-state isolation | initial/reset selectors |
| move | exhaustive destinations and frozen states | invalid selections and legal moves |
| resolve | exact phase snapshots, all RESOLVE tile clicks ignored | extra click no-op, RESOLVE reload |
| score | both actors, every cell, prior scores 0/1 | Red on 5 and Blue on 10 |
| alternate | exact snapshots, both victory playthroughs | active-player changes |
| victory | terminal freeze, Red and Blue win | Red winner/phase, frozen turn |
| reset | every intermediate Blue state and terminal states reset | full initial snapshot and reload |
| persist | complete-state encode/decode and corrupt-save rejection | full-page RESOLVE and reset reload |
| ui | contract schema and production build/typecheck | exact visible fields and actual button input |

## Reproduce

From the repository root:

```sh
NODE_TEST_CONTEXT= KATIE_TEST_REPORT_PATH=/tmp/beacon-model-report.json node --experimental-test-isolation=none --test-reporter=./scripts/test-reporter.mjs tests/game-development/beacon-relay.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/next/dist/bin/next build
node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3100
```

With the built server running, in a second terminal:

```sh
BEACON_RELAY_ORIGIN=http://127.0.0.1:3100 node tests/game-development/beacon-relay.browser.mjs
```

The browser runner accepts only a local origin, isolates storage per scenario and blocks external requests. It fails visibly if Chromium or rendered assertions fail; it does not mark missing browser runs as passed.

## Executed CI browser acceptance — 2026-10-19

- GitHub Actions run: https://github.com/mfackrell/katie/actions/runs/39277120001 (workflow_dispatch, completed SUCCESS).
- Browser acceptance job ID: 118144312635, completed SUCCESS; runner checked out and asserted exact game source commit `9eea65541e96ced56106c85d9f9d48aad53b9382`.
- Executed actual Chromium browser harness `BEACON_RELAY_ORIGIN=http://127.0.0.1:3100 node tests/game-development/beacon-relay.browser.mjs` against a built local Next.js route.
- Browser receipt in job logs: `browserChecks` with `passed: true` and `71 rendered application assertion(s) passed`.
- Evidence artifact: `beacon-phase3-browser-evidence` (artifact ID 12199470092), preserving tested SHA, browser receipt, and server log.
- Vercel Preview for same game source commit is READY: `https://katie-m7wqmskwv-mark-fackrells-projects.vercel.app/project-pilots/beacon-relay`.
- This acceptance execution resolves the earlier zero-browser-interaction blocker. Independent review of evidence and PR #559 remains required before labeling specialist Phase 3 finalized. No production merge or deployment requested.
