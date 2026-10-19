export type BoardState = { position: number; moves: number };

export function moveToken(current: BoardState, cell: number): BoardState {
  const rowDistance = Math.abs(Math.floor(current.position / 3) - Math.floor(cell / 3));
  const columnDistance = Math.abs(current.position % 3 - cell % 3);
  if (rowDistance + columnDistance !== 1) return current;
  return { position: cell, moves: current.moves + 1 };
}
