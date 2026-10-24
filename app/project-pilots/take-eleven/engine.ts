/** Original Take Eleven v1: pure deterministic rules, with no external effects. */
export type Player = "A" | "B";
export type GameState = {
  stones: number;
  player: Player;
  phase: "IN_PROGRESS" | "FINISHED";
  winner: Player | null;
};
export const initialState: Readonly<GameState> = Object.freeze({
  stones: 11, player: "A", phase: "IN_PROGRESS", winner: null,
});

export function transition(state: GameState, action: unknown): GameState {
  if (!action || typeof action !== "object") return state;
  const { type, amount } = action as { type?: unknown; amount?: unknown };
  if (type === "reset") return { ...initialState };
  if (type !== "take" || state.winner !== null || state.phase !== "IN_PROGRESS" ||
      typeof amount !== "number" || !Number.isInteger(amount) ||
      amount < 1 || amount > 3 || amount > state.stones) return state;
  const stones = state.stones - amount;
  return stones === 0
    ? { ...state, stones, phase: "FINISHED", winner: state.player }
    : { ...state, stones, player: state.player === "A" ? "B" : "A" };
}
