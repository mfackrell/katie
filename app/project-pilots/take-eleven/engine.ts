// Pure Take Eleven rules. No UI, storage, or environmental dependencies.
export type Player = 'A' | 'B';
export type Phase = 'IN_PROGRESS' | 'FINISHED';
export type GameState = Readonly<{
  stones: number;
  activePlayer: Player;
  phase: Phase;
  winner: Player | null;
}>;
export type GameAction =
  | { type: 'TAKE'; count: number }
  | { type: 'RESET' }
  | { type: 'INIT' }
  | { type: string; [key: string]: unknown };

export const initialState: GameState = Object.freeze({
  stones: 11,
  activePlayer: 'A',
  phase: 'IN_PROGRESS',
  winner: null,
});

export function transition(state: GameState, action: GameAction): GameState {
  if (action?.type === 'RESET') return { ...initialState };
  if (action?.type !== 'TAKE' || state.phase !== 'IN_PROGRESS' || state.winner !== null) return state;
  const count = action.count;
  if (!Number.isInteger(count) || count < 1 || count > 3 || count > state.stones) return state;

  const stones = state.stones - count;
  return stones === 0
    ? { stones: 0, activePlayer: state.activePlayer, phase: 'FINISHED', winner: state.activePlayer }
    : { stones, activePlayer: state.activePlayer === 'A' ? 'B' : 'A', phase: 'IN_PROGRESS', winner: null };
}
