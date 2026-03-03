import { demoActors } from "@/lib/data/mock";
import type { Actor, Message } from "@/lib/types/chat";

const memoryMessages = new Map<string, Message[]>();
const memorySummaries = new Map<string, string>();
const deletedActorIds = new Set<string>();

const base = process.env.BLOB_BASE_URL;
const writeToken = process.env.BLOB_WRITE_TOKEN;

function requireBlobConfig(): { baseUrl: string; token: string } {
  if (!base) {
    throw new Error("Config Error: BLOB_BASE_URL is not defined");
  }

  if (!writeToken) {
    throw new Error("Config Error: BLOB_WRITE_TOKEN is not defined");
  }

  return { baseUrl: base, token: writeToken };
}

async function blobGet<T>(path: string): Promise<T | null> {
  const { baseUrl } = requireBlobConfig();

  const response = await fetch(`${baseUrl}/${path}`, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }

  return (await response.json()) as T;
}

async function blobPut(path: string, payload: unknown): Promise<void> {
  const { baseUrl, token } = requireBlobConfig();

  const response = await fetch(`${baseUrl}/${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Failed to PUT ${path}: ${response.status} ${response.statusText}`);
  }
}

async function blobDelete(path: string): Promise<void> {
  const { baseUrl, token } = requireBlobConfig();

  await fetch(`${baseUrl}/${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

async function getDeletedActorIds(): Promise<string[]> {
  const deletedFromBlob = (await blobGet<string[]>("actors/deleted-index.json")) ?? [];

  deletedFromBlob.forEach((actorId) => {
    deletedActorIds.add(actorId);
  });

  return [...deletedActorIds];
}

export async function getActorById(actorId: string): Promise<Actor | null> {
  const deletedIds = await getDeletedActorIds();
  if (deletedIds.includes(actorId)) {
    return null;
  }

  const { baseUrl } = requireBlobConfig();
  const path = `actors/${actorId}.json`;
  console.log(`Fetching actor from URL: ${baseUrl}/${path}`);

  const actor = await blobGet<Actor>(path);
  if (actor) {
    return actor;
  }

  return demoActors.find((item) => item.id === actorId) ?? null;
}

export async function listActors(): Promise<Actor[]> {
  const deletedIds = await getDeletedActorIds();
  const deleted = new Set(deletedIds);
  const blobActorIds = (await blobGet<string[]>("actors/index.json")) ?? [];

  const blobActors = (
    await Promise.all(
      blobActorIds.map(async (actorId) => {
        return blobGet<Actor>(`actors/${actorId}.json`);
      })
    )
  ).filter((actor): actor is Actor => Boolean(actor));

  const deduped = new Map<string, Actor>();
  [...demoActors, ...blobActors].forEach((actor) => {
    if (!deleted.has(actor.id)) {
      deduped.set(actor.id, actor);
    }
  });

  return [...deduped.values()];
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
  const actorPath = `actors/${actor.id}.json`;
  console.log(`Attempting to save actor: [${actor.id}] to [${actorPath}]...`);

  deletedActorIds.delete(actor.id);
  await blobPut(actorPath, actor);
  console.log(`Actor [${actor.id}] saved successfully.`);

  console.log("Updating actor index...");
  const currentIndex = (await blobGet<string[]>("actors/index.json")) ?? [];
  if (!currentIndex.includes(actor.id)) {
    await blobPut("actors/index.json", [...currentIndex, actor.id]);
  }
}

export async function deleteActorsById(actorIds: string[]): Promise<void> {
  if (!actorIds.length) {
    return;
  }

  const currentIndex = (await blobGet<string[]>("actors/index.json")) ?? [];
  const nextIndex = currentIndex.filter((actorId) => !actorIds.includes(actorId));

  await blobPut("actors/index.json", nextIndex);

  actorIds.forEach((actorId) => {
    deletedActorIds.add(actorId);
  });

  await Promise.all(actorIds.map(async (actorId) => blobDelete(`actors/${actorId}.json`)));
  await blobPut("actors/deleted-index.json", [...deletedActorIds]);
}
