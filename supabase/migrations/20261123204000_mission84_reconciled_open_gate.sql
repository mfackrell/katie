-- Mission84 released nonbillable catalog: allow the matching already-closed
-- generation-30 gate to OPEN for exactly the verified READY new deployment.
-- Does not change approval, infer, update original assignment or spend.
BEGIN;
DO $guard$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc
   WHERE oid='public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)'::regprocedure)
   <> 'fda400f5af4e974bd4e478024af59136'
 THEN RAISE EXCEPTION 'Unexpected installed Mission84 release gate source';END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.project_org_retest_set_release_gate(p_project uuid, p_release text, p_deployment text, p_action text, p_expected_generation bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare g project_retest_production_release_gate;p work_projects;stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 select * into p from work_projects where id=p_project for update;
 select * into g from project_retest_production_release_gate where project_id=p_project for update;
 if p_expected_generation is null or p_expected_generation<0
  or (g.project_id is null and p_expected_generation<>0)
  or (g.project_id is not null and g.generation is distinct from p_expected_generation)
 then raise exception 'Observed release gate generation changed under operator lock';end if;
 if p.id is null or p.id is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  or p_release is null or p_release !~ '^[0-9a-f]{40}$'
  or p_deployment is null or p_deployment !~ '^dpl_[A-Za-z0-9]+$'
  or p_action is null or p_action not in ('active','closed')
  or p.max_missions<>96 or p.token_allowance<>600000
  or p.approved_hash is distinct from '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  or not exists(select 1 from project_blocked_management_retest_receipts r
    where r.project_id=p_project and r.historical_missions=78)
 then raise exception 'Exact original project release authority required';end if;
 if p_action='closed' and (g.project_id is null or g.state<>'active'
   or g.release_sha is distinct from p_release or g.deployment_id is distinct from p_deployment)
 then raise exception 'Only active exact deployment can be sealed before promotion';end if;
 if p_action='active' and g.project_id is not null and g.state<>'closed'
 then raise exception 'Prior release must be closed before a new SHA is activated';end if;
 -- A bound but unleased original management mission still has a valid
 -- one-time owner grant. Closing and reopening this gate would invalidate
 -- its immutable generation without any supported rebinding operation.
 -- Fail CLOSED before any release mutation; let normal cron claim it, or
 -- terminalize the expired unleased window under its existing exact epoch.
 if p_action='closed' and exists(
  select 1 from project_retest_claim_release_receipts receipt
  join agent_missions m on m.id=receipt.mission_id
  join mission_assignments j on j.id=receipt.assignment_id and j.mission_id=m.id
  join work_projects wp on wp.id=receipt.project_id
  where receipt.project_id=p_project
   and receipt.mission_id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
   and receipt.assignment_id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
   and receipt.bound_release_sha=g.release_sha
   and receipt.bound_deployment_id=g.deployment_id
   and receipt.bound_release_generation=g.generation
   and wp.active_mission_id=m.id
   -- The normal project cron may have blocked an expired owner window
   -- before mission cron can terminally settle this still-unclaimed job.
   -- Do not let CLOSE invalidate that bound generation on either status.
   and wp.status in ('running','blocked') and m.status in ('running','blocked')
   and j.status='queued' and j.attempts=0
   and j.lease is null and j.lease_until is null
 ) then raise exception 'Bound original mission79 is unleased; close only after normal claim or expiry settlement';end if;
 -- Closing a generation must NEVER race a paid worker that already holds a
 -- source-bound lease. An expired lease can be cleared/requeued by the worker
 -- scheduler while the original worker is still in-flight, so reject every
 -- non-completed attempted assignment in the renewed mission lineage, even
 -- when lease is null. Terminal completed jobs cannot start new inference.
 -- The global state/claim advisory locks serialize this check with leasing.
 if exists(
  select 1 from agent_missions m
  join mission_assignments j on j.mission_id=m.id
  left join project_retest_future_window_receipts w on w.project_id=m.project_id
  where m.project_id=p_project
   and (m.id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
     or (w.project_id is not null and m.created_at>=w.authorized_at))
   and j.attempts>0
   and NOT (j.id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid and m.id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid and j.status='queued' and j.attempts=1 and j.lease is null and j.lease_until is null and m.status='running' and m.calls=1 and p.status='blocked' and p.active_mission_id=m.id and p.deadline>clock_timestamp()+interval '5 minutes' and exists (select 1 from project_mission79_retry_receipts r where r.project_id=p.id and r.assignment_id=j.id and r.mission_id=m.id and r.release_sha=g.release_sha and r.release_generation=g.generation - CASE WHEN g.state='closed' THEN 1 ELSE 0 END and r.deployment_id=g.deployment_id and r.prior_attempts=1 and r.prior_calls=1) and not project_provider_request_pending(p.id))
   -- An already STOPPED, fully reconciled, nonbillable Mission84 catalog
   -- may be transferred to the exact new production release without allowing
   -- a new inference, consuming a retry or relaxing any other release fence.
   and NOT (
    (p_action='closed' OR (
      p_action='active' AND g.state='closed'
      AND g.generation=30
      AND g.release_sha='71516560c03f767d109fa80ee8b1fa3c4d8a25ad'
      AND g.deployment_id='dpl_4mDDTZqvvGi7VgkbsRCL97Xuhkj7'
      AND p_release='ca9806a2e0520d5a26fb4b16574dacb80caa4b17'
      AND p_deployment='dpl_5qjLXZPvuuVQE5t5BPWLXxyKmtfz'
    ))
    and j.id='bd8de51d-0195-4c5f-9c88-9dc39e228636'::uuid
    and m.id='18819669-d4cf-4010-a455-19f5bcbf93cb'::uuid
    and j.status='queued' and j.attempts=1
    and j.lease is null and j.lease_until is null
    and m.status='running' and m.calls=0
    and p.status='stopped' and p.active_mission_id=m.id
    and p.deadline>clock_timestamp()+interval '5 minutes'
    and exists(select 1 from public.project_bounded_recovery_receipts r
      where r.project_id=p.id and r.release_sha=g.release_sha
       and r.release_generation=g.generation-CASE WHEN g.state='closed' THEN 1 ELSE 0 END
       and r.deployment_id=g.deployment_id
       and r.cutoff=p.deadline and r.additional_paid_retries=0)
    and exists(select 1 from public.project_m84_catalog_reconciliations c
      join public.project_provider_requests q on q.id=c.request_id
      where c.project_id=p.id and c.assignment_id=j.id
       and q.project_id=p.id and q.mission_id=m.id
       and q.operation='model-list' and q.provider_receipt='model-catalog'
       and q.resolved_at is not null)
    and not public.project_provider_request_pending(p.id)
   )
   and (j.lease is not null or j.lease_until is not null
    or j.status not in ('completed','failed')
    or (j.status='failed' and exists(
      select 1 from project_provider_requests request
      where request.assignment_id=j.id and request.resolved_at is null)))
 ) or project_provider_request_pending(p_project)
 then raise exception 'Undrained owner-renewed worker attempt or unresolved provider request; release gate transition denied';end if;
 stamp:=clock_timestamp();
 if g.project_id is null then
  if p_action<>'active' then raise exception 'Initial release requires verified READY alias';end if;
  insert into project_retest_production_release_gate
   (project_id,release_sha,deployment_id,state,generation,updated_at)
   values(p_project,p_release,p_deployment,'active',1,stamp);
 else
  update project_retest_production_release_gate
   set release_sha=p_release,deployment_id=p_deployment,state=p_action,
       generation=g.generation+1,updated_at=stamp where project_id=p_project;
 end if;
 insert into project_events(project_id,event,data)
 values(p_project,'mission79_release_gate_transition',
  jsonb_build_object('action',p_action,'releaseSha',p_release,
    'deploymentId',p_deployment,'alias','katie-mu.vercel.app',
    'priorGeneration',g.generation,'recordedAt',stamp));
 return jsonb_build_object('projectId',p_project,'state',p_action,
  'releaseSha',p_release,'deploymentId',p_deployment,'recordedAt',stamp);
end
$function$
;
COMMIT;
