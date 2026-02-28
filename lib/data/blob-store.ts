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

export async function getRecentMessages(actorId: string, limit = 20): Promise<Message[]> {
  const blobMessages = await blobGet<Message[]>(`messages/${actorId}.json`);
  const messages = blobMessages ?? memoryMessages.get(actorId) ?? [];
  return messages.slice(-limit);
}

export async function saveMessage(
  actorId: string,
  role: "user" | "assistant",
  content: string,
  chatId: string,
  model?: string
): Promise<void> {
  const current = memoryMessages.get(actorId) ?? [];
  const next = [
    ...current,
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      role,
      model,
      content,
      createdAt: new Date().toISOString()
    }
  ];

  memoryMessages.set(actorId, next);
  await blobPut(`messages/${actorId}.json`, next);
}

export async function getConversationSummary(actorId: string): Promise<string> {
  const summary = await blobGet<string>(`summaries/${actorId}.json`);
  return summary ?? memorySummaries.get(actorId) ?? "";
}

export async function setConversationSummary(actorId: string, summary: string): Promise<void> {
  memorySummaries.set(actorId, summary);
  await blobPut(`summaries/${actorId}.json`, summary);
}
