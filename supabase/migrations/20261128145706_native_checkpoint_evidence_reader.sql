-- Native retained checkpoint validation reads immutable dispatch and settled request evidence.
-- The trusted server role may read only; admission/settlement still require the existing RPCs.
GRANT SELECT ON TABLE public.project_provider_dispatches, public.project_provider_requests TO service_role;
DO $verify$
BEGIN
 IF NOT has_table_privilege('service_role','public.project_provider_dispatches','SELECT')
 OR NOT has_table_privilege('service_role','public.project_provider_requests','SELECT')
 OR has_table_privilege('service_role','public.project_provider_dispatches','INSERT,UPDATE,DELETE')
 OR has_table_privilege('service_role','public.project_provider_requests','INSERT,UPDATE,DELETE')
 OR has_table_privilege('anon','public.project_provider_dispatches','SELECT')
 OR has_table_privilege('authenticated','public.project_provider_dispatches','SELECT')
 OR has_table_privilege('anon','public.project_provider_requests','SELECT')
 OR has_table_privilege('authenticated','public.project_provider_requests','SELECT')
 OR (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('project_provider_dispatches','project_provider_requests') AND relrowsecurity)<>2
 THEN RAISE EXCEPTION 'Native evidence reader privilege boundary mismatch'; END IF;
END $verify$;