import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { RepoFileChange } from "@/lib/repo-sync/github-push";

type RepoSyncRunRow = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  changed_files_count: number;
  deleted_files_count: number;
  processed_changed_files_count: number;
  processed_deleted_files_count: number;
  failed_files_count: number;
};

type RepoSyncJobRow = {
  id: string;
  run_id: string;
  status: "queued" | "processing" | "completed" | "failed";
};

export async function createRepoSyncRun(input: {
  repositoryFullName: string;
  beforeSha: string;
  afterSha: string;
  commitSha: string;
  commitIndex: number;
  files: RepoFileChange[];
}): Promise<string> {
  const client = getSupabaseAdminClient();
  const changedCount = input.files.filter((file) => file.changeType === "changed").length;
  const deletedCount = input.files.filter((file) => file.changeType === "deleted").length;

  const runInsert = await client
    .from("repo_sync_runs")
    .insert({
      repository_full_name: input.repositoryFullName,
      before_sha: input.beforeSha,
      after_sha: input.afterSha,
      commit_sha: input.commitSha,
      commit_index: input.commitIndex,
      status: "queued",
      changed_files_count: changedCount,
      deleted_files_count: deletedCount,
      processed_changed_files_count: 0,
      processed_deleted_files_count: 0,
      failed_files_count: 0
    })
    .select("id")
    .single<{ id: string }>();

  if (runInsert.error || !runInsert.data) {
    throw new Error(`Failed to create repo_sync_runs row: ${runInsert.error?.message ?? "unknown error"}`);
  }

  if (input.files.length > 0) {
    const fileInsert = await client.from("repo_sync_run_files").insert(
      input.files.map((file) => ({
        run_id: runInsert.data.id,
        file_path: file.path,
        change_type: file.changeType,
        status: "pending"
      }))
    );

    if (fileInsert.error) {
      throw new Error(`Failed to create repo_sync_run_files rows: ${fileInsert.error.message}`);
    }
  }

  const jobInsert = await client
    .from("repo_sync_jobs")
    .insert({
      run_id: runInsert.data.id,
      status: "queued"
    })
    .select("id")
    .single<{ id: string }>();

  if (jobInsert.error) {
    throw new Error(`Failed to enqueue repo_sync_jobs row: ${jobInsert.error.message}`);
  }

  return runInsert.data.id;
}

export async function claimNextRepoSyncJob(): Promise<RepoSyncJobRow | null> {
  const client = getSupabaseAdminClient();
  const queued = await client
    .from("repo_sync_jobs")
    .select("id, run_id, status")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<RepoSyncJobRow>();

  if (queued.error) {
    throw new Error(`Failed to fetch queued repo sync job: ${queued.error.message}`);
  }

  if (!queued.data) {
    return null;
  }

  const lockResult = await client.from("repo_sync_jobs").eq("id", queued.data.id).eq("status", "queued").update({
    status: "processing",
    started_at: new Date().toISOString(),
    attempts: 1
  });

  if (lockResult.error) {
    throw new Error(`Failed to lock repo sync job ${queued.data.id}: ${lockResult.error.message}`);
  }

  return {
    ...queued.data,
    status: "processing"
  };
}

export async function markRepoSyncJobDone(jobId: string): Promise<void> {
  const client = getSupabaseAdminClient();
  const result = await client.from("repo_sync_jobs").eq("id", jobId).update({
    status: "completed",
    finished_at: new Date().toISOString()
  });

  if (result.error) {
    throw new Error(`Failed to mark job ${jobId} complete: ${result.error.message}`);
  }
}

export async function markRepoSyncJobFailed(jobId: string, errorMessage: string): Promise<void> {
  const client = getSupabaseAdminClient();
  const result = await client.from("repo_sync_jobs").eq("id", jobId).update({
    status: "failed",
    finished_at: new Date().toISOString(),
    error_message: errorMessage.slice(0, 500)
  });

  if (result.error) {
    throw new Error(`Failed to mark job ${jobId} failed: ${result.error.message}`);
  }
}

export async function getRepoSyncRunById(runId: string): Promise<RepoSyncRunRow> {
  const client = getSupabaseAdminClient();
  const run = await client
    .from("repo_sync_runs")
    .select("id, status, changed_files_count, deleted_files_count, processed_changed_files_count, processed_deleted_files_count, failed_files_count")
    .eq("id", runId)
    .single<RepoSyncRunRow>();

  if (run.error || !run.data) {
    throw new Error(`Failed to load repo sync run ${runId}: ${run.error?.message ?? "unknown error"}`);
  }

  return run.data;
}

export async function listPendingRepoSyncRunFiles(runId: string): Promise<Array<{ id: string; file_path: string; change_type: "changed" | "deleted" }>> {
  const client = getSupabaseAdminClient();
  const files = await client
    .from("repo_sync_run_files")
    .select("id, file_path, change_type")
    .eq("run_id", runId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .returns<Array<{ id: string; file_path: string; change_type: "changed" | "deleted" }>>();

  if (files.error || !files.data) {
    throw new Error(`Failed to load pending run files for run ${runId}: ${files.error?.message ?? "unknown error"}`);
  }

  return files.data;
}

export async function markRepoSyncRunStatus(runId: string, status: RepoSyncRunRow["status"]): Promise<void> {
  const client = getSupabaseAdminClient();
  const result = await client.from("repo_sync_runs").eq("id", runId).update({ status });
  if (result.error) {
    throw new Error(`Failed to update run status ${runId}: ${result.error.message}`);
  }
}

export async function markRepoSyncFileProcessed(input: { runId: string; fileId: string; changeType: "changed" | "deleted"; failed?: boolean }): Promise<void> {
  const client = getSupabaseAdminClient();
  const fileResult = await client.from("repo_sync_run_files").eq("id", input.fileId).eq("run_id", input.runId).update({
    status: input.failed ? "failed" : "processed",
    processed_at: new Date().toISOString()
  });

  if (fileResult.error) {
    throw new Error(`Failed to update run file ${input.fileId}: ${fileResult.error.message}`);
  }

  const patch: Record<string, unknown> = input.failed
    ? { failed_files_count: 1 }
    : input.changeType === "deleted"
      ? { processed_deleted_files_count: 1 }
      : { processed_changed_files_count: 1 };

  const run = await getRepoSyncRunById(input.runId);
  const result = await client.from("repo_sync_runs").eq("id", input.runId).update({
    processed_changed_files_count:
      run.processed_changed_files_count + (patch.processed_changed_files_count ? 1 : 0),
    processed_deleted_files_count:
      run.processed_deleted_files_count + (patch.processed_deleted_files_count ? 1 : 0),
    failed_files_count: run.failed_files_count + (patch.failed_files_count ? 1 : 0)
  });

  if (result.error) {
    throw new Error(`Failed to increment run counters for ${input.runId}: ${result.error.message}`);
  }
}
