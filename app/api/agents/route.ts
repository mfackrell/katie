import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { agentConfigSchema } from "@/lib/agents/policy";
import { agentRpc } from "@/lib/agents/store";
const change = z.object({ id: z.string().uuid().optional(), config: agentConfigSchema, archive: z.boolean().default(false) }).strict();
export async function GET() {
  try {
    const { data, error } = await getSupabaseAdminClient().from("managed_agents").select("*").order("created_at", { ascending: false }).limit(200);
    return NextResponse.json(error ? { error: "Agent definitions unavailable" } : { agents: data }, { status: error ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Agent definitions unavailable" }, { status: 503 }); }
}
export async function POST(request: NextRequest) {
  try {
    const body = change.parse(await request.json());
    const agent = await agentRpc("save_managed_agent", { p_id: body.id ?? null, p_config: body.config, p_archive: body.archive });
    return NextResponse.json({ agent });
  } catch (error) { return NextResponse.json({ error: error instanceof z.ZodError ? "Invalid agent definition" : "Agent could not be saved; it may be archived or unavailable." }, { status: 400 }); }
}
