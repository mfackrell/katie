"use client";

import { useEffect, useRef, useState } from "react";
import { type Action, decodeState, encodeState, initialState, isBeacon, STORAGE_KEY, transition } from "./engine";
import styles from "./relay.module.css";

export default function BeaconRelay() {
  const [state, setState] = useState(initialState);
  const current = useRef(state);
  const [ready, setReady] = useState(false);
  const [storageWarning, setStorageWarning] = useState("");
  useEffect(() => {
    try {
      const loaded = decodeState(window.localStorage.getItem(STORAGE_KEY));
      current.current = loaded;
      setState(loaded);
    } catch { setStorageWarning("Browser storage is unavailable. This game will last until you close or reload this page."); }
    setReady(true);
  }, []);

  function act(action: Action) {
    if (!ready) return;
    const next = transition(current.current, action);
    if (next === current.current) return;
    current.current = next;
    // Save synchronously with each accepted action, including Reset, so a
    // navigation immediately after a click cannot lose an intermediate phase.
    try { window.localStorage.setItem(STORAGE_KEY, encodeState(next)); }
    catch { setStorageWarning("Browser storage is unavailable. This game will last until you close or reload this page."); }
    setState(next);
  }

  return (
    <main className={styles.game}>
      <p className={styles.eyebrow}>A local game for two people</p>
      <h1>Beacon Relay Duel</h1>
      <p>Race to light two beacons. Pass the turn, plan your path.</p>
      <section className={styles.status} aria-label="Game status" aria-live="polite">
        <p>Active player: <strong id="active-player">{state.activePlayer}</strong></p>
        <p>Phase: <strong id="phase">{state.phase}</strong></p>
        <p>Turn: <strong id="turn-number">{state.turn}</strong></p>
        <p>Winner: <strong id="winner">{state.winner ?? "None"}</strong></p>
      </section>
      <section className={styles.scores} aria-label="Players">
        <p><span className={styles.red}>● Red</span> · Score <strong id="red-score">{state.scores.Red}</strong> · Position <span id="red-position">{state.positions.Red}</span></p>
        <p><span className={styles.blue}>● Blue</span> · Score <strong id="blue-score">{state.scores.Blue}</strong> · Position <span id="blue-position">{state.positions.Blue}</span></p>
      </section>
      <div className={styles.board} role="group" aria-label="4 by 4 board, cells 0 through 15">
        {Array.from({ length: 16 }, (_, cell) => {
          const token = state.positions.Red === cell ? "Red" : state.positions.Blue === cell ? "Blue" : null;
          return <button key={cell} id={`cell-${cell}`} type="button" disabled={!ready}
            className={`${styles.cell} ${isBeacon(cell) ? styles.beacon : ""}`}
            aria-label={`Cell ${cell}${isBeacon(cell) ? ", beacon" : ""}${token ? `, ${token} token` : ", empty"}`}
            onClick={() => act({ type: "MOVE", cell })}>
            <span className={styles.index}>{cell}</span>
            {token && <span className={token === "Red" ? styles.red : styles.blue}>{token === "Red" ? "● R" : "● B"}</span>}
            {isBeacon(cell) && <small>Beacon</small>}
          </button>;
        })}
      </div>
      <div className={styles.actions}>
        <button id="end-turn" type="button" disabled={!ready} onClick={() => act({ type: "END_TURN" })}>End Turn</button>
        <button id="reset" type="button" disabled={!ready} onClick={() => act({ type: "RESET" })}>Reset</button>
      </div>
      {!ready && <p role="status">Loading saved game…</p>}
      {storageWarning && <p role="status">{storageWarning}</p>}
      <section className={styles.instructions} aria-label="How to play">
        <h2>How to play</h2>
        <p>Red goes first. In MOVE, click an empty tile directly above, below, left or right of your token. You must move exactly one tile; diagonals and occupied tiles are forbidden.</p>
        <p>After moving, the phase is RESOLVE. Click End Turn to score one point if you landed on a beacon (5 or 10), then pass to the other player. End Turn does nothing before you move. You must move again on your next turn.</p>
        <p>The first player to reach 2 points wins. Reset starts a fresh game. Your game saves automatically in this browser, including a move awaiting resolution.</p>
      </section>
    </main>
  );
}
