begin;

-- Extend the existing owner authority; never delete or reset a recovery receipt.
alter table public.project_provider_execution
 add column continuation_decision_id uuid references public.project_organization_decisions(id),
 add column continuation_release_sha text,
 add column continued_at timestamptz,
 add constraint provider_continuation_complete check (
  (continuation_decision_id is null and continuation_release_sha is null and continued_at is null)
  or (continuation_decision_id is not null and continuation_release_sha is not null and continuation_release_sha ~ '^[0-9a-f]{40}$' and continued_at is not null));

create function public.project_provider_continued(p_project uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_provider_execution a
 join project_director_recoveries r on r.project_id=a.project_id and r.owner_id=a.owner_id
 join project_organization_decisions d on d.id=a.continuation_decision_id and d.project_id=a.project_id and d.assignment_id=r.assignment_id
 join project_organization_nodes n on n.id=d.node_id and n.project_id=a.project_id and n.kind='project_director' and n.parent_id is null
 join agent_missions m on m.id=r.mission_id and m.project_id=a.project_id and m.status='completed'
 join mission_assignments j on j.id=r.assignment_id and j.mission_id=m.id and j.status='completed'
 where a.project_id=p_project and a.continued_at is not null and a.continuation_release_sha ~ '^[0-9a-f]{40}$');
$$;

-- Historical assignments, including the consumed recovery, never enter the new stage.
create function public.project_provider_continued_assignment(p_job uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
 join project_provider_execution a on a.project_id=m.project_id
 join project_director_recoveries r on r.project_id=a.project_id
 where j.id=p_job and j.id<>r.assignment_id and m.project_evidence->>'providerContinuationDecision'=a.continuation_decision_id::text
 and m.project_evidence->>'providerContinuationRelease'=a.continuation_release_sha
 and public.project_provider_continued(a.project_id));
$$;

create function public.project_provider_continue(p_owner uuid,p_project uuid,p_release text,p_decision uuid,p_cutoff timestamptz)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p work_projects;a project_provider_execution;r project_director_recoveries;stamp timestamptz;was_existing boolean;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project;
 select * into r from project_director_recoveries where project_id=p_project;
 if p.id is null or a.owner_id is distinct from p_owner or r.owner_id is distinct from p_owner
 or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 then raise exception 'Authenticated provider project owner required';end if;
 if p_release is null or p_release !~ '^[0-9a-f]{40}$' or p_cutoff is null
 or p_cutoff is distinct from p.deadline or p_cutoff is distinct from a.deadline or p_cutoff is distinct from r.cutoff
 or p_cutoff<=clock_timestamp()
 or a.objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
 then raise exception 'Exact release, unchanged objective and unexpired existing cutoff required';end if;
 was_existing:=a.continued_at is not null;
 if was_existing then
  if a.continuation_decision_id is distinct from p_decision or a.continuation_release_sha is distinct from p_release
  or not project_provider_continued(p.id) then raise exception 'Continuation authority changed';end if;
  stamp:=a.continued_at;
 else
  if p.status<>'blocked' or p.organization_version<>1
  or not exists(select 1 from project_organization_decisions d join project_organization_nodes n on n.id=d.node_id
   join mission_assignments j on j.id=d.assignment_id join agent_missions m on m.id=j.mission_id
   where d.id=p_decision and d.project_id=p.id and d.assignment_id=r.assignment_id and m.id=r.mission_id
   and n.kind='project_director' and n.parent_id is null and not n.decision_needed
   and j.status='completed' and m.status='completed')
  or not exists(select 1 from project_organization_nodes where project_id=p.id and management_level='functional_director' and status='active' and decision_needed)
  or (p.active_mission_id is not null and p.active_mission_id<>r.mission_id and p.active_mission_id is distinct from
   (select (project_evidence->>'previousMissionId')::uuid from agent_missions where id=r.mission_id))
  or exists(select 1 from agent_missions where project_id=p.id and status in ('running','draft','awaiting_approval'))
  or project_provider_request_pending(p.id)
  then raise exception 'Completed Director decision, waiting organization and resolved execution required';end if;
  stamp:=clock_timestamp();
  update project_provider_execution set continuation_decision_id=p_decision,continuation_release_sha=p_release,continued_at=stamp where project_id=p.id;
  -- The old active pointer refers to the failed pre-recovery session. Preserve
  -- every historical row; let the existing scheduler select pending directors.
  update work_projects set status='running',active_mission_id=null,lease=null,lease_until=null,updated_at=stamp,
   detail='Owner authorized continuation of the accepted organization within the existing scope and cutoff.' where id=p.id;
  insert into project_events(project_id,event,data) values(p.id,'provider_execution_continued',
   jsonb_build_object('ownerId',p_owner,'decisionId',p_decision,'recoveryAssignmentId',r.assignment_id,'releaseSha',p_release,'cutoff',p_cutoff));
 end if;
 return jsonb_build_object('projectId',p.id,'decisionId',p_decision,'releaseSha',p_release,'cutoff',p_cutoff,'admittedAt',stamp,'existing',was_existing);
end $$;

-- Reuse normal scheduling, authorization and replay protection only after the
-- durable owner transition. The original recovery assignment remains single-use.
do $migration$
declare body text;patch record;
begin
 for patch in select * from (values
 ('public.project_org_schedule(uuid,uuid)',
  'if not found then return project_org_schedule_before_director_recovery(p_project,p_lease);end if;',
  $stage$if not found then return project_org_schedule_before_director_recovery(p_project,p_lease);end if;
 if project_provider_continued(p_project) then
  continuation_result:=project_org_schedule_before_director_recovery(p_project,p_lease);
  if continuation_result->>'missionId' is not null then
   update agent_missions m set project_evidence=coalesce(m.project_evidence,'{}'::jsonb)||
    jsonb_build_object('providerContinuationDecision',a.continuation_decision_id,'providerContinuationRelease',a.continuation_release_sha)
   from project_provider_execution a where m.id=(continuation_result->>'missionId')::uuid
    and m.project_id=p_project and a.project_id=p_project and m.id<>r.mission_id;
  end if;
  return continuation_result;
 end if;$stage$),
 ('public.project_provider_request(uuid,text,uuid,text,text,text,text)',
  'if found then', 'if found and not project_provider_continued_assignment(p_job) then'),
 ('public.project_org_decide(uuid,uuid,jsonb)',
  'if not found then return project_org_decide_before_director_recovery(p_job,p_lease,p_commands);end if;',
  'if not found or project_provider_continued_assignment(p_job) then return project_org_decide_before_director_recovery(p_job,p_lease,p_commands);end if;'),
 ('public.claim_mission_work_release(text)',
  'and (not exists(select 1 from project_director_recoveries recovery where recovery.project_id=b.project_id)',
  'and ((project_provider_continued_assignment(a.id) and p_release=(select continuation_release_sha from project_provider_execution where project_id=b.project_id)) or not exists(select 1 from project_director_recoveries recovery where recovery.project_id=b.project_id)')
,
 ('public.finish_work_project_lifecycle(uuid,uuid,text,jsonb)',
  'perform control_mission(mid,''start'');',
  $stage$update agent_missions m set project_evidence=coalesce(m.project_evidence,'{}'::jsonb)||
   jsonb_build_object('providerContinuationDecision',a.continuation_decision_id,'providerContinuationRelease',a.continuation_release_sha)
   from project_provider_execution a where m.id=mid and m.project_id=p.id and a.project_id=p.id and project_provider_continued(p.id);
  perform control_mission(mid,'start');$stage$)
 ) as changes(signature,original,replacement) loop
  body:=pg_get_functiondef(patch.signature::regprocedure);
  if (length(body)-length(replace(body,patch.original,'')))/length(patch.original)<>1
  then raise exception 'Unexpected installed continuation boundary: %',patch.signature;end if;
  body:=replace(body,patch.original,patch.replacement);
  if patch.signature='public.project_org_schedule(uuid,uuid)' then
   if strpos(body,'declare r project_director_recoveries;')=0 then raise exception 'Unexpected scheduler declaration';end if;
   body:=replace(body,'declare r project_director_recoveries;','declare r project_director_recoveries; continuation_result jsonb;');
  end if;
  execute body;
 end loop;
end $migration$;

revoke all on function public.project_provider_continue(uuid,uuid,text,uuid,timestamptz),
 public.project_provider_continued(uuid),public.project_provider_continued_assignment(uuid) from public,anon,authenticated;
grant execute on function public.project_provider_continue(uuid,uuid,text,uuid,timestamptz),
 public.project_provider_continued(uuid),public.project_provider_continued_assignment(uuid) to service_role;
commit;
