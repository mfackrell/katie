-- Retain the immutable consumed receipt and make a NEW authenticated offer
-- possible only for a different latest, pre-inference failed source mission.
-- Every existing owner/release/window/state/context/lease guard is retained.
-- Installing this migration neither authorizes nor queues work.
BEGIN;
DO $guard$
DECLARE installed text;anchor text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=
   'public.project_org_context_retest_offer(uuid,uuid,text)'::regprocedure)
   IS DISTINCT FROM 'c49ea85bae7170fe8346206bf8b26eea'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=
   'public.project_org_context_retest_claim_authorized(uuid,text,bigint,text)'::regprocedure)
   IS DISTINCT FROM '9744c78e4f4c650f421d991c2355d8a1'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=
   'public.project_org_context_retest_authorize(uuid,uuid,text,bigint,text,uuid,uuid,uuid,text,text,integer)'::regprocedure)
   IS DISTINCT FROM '6f790edc5dda4841f6a2773abe771130'
 THEN RAISE EXCEPTION 'Unexpected installed source-bound context recovery definition'; END IF;
 installed:=pg_get_functiondef('public.project_org_context_retest_offer(uuid,uuid,text)'::regprocedure);
 anchor:='SELECT * INTO prior FROM public.project_context_retest_receipts WHERE project_id=p_project;';
 IF (length(installed)-length(replace(installed,anchor,'')))/length(anchor)<>1
 THEN RAISE EXCEPTION 'Expected prior receipt lookup anchor not unique'; END IF;
 EXECUTE replace(installed,anchor,
  'SELECT * INTO prior FROM public.project_context_retest_receipts WHERE project_id=p_project AND source_mission_id=p.active_mission_id;');
 installed:=pg_get_functiondef('public.project_org_context_retest_claim_authorized(uuid,text,bigint,text)'::regprocedure);
 anchor:='AND p.status=''running'' AND p.phase=''development''';
 IF (length(installed)-length(replace(installed,anchor,'')))/length(anchor)<>1
 THEN RAISE EXCEPTION 'Expected active source claim anchor not unique'; END IF;
 EXECUTE replace(installed,anchor,anchor||' AND p.active_mission_id=m.id');
END
$guard$;
ALTER TABLE public.project_context_retest_receipts
 DROP CONSTRAINT project_context_retest_receipts_pkey,
 ADD CONSTRAINT project_context_retest_receipts_pkey PRIMARY KEY(project_id,source_mission_id),
 ADD CONSTRAINT project_context_retest_receipts_source_assignment_key UNIQUE(source_assignment_id);
COMMIT;
