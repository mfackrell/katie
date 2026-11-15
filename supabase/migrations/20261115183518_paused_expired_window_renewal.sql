begin;

-- A renewal is a new owner window, never an edit to a historical authorization.
-- It does not resume the project. The existing one-shot management recovery
-- consumes the exact release bound here in a later owner-authorized transaction.
create table public.project_paused_window_renewals (
 authorization_id uuid primary key references public.project_execution_windows(id),
 project_id uuid not null unique references public.work_projects(id),
 owner_id uuid not null,
 source_mission_id uuid not null unique references public.agent_missions(id),
 prior_window_id uuid not null unique references public.project_execution_windows(id),
 decision_id uuid not null references public.project_organization_decisions(id),
 prior_release_sha text not null check(prior_release_sha ~ '^[a-f0-9]{40}$'),
 release_sha text not null check(release_sha ~ '^[a-f0-9]{40}$' and release_sha<>prior_release_sha),
 scope_hash text not null check(scope_hash ~ '^[a-f0-9]{64}$'),
 state_hash text not null check(state_hash ~ '^[a-f0-9]{64}$'),
 source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 prior_cutoff timestamptz not null, cutoff timestamptz not null,
 historical_missions integer not null check(historical_missions<96),
 node_count integer not null check(node_count=13),
 authorized_at timestamptz not null default clock_timestamp(),
 check(isfinite(prior_cutoff) and isfinite(cutoff) and cutoff=prior_cutoff+interval '24 hours')
);
alter table public.project_paused_window_renewals enable row level security;
revoke all on public.project_paused_window_renewals from public,anon,authenticated,service_role;
grant select on public.project_paused_window_renewals to service_role;
create trigger paused_window_renewal_immutable before update or delete on public.project_paused_window_renewals
 for each row execute function public.project_org_change_immutable();

create function public.project_org_renew_paused_window(
 p_owner uuid,p_project uuid,p_release text,p_expected_release text,p_scope_hash text,
 p_source_mission uuid,p_prior_window uuid,p_prior_cutoff timestamptz,p_cutoff timestamptz,
 p_authorization uuid,p_state_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p work_projects;a project_provider_execution;source agent_missions;
 n project_organization_nodes;root project_organization_nodes;used integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 select * into source from agent_missions where id=p_source_mission and project_id=p_project for update;
 if p.id is null or p_owner is null or a.owner_id is distinct from p_owner
 or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 or p_release is null or p_release !~ '^[a-f0-9]{40}$'
 or p_expected_release is null or p_expected_release !~ '^[a-f0-9]{40}$' or p_release=p_expected_release
 or p_scope_hash is null or p_scope_hash !~ '^[a-f0-9]{64}$'
 then raise exception 'Authenticated exact-release project owner approval required';end if;
 if p_authorization is null or p_prior_window is null or p_state_hash is null
 or p_state_hash !~ '^[a-f0-9]{64}$'
 or p_prior_window is distinct from a.window_id
 or p_prior_cutoff is distinct from p.deadline or p_prior_cutoff is distinct from a.deadline
 or p_prior_cutoff>=clock_timestamp()
 or p_cutoff is null or not isfinite(p_cutoff) or p_cutoff<>p_prior_cutoff+interval '24 hours'
 or p_cutoff<=clock_timestamp()+interval '5 minutes'
 or exists(select 1 from project_execution_windows where id=p_authorization or (project_id=p.id and prior_cutoff=p_prior_cutoff))
 or exists(select 1 from project_paused_window_renewals where project_id=p.id or source_mission_id=p_source_mission)
 then raise exception 'Exact expired window and unused 24-hour owner renewal required';end if;
 select count(*) into used from agent_missions where project_id=p.id;
 select * into root from project_organization_nodes where project_id=p.id and kind='project_director' and parent_id is null for update;
 if p.organization_version<>1 or not project_provider_mode(p.id) or p.status<>'paused' or p.phase<>'development'
 or p.active_mission_id is distinct from p_source_mission or p.lease is not null or p.lease_until is not null
 or p.approved_hash is distinct from p_scope_hash or p.approval_hash is distinct from p_scope_hash or a.approved_scope is distinct from p_scope_hash
 or a.objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
 or a.continuation_release_sha is distinct from p_expected_release or not project_provider_continued(p.id)
 or not project_org_window_authorized(p.id,p_owner,p_expected_release,a.continuation_decision_id,p.deadline)
 or source.id is null or source.status<>'blocked' or source.project_kind<>'management'
 or source.project_evidence->>'providerContinuationRelease' is distinct from p_expected_release
 or source.project_evidence->>'providerContinuationWindow' is distinct from a.window_id::text
 or source.project_evidence->>'providerContinuationDecision' is distinct from a.continuation_decision_id::text
 or not exists(select 1 from project_organization_nodes x join project_organization_assignments b on b.node_id=x.id
  join mission_assignments j on j.id=b.assignment_id
  where x.id::text=source.project_evidence->>'organizationNodeId' and x.project_id=p.id
   and x.kind='manager' and x.status='active' and j.mission_id=source.id and j.status='failed')
 or not exists(select 1 from project_scope_ratification_approvals r where r.project_id=p.id and r.owner_id=p_owner
  and r.scope_hash=p_scope_hash and r.approved_at<=source.created_at)
 or p.max_missions<>96 or p.token_allowance<>600000 or used>=96
 or root.id is null or root.token_limit<>600000
 or exists(select 1 from project_work_packages where project_id=p.id)
 or exists(select 1 from agent_missions where project_id=p.id and status in ('draft','running','awaiting_approval'))
 or exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
  where m.project_id=p.id and j.status in ('queued','running','waiting_external'))
 or exists(select 1 from project_organization_work w join project_organization_nodes x on x.id=w.node_id
  where x.project_id=p.id and w.status in ('queued','running'))
 or exists(select 1 from agent_tasks t join mission_assignments j on j.id=t.id join agent_missions m on m.id=j.mission_id
  where m.project_id=p.id and t.status in ('dispatching','submitted'))
 or project_provider_request_pending(p.id)
 or exists(select 1 from project_management_resume_receipts where project_id=p.id)
 then raise exception 'Paused management renewal evidence or authority changed';end if;
 perform 1 from project_organization_nodes where project_id=p.id order by depth,id for update;
 if (select count(*) from project_organization_nodes where project_id=p.id)<>13
 or (select count(*) from project_organization_nodes where project_id=p.id and parent_id is null)<>1
 or exists(select 1 from project_organization_nodes x where x.project_id=p.id and
  (x.status<>'active' or x.deadline is distinct from p_prior_cutoff or (x.id<>root.id and
   not exists(select 1 from project_organization_nodes parent where parent.id=x.parent_id
    and parent.project_id=p.id and parent.depth=x.depth-1 and x.tools<@parent.tools))))
 or exists(with recursive qa as (
  select id from project_organization_nodes where project_id=p.id and area in ('quality_assurance','independent_qa')
  union all select x.id from project_organization_nodes x join qa on x.parent_id=qa.id)
  select 1 from qa join project_organization_nodes x on x.id=qa.id where 'development'=any(x.tools))
 or project_org_hierarchy_recovery_state(p.id) is distinct from p_state_hash
 then raise exception 'Exact original hierarchy and recovery state required';end if;

 -- The historical release is retained until the separate one-shot resume. No
 -- mission can claim it: the project remains paused and has no pending work.
 insert into project_execution_windows(id,project_id,owner_id,release_sha,decision_id,prior_cutoff,cutoff,prior_release_sha)
 values(p_authorization,p.id,p_owner,p_expected_release,a.continuation_decision_id,p_prior_cutoff,p_cutoff,p_expected_release);
 insert into project_paused_window_renewals(authorization_id,project_id,owner_id,source_mission_id,prior_window_id,
  decision_id,prior_release_sha,release_sha,scope_hash,state_hash,source_hash,prior_cutoff,cutoff,historical_missions,node_count)
 values(p_authorization,p.id,p_owner,source.id,a.window_id,a.continuation_decision_id,p_expected_release,p_release,
  p_scope_hash,p_state_hash,encode(sha256(convert_to(project_canonical(to_jsonb(source)),'UTF8')),'hex'),p_prior_cutoff,p_cutoff,used,13);
 update project_provider_execution set deadline=p_cutoff,window_id=p_authorization where project_id=p.id;
 update work_projects set deadline=p_cutoff,updated_at=clock_timestamp() where id=p.id;
 for n in select * from project_organization_nodes where project_id=p.id order by depth,id for update loop
  insert into project_organization_contract_changes(project_id,node_id,window_id,prior_deadline,deadline,prior_tools,tools,prior_submission)
  values(p.id,n.id,p_authorization,n.deadline,p_cutoff,n.tools,n.tools,n.completion_submission);
  update project_organization_nodes set deadline=p_cutoff where id=n.id;
 end loop;
 if not project_provider_continued(p.id)
 or (select count(*) from project_organization_nodes where project_id=p.id and deadline=p_cutoff)<>13
 then raise exception 'Atomic paused renewal failed authority invariants';end if;
 insert into project_events(project_id,event,data) values(p.id,'paused_execution_window_renewed',
  jsonb_build_object('authorizationId',p_authorization,'ownerId',p_owner,'sourceMissionId',source.id,
   'priorWindowId',a.window_id,'priorReleaseSha',p_expected_release,'resumeReleaseSha',p_release,
   'scopeHash',p_scope_hash,'priorCutoff',p_prior_cutoff,'cutoff',p_cutoff,'stateHash',p_state_hash,
   'historicalMissions',used,'maxMissions',96,'tokenAllowance',600000,'nodeCount',13,'status','paused'));
 return jsonb_build_object('projectId',p.id,'authorizationId',p_authorization,'sourceMissionId',source.id,
  'releaseSha',p_release,'cutoff',p_cutoff,'status','paused','historicalMissions',used);
end $$;

-- A bridge authorizes recognition of this terminal source ONLY for recovery.
-- It never makes the old assignment eligible for a claim or provider call.
create function public.project_org_renewed_management_source(
 p_project uuid,p_owner uuid,p_source uuid,p_window uuid,p_expected_release text,p_release text,p_scope text,p_cutoff timestamptz
) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_paused_window_renewals r
 join project_execution_windows w on w.id=r.authorization_id and w.project_id=r.project_id
  and w.owner_id=r.owner_id and w.decision_id=r.decision_id and w.release_sha=r.prior_release_sha
  and w.prior_release_sha=r.prior_release_sha and w.prior_cutoff=r.prior_cutoff and w.cutoff=r.cutoff
 join project_execution_windows old on old.id=r.prior_window_id and old.project_id=r.project_id
  and old.owner_id=r.owner_id and old.decision_id=r.decision_id and old.cutoff=r.prior_cutoff
 join agent_missions m on m.id=r.source_mission_id and m.project_id=r.project_id
  and m.status='blocked' and m.project_kind='management'
  and m.project_evidence->>'providerContinuationWindow'=old.id::text
  and m.project_evidence->>'providerContinuationRelease'=r.prior_release_sha
  and m.project_evidence->>'providerContinuationDecision'=r.decision_id::text
  and encode(sha256(convert_to(project_canonical(to_jsonb(m)),'UTF8')),'hex')=r.source_hash
 where r.project_id=p_project and r.owner_id=p_owner and r.source_mission_id=p_source
  and r.authorization_id=p_window and r.prior_release_sha=p_expected_release and r.release_sha=p_release
  and r.scope_hash=p_scope and r.cutoff=p_cutoff
  and (old.release_sha=r.prior_release_sha or exists(select 1 from project_scoped_root_retry_receipts prior
   where prior.window_id=old.id and prior.project_id=r.project_id and prior.owner_id=r.owner_id
    and prior.decision_id=r.decision_id and prior.prior_release_sha=old.release_sha
    and prior.release_sha=r.prior_release_sha and prior.scope_hash=r.scope_hash and prior.cutoff=r.prior_cutoff)));
$$;

do $patch$
declare body text;anchor text:=$anchor$or source.project_evidence->>'providerContinuationRelease' is distinct from p_expected_release
 or source.project_evidence->>'providerContinuationWindow' is distinct from a.window_id::text$anchor$;
begin
 body:=pg_get_functiondef('public.project_org_resume_management(uuid,uuid,text,text,text,uuid)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
  raise exception 'Unexpected installed management recovery source contract';end if;
 execute replace(body,anchor,$replacement$or not (
  (source.project_evidence->>'providerContinuationRelease' is not distinct from p_expected_release
   and source.project_evidence->>'providerContinuationWindow' is not distinct from a.window_id::text
   and not exists(select 1 from project_paused_window_renewals r where r.authorization_id=a.window_id))
  or project_org_renewed_management_source(p.id,p_owner,source.id,a.window_id,p_expected_release,p_new_release,p_scope_hash,p.deadline)
 )$replacement$);
end $patch$;
revoke all on function public.project_org_renew_paused_window(uuid,uuid,text,text,text,uuid,uuid,timestamptz,timestamptz,uuid,text),
 public.project_org_renewed_management_source(uuid,uuid,uuid,uuid,text,text,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.project_org_renew_paused_window(uuid,uuid,text,text,text,uuid,uuid,timestamptz,timestamptz,uuid,text) to service_role;
commit;
