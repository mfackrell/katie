import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { listActors, listChats } from "@/lib/data/persistence-store";
const keySchema = z
  .string()
  .regex(/^(chat|actor|work:(project|mission|task)):[0-9a-f-]{36}$/);
const valueSchema = z
  .object({
    draft: z.string().max(100000).optional(),
    repoId: z.string().uuid().nullable().optional(),
    repoSource: z.boolean().optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
    readAt: z.string().datetime().optional(),
    notes: z.string().max(12000).optional(),
    audience: z.enum(["conversation", "worker", "test", "unknown"]).optional(),
    summary: z.string().max(500).optional(),
    creator: z.string().max(100).optional(),
    reason: z.string().max(500).optional(),
    scroll: z.number().min(0).max(1e9).optional(),
  })
  .strict();
async function scope(key: string) {
  const parts = key.split(":"),
    id = parts.at(-1)!;
  const [actors, chats] = await Promise.all([listActors(), listChats()]);
  if (parts[0] === "actor") {
    if (!actors.some((a) => a.id === id)) throw Error("Identity unavailable");
    return { actor: id, chat: null };
  }
  if (parts[0] === "chat") {
    const c = chats.find((c) => c.id === id);
    if (!c) throw Error("Conversation unavailable");
    return { actor: c.actorId, chat: c.id };
  }
  const db = getSupabaseAdminClient();
  if (parts[1] === "project" || parts[1] === "task") {
    const { data, error } = await db
      .from(parts[1] === "project" ? "work_projects" : "agent_tasks")
      .select("actor_id,chat_id")
      .eq("id", id)
      .maybeSingle<{ actor_id: string; chat_id: string }>();
    if (
      error ||
      !data ||
      !chats.some((c) => c.id === data.chat_id && c.actorId === data.actor_id)
    )
      throw Error("Work unavailable");
    return { actor: data.actor_id, chat: data.chat_id };
  }
  const { data: d } = await db
    .from("executive_delegations")
    .select("actor_id,chat_id")
    .eq("mission_id", id)
    .limit(1)
    .maybeSingle<{ actor_id: string; chat_id: string }>();
  if (d && chats.some((c) => c.id === d.chat_id && c.actorId === d.actor_id))
    return { actor: d.actor_id, chat: d.chat_id };
  const { data: m } = await db
    .from("agent_missions")
    .select("project_id")
    .eq("id", id)
    .maybeSingle<{ project_id: string | null }>();
  if (m?.project_id) return scope("work:project:" + m.project_id);
  throw Error("Work unavailable");
}
export async function GET(request: NextRequest) {
  try {
    const key = request.nextUrl.searchParams.get("key"),
      db = getSupabaseAdminClient();
    if (key) {
      const parsed = keySchema.parse(key);
      await scope(parsed);
      const { data, error } = await db
        .from("workspace_presentation_state")
        .select("key,value,version,updated_at")
        .eq("key", parsed)
        .maybeSingle();
      if (error) throw error;
      return NextResponse.json(
        { state: data ?? { key: parsed, value: {}, version: 0 } },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const actors = await listActors();
    if (!actors.length) return NextResponse.json({ states: [] });
    const { data, error } = await db
      .from("workspace_presentation_state")
      .select("key,value,version,updated_at")
      .in(
        "actor_id",
        actors.map((a) => a.id),
      )
      .limit(2000)
      .returns<{
        key: string;
        value: Record<string, unknown>;
        version: number;
        updated_at: string;
      }>();
    if (error) throw error;
    // Index excludes private draft/repository/notes content; detailed reads validate the exact scope.
    return NextResponse.json(
      {
        states: (data ?? []).map((s) => ({
          ...s,
          value: Object.fromEntries(
            Object.entries(s.value ?? {}).filter(([k]) =>
              [
                "archived",
                "pinned",
                "readAt",
                "audience",
                "summary",
                "creator",
                "reason",
              ].includes(k),
            ),
          ),
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Saved workspace preferences unavailable" },
      { status: 503 },
    );
  }
}
export async function PATCH(request: NextRequest) {
  try {
    const b = z
        .object({
          key: keySchema,
          value: valueSchema,
          version: z.number().int().min(0),
        })
        .strict()
        .parse(await request.json()),
      owner = await scope(b.key);
    if (
      !b.key.startsWith("chat:") &&
      ("draft" in b.value || "repoId" in b.value || "repoSource" in b.value)
    )
      return NextResponse.json(
        { error: "Draft and repository context require a conversation" },
        { status: 400 },
      );
    const { data, error } = await getSupabaseAdminClient().rpc(
      "save_workspace_presentation",
      {
        p_key: b.key,
        p_actor: owner.actor,
        p_chat: owner.chat,
        p_value: b.value,
        p_version: b.version,
      },
    );
    if (error) throw error;
    return NextResponse.json(
      { state: data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError
            ? "Invalid presentation settings"
            : "Settings changed or could not be saved. Reload to avoid overwriting another edit.",
      },
      { status: 409 },
    );
  }
}
