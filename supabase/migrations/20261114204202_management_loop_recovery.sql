begin;

-- Replacing an agent cannot repair its unchanged delegated contract. Permit one
-- replacement, then require new completed execution before replacing again.
create function public.project_org_replacement_progress_guard()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare since timestamptz;
begin
 if new.agent_id is not distinct from old.agent_id then return new;end if;
 select max(appointed_at) into since from project_organization_leadership where node_id=old.id and agent_id=old.agent_id;
 if (select count(*) from project_organization_leadership where node_id=old.id and agent_id<>new.agent_id)>1
 and not exists(
  with recursive subtree as (select id,kind from project_organization_nodes where id=old.id
   union all select n.id,n.kind from project_organization_nodes n join subtree s on n.parent_id=s.id)
  select 1 from subtree s join project_organization_assignments b on b.node_id=s.id
   join mission_assignments j on j.id=b.assignment_id join agent_missions m on m.id=j.mission_id
  where s.kind='worker' and j.status='completed' and j.result is not null and m.status='completed'
   and m.project_id=old.project_id and m.project_kind<>'management' and j.updated_at>since
 ) then raise exception 'Repeated leadership replacement requires new completed subordinate execution; repair the contract or escalate';end if;
 return new;
end $$;
revoke all on function public.project_org_replacement_progress_guard() from public,anon,authenticated,service_role;
create trigger organization_replacement_progress before update of agent_id on public.project_organization_nodes
 for each row execute function public.project_org_replacement_progress_guard();

-- A paused, blocked management pointer cannot use ordinary resume. Renewal
-- requires a later deadline, which this recovery explicitly does not grant.
create table public.project_management_resume_receipts (
 source_mission_id uuid primary key references public.agent_missions(id),
 project_id uuid not null references public.work_projects(id),
 window_id uuid not null references public.project_execution_windows(id),
 owner_id uuid not null, decision_id uuid not null references public.project_organization_decisions(id),
 prior_release_sha text not null check(prior_release_sha ~ '^[a-f0-9]{40}$'),
 release_sha text not null check(release_sha ~ '^[a-f0-9]{40}$' and release_sha<>prior_release_sha),
 scope_hash text not null check(scope_hash ~ '^[a-f0-9]{64}$'),
 cutoff timestamptz not null, authorized_at timestamptz not null default clock_timestamp(),
 unique(project_id,window_id)
);
alter table public.project_management_resume_receipts enable row level security;
revoke all on public.project_management_resume_receipts from public,anon,authenticated,service_role;
grant select on public.project_management_resume_receipts to service_role;
create trigger management_resume_immutable before update or delete on public.project_management_resume_receipts
 for each row execute function public.project_org_change_immutable();

create function public.project_org_management_resume_release(p_window uuid,p_release text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_management_resume_receipts r
 join project_execution_windows w on w.id=r.window_id and w.project_id=r.project_id
  and w.owner_id=r.owner_id and w.decision_id=r.decision_id and w.cutoff=r.cutoff
 join project_provider_execution a on a.project_id=r.project_id and a.window_id=w.id
  and a.owner_id=r.owner_id and a.continuation_decision_id=r.decision_id
  and a.continuation_release_sha=r.release_sha and a.deadline=r.cutoff and a.approved_scope=r.scope_hash
 join work_projects p on p.id=r.project_id and p.deadline=r.cutoff
  and p.approved_hash=r.scope_hash and p.approval_hash=r.scope_hash
 where r.window_id=p_window and r.release_sha=p_release
 and (w.release_sha=r.prior_release_sha or exists(select 1 from project_scoped_root_retry_receipts prior
  where prior.window_id=w.id and prior.project_id=r.project_id and prior.owner_id=r.owner_id
   and prior.decision_id=r.decision_id and prior.prior_release_sha=w.release_sha
   and prior.release_sha=r.prior_release_sha and prior.scope_hash=r.scope_hash and prior.cutoff=r.cutoff)));
$$;
revoke all on function public.project_org_management_resume_release(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.project_org_management_resume_release(uuid,text) to service_role;
do $patch$
declare body text;sig text;anchor text;
begin
 for sig,anchor in values
 ('public.project_provider_continued(uuid)','project_org_scoped_retry_release(w.id,a.continuation_release_sha)'),
 ('public.project_org_window_authorized(uuid,uuid,text,uuid,timestamp with time zone)','project_org_scoped_retry_release(w.id,p_release)')
 loop
  body:=pg_get_functiondef(sig::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
   raise exception 'Unexpected installed execution window release contract';end if;
  execute replace(body,anchor,'('||anchor||' or '||replace(anchor,'project_org_scoped_retry_release','project_org_management_resume_release')||')');
 end loop;
end $patch$;

create function public.project_org_resume_management(
 p_owner uuid,p_project uuid,p_new_release text,p_expected_release text,p_scope_hash text,p_source_mission uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p work_projects;a project_provider_execution;source agent_missions;n project_organization_nodes;used integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 select * into source from agent_missions where id=p_source_mission and project_id=p_project for update;
 select * into n from project_organization_nodes where id::text=source.project_evidence->>'organizationNodeId' and project_id=p_project for update;
 if p.id is null or p_owner is null or a.owner_id is distinct from p_owner
 or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 or p_new_release is null or p_new_release !~ '^[a-f0-9]{40}$'
 or p_expected_release is null or p_expected_release !~ '^[a-f0-9]{40}$' or p_new_release=p_expected_release
 or p_scope_hash is null or p_scope_hash !~ '^[a-f0-9]{64}$'
 then raise exception 'Authenticated exact-release project owner approval required';end if;
 select count(*) into used from agent_missions where project_id=p.id;
 if p.organization_version<>1 or not project_provider_mode(p.id) or p.status<>'paused' or p.phase<>'development'
 or p.active_mission_id is distinct from p_source_mission or p.lease is not null or p.lease_until is not null
 or p.deadline<=clock_timestamp()+interval '5 minutes' or a.deadline is distinct from p.deadline
 or p.approved_hash is distinct from p_scope_hash or p.approval_hash is distinct from p_scope_hash or a.approved_scope is distinct from p_scope_hash
 or a.objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
 or a.continuation_release_sha is distinct from p_expected_release or not project_provider_continued(p.id)
 or not project_org_window_authorized(p.id,p_owner,p_expected_release,a.continuation_decision_id,p.deadline)
 or source.id is null or source.status<>'blocked' or source.project_kind<>'management'
 or source.project_evidence->>'providerContinuationRelease' is distinct from p_expected_release
 or source.project_evidence->>'providerContinuationWindow' is distinct from a.window_id::text
 or n.id is null or n.kind<>'manager' or n.status<>'active'
 or not exists(select 1 from mission_assignments j join project_organization_assignments b on b.assignment_id=j.id
   where j.mission_id=source.id and j.status='failed' and b.node_id=n.id)
 or not exists(select 1 from project_scope_ratification_approvals r where r.project_id=p.id and r.owner_id=p_owner
   and r.scope_hash=p_scope_hash and r.approved_at<=source.created_at)
 or used>=p.max_missions
 or exists(select 1 from project_work_packages where project_id=p.id)
 or exists(select 1 from agent_missions where project_id=p.id and status in ('draft','running','awaiting_approval'))
 or project_provider_request_pending(p.id)
 or exists(select 1 from project_management_resume_receipts where project_id=p.id and window_id=a.window_id)
 then raise exception 'Paused management recovery evidence or authority changed';end if;
 insert into project_management_resume_receipts(source_mission_id,project_id,window_id,owner_id,decision_id,prior_release_sha,release_sha,scope_hash,cutoff)
 values(source.id,p.id,a.window_id,p_owner,a.continuation_decision_id,p_expected_release,p_new_release,p_scope_hash,p.deadline);
 update project_provider_execution set continuation_release_sha=p_new_release where project_id=p.id;
 if not project_provider_continued(p.id) then raise exception 'Recovered release authority did not bind';end if;
 -- Keep the blocked pointer: the existing scheduler reconciles it, retaining
 -- retry counts and selecting its lawful parent. No manual decision or dispatch.
 update work_projects set status='running',updated_at=clock_timestamp(),detail='Owner authorized corrected management release; scope, limits and failed mission retained.' where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'management_resume_authorized',
  jsonb_build_object('ownerId',p_owner,'sourceMissionId',source.id,'priorReleaseSha',p_expected_release,'releaseSha',p_new_release,
   'windowId',a.window_id,'scopeHash',p_scope_hash,'deadline',p.deadline,'historicalMissions',used,'maxMissions',p.max_missions));
 return jsonb_build_object('projectId',p.id,'sourceMissionId',source.id,'releaseSha',p_new_release,'historicalMissions',used);
end $$;
revoke all on function public.project_org_resume_management(uuid,uuid,text,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.project_org_resume_management(uuid,uuid,text,text,text,uuid) to service_role;
commit;
