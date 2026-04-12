import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteActorsById, getActorById, listActors, saveActor } from "@/lib/data/persistence-store";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { getAvailableProviders } from "@/lib/providers";
import { selectControlPlaneDecisionModels } from "@/lib/router/master-router";
import { createNeutralActorRoutingProfile, generateActorRoutingProfile } from "@/lib/router/actor-routing-profile";
import type { Actor } from "@/lib/types/chat";

const createActorSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().optional(),
  parentId: z.string().min(1).optional()
});

const actorIdParamSchema = z.object({
  id: z.string().min(1)
});

const updateActorSchema = z.object({
  purpose: z.string().trim().min(1)
});

type ActorDbRow = {
  id: string;
  name: string;
  system_prompt: string;
  parent_actor_id: string | null;
  routing_profile: unknown;
  created_at: string;
  updated_at: string;
};

async function buildActorRoutingProfile(actor: Pick<Actor, "name" | "purpose">) {
  const providers = getAvailableProviders();
  if (!providers.length) {
    return createNeutralActorRoutingProfile("Neutral profile used because no providers were configured.");
  }

  const modelEntries = await Promise.all(
    providers.map(async (provider) => ({ provider, models: await provider.listModels() }))
  );
  const decisionProvider = selectControlPlaneDecisionModels(modelEntries)[0] ?? null;
  return generateActorRoutingProfile({
    actorName: actor.name,
    actorPurpose: actor.purpose,
    actorSystemPrompt: actor.purpose,
    decisionProvider
  });
}

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

    const actorPayload: Actor = {
      id: buildActorId(),
      name: name.trim(),
      purpose,
      routingProfile: await buildActorRoutingProfile({ name: name.trim(), purpose }),
      ...(parentId ? { parentId } : {})
    };

    let actor: Actor;

    try {
      actor = await saveActor(actorPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown save error";
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({ actor }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const url = new URL(request.url);

  try {
    const { id: actorId } = actorIdParamSchema.parse({ id: url.searchParams.get("id") });
    const { purpose } = updateActorSchema.parse(await request.json());

    const existingActor = await getActorById(actorId);
    if (!existingActor) {
      return NextResponse.json({ error: `Actor not found: ${actorId}` }, { status: 404 });
    }

    const now = new Date().toISOString();
    const routingProfile = await buildActorRoutingProfile({ name: existingActor.name, purpose: purpose.trim() });
    const client = getSupabaseAdminClient();
    const payload = {
      id: actorId,
      system_prompt: purpose.trim(),
      routing_profile: routingProfile,
      updated_at: now
    };
    const { data, error } = await client
      .from("actors")
      .upsert(payload, { onConflict: "id" })
      .select(
        "id,name,system_prompt,parent_actor_id,routing_profile,created_at,updated_at"
      )
      .single<ActorDbRow>();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      actor: {
        id: data.id,
        name: data.name,
        purpose: data.system_prompt,
        routingProfile,
        ...(data.parent_actor_id ? { parentId: data.parent_actor_id } : {})
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Unknown persistence error";
    return NextResponse.json({ error: message }, { status: 500 });
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
