import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { rules, acceptance } from '../../app/project-pilots/take-eleven/contract.mjs';
import { runGameModelAcceptance } from '../../lib/game-development/rule-contract.mjs';

function load(name, imports = {}) {
  const path = resolve(`app/project-pilots/take-eleven/${name}.ts`);
  const source = readFileSync(path, 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: id => {
    assert.ok(id in imports, `Unexpected dependency: ${id}`);
    return imports[id];
  } }, { filename: path });
  return exports;
}
const engine = load('engine');
const { transition, initialState } = engine;
const { loadGame, saveGame, STORAGE_KEY, isSavedState } = load('persistence', { './engine': engine });
const plain = value => JSON.parse(JSON.stringify(value));
const take = (s, amount) => transition(s, { type: 'take', amount });
const initial = () => plain(initialState);

test('exact initial state and registered model acceptance', () => {
  assert.deepEqual(initial(), { stones: 11, player: 'A', phase: 'IN_PROGRESS', winner: null });
  const receipt = runGameModelAcceptance(rules, acceptance, (s,a) => plain(transition(s,a)));
  assert.equal(receipt.passed, true, JSON.stringify(receipt));
});

test('all reachable states: pure legal moves, alternation, both winners and full-state no-ops', () => {
  const visited = new Set();
  const winners = new Set();
  function visit(state) {
    const key = JSON.stringify(state);
    if (visited.has(key)) return;
    visited.add(key);
    assert.equal(isSavedState(state), true, key);
    Object.freeze(state);
    for (const action of [null, undefined, {}, 'take', {type:'unknown'}, ...[-1,0,4,1.5,NaN,Infinity,'1',null].map(amount => ({type:'take',amount}))]) {
      assert.equal(transition(state, action), state);
    }
    assert.deepEqual(plain(transition(state, {type:'reset'})), initial());
    for (const amount of [1,2,3]) {
      const next = take(state, amount);
      if (state.winner || amount > state.stones) assert.equal(next, state);
      else {
        const remaining = state.stones - amount;
        assert.deepEqual(plain(next), { stones: remaining, player: remaining ? (state.player === 'A' ? 'B' : 'A') : state.player, phase: remaining ? 'IN_PROGRESS' : 'FINISHED', winner: remaining ? null : state.player });
        if (next.winner) winners.add(next.winner);
        visit(next);
      }
    }
    assert.equal(JSON.stringify(state), key);
  }
  visit(initial());
  assert.deepEqual([...winners].sort(), ['A','B']);
});

test('real persistence functions restore progress, both wins and reset using isolated storage', () => {
  const data = new Map([['another-game', 'untouched']]);
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key,value) => data.set(key,value) };
  assert.deepEqual(plain(loadGame(storage)), initial());
  for (const moves of [[1,2], [3,3,3,1,1], [3,3,3,2]]) {
    let state = initial();
    for (const amount of moves) {
      state = take(state, amount);
      assert.equal(saveGame(storage,state), true);
      assert.deepEqual(plain(loadGame(storage)), plain(state));
      state = loadGame(storage);
    }
    const reset = transition(state,{type:'reset'});
    saveGame(storage,reset);
    assert.deepEqual(plain(loadGame(storage)), initial());
  }
  assert.equal(data.get('another-game'),'untouched');
  for (const raw of ['invalid', 'null', '[]', JSON.stringify({...initial(),player:'B'}), JSON.stringify({...initial(),stones:0}), JSON.stringify({...initial(),stones:12}), JSON.stringify({...initial(),stones:10,player:'A'})]) {
    data.set(STORAGE_KEY,raw);
    assert.deepEqual(plain(loadGame(storage)),initial());
  }
  const denied = {getItem() {throw Error('denied');},setItem() {throw Error('denied');}};
  assert.deepEqual(plain(loadGame(denied)),initial());
  assert.equal(saveGame(denied,initial()),false);
});

if (process.env.TAKE_ELEVEN_BROWSER_ACCEPTANCE === '1') {
  test('real Chromium: registered gameplay, progress reload, A/B victory reload and reset reload', {timeout:180_000}, async () => {
    const {spawn} = await import('node:child_process');
    const {runScenarios, prepareTrustedChromium} = await import('../../scripts/project-browser-engine.mjs');
    const origin = process.env.TAKE_ELEVEN_TEST_ORIGIN ?? 'http://127.0.0.1:31948';
    const server = process.env.TAKE_ELEVEN_TEST_ORIGIN ? null : spawn(process.execPath, ['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','31948'], {stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1'}});
    let output = '';
    let closed = false;
    server?.on('close', () => { closed = true; });
    for (const stream of [server?.stdout,server?.stderr]) stream?.on('data', chunk => {output = (output + chunk).slice(-3000);});
    try {
      let started = false;
      for (let i=0;i<100;i++) {
        if (closed) throw Error(`Next server exited (${server.exitCode}): ${output}`);
        try {
          const response = await fetch(origin + '/project-pilots/take-eleven', {signal:AbortSignal.timeout(1000)});
          await response.body?.cancel();
          if (response.ok) {started=true;break;}
        } catch {}
        await new Promise(done => setTimeout(done,250));
      }
      assert.ok(started,output);
      const checks = await runScenarios({path:'/project-pilots/take-eleven',scenarios:acceptance.scenarios.filter(s=>s.kind==='browser').map(s=>({name:s.id,steps:s.steps}))},origin,{executablePath:await prepareTrustedChromium(),timeout:120_000});
      console.log(JSON.stringify({stage:'take-eleven-browser',origin,checks}));
      assert.equal(checks.length,3);
      for (const check of checks) assert.equal(check.passed,true,JSON.stringify(check));
    } finally { server?.kill('SIGKILL'); }
  });
}
