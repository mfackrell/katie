-- Mission109: a qualified nonbillable retest of the unused, owner-signed
-- replacement inference. The failed second lease never reached the provider.
-- Keep the original receipt, paid-request ceiling, and both worker attempts.
create function public.project_org_package_unspent_retry_checkpoint(p_project uuid,p_job uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(
  select 1 from project_package_completion_receipts s
  join project_package_corrective_receipts latest on latest.project_id=s.project_id and latest.receipt_id=s.authorization_id
  join mission_assignments j on j.id=s.failed_assignment_id
  join agent_missions m on m.id=s.failed_mission_id and m.id=j.mission_id and m.project_id=s.project_id
  join project_provider_requests q on q.id=s.prior_request_id and q.assignment_id=j.id and q.mission_id=m.id and q.project_id=s.project_id
  where s.project_id=p_project and j.id=p_job
   and s.terms=project_org_package_completion_terms() and s.cutoff>clock_timestamp()+interval '5 minutes'
   and latest.ordinal<6 and latest.checkpoint->>'mode'='authorized-paid-retry'
   and not exists(select 1 from project_package_corrective_receipts x where x.project_id=s.project_id and x.ordinal>latest.ordinal)
   and j.role='work' and m.project_kind='management' and j.status='failed' and m.status='blocked'
   and j.attempts=2 and m.calls=1 and m.routing_calls=0 and j.lease is null and j.lease_until is null
   and j.detail='Trial management inference was already admitted for this mission'
   and m.detail=j.detail and j.result->>'detail'=j.detail
   and q.operation='inference' and q.resolved_at is not null and q.provider_receipt is not null
   and (select count(*) from project_provider_requests x where x.assignment_id=j.id)=2
   and exists(select 1 from project_provider_requests x where x.assignment_id=j.id and x.operation='model-list'
       and x.execution_attempt=q.execution_attempt and x.resolved_at is not null and x.provider_receipt is not null)
   and not exists(select 1 from mission_calls x where x.job_id=j.id)
   and not exists(select 1 from project_package_paid_responses x where x.assignment_id=j.id)
   and not exists(select 1 from project_organization_decisions x where x.assignment_id=j.id)
   and not exists(select 1 from agent_tasks x where x.id=j.id)
   and not exists(select 1 from project_provider_dispatches x where x.task_id=j.id)
   and not project_provider_request_pending(s.project_id))
$$;

-- The worker preflight must ask the same native authority that admits actual
-- provider requests, or verify an already saved response. No new grant.
create function public.project_org_package_management_resume_allowed(p_job uuid,p_lease uuid,p_release text,p_deployment text) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j mission_assignments; m agent_missions; g project_retest_production_release_gate; saved jsonb;
begin
 select * into j from mission_assignments where id=p_job;
 select * into m from agent_missions where id=j.mission_id;
 select * into g from project_retest_production_release_gate where project_id=m.project_id;
 if j.id is null or m.id is null or j.role<>'work' or m.project_kind<>'management' or m.calls<1
 or p_lease is null or j.lease is distinct from p_lease or j.status<>'running' or j.lease_until<=clock_timestamp()
 or g.state is distinct from 'active' or g.alias_name is distinct from 'katie-mu.vercel.app'
 or g.release_sha is distinct from p_release or g.deployment_id is distinct from p_deployment
 or not project_org_package_release_matches(m.project_id,p_release,g.generation,p_deployment)
 or not project_org_package_execution_assignment(j.id) or project_provider_request_pending(m.project_id)
 then return false;end if;
 saved:=project_org_package_saved_response(p_job,p_lease);
 if saved is not null then return saved->>'status'='completed';end if;
 return project_org_package_execution_request(p_job,p_lease::text,'model-list',null);
end $$;

DO $patch$
declare d text; target text; edit record;
begin
 for target in select distinct signature from (values
 ('public.project_org_package_corrective_checkpoint(uuid)'),
 ('public.project_org_package_corrective_resume(uuid,jsonb)'),
 ('public.project_org_package_corrective_continue(uuid,text,bigint,text,text,jsonb)'),
 ('public.project_org_package_management_retake(uuid,text,bigint,text)'),
 ('public.project_org_package_paid_retry_allowed(uuid,text,text)')
 ) signatures(signature) loop
 d:=pg_get_functiondef(target::regprocedure);
 for edit in select * from (values
 ('public.project_org_package_corrective_checkpoint(uuid)',
  $a$if mode is null and root.project_id is not null and m.project_kind='management'$a$,
  $b$if mode is null and root.project_id is not null and m.project_kind='management'
  and n.id=w.manager_id and n.agent_id=j.agent_id and n.status='active' and n.deadline>clock_timestamp()
  and w.status in('review','rejected') and project_provider_continued_assignment(j.id)
  and m.project_evidence->>'organizationNodeId'=w.manager_id::text
  and j.payload->>'organizationNodeId'=w.manager_id::text
  and project_org_package_unspent_retry_checkpoint(p.id,j.id)
 then mode:='unspent-authorized-retry';end if;
 if mode is null and root.project_id is not null and m.project_kind='management'$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',
  $a$mode in('pre-provider-retest','saved-response-replay')$a$,
  $b$mode in('pre-provider-retest','saved-response-replay','unspent-authorized-retry')$b$,3),
 ('public.project_org_package_corrective_checkpoint(uuid)',
  $a$return snapshot||jsonb_build_object('stateHash'$a$,
  $b$if mode='unspent-authorized-retry' then
  snapshot:=snapshot||(select jsonb_build_object('completionAuthorizationId',authorization_id,'priorRequestId',prior_request_id)
    from project_package_completion_receipts where project_id=p.id);
 end if;
 return snapshot||jsonb_build_object('stateHash'$b$,1),
 ('public.project_org_package_corrective_resume(uuid,jsonb)',
  $a$in('pre-provider-retest','saved-response-replay')$a$,
  $b$in('pre-provider-retest','saved-response-replay','unspent-authorized-retry')$b$,1),
 ('public.project_org_package_corrective_continue(uuid,text,bigint,text,text,jsonb)',
  $a$in('pre-provider-retest','saved-response-replay')$a$,
  $b$in('pre-provider-retest','saved-response-replay','unspent-authorized-retry')$b$,1),
 ('public.project_org_package_management_retake(uuid,text,bigint,text)',
  $a$or (latest.checkpoint->>'mode'='saved-response-replay'$a$,
  $b$or (latest.checkpoint->>'mode'='unspent-authorized-retry' and latest.prior_receipt_id=s.authorization_id
  and latest.checkpoint->>'completionAuthorizationId'=s.authorization_id::text
  and latest.checkpoint->>'priorRequestId'=s.prior_request_id::text
  and s.failed_assignment_id=j.id and s.failed_mission_id=m.id and j.attempts=2 and m.calls=1
  and s.cutoff>clock_timestamp() and s.terms=project_org_package_completion_terms()
  and exists(select 1 from project_provider_requests q where q.id=s.prior_request_id and q.assignment_id=j.id and q.operation='inference' and q.resolved_at is not null)
  and (select count(*) from project_provider_requests q where q.assignment_id=j.id)=2
  and not exists(select 1 from project_package_paid_responses where assignment_id=j.id))
 or (latest.checkpoint->>'mode'='saved-response-replay'$b$,1),
 ('public.project_org_package_paid_retry_allowed(uuid,text,text)',
  $a$and j.attempts=2 and j.status='running'$a$,
  $b$and j.status='running'$b$,1),
 ('public.project_org_package_paid_retry_allowed(uuid,text,text)',
  $a$and latest.receipt_id=s.authorization_id and latest.checkpoint->>'mode'='authorized-paid-retry'$a$,
  $b$and ((j.attempts=2 and latest.receipt_id=s.authorization_id and latest.checkpoint->>'mode'='authorized-paid-retry')
   or (j.attempts=3 and latest.prior_receipt_id=s.authorization_id and latest.checkpoint->>'mode'='unspent-authorized-retry'
    and latest.checkpoint->>'assignmentId'=j.id::text and latest.checkpoint->>'missionId'=j.mission_id::text
    and latest.checkpoint->>'priorAttempts'='2'
    and latest.checkpoint->>'completionAuthorizationId'=s.authorization_id::text
    and latest.checkpoint->>'priorRequestId'=s.prior_request_id::text))$b$,1)
 ) edits(signature,anchor,replacement,expected) where signature=target loop
  if (length(d)-length(replace(d,edit.anchor,'')))/length(edit.anchor)<>edit.expected
   then raise exception 'Unexpected unused-retry predecessor: % / %',target,edit.anchor;end if;
  d:=replace(d,edit.anchor,edit.replacement);
 end loop;
 execute d;
 end loop;
end $patch$;

revoke all on function public.project_org_package_unspent_retry_checkpoint(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_management_resume_allowed(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.project_org_package_management_resume_allowed(uuid,uuid,text,text) to service_role;
