'use client';
import { useEffect, useState } from 'react';

type Player = 'A' | 'B';
type Phase = 'IN_PROGRESS' | 'FINISHED';
type Winner = Player | 'None';
type GameState = { stoneCount: number; activePlayer: Player; phase: Phase; winner: Winner };
type Action = { type: 'TAKE'; amount: number } | { type: 'RESET' };

const STORAGE_KEY = 'take-eleven-state-v1';
const initialState: GameState = { stoneCount: 11, activePlayer: 'A', phase: 'IN_PROGRESS', winner: 'None' };

export function transition(state: GameState, action: Action): GameState {
  if (action.type === 'RESET') return initialState;
  if (state.phase === 'FINISHED') return state;
  if (![1, 2, 3].includes(action.amount) || action.amount > state.stoneCount) return state;
  const stoneCount = state.stoneCount - action.amount;
  if (stoneCount === 0) return { stoneCount: 0, activePlayer: state.activePlayer, phase: 'FINISHED', winner: state.activePlayer };
  return { stoneCount, activePlayer: state.activePlayer === 'A' ? 'B' : 'A', phase: 'IN_PROGRESS', winner: 'None' };
}

export default function Page() {
  const [state, setState] = useState<GameState>(initialState);
  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as GameState;
      if (typeof parsed.stoneCount === 'number' && (parsed.activePlayer === 'A' || parsed.activePlayer === 'B') && (parsed.phase === 'IN_PROGRESS' || parsed.phase === 'FINISHED') && (parsed.winner === 'A' || parsed.winner === 'B' || parsed.winner === 'None')) setState(parsed);
    } catch {}
  }, []);
  useEffect(() => { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }, [state]);

  return <main><h1>Take Eleven</h1><p>Stones: <span data-testid='stone-count'>{state.stoneCount}</span></p><p>Active Player: <span data-testid='active-player'>{state.activePlayer}</span></p><p>Phase: <span data-testid='phase'>{state.phase}</span></p><p>Winner: <span data-testid='winner'>{state.winner}</span></p><button type='button' aria-label='Take 1' onClick={() => setState((s) => transition(s, { type: 'TAKE', amount: 1 }))}>Take 1</button><button type='button' aria-label='Take 2' onClick={() => setState((s) => transition(s, { type: 'TAKE', amount: 2 }))}>Take 2</button><button type='button' aria-label='Take 3' onClick={() => setState((s) => transition(s, { type: 'TAKE', amount: 3 }))}>Take 3</button><button type='button' aria-label='Reset' onClick={() => setState((s) => transition(s, { type: 'RESET' }))}>Reset</button></main>;
}
