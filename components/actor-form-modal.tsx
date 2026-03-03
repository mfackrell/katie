"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Actor } from "@/lib/types/chat";

interface ActorFormModalProps {
  mode: "primary" | "sub";
  parentActor?: Actor;
  onClose: () => void;
  onCreate: (input: { name: string; purpose?: string; parentId?: string }) => Promise<void>;
}

export function ActorFormModal({ mode, parentActor, onClose, onCreate }: ActorFormModalProps) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "sub" && parentActor) {
      setPurpose(parentActor.purpose);
    }
  }, [mode, parentActor]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    if (mode === "primary" && !purpose.trim()) {
      setError("Purpose is required for primary actors.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await onCreate({
        name: name.trim(),
        purpose: mode === "primary" ? purpose.trim() : undefined,
        parentId: mode === "sub" ? parentActor?.id : undefined
      });
      onClose();
    } catch (submissionError: unknown) {
      setError(submissionError instanceof Error ? submissionError.message : "Failed to create actor.");
    } finally {
      setSubmitting(false);
    }
  }

  const title = mode === "primary" ? "Create New Actor" : `Create Sub-Actor from ${parentActor?.name ?? "Parent"}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form className="w-full max-w-xl rounded-lg border border-zinc-700 bg-zinc-900 p-4" onSubmit={handleSubmit}>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <div className="mt-4 space-y-3">
          <label className="block text-sm text-zinc-300">
            Name
            <input
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={mode === "primary" ? "Financial Analyst" : "Q3 Specific Analysis"}
            />
          </label>

          <label className="block text-sm text-zinc-300">
            Purpose / System Prompt
            <textarea
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              rows={5}
              readOnly={mode === "sub"}
              placeholder="Describe this actor's persona and goals."
            />
          </label>

          {mode === "sub" ? (
            <p className="text-xs text-zinc-400">Sub-actors inherit the parent purpose and start with an empty chat history.</p>
          ) : null}

          {error ? <p className="text-sm text-red-400">{error}</p> : null}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-70"
            disabled={submitting}
          >
            {submitting ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
