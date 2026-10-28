-- The existing controller persists a six-package structured forecast plus its
-- provisional specialist allocation. Its complete JSON exceeds the original
-- 4k prose field even for three small milestones. Keep it bounded and intact;
-- this changes storage capacity only, never spending authorization.
ALTER TABLE public.work_projects DROP CONSTRAINT work_projects_estimate_rationale_size;
ALTER TABLE public.work_projects ADD CONSTRAINT work_projects_estimate_rationale_size
 CHECK (estimate_rationale IS NULL OR length(estimate_rationale) <= 16000);
