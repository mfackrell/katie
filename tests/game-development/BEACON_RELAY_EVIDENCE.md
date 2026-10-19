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

No private Preview or immutable committed patch SHA exists in this implementation workspace. Base HEAD was `016f65251815d583de26e259d2f39f4b81c1856a`; this is **not** the tested patch SHA. `beacon-relay.source-sha256` binds the tested source files. The owning workflow must commit, independently test/review, and produce the draft PR and immutable tested SHA. No commit, push, merge, deployment or production access was performed here. A passing model/build is not a completed live validation.

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
