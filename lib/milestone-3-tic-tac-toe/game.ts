export type Player = 'X' | 'O';
export type Cell = Player | '';

export type GameState = {
  board: Cell[];
  currentPlayer: Player;
  status: "X's turn" | "O's turn" | 'X wins' | 'O wins' | 'Draw';
  winner: Player | null;
  isDraw: boolean;
  isTerminal: boolean;
};

const WIN_LINES: number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function createInitialGameState(): GameState {
  return {
    board: Array.from({ length: 9 }, () => ''),
    currentPlayer: 'X',
    status: "X's turn",
    winner: null,
    isDraw: false,
    isTerminal: false,
  };
}

function getWinner(board: Cell[]): Player | null {
  for (const [a, b, c] of WIN_LINES) {
    const marker = board[a];
    if (marker !== '' && marker === board[b] && marker === board[c]) {
      return marker;
    }
  }

  return null;
}

export function playMove(state: GameState, cellIndex: number): GameState {
  if (state.isTerminal) {
    return state;
  }

  if (cellIndex < 0 || cellIndex > 8) {
    return state;
  }

  if (state.board[cellIndex] !== '') {
    return state;
  }

  const board = [...state.board];
  board[cellIndex] = state.currentPlayer;

  const winner = getWinner(board);
  if (winner) {
    return {
      board,
      currentPlayer: state.currentPlayer,
      status: `${winner} wins`,
      winner,
      isDraw: false,
      isTerminal: true,
    };
  }

  const isDraw = board.every((cell) => cell !== '');
  if (isDraw) {
    return {
      board,
      currentPlayer: state.currentPlayer,
      status: 'Draw',
      winner: null,
      isDraw: true,
      isTerminal: true,
    };
  }

  const nextPlayer: Player = state.currentPlayer === 'X' ? 'O' : 'X';
  return {
    board,
    currentPlayer: nextPlayer,
    status: `${nextPlayer}'s turn`,
    winner: null,
    isDraw: false,
    isTerminal: false,
  };
}
