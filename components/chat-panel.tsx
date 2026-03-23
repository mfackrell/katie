"use client";

import Image from "next/image";
import {
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileReference } from "@/lib/providers/types";
import type { Message } from "@/lib/types/chat";

type ProviderName = "openai" | "google" | "grok" | "anthropic";

type AvailableModels = Partial<Record<ProviderName, string[]>>;

type SelectedOverride = {
  providerName: ProviderName;
  modelId: string;
} | null;

interface ChatPanelProps {
  actorId: string;
  chatId: string;
}

export function ChatPanel({ actorId, chatId }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<{ provider: string; model: string } | null>(
    null,
  );
  const [availableModels, setAvailableModels] = useState<AvailableModels>({});
  const [selectedOverride, setSelectedOverride] =
    useState<SelectedOverride>(null);
  const [streamingModel, setStreamingModel] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [fileReferences, setFileReferences] = useState<FileReference[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const messagesContainerRef = useRef<HTMLElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const copiedFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const canSend = useMemo(
    () =>
      (input.trim().length > 0 ||
        selectedImages.length > 0 ||
        selectedFiles.length > 0 ||
        fileReferences.length > 0) &&
      !loading &&
      !uploadingFiles,
    [
      input,
      loading,
      selectedFiles.length,
      selectedImages.length,
      uploadingFiles,
      fileReferences.length,
    ],
  );

  const scrollToTop = () => {
    messagesContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const scrollToBottom = () => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      return;
    }

    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    async function fetchModels() {
      const response = await fetch("/api/models");
      const data = (await response.json()) as AvailableModels;

      if (!response.ok) {
        return;
      }

      setAvailableModels(data);
    }

    void fetchModels();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  useEffect(() => {
    abortControllerRef.current?.abort();
    setMessages([]);
    setMeta(null);
    setStatusMessage("");
    setStreamingModel(null);
    setCopiedMessageId(null);
  }, [actorId, chatId]);

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
      if (copiedFeedbackTimeoutRef.current) {
        clearTimeout(copiedFeedbackTimeoutRef.current);
      }
    },
    [],
  );

  async function uploadFiles(files: File[]): Promise<FileReference[]> {
    if (files.length === 0) {
      return [];
    }

    setUploadingFiles(true);
    setStatusMessage(
      `Uploading ${files.length} file${files.length > 1 ? "s" : ""}...`,
    );

    try {
      const formData = new FormData();
      files.forEach((file) => {
        formData.append("files", file);
      });

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json()) as {
        fileReferences?: FileReference[];
        error?: string;
      };

      if (!response.ok || !payload.fileReferences) {
        throw new Error(payload.error ?? "File upload failed.");
      }

      setStatusMessage(
        `Uploaded ${payload.fileReferences.length} file${payload.fileReferences.length > 1 ? "s" : ""}.`,
      );
      return payload.fileReferences;
    } finally {
      setUploadingFiles(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) {
      return;
    }

    const content = input.trim();
    const imagesToSend = [...selectedImages];
    const filesToUpload = [...selectedFiles];
    const priorReferences = [...fileReferences];
    const hasImages = imagesToSend.length > 0;

    setInput("");
    setSelectedImages([]);
    setSelectedFiles([]);
    setFileReferences([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setLoading(true);
    setStreamingModel(null);

    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        chatId,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      const uploadedReferences =
        filesToUpload.length > 0 ? await uploadFiles(filesToUpload) : [];
      const refsToSend = [...priorReferences, ...uploadedReferences];

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        signal: abortController.signal,
        body: JSON.stringify({
          actorId,
          chatId,
          message: content || (hasImages ? "[image]" : "[file]"),
          images: imagesToSend,
          fileReferences: refsToSend,
          overrideProvider: selectedOverride?.providerName,
          overrideModel: selectedOverride?.modelId,
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            chatId,
            role: "assistant",
            content: errorData.error ?? "Something went wrong.",
            createdAt: new Date().toISOString(),
          },
        ]);
        setStatusMessage(errorData.error ?? "Message failed.");
        return;
      }

      if (!response.body) {
        throw new Error("Missing response stream from /api/chat.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let textContent = "";
      let assets: Array<{ type: string; url: string }> = [];
      let provider = "unknown";
      let model = "unknown";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const chunk = JSON.parse(line) as
            | { type: "metadata"; modelId: string; provider: string }
            | {
                type: "content";
                text: string;
                assets?: Array<{ type: string; url: string }>;
                provider?: string;
                model?: string;
              };

          if (chunk.type === "metadata") {
            setStreamingModel(chunk.modelId);
            provider = chunk.provider;
          }

          if (chunk.type === "content") {
            textContent += chunk.text;
            if (chunk.assets?.length) {
              assets = [...assets, ...chunk.assets];
            }
            provider = chunk.provider ?? provider;
            model = chunk.model ?? model;
          }
        }
      }

      if (buffered.trim()) {
        const trailingChunk = JSON.parse(buffered) as
          | { type: "metadata"; modelId: string; provider: string }
          | {
              type: "content";
              text: string;
              assets?: Array<{ type: string; url: string }>;
              provider?: string;
              model?: string;
            };

        if (trailingChunk.type === "metadata") {
          setStreamingModel(trailingChunk.modelId);
          provider = trailingChunk.provider;
        }

        if (trailingChunk.type === "content") {
          textContent += trailingChunk.text;
          if (trailingChunk.assets?.length) {
            assets = [...assets, ...trailingChunk.assets];
          }
          provider = trailingChunk.provider ?? provider;
          model = trailingChunk.model ?? model;
        }
      }

      abortControllerRef.current = null;
      setMeta({ provider, model });
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          chatId,
          role: "assistant",
          model,
          content: textContent,
          assets,
          createdAt: new Date().toISOString(),
        },
      ]);
      setStatusMessage("Response received.");
    } catch (error: unknown) {
      abortControllerRef.current = null;

      if (error instanceof DOMException && error.name === "AbortError") {
        setStatusMessage("Request canceled.");
        return;
      }

      const message =
        error instanceof Error ? error.message : "Something went wrong.";
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          chatId,
          role: "assistant",
          content: message,
          createdAt: new Date().toISOString(),
        },
      ]);
      setStatusMessage(message);
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
      setStreamingModel(null);
    }
  }

  function handleCancelRequest() {
    abortControllerRef.current?.abort();
  }

  async function handleCopyMessage(messageId: string, content: string) {
    await navigator.clipboard.writeText(content);
    setCopiedMessageId(messageId);

    if (copiedFeedbackTimeoutRef.current) {
      clearTimeout(copiedFeedbackTimeoutRef.current);
    }

    copiedFeedbackTimeoutRef.current = setTimeout(() => {
      setCopiedMessageId((current) => (current === messageId ? null : current));
    }, 1500);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void onSubmit(event);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData.items;

    for (const item of items) {
      if (!item.type.startsWith("image/")) {
        continue;
      }

      const file = item.getAsFile();
      if (!file) {
        continue;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;

        if (typeof result === "string") {
          setSelectedImages((current) => [...current, result]);
        }
      };
      reader.readAsDataURL(file);
    }
  }

  function handleFileChange(event: FormEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);

    if (files.length === 0) {
      return;
    }

    const nextFiles = files.filter((file) => !file.type.startsWith("image/"));
    setSelectedFiles((current) => [...current, ...nextFiles]);
    setStatusMessage(
      `${nextFiles.length} non-image file${nextFiles.length === 1 ? "" : "s"} ready for upload.`,
    );

    files
      .filter((file) => file.type.startsWith("image/"))
      .forEach((file) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result;

          if (typeof result === "string") {
            setSelectedImages((current) => [...current, result]);
          }
        };
        reader.readAsDataURL(file);
      });
  }

  function handleInputChange(event: FormEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    setInput(textarea.value);

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`;
  }

  useEffect(() => {
    if (!textareaRef.current || input.length !== 0) {
      return;
    }

    textareaRef.current.style.height = "auto";
  }, [input]);

  const providerNames = Object.keys(availableModels) as ProviderName[];

  async function handleDownload(imageUrl: string, filename: string) {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Image download failed with status ${response.status}`);
      }

      const imageBlob = await response.blob();
      const blobUrl = URL.createObjectURL(imageBlob);

      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(imageUrl, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <main className="relative flex h-[calc(100vh-2rem)] flex-1 flex-col overflow-hidden bg-gradient-to-b from-white/[0.02] via-transparent to-black/10">
      <header className="border-b border-white/10 px-4 py-3 sm:px-6 sm:py-3.5">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br from-sky-400/15 via-white/10 to-emerald-400/10 shadow-[0_8px_24px_rgba(0,0,0,0.24)]">
                <span className="text-sm">✦</span>
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-500">
                  Master Router
                </p>
                <h2 className="truncate text-lg font-semibold tracking-tight text-white sm:text-xl">
                  Katie - AI Command Center
                </h2>
              </div>
            </div>

            {meta ? (
              <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]" />
                Last response via <span className="text-zinc-200">{meta.provider}</span> · {meta.model}
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-2 overflow-x-auto">
            {providerNames.map((providerName) => {
              const options = availableModels[providerName] ?? [];
              const selectedValue =
                selectedOverride?.providerName === providerName
                  ? selectedOverride.modelId
                  : "";

              return (
                <label
                  key={providerName}
                  className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.035] px-2.5 py-1.5 text-[11px] text-zinc-300"
                >
                  <span className="capitalize text-zinc-500">{providerName}</span>
                  <select
                    value={selectedValue}
                    onChange={(event) => {
                      const nextModel = event.target.value;
                      setSelectedOverride(
                        nextModel ? { providerName, modelId: nextModel } : null,
                      );
                    }}
                    className="min-w-0 rounded-lg border border-white/10 bg-zinc-950/90 px-2 py-1 text-[11px] text-zinc-100 outline-none ring-emerald-500 transition focus:ring"
                  >
                    <option value="">Master Router (Auto)</option>
                    {options.map((modelId) => (
                      <option key={modelId} value={modelId}>
                        {modelId}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        </div>
      </header>

      <section
        ref={messagesContainerRef}
        className="flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5"
      >
        {messages.length === 0 ? (
          <div className="max-w-2xl rounded-[28px] border border-white/10 bg-white/[0.035] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-sm">
            <p className="text-sm font-medium text-zinc-200">Ready for orchestration.</p>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              Start a new message to invoke the master router.
            </p>
          </div>
        ) : null}
        {messages.map((message) => (
          <div
            key={message.id}
            className={[
              "max-w-4xl rounded-[28px] border px-5 py-4 text-sm shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-sm",
              message.role === "user"
                ? "ml-auto border-emerald-400/20 bg-gradient-to-br from-emerald-400/14 via-emerald-500/8 to-sky-500/10"
                : "border-white/10 bg-white/[0.035]"
            ].join(" ")}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-400">
                {message.role}
                {message.role === "assistant" && message.model
                  ? ` (${message.model})`
                  : ""}
              </p>
              <button
                type="button"
                onClick={() =>
                  void handleCopyMessage(message.id, message.content ?? "")
                }
                className="rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                {copiedMessageId === message.id ? "Copied" : "Copy"}
              </button>
            </div>
            {message.content ? (
              <p className="whitespace-pre-wrap leading-7 text-zinc-100/95">{message.content}</p>
            ) : null}
            {message.assets
              ?.filter((asset) => asset.type === "image")
              .map((asset) => (
                <div key={asset.url} className="group relative mt-4">
                  <div className="relative h-80 w-full overflow-hidden rounded-[22px] border border-white/10 bg-black/20">
                    <Image
                      src={asset.url}
                      alt="Generated asset"
                      fill
                      sizes="(max-width: 768px) 100vw, 768px"
                      className="object-contain"
                      unoptimized
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void handleDownload(
                        asset.url,
                        `katie-generated-${Date.now()}.png`,
                      )
                    }
                    className="absolute right-3 top-3 rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-1.5 text-xs font-medium text-white opacity-0 transition-opacity hover:bg-zinc-900 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 group-hover:opacity-100"
                  >
                    Download
                  </button>
                </div>
              ))}
          </div>
        ))}
        {loading && (
          <div className="flex w-fit items-center gap-3 rounded-[24px] border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-zinc-300 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-sm">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
            <p className="italic text-zinc-400">
              {uploadingFiles
                ? "Uploading attachments..."
                : `${streamingModel ?? selectedOverride?.modelId ?? "Master Router"} is thinking...`}
            </p>
          </div>
        )}
        <div className="sticky bottom-4 z-10 ml-auto flex w-fit flex-col gap-2 pr-1">
          <button
            type="button"
            onClick={scrollToTop}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-zinc-950/80 text-sm text-zinc-200 shadow-[0_14px_30px_rgba(0,0,0,0.3)] backdrop-blur transition hover:border-white/20 hover:bg-zinc-900/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label="Scroll to top"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-zinc-950/80 text-sm text-zinc-200 shadow-[0_14px_30px_rgba(0,0,0,0.3)] backdrop-blur transition hover:border-white/20 hover:bg-zinc-900/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label="Scroll to bottom"
          >
            ↓
          </button>
        </div>
        <div ref={messagesEndRef} />
      </section>

      <form onSubmit={onSubmit} className="border-t border-white/10 px-4 py-4 sm:px-6 sm:py-4">
        <p className="sr-only" role="status" aria-live="polite">
          {statusMessage}
        </p>

        {selectedImages.length > 0 ? (
          <div className="mb-4 flex flex-wrap gap-3">
            {selectedImages.map((image, index) => (
              <div
                key={`${image.slice(0, 32)}-${index}`}
                className="relative h-24 w-24 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]"
              >
                <Image
                  src={image}
                  alt={`Selected image ${index + 1}`}
                  fill
                  sizes="96px"
                  className="object-cover"
                  unoptimized
                />
                <button
                  type="button"
                  onClick={() =>
                    setSelectedImages((current) =>
                      current.filter(
                        (_, currentIndex) => currentIndex !== index,
                      ),
                    )
                  }
                  className="absolute right-1.5 top-1.5 rounded-full bg-red-500/90 px-1.5 py-0.5 text-xs text-white shadow-lg"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {selectedFiles.length > 0 ? (
          <ul
            className="mb-4 space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-zinc-400"
            aria-live="polite"
          >
            {selectedFiles.map((file, index) => (
              <li key={`${file.name}-${index}`}>📄 {file.name}</li>
            ))}
          </ul>
        ) : null}

        <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-3 shadow-[0_20px_60px_rgba(0,0,0,0.2)] backdrop-blur-sm">
          <div className="flex items-end gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.txt,.md,.json,.csv"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-2xl border border-white/10 bg-white/[0.05] px-3.5 py-3 text-sm text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              aria-label="Attach files"
            >
              📷
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Ask your actor something..."
              className="min-h-[48px] max-h-48 flex-1 resize-none overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950/80 px-4 py-3 text-sm text-zinc-100 outline-none ring-emerald-500 placeholder:text-zinc-500 focus:ring"
            />
            {loading ? (
              <button
                type="button"
                onClick={handleCancelRequest}
                className="rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-100 transition hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
              >
                Cancel
              </button>
            ) : null}
            <button
              type="submit"
              disabled={!canSend}
              className="rounded-2xl bg-gradient-to-r from-emerald-500 to-sky-500 px-5 py-3 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(16,185,129,0.25)] transition hover:brightness-110 disabled:opacity-50"
            >
              {loading || uploadingFiles ? "Routing..." : "Send"}
            </button>
          </div>
        </div>
      </form>
    </main>
  );
}
