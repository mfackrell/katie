import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { listChats } from "@/lib/data/persistence-store";

type ProjectRow = {
  id: string; actor_id: string; chat_id: string; status: string; phase: string;
  detail: string | null; milestone_index: number; cycles: number;
  max_cycles: number; updated_at: string; deadline: string;
  spec: {name?: string; milestones?: unknown[]} | null;
};

export async function GET() {
  try {
    const chats = await listChats();
    const ownedChats = new Map(chats.map(c => [c.id, c]));
    if (!ownedChats.size) return NextResponse.json({projects: []}, {headers: {"Cache-Control":"no-store"}});
    const {data,error} = await getSupabaseAdminClient().from("work_projects")
      .select("id,actor_id,chat_id,status,phase,detail,milestone_index,cycles,max_cycles,updated_at,deadline,spec")
      .order("updated_at",{ascending:false}).limit(100);
    if (error) throw Error("Project records unavailable");
    const projects = ((data ?? []) as ProjectRow[]).flatMap(row => {
      const chat = ownedChats.get(row.chat_id);
      if (!chat || chat.actorId !== row.actor_id) return [];
      return [{
        id: row.id, actorId: row.actor_id, chatId: row.chat_id,
        chatTitle: chat.title, name: row.spec?.name ?? "Autonomous project",
        status: row.status, phase: row.phase, detail: row.detail,
        milestoneIndex: row.milestone_index, milestoneCount: row.spec?.milestones?.length ?? 0,
        cycles: row.cycles, maxCycles: row.max_cycles,
        updatedAt: row.updated_at, deadline: row.deadline,
      }];
    });
    return NextResponse.json({projects}, {headers: {"Cache-Control":"no-store"}});
  } catch (error) {
    console.error("[Projects] Overview failed", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({error:"Project overview unavailable"}, {status:503,headers:{"Cache-Control":"no-store"}});
  }
}
