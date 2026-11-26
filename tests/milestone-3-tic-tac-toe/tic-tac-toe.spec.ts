import assert from 'node:assert/strict';
import { createInitialGameState, playMove, type GameState } from '@/lib/milestone-3-tic-tac-toe/game';

function applyMoves(moves: number[]): GameState {
  return moves.reduce((state, move) => playMove(state, move), createInitialGameState());
}

function expectCell(state: GameState, index: number, value: '' | 'X' | 'O') {
  assert.equal(state.board[index], value);
}

function testInitialBoardAndLegalTurns() {
  const start = createInitialGameState();
  assert.equal(start.status, "X's turn");
  expectCell(start, 0, '');

  const xPlays = playMove(start, 0);
  expectCell(xPlays, 0, 'X');
  assert.equal(xPlays.status, "O's turn");

  const occupiedIgnored = playMove(xPlays, 0);
  expectCell(occupiedIgnored, 0, 'X');
  assert.equal(occupiedIgnored.status, "O's turn");

  const oPlays = playMove(occupiedIgnored, 1);
  expectCell(oPlays, 1, 'O');
  assert.equal(oPlays.status, "X's turn");
}

function testHorizontalWinAndTerminalFreeze() {
  const winState = applyMoves([0, 3, 1, 4, 2]);
  assert.equal(winState.status, 'X wins');
  assert.equal(winState.isTerminal, true);

  const frozen = playMove(winState, 5);
  expectCell(frozen, 5, '');
  assert.equal(frozen.status, 'X wins');
}

function testVerticalWin() {
  const winState = applyMoves([0, 1, 3, 2, 6]);
  assert.equal(winState.status, 'X wins');
}

function testMainDiagonalWin() {
  const winState = applyMoves([0, 1, 4, 2, 8]);
  assert.equal(winState.status, 'X wins');
}

function testAntiDiagonalWin() {
  const winState = applyMoves([2, 0, 4, 1, 6]);
  assert.equal(winState.status, 'X wins');
}

function testOWin() {
  const winState = applyMoves([0, 1, 2, 4, 3, 7]);
  assert.equal(winState.status, 'O wins');
}

function testDrawAndTerminalFreeze() {
  const drawState = applyMoves([0, 1, 2, 4, 3, 5, 7, 6, 8]);
  assert.equal(drawState.status, 'Draw');
  assert.equal(drawState.isTerminal, true);

  const frozen = playMove(drawState, 0);
  assert.deepEqual(frozen.board, drawState.board);
  assert.equal(frozen.status, 'Draw');
}

function testNewGameAndReloadResetBehavior() {
  const progressed = applyMoves([0, 1, 4]);
  assert.notDeepEqual(progressed.board, createInitialGameState().board);

  const newGame = createInitialGameState();
  assert.deepEqual(newGame.board, Array(9).fill(''));
  assert.equal(newGame.status, "X's turn");

  const reload = createInitialGameState();
  assert.deepEqual(reload.board, Array(9).fill(''));
  assert.equal(reload.status, "X's turn");
}

function run() {
  testInitialBoardAndLegalTurns();
  testHorizontalWinAndTerminalFreeze();
  testVerticalWin();
  testMainDiagonalWin();
  testAntiDiagonalWin();
  testOWin();
  testDrawAndTerminalFreeze();
  testNewGameAndReloadResetBehavior();
  console.log('milestone-3 tic-tac-toe tests passed');
}

run();
