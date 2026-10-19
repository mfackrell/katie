"use client";

import { useEffect, useState } from "react";
import { moveToken, type BoardState } from "./board";

const storageKey = "token-board-state";

export default function TokenBoardPage() {
  const [game, setGame] = useState({ position: 0, moves: 0 });

  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) setGame(JSON.parse(saved) as BoardState);
    setReady(true);
  }, []);

  useEffect(() => {
    // Wait for restoration before writing so the initial render cannot erase a saved game.
    if (ready) localStorage.setItem(storageKey, JSON.stringify(game));
  }, [game, ready]);

  function moveTo(cell: number) {
    setGame(current => moveToken(current, cell));
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold">Token board</h1>
      <p className="text-center text-zinc-300">
        Move the blue token by choosing a neighboring cell above, below, left, or right.
      </p>
      <div role="group" aria-label="Token board" className="grid w-full max-w-xs grid-cols-3 gap-2">
        {Array.from({ length: 9 }, (_, cell) => (
          <button
            key={cell}
            id={`cell-${cell}`}
            type="button"
            disabled={!ready}
            aria-label={`Cell ${cell}${game.position === cell ? ", blue token" : ""}`}
            aria-pressed={game.position === cell}
            onClick={() => moveTo(cell)}
            className="flex aspect-square items-center justify-center rounded-xl border border-zinc-600 bg-zinc-900 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
          >
            {game.position === cell && (
              <span aria-hidden="true" className="h-10 w-10 rounded-full bg-blue-500 shadow-lg" />
            )}
          </button>
        ))}
      </div>
      <dl aria-live="polite" aria-atomic="true" className="flex gap-10 text-center">
        <div>
          <dt className="text-zinc-400">Position</dt>
          <dd id="position" className="text-2xl font-semibold">{game.position}</dd>
        </div>
        <div>
          <dt className="text-zinc-400">Moves</dt>
          <dd id="moves" className="text-2xl font-semibold">{game.moves}</dd>
        </div>
      </dl>
      <button
        id="reset"
        type="button"
        disabled={!ready}
        onClick={() => setGame({ position: 0, moves: 0 })}
        className="rounded-lg border border-zinc-600 px-5 py-2 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
      >
        Reset
      </button>
    </main>
  );
}
