import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const enginePath = resolve("app/project-pilots/signal-sprint/engine.ts");
const source = readFileSync(enginePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports }, { filename: enginePath });
const { transition, initialState } = exports;
const normalize = value => JSON.parse(JSON.stringify(value));
const initial = () => normalize(initialState);
const apply = (state, type) => transition(state, { type });
const assertState = (actual, expected) => assert.deepEqual(normalize(actual), expected);

test("engine is self-contained and initial state matches the authoritative brief", () => {
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /localStorage|window\.|document\.|fetch\(/);
  assertState(initialState, { count: 0, player: "A", phase: "MOVE", winner: null });
});

test("illegal initial end-turn and unrecognized actions do not mutate the complete state", () => {
  const state = Object.freeze(initial());
  assert.equal(apply(state, "endTurn"), state);
  assert.equal(apply(state, "invalid"), state);
  assertState(state, initial());
});

test("move changes phase but preserves player, while repeated move is a no-op", () => {
  const before = Object.freeze(initial());
  const moved = apply(before, "move");
  assertState(moved, { count: 1, player: "A", phase: "RESOLVE", winner: null });
  assert.equal(apply(moved, "move"), moved);
  assertState(before, initial());
});

test("end turn alternates ownership until the fourth move resolves to B victory", () => {
  let state = initial();
  for (let turn = 1; turn <= 4; turn++) {
    const owner = turn % 2 ? "A" : "B";
    assert.equal(state.player, owner);
    assert.equal(state.phase, "MOVE");
    assert.equal(apply(state, "endTurn"), state);
    state = apply(state, "move");
    assertState(state, { count: turn, player: owner, phase: "RESOLVE", winner: null });
    assert.equal(apply(state, "move"), state);
    state = apply(state, "endTurn");
    assertState(state, turn === 4
      ? { count: 4, player: "B", phase: "FINISHED", winner: "B" }
      : { count: turn, player: owner === "A" ? "B" : "A", phase: "MOVE", winner: null });
  }
  for (const type of ["move", "endTurn", "unrecognized"]) {
    assert.equal(apply(state, type), state);
  }
});

test("reset always restores initial state, including after a win", () => {
  let state = initial();
  for (let turn = 0; turn < 4; turn++) {
    state = apply(state, "move");
    state = apply(state, "endTurn");
  }
  assert.equal(state.winner, "B");
  assertState(apply(state, "reset"), initial());
  assertState(apply(initial(), "reset"), initial());
});

test("all intermediate phases and terminal state survive serialization and restoration", () => {
  let state = initial();
  for (let turn = 1; turn <= 4; turn++) {
    state = apply(state, "move");
    const restoredResolve = JSON.parse(JSON.stringify(state));
    assertState(restoredResolve, normalize(state));
    assert.equal(apply(restoredResolve, "move"), restoredResolve);
    state = apply(restoredResolve, "endTurn");
    assertState(JSON.parse(JSON.stringify(state)), normalize(state));
  }
  const reset = apply(JSON.parse(JSON.stringify(state)), "reset");
  assertState(JSON.parse(JSON.stringify(reset)), initial());
});

test("route contains the exact required accessible selectors and persistent storage", () => {
  const page = readFileSync(resolve("app/project-pilots/signal-sprint/page.tsx"), "utf8");
  for (const id of ["count", "player", "phase", "winner", "move", "end-turn", "reset"]) {
    assert.match(page, new RegExp('id="' + id + '"'));
  }
  assert.match(page, /Signal Sprint|Signal <span/);
  assert.match(page, /localStorage\.setItem/);
  assert.match(page, /localStorage\.getItem/);
  assert.match(page, /transition\(/);
});


if (process.env.SIGNAL_SPRINT_BROWSER_ACCEPTANCE === "1") {
  test("Chromium verifies the built route, invalid actions, reloads, victory and reset", { timeout: 150_000 }, async () => {
    const { spawn } = await import("node:child_process");
    const { runScenarios, prepareTrustedChromium } = await import("../../scripts/project-browser-engine.mjs");
    const port = 31947;
    const origin = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" }
    });
    let output = "";
    for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { output = (output + String(chunk)).slice(-2500); });
    const path = "/project-pilots/signal-sprint";
    const goto = { action: "goto", path };
    const click = selector => ({ action: "click", selector });
    const expect = (selector, value) => ({ action: "expectText", selector, value });
    const ready = expect("#ready", "Ready to play");
    const contract = {
      path, scenarios: [
        {
          name: "initial-and-invalid-actions",
          steps: [goto, ready, expect("#count", "0"), expect("#player", "A"),
            expect("#phase", "MOVE"), expect("#winner", "None"),
            click("#end-turn"), expect("#count", "0"), expect("#player", "A"),
            click("#move"), expect("#count", "1"), expect("#phase", "RESOLVE"),
            click("#move"), expect("#count", "1"), expect("#player", "A"),
            goto, ready, expect("#count", "1"), expect("#phase", "RESOLVE"),
            click("#end-turn"), expect("#player", "B"), expect("#phase", "MOVE")]
        },
        {
          name: "four-turn-victory-terminal-noops-and-reload",
          steps: [goto, ready,
            click("#move"), click("#end-turn"), expect("#player", "B"),
            click("#move"), click("#end-turn"), expect("#player", "A"),
            click("#move"), click("#end-turn"), expect("#player", "B"),
            click("#move"), expect("#count", "4"), expect("#phase", "RESOLVE"),
            click("#end-turn"), expect("#phase", "FINISHED"), expect("#winner", "B"),
            click("#move"), click("#end-turn"), expect("#count", "4"),
            expect("#player", "B"), expect("#winner", "B"),
            goto, ready, expect("#phase", "FINISHED"), expect("#winner", "B"),
            click("#reset"), expect("#count", "0"), expect("#player", "A"),
            expect("#phase", "MOVE"), expect("#winner", "None"),
            goto, ready, expect("#count", "0"), expect("#phase", "MOVE")]
        },
        {
          name: "reset-unresolved-turn-and-reload",
          steps: [goto, ready, click("#move"), expect("#phase", "RESOLVE"),
            goto, ready, expect("#count", "1"), expect("#player", "A"),
            click("#reset"), expect("#count", "0"), expect("#phase", "MOVE"),
            goto, ready, expect("#count", "0"), expect("#winner", "None")]
        }
      ]
    };
    try {
      let started = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (server.exitCode !== null) throw Error("Next server exited: " + output);
        try {
          const response = await fetch(origin + path, { signal: AbortSignal.timeout(1_000) });
          await response.body?.cancel();
          if (response.ok) { started = true; break; }
        } catch {}
        await new Promise(done => setTimeout(done, 250));
      }
      assert.ok(started, "Built Next server did not start: " + output);
      const executablePath = await prepareTrustedChromium();
      const checks = await runScenarios(contract, origin, { executablePath, timeout: 100_000 });
      assert.equal(checks.length, contract.scenarios.length);
      for (const check of checks) assert.equal(check.passed, true, check.name + ": " + check.detail);
    } finally {
      server.kill("SIGKILL");
    }
  });
}
