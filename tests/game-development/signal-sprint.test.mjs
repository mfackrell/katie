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
