begin;

-- Only owner-ratified development creates a new management decision epoch.
-- Preserve every historical failure, but count the retries for the approved
-- objective from its immutable ratification, not from earlier pre-scope runs.
-- No changes to worker, provider, spending, leasing or reporting permissions.
do $patch$
declare
 body text;
 original text := 'if (select count(*) from agent_missions where project_id=p.id and project_kind=''management'' and project_evidence->>''organizationNodeId''=n.id::text and status in (''blocked'',''stopped''))>=2 then';
 replacement text := 'if (select count(*) from agent_missions where project_id=p.id and project_kind=''management'' and project_evidence->>''organizationNodeId''=n.id::text and status in (''blocked'',''stopped'') and (not project_provider_mode(p.id) or p.phase<>''development'' or p.approved_hash is null or created_at>=coalesce((select max(s.approved_at) from project_scope_ratification_approvals s where s.project_id=p.id and s.scope_hash=p.approved_hash),''-infinity''::timestamptz)))>=2 then';
begin
 body := pg_get_functiondef('public.project_org_schedule_hierarchy(uuid,uuid)'::regprocedure);
 if (length(body)-length(replace(body,original,'')))/length(original)<>1 then
   raise exception 'Unexpected installed management retry contract';
 end if;
 execute replace(body,original,replacement);
end
$patch$;

-- Rebind this recovery to a new release without renewing the owner window or
-- rewriting its immutable receipt. Only the guarded recovery below may append
-- this exact window/source/scope binding; ordinary window semantics stay intact.
create table public.project_scoped_root_retry_receipts (
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
alter table public.project_scoped_root_retry_receipts enable row level security;
revoke all on public.project_scoped_root_retry_receipts from public,anon,authenticated,service_role;
grant select on public.project_scoped_root_retry_receipts to service_role;
create trigger scoped_root_retry_immutable before update or delete on public.project_scoped_root_retry_receipts
 for each row execute function public.project_org_change_immutable();

create function public.project_org_scoped_retry_release(p_window uuid,p_release text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_scoped_root_retry_receipts r
 join project_execution_windows w on w.id=r.window_id and w.project_id=r.project_id
  and w.owner_id=r.owner_id and w.decision_id=r.decision_id
  and w.release_sha=r.prior_release_sha and w.cutoff=r.cutoff
 join project_provider_execution a on a.project_id=r.project_id and a.window_id=w.id
  and a.owner_id=r.owner_id and a.continuation_decision_id=r.decision_id
  and a.continuation_release_sha=r.release_sha and a.deadline=r.cutoff and a.approved_scope=r.scope_hash
 join work_projects p on p.id=r.project_id and p.deadline=r.cutoff
  and p.approved_hash=r.scope_hash and p.approval_hash=r.scope_hash
 where r.window_id=p_window and r.release_sha=p_release);
$$;
revoke all on function public.project_org_scoped_retry_release(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.project_org_scoped_retry_release(uuid,text) to service_role;
do $patch$
declare body text;sig text;anchor text;replacement text;
begin
 for sig,anchor,replacement in values
  ('public.project_provider_continued(uuid)','w.release_sha=a.continuation_release_sha',
   '(w.release_sha=a.continuation_release_sha or project_org_scoped_retry_release(w.id,a.continuation_release_sha))'),
  ('public.project_org_window_authorized(uuid,uuid,text,uuid,timestamp with time zone)','w.release_sha=p_release',
   '(w.release_sha=p_release or project_org_scoped_retry_release(w.id,p_release))')
 loop
  body:=pg_get_functiondef(sig::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
   raise exception 'Unexpected installed execution window release contract';
  end if;
  execute replace(body,anchor,replacement);
 end loop;
end $patch$;

-- The existing live directorate is named independent_qa. Apply the same
-- implementation fence already enforced for quality_assurance, including all
-- descendants, rather than relying on model guidance to preserve separation.
do $patch$
declare body text;anchor text:='select 1 from ancestors where area=''quality_assurance'')';
begin
 body:=pg_get_functiondef('public.project_org_amend_delegation(uuid,uuid,jsonb)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
  raise exception 'Unexpected installed independent QA amendment guard';
 end if;
 execute replace(body,anchor,'select 1 from ancestors where area in (''quality_assurance'',''independent_qa''))');
end $patch$;

-- One audited recovery for an existing Project Director that was prematurely
-- blocked by historical (pre-ratification) failure counts. Never reset attempts,
-- rewrite decisions, expand authority, alter budgets or manually call a worker.
create function public.project_org_resume_scoped_root_retry(
 p_owner uuid,p_project uuid,p_new_release text,p_expected_release text,
 p_scope_hash text,p_source_mission uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
declare
 p work_projects; a project_provider_execution; root project_organization_nodes;
 source agent_missions; rat project_scope_ratification_approvals;
 failures integer; used integer; stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 select * into root from project_organization_nodes
  where project_id=p_project and kind='project_director'
  and parent_id is null and status='active' for update;
 select * into source from agent_missions where id=p_source_mission and project_id=p_project for update;
 select * into rat from project_scope_ratification_approvals
  where project_id=p_project and scope_hash=p_scope_hash;
 if p.id is null or p_owner is null or a.owner_id is distinct from p_owner
    or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
    or p_new_release is null or p_new_release !~ '^[a-f0-9]{40}$'
    or p_expected_release is null or p_expected_release !~ '^[a-f0-9]{40}$'
    or p_new_release=p_expected_release
    or p_scope_hash is null or p_scope_hash !~ '^[a-f0-9]{64}$'
 then raise exception 'Authenticated, exact-release project owner approval required';end if;

 select count(*) into failures from agent_missions m
  where m.project_id=p.id and m.project_kind='management'
   and m.project_evidence->>'organizationNodeId'=root.id::text
   and m.status in ('blocked','stopped') and m.created_at>=rat.approved_at;
 select count(*) into used from agent_missions m where m.project_id=p.id;

 if p.organization_version<>1 or not project_provider_mode(p.id)
    or p.status<>'blocked' or p.phase<>'development'
    or p.detail is distinct from 'Project management cannot achieve its objective within bounded retry authority'
    or p.active_mission_id is distinct from p_source_mission
    or p.lease is not null or p.lease_until is not null
    or p.deadline<=clock_timestamp()+interval '5 minutes'
    or p.approval_hash is distinct from p_scope_hash
    or p.approved_hash is distinct from p_scope_hash or a.approved_scope is distinct from p_scope_hash
    or a.deadline is distinct from p.deadline or a.continuation_release_sha is distinct from p_expected_release
    or a.continued_at is null or not project_provider_continued(p.id)
    or not exists(select 1 from project_execution_windows w where w.id=a.window_id
       and w.project_id=p.id and w.owner_id=p_owner and w.decision_id=a.continuation_decision_id
       and w.release_sha=p_expected_release and w.cutoff=p.deadline)
    or root.id is null or not root.decision_needed or root.deadline<p.deadline
    or rat.proposal_id is null or rat.owner_id is distinct from p_owner or source.id is null
    or source.project_kind<>'management'
    or source.project_evidence->>'organizationNodeId' is distinct from root.id::text
    or source.project_evidence->>'providerContinuationRelease' is distinct from p_expected_release
    or source.project_evidence->>'providerContinuationWindow' is distinct from a.window_id::text
    or source.status<>'blocked' or source.created_at<rat.approved_at
    or failures<>1 or used>=p.max_missions
    or not exists(select 1 from mission_assignments j
       where j.mission_id=source.id and j.status='failed'
         and j.result->'managementCommandRejection'->>'code'='director_appointment')
    or (select count(*) from project_organization_scope_grants g
        join project_organization_nodes n on n.id=g.node_id where n.project_id=p.id)<>1
    or not exists(select 1 from project_organization_scope_grants g
        where g.node_id=root.id and g.scope_hash=p_scope_hash and g.parent_id is null)
    or not exists(select 1 from project_organization_nodes n where n.parent_id=root.id and n.area='game_delivery' and n.management_level='functional_director' and n.status='active' and not('development'=any(n.tools)))
    or exists(select 1 from project_work_packages where project_id=p.id)
    or exists(select 1 from agent_missions where project_id=p.id and status in ('draft','running','awaiting_approval'))
    or project_provider_request_pending(p.id)
    or exists(select 1 from project_scoped_root_retry_receipts
        where source_mission_id=p_source_mission or (project_id=p.id and window_id=a.window_id))
    or exists(select 1 from project_events
        where project_id=p.id and event='scoped_root_retry_authorized'
          and data->>'sourceMissionId'=p_source_mission::text)
 then raise exception 'Original scoped root-retry evidence or authority changed';end if;

 stamp:=clock_timestamp();
 insert into project_scoped_root_retry_receipts(source_mission_id,project_id,window_id,
  owner_id,decision_id,prior_release_sha,release_sha,scope_hash,cutoff,authorized_at)
 values(p_source_mission,p.id,a.window_id,p_owner,a.continuation_decision_id,
  p_expected_release,p_new_release,p_scope_hash,p.deadline,stamp);
 update project_provider_execution set continuation_release_sha=p_new_release where project_id=p.id;
 if not project_provider_continued(p.id) then raise exception 'Recovered release authority did not bind';end if;
 update work_projects set status='running',lease=null,lease_until=null,
  detail='Scoped Project Director retry authorized after preserving pre-ratification failures',
  updated_at=stamp where id=p.id;
 insert into project_events(project_id,event,data) values(
  p.id,'scoped_root_retry_authorized',
  jsonb_build_object('ownerId',p_owner,'newReleaseSha',p_new_release,
   'priorContinuationReleaseSha',p_expected_release,'continuationReleaseSha',p_new_release,
   'windowId',a.window_id,'scopeHash',p_scope_hash,
   'sourceMissionId',p_source_mission,'approvedAt',rat.approved_at,
   'scopedRootFailures',failures,'historicalMissions',used,
   'maxMissions',p.max_missions,'deadline',p.deadline,
   'preservedActiveMissionId',p_source_mission,'authorizedAt',stamp)
 );
 return jsonb_build_object('projectId',p.id,'status','running',
  'sourceMissionId',p_source_mission,'newReleaseSha',p_new_release,
  'scopedRootFailures',failures,'historicalMissions',used,'authorizedAt',stamp);
end
$fn$;

revoke all on function public.project_org_resume_scoped_root_retry(uuid,uuid,text,text,text,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.project_org_resume_scoped_root_retry(uuid,uuid,text,text,text,uuid) to service_role;
commit;
