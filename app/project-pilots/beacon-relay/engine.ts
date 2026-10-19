export type Player = "Red" | "Blue";
export type GameState = {
  positions: Record<Player, number>;
  scores: Record<Player, number>;
  activePlayer: Player;
  turn: number;
  phase: "MOVE" | "RESOLVE" | "GAME_OVER";
  winner: Player | null;
};
export type Action = { type: "MOVE"; cell: number } | { type: "END_TURN" } | { type: "RESET" };

export const STORAGE_KEY = "beacon-relay-duel:v1";
export const isBeacon = (cell: number) => cell === 5 || cell === 10;
export function initialState(): GameState {
  return { positions: { Red: 0, Blue: 15 }, scores: { Red: 0, Blue: 0 }, activePlayer: "Red", turn: 1, phase: "MOVE", winner: null };
}

export function transition(state: GameState, action: Action): GameState {
  if (action.type === "RESET") return initialState();
  if (state.phase === "GAME_OVER") return state;
  const player = state.activePlayer;
  const other = player === "Red" ? "Blue" : "Red";
  if (action.type === "MOVE" && state.phase === "MOVE") {
    const from = state.positions[player];
    const to = action.cell;
    if (!Number.isInteger(to) || to < 0 || to > 15 || to === state.positions[other] ||
      Math.abs(Math.floor(from / 4) - Math.floor(to / 4)) + Math.abs(from % 4 - to % 4) !== 1) return state;
    return { ...state, positions: { ...state.positions, [player]: to }, phase: "RESOLVE" };
  }
  if (action.type === "END_TURN" && state.phase === "RESOLVE") {
    const scores = { ...state.scores, [player]: state.scores[player] + (isBeacon(state.positions[player]) ? 1 : 0) };
    if (scores[player] === 3) return { ...state, scores, phase: "GAME_OVER", winner: player };
    return { ...state, scores, activePlayer: other, turn: state.turn + 1, phase: "MOVE" };
  }
  return state;
}

// Accept only complete, versioned game saves. Never merge partial/corrupt data
// with live state, and never write to any other feature's storage namespace.
export function decodeState(raw: string | null): GameState {
  try {
    if (raw === null) return initialState();
    const save = JSON.parse(raw);
    const s = save.state;
    if (save.version !== 1 || !s || !s.positions || !s.scores) return initialState();
    const player = s.activePlayer;
    const cell = (n: unknown) => Number.isInteger(n) && Number(n) >= 0 && Number(n) < 16;
    const score = (n: unknown) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 2;
    if (!cell(s.positions.Red) || !cell(s.positions.Blue) || s.positions.Red === s.positions.Blue ||
      !score(s.scores.Red) || !score(s.scores.Blue) || !["Red", "Blue"].includes(player) ||
      !Number.isSafeInteger(s.turn) || s.turn < 1 || player !== (s.turn % 2 === 1 ? "Red" : "Blue") ||
      !["MOVE", "RESOLVE", "GAME_OVER"].includes(s.phase)) return initialState();
    if (s.phase === "GAME_OVER") {
      if (s.winner !== player || s.scores[player] !== 2 || s.scores[player === "Red" ? "Blue" : "Red"] >= 2 || !isBeacon(s.positions[player])) return initialState();
    } else if (s.winner !== null || s.scores.Red >= 2 || s.scores.Blue >= 2) return initialState();
    return { positions: { Red: s.positions.Red, Blue: s.positions.Blue }, scores: { Red: s.scores.Red, Blue: s.scores.Blue }, activePlayer: player, turn: s.turn, phase: s.phase, winner: s.winner };
  } catch { return initialState(); }
}
export const encodeState = (state: GameState) => JSON.stringify({ version: 1, state });
