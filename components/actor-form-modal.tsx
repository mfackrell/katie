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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-md">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.14),transparent_30%),radial-gradient(circle_at_bottom,rgba(16,185,129,0.12),transparent_28%)]" />
      <form className="relative w-full max-w-xl overflow-hidden rounded-[30px] border border-white/10 bg-zinc-950/95 p-6 shadow-[0_30px_90px_rgba(0,0,0,0.5)] backdrop-blur-xl" onSubmit={handleSubmit}>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.05] via-transparent to-transparent" />
        <div className="relative">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-zinc-500">Actor setup</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">{title}</h2>
              <p className="mt-2 text-sm text-zinc-400">Configure the identity and execution context without changing any underlying workflow.</p>
            </div>
            <button
              type="button"
              className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
              onClick={onClose}
              disabled={submitting}
            >
              Close
            </button>
          </div>

          <div className="space-y-4">
            <label className="block text-sm font-medium text-zinc-200">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-zinc-500">Name</span>
              <input
                className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-zinc-100 outline-none ring-emerald-500 placeholder:text-zinc-500 focus:ring"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={mode === "primary" ? "Financial Analyst" : "Q3 Specific Analysis"}
              />
            </label>

            <label className="block text-sm font-medium text-zinc-200">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-zinc-500">Purpose / System Prompt</span>
              <textarea
                className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-zinc-100 outline-none ring-emerald-500 placeholder:text-zinc-500 focus:ring"
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                rows={5}
                readOnly={mode === "sub"}
                placeholder="Describe this actor's persona and goals."
              />
            </label>

            {mode === "sub" ? (
              <p className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs leading-6 text-zinc-400">Sub-actors inherit the parent purpose and start with an empty chat history.</p>
            ) : null}

            {error ? <p className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p> : null}
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.07] hover:text-white"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-2xl bg-gradient-to-r from-sky-500 to-emerald-500 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(14,165,233,0.25)] transition hover:brightness-110 disabled:opacity-70"
              disabled={submitting}
            >
              {submitting ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
