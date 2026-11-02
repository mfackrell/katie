import { initialState, type GameState } from "./engine";

export const STORAGE_KEY = "katie.takeEleven.v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Accept only reachable v1 states, including the opening turn's ownership. */
export function isSavedState(value: unknown): value is GameState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as GameState;
  if (!Number.isInteger(s.stones) || s.stones < 0 || s.stones > 11 ||
      (s.player !== "A" && s.player !== "B")) return false;
  if (s.stones === 0) return s.phase === "FINISHED" && s.winner === s.player;
  if (s.phase !== "IN_PROGRESS" || s.winner !== null) return false;
  const removed = 11 - s.stones;
  // A turn removes 1..3 stones; ownership follows the number of turns.
  for (let turns = Math.ceil(removed / 3); turns <= removed; turns++) {
    if (s.player === (turns % 2 === 0 ? "A" : "B")) return true;
  }
  return false;
}

export function loadGame(storage: Storage): GameState {
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    if (isSavedState(value)) return {
      stones: value.stones, player: value.player, phase: value.phase, winner: value.winner,
    };
  } catch { /* Unavailable or corrupt storage must not prevent play. */ }
  return { ...initialState };
}

export function saveGame(storage: Storage, state: GameState): boolean {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
  catch { return false; }
}
