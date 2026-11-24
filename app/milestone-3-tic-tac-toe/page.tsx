"use client";

import {useState} from "react";
import {newGame, playMove, type Game} from "@/lib/milestone-3-tic-tac-toe/game";

export default function TicTacToePage() {
  const [game, setGame] = useState<Game>(newGame);
  const ended = game.winner !== null;
  const status = game.winner === "draw"
    ? "It's a draw!"
    : game.winner
      ? `${game.winner} wins!`
      : `${game.current}'s turn`;

  return (
    <main className="flex min-h-[75vh] items-center justify-center px-4 py-10">
      <section className="w-full max-w-md rounded-3xl border border-white/15 bg-slate-900/80 p-6 text-center shadow-2xl sm:p-9" aria-label="Two-player tic-tac-toe">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-sky-300">Two players · One device</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">Tic-Tac-Toe</h1>
        <p className="mt-4 text-xl font-semibold text-slate-100" role="status" aria-live="polite">{status}</p>
        <div className="mx-auto mt-7 grid w-full max-w-[350px] grid-cols-3 gap-2.5" role="group" aria-label="Game board">
          {game.board.map((cell, index) => {
            const winningCell = game.winningLine?.includes(index) ?? false;
            return (
              <button
                key={index}
                type="button"
                aria-label={`Row ${Math.floor(index / 3) + 1}, column ${index % 3 + 1}: ${cell ?? "empty"}`}
                disabled={ended || cell !== null}
                onClick={() => setGame(previous => playMove(previous, index))}
                className={`aspect-square min-w-0 rounded-xl border text-5xl font-bold transition-colors focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-sky-400 sm:text-6xl ${
                  winningCell
                    ? "border-emerald-300 bg-emerald-700 text-white"
                    : cell === "X"
                      ? "border-slate-600 bg-slate-800 text-sky-300"
                      : cell === "O"
                        ? "border-slate-600 bg-slate-800 text-amber-300"
                        : "border-slate-600 bg-slate-800 text-white hover:border-sky-400 hover:bg-slate-700"
                } disabled:cursor-default`}
              >
                {cell}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setGame(newGame())}
          className="mt-8 rounded-xl bg-sky-400 px-6 py-3 font-bold text-slate-950 transition-colors hover:bg-sky-300 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          New game
        </button>
        <p className="mt-5 text-sm text-slate-400">Take turns placing X and O. First to get three in a row wins.</p>
      </section>
    </main>
  );
}
