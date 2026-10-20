"use client";
import { useCallback, useEffect, useRef, useState } from "react";
export function useResource<T>(url: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [checked, setChecked] = useState<string | null>(null),
    [revision, setRevision] = useState(0),
    lastUrl = useRef("");
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    let active = true,
      busy = false;
    const controller = new AbortController();
    if (lastUrl.current !== url) {
      lastUrl.current = url;
      setData(null);
      setError("");
      setLoading(true);
      setChecked(null);
    }
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok)
          throw Error("Status unavailable. Retry the connection.");
        const payload = (await response.json()) as T;
        if (active) {
          setData(payload);
          setError("");
          setChecked(new Date().toISOString());
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "Connection unavailable");
      } finally {
        busy = false;
        if (active) setLoading(false);
      }
    };
    const focus = () => {
      if (!document.hidden) void load();
    };
    void load();
    const timer = setInterval(focus, 15000);
    window.addEventListener("focus", focus);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [url, revision]);
  return { data, error, loading, checked, refresh };
}
