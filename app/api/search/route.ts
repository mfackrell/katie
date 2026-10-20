import { NextRequest, NextResponse } from "next/server";
import { listActors, listChats } from "@/lib/data/persistence-store";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { GET as getWork } from "@/app/api/work/route";
import { actorAudience, type WorkItem } from "@/lib/ui/work";
import { conversationHref, workHref } from "@/lib/ui/links";
export async function GET(request: NextRequest) {
  try {
    const q = (request.nextUrl.searchParams.get("q") ?? "")
      .trim()
      .slice(0, 200)
      .toLowerCase();
    if (q.length < 2) return NextResponse.json({ results: [], warnings: [] });
    const [actors, chats, workResponse] = await Promise.all([
      listActors(),
      listChats(),
      getWork(),
    ]);
    const db = getSupabaseAdminClient();
    const { data: managed, error: managedError } = await db
      .from("managed_agents")
      .select("actor_id")
      .returns<{ actor_id: string }>();
    if (managedError) throw managedError;
    const workers = new Set((managed ?? []).map((a) => a.actor_id));
    const publicIds = new Set(
      actors
        .filter(
          (a) => !workers.has(a.id) && actorAudience(a) === "conversation",
        )
        .map((a) => a.id),
    );
    const visible = chats.filter((c) => publicIds.has(c.actorId)),
      visibleIds = new Set(visible.map((c) => c.id));
    const results: Array<{
      id: string;
      kind: string;
      title: string;
      snippet: string;
      href: string;
      updatedAt: string | null;
    }> = [];
    for (const c of visible)
      if (c.title.toLowerCase().includes(q))
        results.push({
          id: c.id,
          kind: "Conversation",
          title: c.title,
          snippet: "Open the source discussion",
          href: conversationHref(c.id),
          updatedAt: c.updatedAt,
        });
    const warnings: string[] = [];
    const { data: messages, error: messageError } = visible.length
      ? await db
          .from("messages")
          .select("id,chat_id,role,content,created_at")
          .in(
            "chat_id",
            visible.map((c) => c.id),
          )
          .order("created_at", { ascending: false })
          .limit(2000)
          .returns<{
            id: string;
            chat_id: string;
            role: string;
            content: string;
            created_at: string;
          }>()
      : { data: [], error: null };
    if (messageError) warnings.push("Conversation content search unavailable");
    for (const m of messages ?? [])
      if (m.content.toLowerCase().includes(q)) {
        const at = m.content.toLowerCase().indexOf(q);
        results.push({
          id: m.id,
          kind: m.role === "assistant" ? "Answer" : "Request",
          title:
            visible.find((c) => c.id === m.chat_id)?.title ?? "Conversation",
          snippet: m.content.slice(Math.max(0, at - 80), at + 240),
          href: conversationHref(m.chat_id) + "#message-" + m.id,
          updatedAt: m.created_at,
        });
      }
    if (workResponse.ok) {
      const payload = (await workResponse.json()) as { items: WorkItem[] };
      for (const w of payload.items ?? [])
        if (
          w.chatId &&
          visibleIds.has(w.chatId) &&
          !w.isTest &&
          `${w.title} ${w.detail ?? ""} ${w.result ?? ""}`
            .toLowerCase()
            .includes(q)
        )
          results.push({
            id: w.key,
            kind: w.result ? "Result" : "Work",
            title: w.title.slice(0, 160),
            snippet: w.result?.slice(0, 240) ?? w.detail ?? w.phase,
            href: workHref(w.source, w.id) + (w.result ? "?tab=results" : ""),
            updatedAt: w.updatedAt,
          });
    } else warnings.push("Work search unavailable");
    for (const a of actors)
      if (
        publicIds.has(a.id) &&
        `${a.name} ${a.routingProfile?.summary ?? ""}`.toLowerCase().includes(q)
      )
        results.push({
          id: a.id,
          kind: "Specialist",
          title: a.name,
          snippet: a.routingProfile?.summary ?? "Saved conversational persona",
          href: "/specialists/" + encodeURIComponent("persona:" + a.id),
          updatedAt: null,
        });
    return NextResponse.json(
      {
        results,
        warnings,
        scope:
          "Latest 2,000 permitted messages and current work inventory. Memory records are not searched.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      {
        error: "Search unavailable. Your conversations and work are unchanged.",
      },
      { status: 503 },
    );
  }
}
