import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {resolve, dirname} from "node:path";
import {createRequire} from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(resolve(root, "lib/milestone-3-tic-tac-toe/game.ts"), "utf8");
const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
const exports = {};
vm.runInNewContext(compiled, {exports});
const {newGame, playMove, WINNING_LINES} = exports;
function moves(...indices) {return indices.reduce((g,i)=>playMove(g,i),newGame());}
test("starts with empty board and X to play", () => {
 const g = newGame();
 assert.equal(g.board.length,9);
 assert.equal(g.board.filter(Boolean).length,0);
 assert.equal(g.current,"X");
 assert.equal(g.winner,null);
});
test("alternates players and rejects occupied or invalid cells without changing state", () => {
 const g = moves(0); assert.equal(g.current,"O");
 assert.equal(playMove(g,0),g);
 for(const i of [-1,9,1.5,NaN])assert.equal(playMove(g,i),g);
 assert.equal(playMove(g,1).board[1],"O");
});
test("detects all eight winning combinations", () => {
 for(const line of WINNING_LINES){
  const other = [0,1,2,3,4,5,6,7,8].filter(x=>!line.includes(x));
  const g = moves(line[0],other[0],line[1],other[1],line[2]);
  assert.equal(g.winner,"X",`line ${line}`);
  assert.deepEqual(Array.from(g.winningLine),Array.from(line));
  assert.equal(playMove(g,other[2]),g);
 }
});
test("recognizes O victory", () => {
 const g = moves(0,3,1,4,8,5);
 assert.equal(g.winner,"O");
 assert.equal(g.current,"O");
});
test("detects a full-board draw", () => {
 const g = moves(0,1,2,4,3,5,7,6,8);
 assert.equal(g.winner,"draw");
 assert.equal(g.board.filter(Boolean).length,9);
 assert.equal(playMove(g,0),g);
});
test("new game resets completed game independently", () => {
 const played = moves(0,3,1,4,2);
 const reset = newGame();
 assert.equal(played.winner,"X");
 assert.equal(reset.winner,null);
 assert.equal(reset.board.filter(Boolean).length,0);
 assert.equal(reset.current,"X");
});
