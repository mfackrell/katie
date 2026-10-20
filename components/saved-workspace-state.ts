"use client";
import { useCallback, useEffect, useRef, useState } from "react";
export type UIState = {
  key: string;
  version: number;
  updated_at?: string;
  value: {
    draft?: string;
    repoId?: string | null;
    repoSource?: boolean;
    archived?: boolean;
    pinned?: boolean;
    readAt?: string;
    notes?: string;
    audience?: string;
    summary?: string;
    creator?: string;
    reason?: string;
    scroll?: number;
  };
};
// Shared by context controls and composer, so independent UI surfaces cannot race their version checks.
const current = new Map<string, UIState>(),
  queues = new Map<string, Promise<unknown>>();
export function useSavedState(key: string) {
  const [state, setState] = useState<UIState | null>(null),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    mounted = useRef(false);
  const publish = useCallback(
    (next: UIState) => {
      const prior = current.get(key);
      if (prior && prior.version > next.version) return;
      current.set(key, next);
      window.dispatchEvent(new CustomEvent("katie:ui-state", { detail: next }));
    },
    [key],
  );
  const reload = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/ui-state?key=${encodeURIComponent(key)}`,
        { cache: "no-store" },
      );
      if (!response.ok)
        throw Error(
          "Saved preferences unavailable; local changes remain in this browser.",
        );
      const payload = await response.json();
      publish(payload.state);
      if (mounted.current) setError("");
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "Saved state unavailable");
    }
  }, [key, publish]);
  useEffect(() => {
    mounted.current = true;
    setState(null);
    const receive = (event: Event) => {
      const next = (event as CustomEvent<UIState>).detail;
      if (next.key === key) setState(next);
    };
    window.addEventListener("katie:ui-state", receive);
    if (current.has(key)) setState(current.get(key)!);
    void reload();
    return () => {
      mounted.current = false;
      window.removeEventListener("katie:ui-state", receive);
    };
  }, [key, reload]);
  const save = useCallback(
    async (value: UIState["value"]) => {
      const work = async () => {
        const latest = current.get(key);
        if (!latest) return false;
        if (mounted.current) setSaving(true);
        try {
          const response = await fetch("/api/ui-state", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, value, version: latest.version }),
          });
          const payload = await response.json();
          if (!response.ok) throw Error(payload.error ?? "Could not save");
          publish(payload.state);
          if (mounted.current) setError("");
          return true;
        } catch (e) {
          if (mounted.current)
            setError(e instanceof Error ? e.message : "Could not save");
          return false;
        } finally {
          if (mounted.current) setSaving(false);
        }
      };
      const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
      queues.set(key, next);
      return next;
    },
    [key, publish],
  );
  return { state, error, saving, save, reload };
}
