import { getActorById, saveActor } from "@/lib/data/blob-store";
import type { Actor } from "@/lib/types/chat";

function buildActorId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `actor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createSubActor(parentActorId: string, name: string): Promise<Actor> {
  const parent = await getActorById(parentActorId);

  if (!parent) {
    throw new Error(`Parent actor not found: ${parentActorId}`);
  }

  const actor: Actor = {
    id: buildActorId(),
    name,
    purpose: parent.purpose,
    parentId: parent.id
  };

  await saveActor(actor);

  return actor;
}
