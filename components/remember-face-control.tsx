"use client";

import { FormEvent, useId, useState } from "react";

interface RememberFaceControlProps {
  actorId: string;
  chatId: string;
  messageId: string;
  assetIndex: number;
}

/**
 * Use an in-page editor rather than window.prompt/alert. Browser/PWA prompt
 * dialogs can be suppressed (especially on mobile), leaving a dead button
 * and no request to /api/visual-references.
 */
export function RememberFaceControl({
  actorId,
  chatId,
  messageId,
  assetIndex,
}: RememberFaceControlProps) {
  const nameId = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const label = name.trim();
    if (label.length < 2) {
      setError("Enter the person's name.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/visual-references", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId, chatId, messageId, assetIndex, label }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; approved?: boolean };
      if (!response.ok || body.approved !== true) {
        throw new Error(body.error || "Katie could not save this face. Try again.");
      }
      setSavedName(label);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Katie could not save this face.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="absolute bottom-3 right-3 z-20 max-w-[calc(100%-1.5rem)]">
      {editing ? (
        <form
          onSubmit={save}
          className="w-64 max-w-full rounded-xl border border-white/20 bg-zinc-950/95 p-3 text-white shadow-xl backdrop-blur"
        >
          <label htmlFor={nameId} className="mb-2 block text-xs font-medium">
            Whose face should Katie remember?
          </label>
          <input
            id={nameId}
            autoFocus
            type="text"
            autoComplete="off"
            maxLength={80}
            value={name}
            onChange={(event) => { setName(event.target.value); setError(""); }}
            placeholder="Person's name"
            disabled={saving}
            className="w-full rounded-lg border border-white/20 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          />
          {error && <p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="submit"
              disabled={saving || name.trim().length < 2}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save face"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => { setEditing(false); setError(""); }}
              className="rounded-lg border border-white/20 px-3 py-2 text-xs text-zinc-200 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => { setError(""); setEditing(true); }}
          className="rounded-xl border border-white/10 bg-zinc-950/90 px-3 py-2 text-xs font-medium text-white shadow-lg hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          aria-label={savedName ? "Face saved as " + savedName + ". Edit saved face." : "Remember this face"}
        >
          {savedName ? "✓ Saved: " + savedName + " · Edit" : "Remember this face"}
        </button>
      )}
    </div>
  );
}
