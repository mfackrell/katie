"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Message } from "@/lib/types/chat";

type ProviderName = "openai" | "google";

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
  const [meta, setMeta] = useState<{ provider: string; model: string } | null>(null);
  const [availableModels, setAvailableModels] = useState<AvailableModels>({});
  const [selectedOverride, setSelectedOverride] = useState<SelectedOverride>(null);
  const [streamingModel, setStreamingModel] = useState<string | null>(null);

  const canSend = useMemo(() => input.trim().length > 0 && !loading, [input, loading]);

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

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) {
      return;
    }

    const content = input.trim();
    setInput("");
    setLoading(true);
    setStreamingModel(null);

    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        chatId,
        role: "user",
        content,
        createdAt: new Date().toISOString()
      }
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId,
          chatId,
          message: content,
          overrideProvider: selectedOverride?.providerName,
          overrideModel: selectedOverride?.modelId
        })
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
            createdAt: new Date().toISOString()
          }
        ]);
        return;
      }

      const headerRoutingModel = response.headers.get("X-Routing-Model");
      if (headerRoutingModel) {
        setStreamingModel(headerRoutingModel);
      }

      if (!response.body) {
        throw new Error("Missing response stream from /api/chat.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let textContent = "";
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
            | { type: "content"; text: string; provider?: string; model?: string };

          if (chunk.type === "metadata") {
            setStreamingModel(chunk.modelId);
            provider = chunk.provider;
          }

          if (chunk.type === "content") {
            textContent += chunk.text;
            provider = chunk.provider ?? provider;
            model = chunk.model ?? model;
          }
        }
      }

      if (buffered.trim()) {
        const trailingChunk = JSON.parse(buffered) as
          | { type: "metadata"; modelId: string; provider: string }
          | { type: "content"; text: string; provider?: string; model?: string };

        if (trailingChunk.type === "metadata") {
          setStreamingModel(trailingChunk.modelId);
          provider = trailingChunk.provider;
        }

        if (trailingChunk.type === "content") {
          textContent += trailingChunk.text;
          provider = trailingChunk.provider ?? provider;
          model = trailingChunk.model ?? model;
        }
      }

      setMeta({ provider, model });
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          chatId,
          role: "assistant",
          model,
          content: textContent,
          createdAt: new Date().toISOString()
        }
      ]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          chatId,
          role: "assistant",
          content: message,
          createdAt: new Date().toISOString()
        }
      ]);
    } finally {
      setLoading(false);
      setStreamingModel(null);
    }
  }

  const providerNames = Object.keys(availableModels) as ProviderName[];

  return (
    <main className="flex h-screen flex-1 flex-col">
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-400">Master Router</p>
            <h2 className="text-lg font-semibold">Polyglot Actor Orchestrator</h2>
            {meta ? (
              <p className="mt-1 text-xs text-zinc-400">
                Last response via <span className="text-zinc-200">{meta.provider}</span> · {meta.model}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {providerNames.map((providerName) => {
              const options = availableModels[providerName] ?? [];
              const selectedValue =
                selectedOverride?.providerName === providerName ? selectedOverride.modelId : "";

              return (
                <label key={providerName} className="flex items-center gap-2 text-xs text-zinc-300">
                  <span className="capitalize text-zinc-400">{providerName}</span>
                  <select
                    value={selectedValue}
                    onChange={(event) => {
                      const nextModel = event.target.value;
                      setSelectedOverride(
                        nextModel ? { providerName, modelId: nextModel } : null
                      );
                    }}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none ring-emerald-500 focus:ring"
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

      <section className="flex-1 space-y-3 overflow-y-auto p-6">
        {messages.length === 0 ? (
          <p className="text-sm text-zinc-500">Start a new message to invoke the master router.</p>
        ) : null}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`max-w-3xl rounded-lg border px-4 py-3 text-sm ${
              message.role === "user"
                ? "ml-auto border-emerald-700 bg-emerald-950/50"
                : "border-zinc-700 bg-zinc-900"
            }`}
          >
            <p className="mb-1 text-xs uppercase text-zinc-400">
              {message.role}{message.role === "assistant" && message.model ? ` (${message.model})` : ""}
            </p>
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
        ))}
        {loading && (
          <div className="flex w-fit items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-400">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            <p className="italic">
              {streamingModel ?? selectedOverride?.modelId ?? "Master Router"} is thinking...
            </p>
          </div>
        )}
      </section>

      <form onSubmit={onSubmit} className="border-t border-zinc-800 p-4">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask your actor something..."
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none ring-emerald-500 focus:ring"
          />
          <button
            type="submit"
            disabled={!canSend}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? "Routing..." : "Send"}
          </button>
        </div>
      </form>
    </main>
  );
}
