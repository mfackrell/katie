import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { listChats } from "@/lib/data/persistence-store";
import { delegationReplyId } from "@/lib/executive/delivery";
import { testCandidate, workKey, type WorkItem } from "@/lib/ui/work";
export const dynamic = "force-dynamic";
type ProjectRow = {
  id: string;
  actor_id: string;
  chat_id: string;
  status: string;
  phase: string;
  detail: string | null;
  updated_at: string;
  result: string | null;
  spec: { name?: string } | null;
};
type MissionRow = {
  id: string;
  objective: string;
  status: string;
  detail: string | null;
  updated_at: string;
  project_id: string | null;
  project_kind: string | null;
  result: string | null;
};
type TaskRow = {
  id: string;
  actor_id: string;
  chat_id: string;
  status: string;
  details: string | null;
  initial_input: string;
  snapshot: { name?: string };
  updated_at: string;
  external?: Record<string, unknown>;
};
type DelegationRow = {
  id: string;
  actor_id: string;
  chat_id: string;
  mission_id: string | null;
  orchestrator_id: string;
  status: string;
  updated_at: string;
};
type JobRow = {
  id: string;
  mission_id: string;
  role: string;
  job_key: string;
  status: string;
  result: { verdict?: string } | null;
};
function projectReplyId(id: string) {
  const h = createHash("md5")
    .update(id + ":project-progress")
    .digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20),
  ].join("-");
}

// Presentation only: never start, refresh/reconcile, approve, or retry work on a GET.
export async function GET() {
  try {
    const chats = await listChats(),
      owned = new Map(chats.map((c) => [c.id, c.actorId]));
    const db = getSupabaseAdminClient();
    const queries = [
      db
        .from("work_projects")
        .select(
          "id,actor_id,chat_id,status,phase,detail,updated_at,spec,result",
        )
        .order("updated_at", { ascending: false })
        .limit(500),
      db
        .from("agent_missions")
        .select(
          "id,objective,status,detail,updated_at,project_id,project_kind,result",
        )
        .order("updated_at", { ascending: false })
        .limit(500),
      db
        .from("agent_tasks")
        .select(
          "id,actor_id,chat_id,status,details,initial_input,snapshot,updated_at,external",
        )
        .order("updated_at", { ascending: false })
        .limit(500),
      db
        .from("executive_delegations")
        .select(
          "id,actor_id,chat_id,mission_id,orchestrator_id,updated_at,status",
        )
        .order("updated_at", { ascending: false })
        .limit(500),
      db
        .from("mission_assignments")
        .select("id,mission_id,role,job_key,status,result")
        .order("created_at", { ascending: false })
        .limit(5000),
    ];
    const results = await Promise.allSettled(queries),
      warnings: string[] = [];
    const names = [
      "Projects",
      "Missions",
      "Tasks",
      "Conversation links",
      "Independent review",
    ];
    const rows = results.map((r, i) => {
      if (r.status === "rejected" || r.value.error) {
        warnings.push(
          `${names[i]} unavailable; saved status may be incomplete.`,
        );
        return [];
      }
      return r.value.data ?? [];
    });
    const projects = rows[0] as ProjectRow[],
      missions = rows[1] as MissionRow[],
      tasks = rows[2] as TaskRow[],
      delegations = rows[3] as DelegationRow[],
      jobs = rows[4] as JobRow[];
    const visibleProjects = projects.filter(
      (p) => owned.get(p.chat_id) === p.actor_id,
    );
    const visibleDelegations = delegations.filter(
      (d) => owned.get(d.chat_id) === d.actor_id,
    );
    const visibleTasks = tasks.filter(
      (t) => owned.get(t.chat_id) === t.actor_id,
    );
    const projectIds = new Set(visibleProjects.map((p) => p.id));
    const receiptIds = [
      ...visibleDelegations.map((d) => delegationReplyId(d.id)),
      ...visibleProjects.map((p) => projectReplyId(p.id)),
    ];
    const receiptResult = receiptIds.length
      ? await db
          .from("messages")
          .select("id,chat_id")
          .in("id", receiptIds)
          .returns<{ id: string; chat_id: string }>()
      : { data: [], error: null };
    if (receiptResult.error) warnings.push("Delivery receipts unavailable.");
    const receipts = new Set(
      (receiptResult.data ?? []).map((m) => m.chat_id + ":" + m.id),
    );
    const items: WorkItem[] = [];
    for (const p of visibleProjects)
      items.push({
        key: workKey("project", p.id),
        source: "project",
        id: p.id,
        title: p.spec?.name ?? "Development project",
        status: p.status,
        phase: p.phase,
        detail: p.detail,
        updatedAt: p.updated_at,
        chatId: p.chat_id,
        specialist: "Development",
        parentKey: null,
        isTest: testCandidate(p.spec?.name ?? ""),
        result: p.result,
        reviewState: "See project acceptance in conversation",
        deliveryState:
          p.status === "completed"
            ? receipts.has(p.chat_id + ":" + projectReplyId(p.id))
              ? "delivered"
              : "pending"
            : "unknown",
      });
    const missionReview = (id: string) => {
      const reviews = jobs.filter(
        (j) =>
          j.mission_id === id &&
          j.role === "review" &&
          j.status === "completed",
      );
      const final =
        reviews.find((j) => j.job_key === "review_again") ??
        reviews.find((j) => j.job_key === "review");
      return final?.result?.verdict ?? "Not established";
    };
    for (const m of missions) {
      const d = visibleDelegations.find((d) => d.mission_id === m.id);
      // Unlinked missions are retained in Advanced. Do not expose records outside accessible chat ownership.
      if (!d && !projectIds.has(m.project_id ?? "")) continue;
      const p = visibleProjects.find((p) => p.id === m.project_id);
      const delivered =
        d && receipts.has(d.chat_id + ":" + delegationReplyId(d.id));
      items.push({
        key: workKey("mission", m.id),
        source: "mission",
        id: m.id,
        title: m.objective,
        status: m.status,
        coordinationState: d?.status,
        phase: m.project_kind ?? m.status,
        detail: m.detail,
        updatedAt: m.updated_at,
        chatId: d?.chat_id ?? p?.chat_id ?? null,
        specialist: "Katie's specialist team",
        parentKey: p ? workKey("project", p.id) : null,
        isTest: testCandidate(m.objective),
        result: m.result,
        reviewState: missionReview(m.id),
        deliveryState: delivered
          ? m.status === "completed" &&
            missionReview(m.id) === "pass" &&
            m.result
            ? "delivered"
            : "reported"
          : d && m.status === "completed"
            ? "pending"
            : "unknown",
      });
    }
    for (const t of visibleTasks) {
      const linked = jobs.find((j) => j.id === t.id),
        parent =
          linked &&
          items.find(
            (i) => i.source === "mission" && i.id === linked.mission_id,
          );
      items.push({
        key: workKey("task", t.id),
        source: "task",
        id: t.id,
        title: t.initial_input,
        status: t.status,
        phase: t.status,
        detail: t.details,
        updatedAt: t.updated_at,
        chatId: t.chat_id,
        specialist: t.snapshot?.name ?? "Saved specialist",
        parentKey: parent?.key ?? null,
        isTest: testCandidate(t.initial_input),
        result: null,
        reviewState: "See task review",
        deliveryState: "unknown",
      });
    }
    return NextResponse.json(
      {
        items: items.sort((a, b) =>
          (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
        ),
        warnings,
        checkedAt: new Date().toISOString(),
        limit: 500,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Work status unavailable. Your existing work is unchanged." },
      { status: 503 },
    );
  }
}
