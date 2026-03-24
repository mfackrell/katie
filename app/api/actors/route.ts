import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteActorsById, getActorById, listActors, saveActor } from "@/lib/data/blob-store";
import type { Actor } from "@/lib/types/chat";

const createActorSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().optional(),
  parentId: z.string().min(1).optional()
});

const actorIdParamSchema = z.object({
  id: z.string().min(1)
});

function buildActorId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `actor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function GET() {
  const actors = await listActors();

  return NextResponse.json({ actors }, { headers: { "Cache-Control": "no-cache" } });
}

export async function POST(request: NextRequest) {
  try {
    const payload = createActorSchema.parse(await request.json());
    const { name, parentId } = payload;

    let purpose = payload.purpose?.trim();

    if (parentId) {
      const parent = await getActorById(parentId);
      if (!parent) {
        return NextResponse.json({ error: `Parent actor not found: ${parentId}` }, { status: 404 });
      }

      purpose = parent.purpose;
    }

    if (!purpose) {
      return NextResponse.json({ error: "Purpose is required for primary actors." }, { status: 400 });
    }

    const actor: Actor = {
      id: buildActorId(),
      name: name.trim(),
      purpose,
      ...(parentId ? { parentId } : {})
    };

    try {
      await saveActor(actor);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown save error";
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ actor }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
  }
}


export async function DELETE(request: NextRequest) {
  const url = new URL(request.url);

  try {
    const { id: actorId } = actorIdParamSchema.parse({ id: url.searchParams.get("id") });
    const actors = await listActors();

    const target = actors.find((actor) => actor.id === actorId);
    if (!target) {
      return NextResponse.json({ error: `Actor not found: ${actorId}` }, { status: 404 });
    }

    const toDelete = new Set<string>([actorId]);
    const queue = [actorId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const childIds = actors.filter((actor) => actor.parentId === currentId).map((actor) => actor.id);

      childIds.forEach((childId) => {
        if (!toDelete.has(childId)) {
          toDelete.add(childId);
          queue.push(childId);
        }
      });
    }

    const deletedActorIds = [...toDelete];
    await deleteActorsById(deletedActorIds);

    return NextResponse.json({ deletedActorIds });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid actor id" }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Unknown persistence error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
