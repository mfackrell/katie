import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('app/project-pilots/token-board/page.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;

// Run the actual component with an isolated state hook for each test instance.
// Functional state updates are applied immediately, including batched clicks.
function mount() {
  let state;
  const exports = {};
  const react = { ...React, useState(initial) {
    state ??= initial;
    return [state, update => { state = typeof update === 'function' ? update(state) : update; }];
  } };
  runInNewContext(code, { exports, React, require: name => {
    assert.equal(name, 'react');
    return react;
  } });
  function render() { return exports.default(); }
  function elements(node) {
    return React.isValidElement(node)
      ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
  }
  return {
    render,
    state: () => ({ ...state }),
    click(cell) { elements(render()).find(node => node.props.id === `cell-${cell}`).props.onClick(); },
  };
}

test('initial board renders nine buttons, one blue token and exact numeric counters', () => {
  const game = mount();
  const html = renderToStaticMarkup(game.render());
  for (let cell = 0; cell < 9; cell++) assert.match(html, new RegExp(`id="cell-${cell}"`));
  assert.equal((html.match(/<button/g) || []).length, 9);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(html, /aria-label="Cell 0, blue token"/);
  assert.match(html, /bg-blue-500/);
  assert.match(html, /id="position">0<\/span>/);
  assert.match(html, /id="moves">0<\/span>/);
});

test('all 81 directed moves enforce orthogonal adjacency and preserve invalid state', () => {
  for (let from = 0; from < 9; from++) {
    for (let to = 0; to < 9; to++) {
      const game = mount();
      game.render();
      let moves = 0;
      for (let row = 1; row <= Math.floor(from / 3); row++) { game.click(row * 3); moves++; }
      for (let col = 1; col <= from % 3; col++) { game.click(Math.floor(from / 3) * 3 + col); moves++; }
      assert.deepEqual(game.state(), { position: from, moves });
      const legal = Math.abs(Math.floor(from / 3) - Math.floor(to / 3)) + Math.abs(from % 3 - to % 3) === 1;
      game.click(to);
      assert.deepEqual(game.state(), { position: legal ? to : from, moves: moves + Number(legal) }, `${from} -> ${to}`);
      const html = renderToStaticMarkup(game.render());
      assert.match(html, new RegExp(`aria-label="Cell ${legal ? to : from}, blue token"`));
      assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
    }
  }
});

test('separate board instances do not share game state', () => {
  const first = mount();
  const second = mount();
  first.click(1);
  first.click(4);
  second.render();
  assert.deepEqual(first.state(), { position: 4, moves: 2 });
  assert.deepEqual(second.state(), { position: 0, moves: 0 });
});
