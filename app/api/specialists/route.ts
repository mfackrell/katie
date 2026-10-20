import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { listActors } from "@/lib/data/persistence-store";
export async function GET() {
  try {
    const actors = await listActors();
    const { data, error } = await getSupabaseAdminClient()
      .from("executive_orchestrators")
      .select(
        "id,actor_id,slug,title,description,capabilities,status,autonomy,adapter,version",
      )
      .in(
        "actor_id",
        actors.map((a) => a.id),
      );
    if (error) throw error;
    return NextResponse.json(
      { specialists: data ?? [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Specialist capabilities unavailable" },
      { status: 503 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const parsed = z
    .object({
      id: z.string().uuid(),
      version: z.coerce.number().int().min(1).max(99999),
    })
    .safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid orchestrator reference" },
      { status: 400 },
    );
  try {
    const db = getSupabaseAdminClient();
    const actors = await listActors();
    const { data: entry, error: readError } = await db
      .from("executive_orchestrators")
      .select("id,actor_id,version,status")
      .eq("id", parsed.data.id)
      .maybeSingle<{
        id: string;
        actor_id: string;
        version: number;
        status: string;
      }>();
    if (readError) throw readError;
    if (!entry || !actors.some((actor) => actor.id === entry.actor_id))
      return NextResponse.json(
        { error: "Orchestrator unavailable" },
        { status: 404 },
      );
    if (entry.version !== parsed.data.version)
      return NextResponse.json(
        { error: "This orchestrator changed. Reload before removing it." },
        { status: 409 },
      );
    const { data, error } = await db
      .from("executive_orchestrators")
      .eq("id", entry.id)
      .eq("actor_id", entry.actor_id)
      .eq("version", entry.version)
      .updateReturning<{ id: string }>({
        status: "retired",
        version: entry.version + 1,
        updated_at: new Date().toISOString(),
      }, "id");
    if (error) throw error;
    if (!data?.length)
      return NextResponse.json(
        { error: "This orchestrator changed. Reload before removing it." },
        { status: 409 },
      );
    return NextResponse.json({ removed: entry.id, retainedHistory: true });
  } catch {
    return NextResponse.json(
      {
        error:
          "Orchestrator could not be removed. Its saved history is unchanged.",
      },
      { status: 503 },
    );
  }
}
