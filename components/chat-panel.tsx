"use client";

import { FormEvent, useMemo, useState } from "react";
import type { Message } from "@/lib/types/chat";

interface ChatPanelProps {
  actorId: string;
  chatId: string;
}

export function ChatPanel({ actorId, chatId }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<{ provider: string; model: string } | null>(null);

  const canSend = useMemo(() => input.trim().length > 0 && !loading, [input, loading]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) {
      return;
    }

    const content = input.trim();
    setInput("");
    setLoading(true);

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

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId, chatId, message: content })
    });

    const data = (await response.json()) as { text?: string; provider?: string; model?: string; error?: string };

    if (!response.ok) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          chatId,
          role: "assistant",
          content: data.error ?? "Something went wrong.",
          createdAt: new Date().toISOString()
        }
      ]);
      setLoading(false);
      return;
    }

    setMeta({ provider: data.provider ?? "unknown", model: data.model ?? "unknown" });
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        chatId,
        role: "assistant",
        content: data.text ?? "",
        createdAt: new Date().toISOString()
      }
    ]);

    setLoading(false);
  }

  return (
    <main className="flex h-screen flex-1 flex-col">
      <header className="border-b border-zinc-800 px-6 py-4">
        <p className="text-xs uppercase tracking-wide text-zinc-400">Master Router</p>
        <h2 className="text-lg font-semibold">Polyglot Actor Orchestrator</h2>
        {meta ? (
          <p className="mt-1 text-xs text-zinc-400">
            Last response via <span className="text-zinc-200">{meta.provider}</span> · {meta.model}
          </p>
        ) : null}
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
            <p className="mb-1 text-xs uppercase text-zinc-400">{message.role}</p>
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
        ))}
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
