"use client";

import { useEffect, useState } from "react";
import { initialState, transition, type GameState } from "./engine";

const STORAGE_KEY = "katie.signalSprint.v1";

function isSavedState(value: unknown): value is GameState {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  if (!Number.isInteger(s.count) || (s.count as number) < 0 || (s.count as number) > 4) return false;
  if (s.player !== "A" && s.player !== "B") return false;
  if (s.phase !== "MOVE" && s.phase !== "RESOLVE" && s.phase !== "FINISHED") return false;
  if (s.winner !== null && s.winner !== "A" && s.winner !== "B") return false;
  if (s.phase === "FINISHED") return s.count === 4 && s.player === "B" && s.winner === "B";
  if (s.winner !== null) return false;
  const count = s.count as number;
  if (s.phase === "MOVE") return count < 4 && s.player === (count % 2 === 0 ? "A" : "B");
  return count >= 1 && s.player === (count % 2 === 1 ? "A" : "B");
}

export default function SignalSprintPage() {
  const [game, setGame] = useState<GameState>(initialState);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isSavedState(parsed)) setGame(parsed);
      }
    } catch { /* Storage is optional: an in-memory game still works. */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(game)); }
    catch { /* Game continues in memory if storage is unavailable. */ }
  }, [game, loaded]);

  function act(type: "move" | "endTurn" | "reset") {
    setGame(before => transition(before, { type }));
  }

  const finished = game.phase === "FINISHED";
  const hint = finished
    ? `Player ${game.winner} wins. Reset to play again.`
    : game.phase === "MOVE"
      ? `Player ${game.player}: make your move.`
      : `Player ${game.player}: resolve your move with End Turn.`;

  return (
    <main className="min-h-screen px-4 py-10 sm:px-8 sm:py-16" style={{ background: "radial-gradient(ellipse at 50% 0%, #132a49 0%, #07101f 62%, #060a12 100%)", color: "#e9f5ff" }}>
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-8 text-center sm:mb-11">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.36em]" style={{ color: "#6ae8cf" }}>Two player · turn-based strategy</p>
          <h1 className="text-4xl font-black tracking-tight sm:text-6xl" style={{ color: "#f4fbff" }}>Signal <span style={{ color: "#6ae8cf" }}>Sprint</span></h1>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-7 sm:text-base" style={{ color: "#b4c5d8" }}>
            Two players. Four signals. One winner. Move, resolve your turn, and race to complete the sequence.
          </p>
        </header>

        <section aria-label="Game board" className="overflow-hidden rounded-3xl border p-5 shadow-2xl sm:p-8" style={{ background: "linear-gradient(145deg, rgba(24,46,73,.95), rgba(10,21,36,.98))", borderColor: "#254662" }}>
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:justify-between">
            {(["A", "B"] as const).map(player => (
              <div key={player} className="flex min-w-0 flex-1 items-center justify-between rounded-2xl border px-5 py-4 sm:mx-1" style={{
                borderColor: game.player === player ? (player === "A" ? "#6ae8cf" : "#9fa9ff") : "#34506b",
                background: game.player === player ? "rgba(45,83,115,.35)" : "rgba(13,28,45,.7)"
              }}>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#abc3d7" }}>Player {player}</div>
                  <div className="mt-1 text-lg font-bold">{game.winner === player ? "Winner" : game.player === player ? "Your turn" : "Standing by"}</div>
                </div>
                <div className="flex h-11 w-11 items-center justify-center rounded-xl text-2xl font-black" style={{
                  background: player === "A" ? "#174d50" : "#353a68",
                  color: player === "A" ? "#83ffe4" : "#c6c9ff"
                }}>{player}</div>
              </div>
            ))}
          </div>

          <div className="rounded-3xl border px-4 py-7 text-center sm:py-10" style={{ background: "rgba(4,13,25,.63)", borderColor: "#2c475d" }}>
            <p className="text-xs font-bold uppercase tracking-[.3em]" style={{ color: "#97b4c9" }}>Signals completed</p>
            <div id="count" className="mt-2 text-7xl font-black tabular-nums sm:text-8xl" style={{ color: "#f3fbff" }}>{game.count}</div>
            <div className="mt-2 text-sm" style={{ color: "#93b4c6" }}>out of 4</div>
            <div className="mx-auto mt-6 flex max-w-xs gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} aria-label={i < game.count ? `Signal ${i + 1} completed` : `Signal ${i + 1} remaining`} className="h-3 flex-1 rounded-full" style={{
                  background: i < game.count ? "#6ae8cf" : "#29425b",
                  boxShadow: i < game.count ? "0 0 14px rgba(106,232,207,.25)" : "none"
                }} />
              ))}
            </div>
          </div>

          <div className="my-6 grid grid-cols-3 gap-2 rounded-2xl border p-4 text-center" style={{ borderColor: "#29465e", background: "rgba(15,33,52,.8)" }}>
            <div><div className="text-xs uppercase tracking-widest" style={{ color: "#9fb8ce" }}>Player</div><div id="player" className="mt-2 text-xl font-bold">{game.player}</div></div>
            <div><div className="text-xs uppercase tracking-widest" style={{ color: "#9fb8ce" }}>Phase</div><div id="phase" className="mt-2 text-sm font-extrabold sm:text-base">{game.phase}</div></div>
            <div><div className="text-xs uppercase tracking-widest" style={{ color: "#9fb8ce" }}>Winner</div><div id="winner" className="mt-2 text-xl font-bold">{game.winner ?? "None"}</div></div>
          </div>

          <p aria-live="polite" className="mb-5 min-h-7 text-center text-sm font-medium" style={{ color: finished ? "#6ae8cf" : "#d1e2f1" }}>{hint}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button id="move" type="button" onClick={() => act("move")} className="rounded-xl px-5 py-4 text-base font-bold transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ background: "#6ae8cf", color: "#051b1f", outlineColor: "#bafbed" }}>Move →</button>
            <button id="end-turn" type="button" onClick={() => act("endTurn")} className="rounded-xl border px-5 py-4 text-base font-bold transition hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ background: "#243e60", color: "#e9f5ff", borderColor: "#527499", outlineColor: "#bafbed" }}>End Turn</button>
          </div>
          <button id="reset" type="button" onClick={() => act("reset")} className="mt-4 w-full rounded-xl border px-5 py-3 text-sm font-semibold transition hover:bg-white/10" style={{ borderColor: "#2c4a65", color: "#b7d2e4" }}>Reset game</button>
        </section>

        <section className="mx-auto mt-7 max-w-2xl rounded-2xl border p-5 text-sm leading-7" style={{ borderColor: "#25425c", background: "rgba(16,34,55,.62)", color: "#b7cbda" }}>
          <h2 className="mb-2 font-bold" style={{ color: "#e9f5ff" }}>How to play</h2>
          <p>Player A moves first. A valid <strong>Move</strong> adds one signal; <strong>End Turn</strong> resolves it and passes control to the other player. Whoever resolves the fourth signal wins. Out-of-turn actions have no effect. Progress is automatically saved, including unfinished turns and wins, so you can reload safely.</p>
        </section>
        <p className="mt-6 text-center text-xs" style={{ color: "#67819b" }}>Signal Sprint · Original test edition v1 · Local two-player</p>
      </div>
    </main>
  );
}
