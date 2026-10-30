import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync('app/project-pilots/take-eleven/engine.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const context = { exports: {}, Object, Number };
runInNewContext(compiled, context, { timeout: 3000 });
const { initialState, transition } = context.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const state0 = () => plain(initialState);
const take = (state, count) => plain(transition(state, { type: 'TAKE', count }));

test('exact initial state and INIT no-op', () => {
  assert.deepEqual(state0(), { stones: 11, activePlayer: 'A', phase: 'IN_PROGRESS', winner: null });
  const state = state0();
  assert.equal(transition(state, { type: 'INIT' }), state);
});

test('legal takes of 1, 2 and 3 subtract and alternate players', () => {
  for (const count of [1, 2, 3]) {
    assert.deepEqual(take(state0(), count), {
      stones: 11 - count, activePlayer: 'B', phase: 'IN_PROGRESS', winner: null,
    });
  }
});

test('illegal moves, non-integers and unknown actions preserve original object', () => {
  const original = state0();
  const before = JSON.stringify(original);
  for (const action of [
    { type: 'TAKE', count: 0 },
    { type: 'TAKE', count: 4 },
    { type: 'TAKE', count: -1 },
    { type: 'TAKE', count: 2.5 },
    { type: 'TAKE', count: NaN },
    { type: 'TAKE', count: '1' },
    { type: 'BOGUS' },
  ]) assert.equal(transition(original, action), original);
  assert.equal(JSON.stringify(original), before);
  const one = { stones: 1, activePlayer: 'B', phase: 'IN_PROGRESS', winner: null };
  assert.equal(transition(one, { type: 'TAKE', count: 2 }), one);
});

test('legal turns alternate correctly through the game', () => {
  let current = state0();
  for (const [count, stones, player] of [[3, 8, 'B'], [2, 6, 'A'], [3, 3, 'B']]) {
    current = take(current, count);
    assert.deepEqual([current.stones, current.activePlayer], [stones, player]);
  }
});

test('either A or B can win by taking the final stone', () => {
  for (const [moves, winner] of [[[3, 3, 3, 2], 'B'], [[3, 3, 3, 1, 1], 'A']]) {
    let current = state0();
    for (const count of moves) current = take(current, count);
    assert.deepEqual(current, { stones: 0, activePlayer: winner, phase: 'FINISHED', winner });
    assert.equal(transition(current, { type: 'TAKE', count: 1 }), current);
  }
});

test('reset restores exact initial state, including from terminal state', () => {
  let current = state0();
  for (const n of [3, 3, 3, 2]) current = take(current, n);
  assert.deepEqual(plain(transition(current, { type: 'RESET' })), state0());
  assert.deepEqual(plain(transition(take(state0(), 2), { type: 'RESET' })), state0());
});

test('transition is deterministic and never mutates input', () => {
  const before = state0();
  const frozen = Object.freeze({ ...before });
  const one = take(frozen, 3), two = take(frozen, 3);
  assert.deepEqual(one, two);
  assert.deepEqual(before, state0());
  assert.deepEqual(frozen, before);
});

test('UI binds the pure engine, persistence and the source-bound selectors', () => {
  const page = readFileSync('app/project-pilots/take-eleven/page.tsx', 'utf8');
  assert.match(page, /import \{ initialState, transition/);
  assert.match(page, /localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(page, /localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(game\)\)/);
  assert.match(page, /if \(!loaded\) return/);
  for (const id of ['stone-count', 'active-player', 'phase', 'winner']) assert.ok(page.includes('data-testid="'+id+'"'));
  assert.match(page, /aria-label="Reset"/);
  assert.match(page, /aria-label=\{\`Take \$\{count\}\`\}/);
});
