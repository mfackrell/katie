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
        className="fixed bottom-4 right-4 z-50 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg hover:bg-blue-700"
      >
        📝 Notepad
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[90%] max-w-2xl resize overflow-auto rounded-lg bg-white p-4 shadow-xl">
            <div className="mb-2 flex justify-between">
              <h2 className="text-lg font-semibold">Notepad</h2>
              <button
                aria-label="Close notepad"
                onClick={() => setOpen(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            <textarea
              aria-label="Notepad text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="h-64 w-full resize-y rounded border border-gray-300 p-2 font-mono text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
      )}
    </>
  );
}
