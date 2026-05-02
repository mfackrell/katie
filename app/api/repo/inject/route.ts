import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { injectRelevantContents } from "@/lib/repo/content-injector";
import { registerRepoBinding } from "@/lib/repo/repo-access";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const repoId = searchParams.get("repoId")?.trim();
  const message = searchParams.get("message")?.trim();

  if (!repoId || !message) {
    return NextResponse.json({ error: "repoId and message are required" }, { status: 400 });
  }

  const client = getSupabaseAdminClient();
  const response = await client
    .from("repo_sync_runs")
    .select("id, repository_full_name")
    .eq("id", repoId)
    .maybeSingle<{ id: string; repository_full_name: string }>();

  if (response.error) {
    return NextResponse.json({ error: response.error.message }, { status: 500 });
  }

  if (!response.data) {
    return NextResponse.json({ error: "Repository context not found" }, { status: 404 });
  }

  registerRepoBinding(response.data.id, response.data.repository_full_name, "main");
  const injected = await injectRelevantContents(message, response.data.id, 5);

  return NextResponse.json({ repoId: response.data.id, injected });
}
