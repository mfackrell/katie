import {
  claimNextRepoSyncJob,
  getRepoSyncRunById,
  listPendingRepoSyncRunFiles,
  markRepoSyncFileProcessed,
  markRepoSyncJobDone,
  markRepoSyncJobFailed,
  markRepoSyncRunStatus
} from "@/lib/repo-sync/store";

export type RepoSyncFileProcessor = (file: { path: string; changeType: "changed" | "deleted" }) => Promise<void>;

async function processRunFiles(runId: string, processFile: RepoSyncFileProcessor): Promise<{ processed: number; failed: number }> {
  const pendingFiles = await listPendingRepoSyncRunFiles(runId);
  let processed = 0;
  let failed = 0;

  for (const file of pendingFiles) {
    try {
      await processFile({ path: file.file_path, changeType: file.change_type });
      await markRepoSyncFileProcessed({ runId, fileId: file.id, changeType: file.change_type });
      processed += 1;
    } catch {
      await markRepoSyncFileProcessed({ runId, fileId: file.id, changeType: file.change_type, failed: true });
      failed += 1;
    }
  }

  return { processed, failed };
}

export async function processNextRepoSyncJob(processFile: RepoSyncFileProcessor): Promise<
  | { status: "idle" }
  | { status: "processed"; runId: string; processedFiles: number; failedFiles: number }
  | { status: "failed"; runId: string; error: string }
> {
  const job = await claimNextRepoSyncJob();
  if (!job) {
    return { status: "idle" };
  }

  try {
    await markRepoSyncRunStatus(job.run_id, "processing");
    const outcome = await processRunFiles(job.run_id, processFile);
    const run = await getRepoSyncRunById(job.run_id);

    const shouldFail = run.failed_files_count > 0;
    await markRepoSyncRunStatus(job.run_id, shouldFail ? "failed" : "completed");
    await markRepoSyncJobDone(job.id);

    return {
      status: "processed",
      runId: job.run_id,
      processedFiles: outcome.processed,
      failedFiles: outcome.failed
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected repo sync worker failure";
    await markRepoSyncRunStatus(job.run_id, "failed");
    await markRepoSyncJobFailed(job.id, message);
    return {
      status: "failed",
      runId: job.run_id,
      error: message
    };
  }
}
