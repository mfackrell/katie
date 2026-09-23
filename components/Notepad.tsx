"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "global-notepad";

export default function Notepad() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      setText(saved);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, text);
  }, [text]);

  return (
    <>
      <button
        aria-label="Open notepad"
        onClick={() => setOpen(true)}
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] right-3 z-50 flex h-11 w-11 items-center justify-center rounded-full bg-blue-600 p-0 text-sm font-medium text-white shadow-lg transition active:scale-95 hover:bg-blue-700 sm:bottom-4 sm:right-4 sm:h-auto sm:w-auto sm:px-4 sm:py-2"
      >
        <span aria-hidden>📝</span><span className="hidden sm:inline"> Notepad</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center">
          <div className="h-[72dvh] w-full overflow-auto rounded-t-2xl bg-zinc-950 p-4 text-zinc-100 shadow-2xl sm:h-auto sm:w-[90%] sm:max-w-2xl sm:resize sm:rounded-lg sm:bg-white sm:text-zinc-900">
            <div className="mb-3 flex justify-between">
              <h2 className="text-lg font-semibold">Notepad</h2>
              <button
                aria-label="Close notepad"
                onClick={() => setOpen(false)}
                className="text-zinc-400 hover:text-zinc-200 sm:text-gray-500 sm:hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            <textarea
              aria-label="Notepad text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="h-[calc(72dvh-4.5rem)] w-full resize-none rounded-xl border border-white/10 bg-zinc-900 p-3 font-mono text-[16px] text-zinc-100 focus:border-blue-500 focus:outline-none sm:h-64 sm:resize-y sm:rounded sm:border-gray-300 sm:bg-white sm:p-2 sm:text-sm sm:text-zinc-900"
            />
          </div>
        </div>
      )}
    </>
  );
}
