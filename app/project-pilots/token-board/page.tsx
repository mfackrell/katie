"use client";

import { useState } from "react";

export default function TokenBoardPage() {
  const [game, setGame] = useState({ position: 0, moves: 0 });

  function moveTo(cell: number) {
    setGame(current => {
      const rowDistance = Math.abs(Math.floor(cell / 3) - Math.floor(current.position / 3));
      const columnDistance = Math.abs((cell % 3) - (current.position % 3));
      return rowDistance + columnDistance === 1
        ? { position: cell, moves: current.moves + 1 }
        : current;
    });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <h1 className="text-3xl font-semibold">Token board</h1>
      <p className="text-zinc-300">Move the blue token by selecting a neighboring cell above, below, left, or right.</p>
      <div className="flex gap-6" aria-live="polite" aria-atomic="true">
        <p>Position: <span id="position">{game.position}</span></p>
        <p>Moves: <span id="moves">{game.moves}</span></p>
      </div>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Token board">
        {Array.from({ length: 9 }, (_, cell) => (
          <button
            key={cell}
            id={`cell-${cell}`}
            type="button"
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
    </main>
  );
}
