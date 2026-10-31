'use client';

import { useEffect, useState } from 'react';
import { initialState, transition, type GameAction, type GameState } from './engine';

const STORAGE_KEY = 'take-eleven-state-v1';

function validState(value: unknown): value is GameState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (typeof s.stones !== 'number' || !Number.isInteger(s.stones) || s.stones < 0 || s.stones > 11) return false;
  if (s.activePlayer !== 'A' && s.activePlayer !== 'B') return false;
  if (s.phase !== 'IN_PROGRESS' && s.phase !== 'FINISHED') return false;
  if (s.phase === 'IN_PROGRESS') return (s.stones as number) > 0 && s.winner === null;
  return s.stones === 0 && (s.winner === 'A' || s.winner === 'B') && s.winner === s.activePlayer;
}

export default function TakeEleven() {
  const [game, setGame] = useState<GameState>(initialState);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (validState(parsed)) setGame(parsed);
      }
    } catch {
      // Invalid or unavailable browser storage does not prevent playing.
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(game));
    } catch {
      // Browser storage may be restricted; in-memory play remains available.
    }
  }, [game, loaded]);

  const act = (action: GameAction) => setGame(current => transition(current, action));

  return (
    <main data-game-ready={loaded ? "true" : "false"} className="mx-auto flex min-h-[75vh] w-full max-w-2xl flex-col items-center justify-center px-5 py-12 text-center">
      <div className="w-full rounded-3xl border border-white/15 bg-zinc-900/80 p-6 shadow-2xl sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-400">Two players · One winner</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">Take Eleven</h1>
        <p className="mt-3 text-sm text-zinc-400">Players alternate taking 1, 2, or 3 stones. Whoever takes the last stone wins.</p>

        <div className="mt-8 rounded-2xl border border-amber-300/20 bg-zinc-950/70 p-6">
          <p className="text-sm font-medium text-zinc-400">Stones remaining</p>
          <p data-testid="stone-count" aria-live="polite" className="mt-1 text-7xl font-semibold tabular-nums text-amber-300">{game.stones}</p>
          <div aria-hidden="true" className="mx-auto mt-5 flex max-w-sm flex-wrap justify-center gap-2">
            {Array.from({ length: game.stones }, (_, i) =>
              <span key={i} className="h-4 w-4 rounded-full border border-amber-300/70 bg-amber-500/60" />
            )}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-3 text-sm">
          <div className="rounded-xl border border-white/10 p-3">
            <p className="text-zinc-400">Active player</p>
            <p data-testid="active-player" className="mt-1 text-xl font-bold">{game.activePlayer}</p>
          </div>
          <div className="rounded-xl border border-white/10 p-3">
            <p className="text-zinc-400">Phase</p>
            <p data-testid="phase" className="mt-1 text-sm font-bold">{game.phase}</p>
          </div>
          <div className="rounded-xl border border-white/10 p-3">
            <p className="text-zinc-400">Winner</p>
            <p data-testid="winner" className="mt-1 text-xl font-bold">{game.winner ?? 'None'}</p>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-3 gap-3">
          {[1, 2, 3].map(count => (
            <button key={count} type="button" aria-label={`Take ${count}`}
              onClick={() => act({ type: 'TAKE', count })}
              className="min-h-12 rounded-xl bg-amber-400 px-3 py-3 font-semibold text-zinc-950 transition hover:bg-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200">
              Take {count}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Reset" onClick={() => act({ type: 'RESET' })}
          className="mt-4 min-h-11 w-full rounded-xl border border-white/25 px-4 py-2 font-medium text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
          Reset
        </button>
        <p role="status" className="mt-4 text-sm text-zinc-400">
          {game.phase === 'FINISHED' ? `Player ${game.winner} wins! Reset to play again.` : `Player ${game.activePlayer}, your move.`}
        </p>
      </div>
    </main>
  );
}
