"use client";

import { memo, useCallback, useEffect, useRef, useState, type ClipboardEventHandler, type KeyboardEventHandler, type ReactNode, type MutableRefObject } from "react";

type Props = {
  externalValue: string;
  resetVersion: number;
  currentValueRef: MutableRefObject<string>;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string) => void;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
  actorName: string;
  fileControl: ReactNode;
  emojiControl: ReactNode;
  onCancel: () => void;
  managed: boolean;
  draftReady: boolean;
  attachmentsReady: boolean;
  hasAttachments: boolean;
  composerAttachmentsReady: boolean;
  hasValidChatSelection: boolean;
  loading: boolean;
  uploadingFiles: boolean;
  collaborationActive: boolean;
  routingInFlight: boolean;
  statusMessage: string;
};

/** Keystrokes update only this memoized composer, never the expensive conversation tree. */
export const ChatComposerInput = memo(function ChatComposerInput(props: Props) {
  const [value, setValue] = useState(props.externalValue);
  const lastCommitted = useRef(props.externalValue);
  const lastReset = useRef(props.resetVersion);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeFrame = useRef<number | null>(null);

  useEffect(() => {
    const reset = props.resetVersion !== lastReset.current;
    lastReset.current = props.resetVersion;
    // A delayed echo of what this composer already saved must not erase
    // characters entered after the save was scheduled.
    if (!reset && props.externalValue === lastCommitted.current) return;
    if (!reset && props.externalValue === props.currentValueRef.current) return;
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = null;
    lastCommitted.current = props.externalValue;
    props.currentValueRef.current = props.externalValue;
    setValue(props.externalValue);
  }, [props.externalValue, props.resetVersion, props.currentValueRef]);

  useEffect(() => () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
  }, []);

  const scheduleResize = useCallback(() => {
    if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
    resizeFrame.current = requestAnimationFrame(() => {
      resizeFrame.current = null;
      const textarea = props.textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`;
    });
  }, [props.textareaRef]);

  // External resets queue setValue in an earlier effect; their frame can run
  // before that value commits. Re-measure after the local value is rendered.
  useEffect(() => {
    scheduleResize();
  }, [value, props.resetVersion, scheduleResize]);

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.currentTarget.value;
    props.currentValueRef.current = next;
    setValue(next);
    scheduleResize();
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      lastCommitted.current = next;
      props.onDraftChange(next);
      commitTimer.current = null;
    }, 250);
  };
  const hasText = value.trim().length > 0;
  const canSend = !props.managed && props.draftReady &&
    (props.attachmentsReady || hasText) &&
    (!props.hasAttachments || props.composerAttachmentsReady) &&
    props.hasValidChatSelection &&
    (hasText || props.hasAttachments) && !props.loading && !props.uploadingFiles;
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-2 shadow-[0_14px_36px_rgba(0,0,0,0.2)] backdrop-blur-sm sm:rounded-[28px] sm:p-3 sm:shadow-[0_20px_60px_rgba(0,0,0,0.2)]">
      <div className="flex items-end gap-2">
        {props.fileControl}
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={props.textareaRef}
            rows={1}
            enterKeyHint="send"
            autoComplete="off"
            autoCorrect="on"
            spellCheck
            value={value}
            onChange={onChange}
            onKeyDown={props.onKeyDown}
            onPaste={props.onPaste}
            placeholder={`Ask ${props.actorName || "Katie"}…`}
            className="min-h-[44px] max-h-36 w-full resize-none overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-2.5 text-[16px] leading-6 text-zinc-100 outline-none ring-emerald-500 placeholder:text-zinc-500 focus:ring sm:min-h-[48px] sm:max-h-48 sm:rounded-2xl sm:px-4 sm:py-3 sm:pr-14 sm:text-sm"
          />
          {props.emojiControl}
        </div>
        <div className="flex flex-none items-end gap-2">
          {props.loading ? (
            <button type="button" onClick={props.onCancel}
              className="h-11 rounded-xl border border-red-400/30 bg-red-500/10 px-3 text-xs font-medium text-red-100 transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 sm:rounded-2xl sm:px-4 sm:text-sm">
              Cancel
            </button>
          ) : null}
          <button type="submit" disabled={!canSend}
            className="h-11 min-w-16 flex-none rounded-xl bg-gradient-to-r from-emerald-500 to-sky-500 px-4 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(16,185,129,0.25)] transition active:scale-95 disabled:opacity-50 sm:rounded-2xl sm:px-5 sm:py-3">
            {props.uploadingFiles ? "Uploading..." : props.loading
              ? props.collaborationActive ? "Collaborating..."
                : props.routingInFlight ? "Routing..."
                : props.statusMessage.toLowerCase().includes("synthes") ? "Synthesizing..." : "Thinking..."
              : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
});
