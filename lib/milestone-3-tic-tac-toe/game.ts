export type Player = "X" | "O";
export type Cell = Player | null;
export type Winner = Player | "draw" | null;
export type Game = {board: Cell[]; current: Player; winner: Winner; winningLine: readonly number[] | null};

export const WINNING_LINES: readonly (readonly number[])[] = [
  [0,1,2], [3,4,5], [6,7,8],
  [0,3,6], [1,4,7], [2,5,8],
  [0,4,8], [2,4,6],
];

export function newGame(): Game {
  return {board: Array<Cell>(9).fill(null), current: "X", winner: null, winningLine: null};
}

export function playMove(game: Game, index: number): Game {
  if (!Number.isInteger(index) || index < 0 || index > 8 || game.winner || game.board[index]) return game;

  const board = [...game.board];
  board[index] = game.current;
  const winningLine = WINNING_LINES.find(line => line.every(i => board[i] === game.current)) ?? null;
  const winner: Winner = winningLine ? game.current : board.every(Boolean) ? "draw" : null;

  return {
    board,
    current: winner ? game.current : game.current === "X" ? "O" : "X",
    winner,
    winningLine,
  };
}
