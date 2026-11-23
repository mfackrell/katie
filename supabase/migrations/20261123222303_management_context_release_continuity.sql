-- Continue the already authenticated original owner window across future
-- reviewed exact-release promotions. This adds no paid or retry authority.
-- Preimage guard rejects every changed installed authorization function.
BEGIN;
DO $guard$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc
  WHERE oid='public.project_org_m84_provider_release_valid(uuid)'::regprocedure)
 <> '8b2b0d1924e6c27c776fd34d5944947a'
 THEN RAISE EXCEPTION 'Unexpected original bounded owner release contract'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.project_org_m84_provider_release_valid(p_project uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT EXISTS(
  SELECT 1 FROM public.project_bounded_recovery_receipts r
  JOIN public.project_retest_production_release_gate g ON g.project_id=r.project_id
  WHERE r.project_id=p_project
    AND g.state='active' AND g.alias_name='katie-mu.vercel.app'
    AND r.owner_id='04ed6c05-a586-4a56-ba81-1b50e378746b'::uuid
    AND r.cutoff>clock_timestamp()
    AND ( (g.release_sha=r.release_sha AND g.generation=r.release_generation AND g.deployment_id=r.deployment_id)
      OR EXISTS(
       SELECT 1 FROM public.project_m84_provider_release_handoffs h
       WHERE h.project_id=r.project_id AND h.owner_window=r.authorization_id
        AND h.source_release=r.release_sha AND h.source_generation=r.release_generation
        AND h.source_deployment=r.deployment_id
        AND h.release_sha=g.release_sha AND h.generation=g.generation
        AND h.deployment_id=g.deployment_id
      )
      -- Subsequent independently gated production releases retain the same
      -- original owner/scope/deadline authority, with no new spending or
      -- implied retry. The release gate itself must have advanced through
      -- its locked CLOSE -> verified READY/promote -> OPEN transition.
      OR EXISTS(
       SELECT 1 FROM public.project_m84_provider_release_handoffs h
       JOIN public.project_events activated ON activated.project_id=r.project_id
        AND activated.event='mission79_release_gate_transition'
        AND activated.data->>'action'='active'
        AND activated.data->>'alias'='katie-mu.vercel.app'
        AND activated.data->>'releaseSha'=g.release_sha
        AND activated.data->>'deploymentId'=g.deployment_id
        AND (activated.data->>'priorGeneration')::bigint=g.generation-1
        AND (activated.data->>'recordedAt')::timestamptz=g.updated_at
       WHERE h.project_id=r.project_id AND h.owner_window=r.authorization_id
        AND h.source_release=r.release_sha AND h.source_generation=r.release_generation
        AND h.source_deployment=r.deployment_id
        AND h.release_sha='ca9806a2e0520d5a26fb4b16574dacb80caa4b17'
        AND h.generation=31
        AND h.deployment_id='dpl_5qjLXZPvuuVQE5t5BPWLXxyKmtfz'
        AND g.generation>=h.generation+2
        AND activated.created_at>h.recorded_at
      ) )
 );
$function$;
REVOKE ALL ON FUNCTION public.project_org_m84_provider_release_valid(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_org_m84_provider_release_valid(uuid) TO service_role;
COMMIT;

