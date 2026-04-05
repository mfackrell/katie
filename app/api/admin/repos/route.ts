import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";

type RepoSyncRunRow = {
  id: string;
  repository_full_name: string;
  created_at: string;
};

export async function GET() {
  const client = getSupabaseAdminClient();
  const response = await client
    .from("repo_sync_runs")
    .select("id, repository_full_name, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (response.error) {
    return NextResponse.json(
      { ok: false, error: `Failed to load connected repositories: ${response.error.message}` },
      { status: 500 },
    );
  }

  const latestByName = new Map<string, RepoSyncRunRow>();
  for (const row of (response.data ?? []) as RepoSyncRunRow[]) {
    if (!latestByName.has(row.repository_full_name)) {
      latestByName.set(row.repository_full_name, row);
    }
  }

  const repos = Array.from(latestByName.values()).map((row) => ({
    id: row.id,
    full_name: row.repository_full_name,
    created_at: row.created_at,
  }));

  return NextResponse.json({ ok: true, repos });
}
