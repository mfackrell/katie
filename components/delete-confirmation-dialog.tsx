"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface DeleteConfirmationDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Mobile-safe confirmation: embedded browsers can suppress window.confirm(),
 * silently preventing the deletion request from ever being sent.
 */
export function DeleteConfirmationDialog({
  title, description, confirmLabel, busy, error, onConfirm, onCancel,
}: DeleteConfirmationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [busy, onCancel]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/75 px-4 py-6">
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-white/20 bg-zinc-950 p-5 shadow-2xl"
      >
        <h2 id={titleId} className="text-lg font-semibold text-white">{title}</h2>
        <p id={descriptionId} className="mt-3 break-words text-sm text-zinc-300">{description}</p>
        {error ? <p role="alert" className="mt-3 text-sm text-red-300">{error}</p> : null}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="min-h-11 rounded-lg border border-white/20 px-4 py-2 text-sm text-zinc-100 disabled:opacity-40"
          >Cancel</button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="min-h-11 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >{busy ? "Deleting…" : confirmLabel}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
