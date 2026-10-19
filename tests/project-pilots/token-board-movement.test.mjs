import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const exports = {};
runInNewContext(ts.transpileModule(readFileSync('app/project-pilots/token-board/board.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const { moveToken } = exports;

test('the actual page renders nine cells, one blue token, and exact initial counters', () => {
  const pageExports = {};
  const require = createRequire(import.meta.url);
  runInNewContext(ts.transpileModule(readFileSync('app/project-pilots/token-board/page.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports: pageExports, require: name => name === './board' ? exports : require(name) });
  const html = renderToStaticMarkup(React.createElement(pageExports.default));
  for (let cell = 0; cell < 9; cell++) assert.ok(html.includes(`id="cell-${cell}"`));
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.match(html, /id="cell-0"[^>]*aria-pressed="true"/);
  assert.equal((html.match(/bg-blue-500/g) ?? []).length, 1);
  assert.match(html, /id="position"[^>]*>0<\/dd>/);
  assert.match(html, /id="moves"[^>]*>0<\/dd>/);
});

test('every cell permits exactly its orthogonal neighbors and preserves invalid clicks', () => {
  const neighbors = [[1, 3], [0, 2, 4], [1, 5], [0, 4, 6], [1, 3, 5, 7], [2, 4, 8], [3, 7], [4, 6, 8], [5, 7]];
  for (let source = 0; source < 9; source++) {
    for (let destination = 0; destination < 9; destination++) {
      const current = Object.freeze({ position: source, moves: 12 });
      const next = moveToken(current, destination);
      if (neighbors[source].includes(destination)) {
        assert.equal(next.position, destination);
        assert.equal(next.moves, 13);
        assert.notEqual(next, current);
      } else {
        assert.equal(next, current, `${source} -> ${destination} must not move`);
      }
    }
  }
});

test('successive updates count only legal moves and keep games independent', () => {
  let game = { position: 0, moves: 0 };
  const otherGame = { position: 0, moves: 0 };
  for (const cell of [1, 5, 2, 3, 5, 8, 8, 6, 7, 4, 1, 0]) game = moveToken(game, cell);
  assert.equal(game.position, 0);
  assert.equal(game.moves, 8);
  assert.deepEqual(otherGame, { position: 0, moves: 0 });
});
