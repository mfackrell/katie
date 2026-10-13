-- Nullable for historical receipts: no backfill or modification of existing work.
-- A unique local claim prevents concurrent retries from issuing another GPU POST.
ALTER TABLE public.video_analysis_jobs ADD COLUMN IF NOT EXISTS submission_key text;
CREATE UNIQUE INDEX IF NOT EXISTS video_analysis_jobs_submission_key_idx
  ON public.video_analysis_jobs (submission_key) WHERE submission_key IS NOT NULL;
