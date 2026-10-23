-- Preserve the legacy cap for projects without explicit owner spending approval.
ALTER TABLE public.work_projects DROP CONSTRAINT work_projects_token_allowance_check;
ALTER TABLE public.work_projects ADD CONSTRAINT work_projects_token_allowance_check
CHECK (token_allowance >= 60000 AND token_allowance <= 10000000
AND (token_allowance <= 600000 OR budget_authorization_source = 'user_approved'));