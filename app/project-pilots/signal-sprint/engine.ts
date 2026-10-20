/**
 * Signal Sprint v1. Pure, deterministic game engine.
 * No imports, persistence, browser APIs or mutable globals.
 */
export type Phase = "MOVE" | "RESOLVE" | "FINISHED";
export type Player = "A" | "B";
export type GameState = { count: number; player: Player; phase: Phase; winner: Player | null };
export type GameAction = { type: string };

export const initialState: GameState = { count: 0, player: "A", phase: "MOVE", winner: null };

export function transition(state: GameState, action: GameAction): GameState {
  if (action?.type === "reset") return { ...initialState };
  if (state.winner !== null || state.phase === "FINISHED") return state;

  if (action?.type === "move" && state.phase === "MOVE") {
    return { ...state, count: state.count + 1, phase: "RESOLVE" };
  }

  if (action?.type === "endTurn" && state.phase === "RESOLVE") {
    if (state.count === 4) return { ...state, phase: "FINISHED", winner: state.player };
    return { ...state, player: state.player === "A" ? "B" : "A", phase: "MOVE" };
  }

  return state;
}
