import { NextResponse } from "next/server";
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
