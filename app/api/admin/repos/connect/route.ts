import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";

const connectRepoSchema = z.object({
  repo: z.string().trim().min(1),
});

type RepoSyncRunRow = {
  id: string;
};

const CONNECT_COMMIT_SHA = "manual-connect";

export async function POST(request: NextRequest) {
  try {
    const { repo } = connectRepoSchema.parse(await request.json());
    const normalizedRepo = repo.trim();
    const client = getSupabaseAdminClient();

    const existingRun = await client
      .from("repo_sync_runs")
      .select("id")
      .eq("repository_full_name", normalizedRepo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<RepoSyncRunRow>();

    if (existingRun.error) {
      return NextResponse.json(
        { ok: false, error: `Failed to load repo sync state: ${existingRun.error.message}` },
        { status: 500 },
      );
    }

    if (existingRun.data?.id) {
      return NextResponse.json({
        ok: true,
        message: "Repository connected successfully.",
        repo_id: existingRun.data.id,
      });
    }

    const createdRun = await client
      .from("repo_sync_runs")
      .insert({
        repository_full_name: normalizedRepo,
        before_sha: CONNECT_COMMIT_SHA,
        after_sha: CONNECT_COMMIT_SHA,
        commit_sha: CONNECT_COMMIT_SHA,
        commit_index: 0,
        status: "completed",
        changed_files_count: 0,
        deleted_files_count: 0,
        processed_changed_files_count: 0,
        processed_deleted_files_count: 0,
        failed_files_count: 0,
      })
      .select("id")
      .single<RepoSyncRunRow>();

    if (createdRun.error || !createdRun.data) {
      return NextResponse.json(
        { ok: false, error: `Failed to connect repository: ${createdRun.error?.message ?? "unknown error"}` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      message: "Repository connected successfully.",
      repo_id: createdRun.data.id,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ ok: false, error: "Invalid request payload." }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Failed to connect repository.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
