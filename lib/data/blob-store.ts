import { demoActors } from "@/lib/data/mock";
import type { Actor, Message } from "@/lib/types/chat";

const memoryMessages = new Map<string, Message[]>();
const memorySummaries = new Map<string, string>();

const base = process.env.BLOB_BASE_URL;
const writeToken = process.env.BLOB_WRITE_TOKEN;

async function blobGet<T>(path: string): Promise<T | null> {
  if (!base) {
    return null;
  }

  const response = await fetch(`${base}/${path}`, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }

  return (await response.json()) as T;
}

async function blobPut(path: string, payload: unknown): Promise<void> {
  if (!base || !writeToken) {
    return;
  }

  await fetch(`${base}/${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${writeToken}`
    },
    body: JSON.stringify(payload)
  });
}

export async function getActorById(actorId: string): Promise<Actor | null> {
  const actor = await blobGet<Actor>(`actors/${actorId}.json`);
  return actor ?? demoActors.find((item) => item.id === actorId) ?? null;
}

export async function getRecentMessages(chatId: string, limit = 20): Promise<Message[]> {
  const blobMessages = await blobGet<Message[]>(`messages/${chatId}.json`);
  if (blobMessages) {
    memoryMessages.set(chatId, blobMessages);
  }

  const messages = blobMessages ?? memoryMessages.get(chatId) ?? [];
  return messages.slice(-limit);
}

export async function saveMessage(
  chatId: string,
  role: "user" | "assistant",
  content: string,
  model?: string,
  assets?: Array<{ type: string; url: string }>
): Promise<void> {
  let current = memoryMessages.get(chatId);

  if (!current) {
    current = (await blobGet<Message[]>(`messages/${chatId}.json`)) ?? [];
  }

  const next = [
    ...current,
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      role,
      model,
      content,
      assets,
      createdAt: new Date().toISOString()
    }
  ];

  memoryMessages.set(chatId, next);
  await blobPut(`messages/${chatId}.json`, next);
}

export async function getConversationSummary(chatId: string): Promise<string> {
  const summary = await blobGet<string>(`summaries/${chatId}.json`);
  return summary ?? memorySummaries.get(chatId) ?? "";
}

export async function setConversationSummary(chatId: string, summary: string): Promise<void> {
  memorySummaries.set(chatId, summary);
  await blobPut(`summaries/${chatId}.json`, summary);
}

export async function saveActor(actor: Actor): Promise<void> {
  await blobPut(`actors/${actor.id}.json`, actor);
}
