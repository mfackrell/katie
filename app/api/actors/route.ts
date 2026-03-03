import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActorById, listActors, saveActor } from "@/lib/data/blob-store";
import type { Actor } from "@/lib/types/chat";

const createActorSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().optional(),
  parentId: z.string().min(1).optional()
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

    await saveActor(actor);

    return NextResponse.json({ actor }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
  }
}
