"use client";

import { useEffect, useState } from "react";
import { initialState, transition, type GameState } from "./engine";
import { loadGame, saveGame } from "./persistence";

export default function TakeElevenPage() {
  const [game, setGame] = useState<GameState>({ ...initialState });
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    try { setGame(loadGame(window.localStorage)); }
    catch { /* The browser may deny even access to localStorage. */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { setSaved(saveGame(window.localStorage, game)); }
    catch { setSaved(false); }
  }, [game, loaded]);

  const finished = game.phase === "FINISHED";
  const buttonStyle = "rounded-xl border border-emerald-300 px-6 py-4 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-200 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-12 text-slate-100">
      <div className="mx-auto max-w-2xl space-y-8">
        <header>
          <p className="text-sm uppercase tracking-widest text-emerald-300">Original v1 · Two human players</p>
          <h1 className="mt-3 text-5xl font-bold">Take Eleven</h1>
          <p className="mt-4 text-slate-300">Start with 11 stones. Player A goes first. Take 1, 2 or 3 stones on your turn. Whoever takes the last stone wins.</p>
        </header>
        <section aria-label="Game board" className="rounded-3xl border border-slate-700 bg-slate-900 p-6">
          <div aria-live="polite" aria-atomic="true">
            <p>Stones remaining: <strong id="stones" className="text-4xl">{game.stones}</strong></p>
            <div aria-hidden="true" className="my-6 flex flex-wrap gap-3">
              {Array.from({ length: game.stones }, (_, i) => <span key={i} className="h-8 w-10 rounded-full bg-emerald-300 shadow-lg" />)}
            </div>
            <dl className="grid grid-cols-3 gap-3">
              <div><dt>Player</dt><dd id="player" className="font-bold">{game.player}</dd></div>
              <div><dt>Phase</dt><dd id="phase" className="break-all font-bold">{game.phase}</dd></div>
              <div><dt>Winner</dt><dd id="winner" className="font-bold">{game.winner ?? "None"}</dd></div>
            </dl>
            <p className="my-6 text-emerald-200">{finished ? `Player ${game.winner} wins! Reset to play again.` : `Player ${game.player}, choose how many stones to take.`}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            {([1, 2, 3] as const).map(amount => (
              <button key={amount} id={`take-${amount}`} type="button" className={buttonStyle}
                disabled={!loaded || finished || game.stones < amount}
                onClick={() => setGame(before => transition(before, { type: "take", amount }))}>Take {amount}</button>
            ))}
          </div>
          <button id="reset" type="button" disabled={!loaded} className={`${buttonStyle} mt-4 w-full`}
            onClick={() => setGame(before => transition(before, { type: "reset" }))}>Reset</button>
        </section>
        <p id="ready" role="status">{loaded ? "Ready to play" : "Loading saved game…"}</p>
        <p className="text-sm text-slate-300">{saved ? "This browser saves your game automatically, including wins and resets." : "Saving is unavailable. You can keep playing, but reloading may lose progress."}</p>
      </div>
    </main>
  );
}
