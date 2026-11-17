begin;

-- One owner-confirmed re-admission of the original failed Project Director.
-- This is NOT another execution window, mission authorization, or reset.
-- The normal scheduler alone will allocate a new lease-bound management mission.
create table public.project_blocked_management_retest_receipts (
 project_id uuid primary key references public.work_projects(id),
 source_mission_id uuid not null unique references public.agent_missions(id),
 window_id uuid not null references public.project_execution_windows(id),
 owner_id uuid not null,
 release_sha text not null check(release_sha ~ '^[0-9a-f]{40}$'),
 prior_release_sha text not null check(prior_release_sha ~ '^[0-9a-f]{40}$'),
 scope_hash text not null check(scope_hash ~ '^[0-9a-f]{64}$'),
 cutoff timestamptz not null,
 historical_missions integer not null check(historical_missions=78),
 authorized_at timestamptz not null default clock_timestamp()
);
alter table public.project_blocked_management_retest_receipts enable row level security;
revoke all on public.project_blocked_management_retest_receipts from public,anon,authenticated,service_role;
grant select on public.project_blocked_management_retest_receipts to service_role;
create trigger project_blocked_management_retest_immutable
 before update or delete on public.project_blocked_management_retest_receipts
 for each row execute function public.project_org_change_immutable();

-- Read-only exact-state offer. Completed receipts are visible but never reusable.
create function public.project_org_blocked_management_retest_offer(
 p_owner uuid,p_project uuid,p_release text
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $fn$
declare
 p work_projects;a project_provider_execution;src agent_missions;
 root project_organization_nodes;game project_organization_nodes;
 rat project_scope_ratification_approvals;w project_blocked_owner_windows;
 s project_blocked_owner_resumes;receipt project_blocked_management_retest_receipts;
 used integer;failed integer;
begin
 select * into p from work_projects where id=p_project;
 select * into a from project_provider_execution where project_id=p_project;
 if p_project is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  or p.id is null or p_owner is null or a.owner_id is distinct from p_owner
  or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  or p_release is null or p_release !~ '^[0-9a-f]{40}$'
 then raise exception 'Exact original project, owner and production release required';end if;
 select * into receipt from project_blocked_management_retest_receipts where project_id=p_project;
 if receipt.project_id is not null then
  if receipt.owner_id is distinct from p_owner or receipt.scope_hash is distinct from
   '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  then raise exception 'Previously recorded retest authority changed';end if;
  return jsonb_build_object('projectId',p.id,'stage','admitted','status',p.status,
   'sourceMissionId',receipt.source_mission_id,'windowId',receipt.window_id,
   'scopeHash',receipt.scope_hash,'releaseSha',p_release,
   'admittedReleaseSha',receipt.release_sha,'cutoff',receipt.cutoff,
   'historicalMissions',receipt.historical_missions,'maxMissions',96,
   'tokenAllowance',600000,'nodeCount',13,'authorizedAt',receipt.authorized_at,
   'stateHash',project_org_hierarchy_recovery_state(p.id));
 end if;
 select * into src from agent_missions where id=p.active_mission_id and project_id=p.id;
 select * into root from project_organization_nodes where project_id=p.id
  and kind='project_director' and parent_id is null and status='active';
 select * into game from project_organization_nodes where parent_id=root.id
  and project_id=p.id and area='game_delivery'
  and management_level='functional_director' and status='active';
 select * into w from project_blocked_owner_windows where project_id=p.id;
 select * into s from project_blocked_owner_resumes where project_id=p.id;
 select * into rat from project_scope_ratification_approvals where project_id=p.id
  and scope_hash=p.approved_hash;
 select count(*) into used from agent_missions where project_id=p.id;
 select count(*) into failed from agent_missions m where m.project_id=p.id
  and m.project_kind='management' and m.project_evidence->>'organizationNodeId'=root.id::text
  and m.status in ('blocked','stopped') and m.created_at>=rat.approved_at;
 if p.organization_version<>1 or not project_provider_mode(p.id)
  or p.status<>'blocked' or p.phase<>'development'
  or p.detail is distinct from 'Project management cannot achieve its objective within bounded retry authority'
  or p.lease is not null or p.lease_until is not null
  or p.deadline<=clock_timestamp()+interval '5 minutes'
  or p.approved_hash is distinct from '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  or p.approval_hash is distinct from p.approved_hash
  or p.max_missions<>96 or p.token_allowance<>600000 or used<>78
  or (select count(*) from project_organization_nodes n where n.project_id=p.id)<>13
  or (select count(*) from project_organization_nodes n where n.project_id=p.id and n.status='active' and n.deadline=p.deadline)<>13
  or a.deadline is distinct from p.deadline or a.approved_scope is distinct from p.approved_hash
  or a.window_id is distinct from w.authorization_id
  or a.continuation_release_sha is null or a.continuation_release_sha !~ '^[0-9a-f]{40}$'
  or a.continued_at is null or not project_provider_continued(p.id)
  or w.owner_id is distinct from p_owner or w.cutoff is distinct from p.deadline
  or w.resume_release_sha is distinct from a.continuation_release_sha
  or s.owner_id is distinct from p_owner or s.authorization_id is distinct from w.authorization_id
  or s.release_sha is distinct from a.continuation_release_sha
  or not project_org_blocked_owner_release(w.authorization_id,a.continuation_release_sha)
  or p_release=a.continuation_release_sha
  or root.id is null or not root.decision_needed or root.deadline is distinct from p.deadline
  or game.id is null or game.deadline is distinct from p.deadline
  or not ('development'=any(root.tools)) or not ('development'=any(game.tools))
  or not exists(select 1 from project_organization_scope_grants g
    where g.node_id=root.id and g.scope_hash=p.approved_hash and g.parent_id is null)
  or not exists(select 1 from project_organization_scope_grants g
    where g.node_id=game.id and g.scope_hash=p.approved_hash and g.parent_id=root.id)
  or exists(with recursive qa as
    (select id from project_organization_nodes where project_id=p.id and area in ('quality_assurance','independent_qa')
     union all select n.id from project_organization_nodes n join qa on n.parent_id=qa.id)
     select 1 from qa join project_organization_nodes n on n.id=qa.id where 'development'=any(n.tools))
  or rat.proposal_id is null or rat.owner_id is distinct from p_owner
  or failed<>2
  or src.id is distinct from '911d15bd-be5f-416e-bbac-fbe86ca6fa90'::uuid
  or src.status<>'blocked' or src.project_kind<>'management' or src.calls<>1
  or src.project_evidence->>'organizationNodeId' is distinct from root.id::text
  or src.project_evidence->>'providerContinuationWindow' is distinct from w.authorization_id::text
  or src.project_evidence->>'providerContinuationRelease' is distinct from a.continuation_release_sha
  or src.project_evidence->>'previousMissionId' is not null
  or not exists(select 1 from mission_assignments j where j.mission_id=src.id and j.status='failed'
    and j.result->>'detail' like '%No delegation change requested%')
  or exists(select 1 from project_work_packages pkg where pkg.project_id=p.id)
  or exists(select 1 from agent_missions m where m.project_id=p.id and m.status in ('draft','running','awaiting_approval'))
  or exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
    where m.project_id=p.id and j.status in ('queued','running','waiting_external'))
  or exists(select 1 from project_organization_work ow where ow.project_id=p.id and ow.status in ('queued','running'))
  or project_provider_request_pending(p.id)
 then raise exception 'Original failed management mission or owner execution authority changed';end if;
 return jsonb_build_object('projectId',p.id,'stage','retest','status',p.status,
  'sourceMissionId',src.id,'windowId',w.authorization_id,
  'scopeHash',p.approved_hash,'releaseSha',p_release,
  'cutoff',p.deadline,'historicalMissions',used,'maxMissions',p.max_missions,
  'tokenAllowance',p.token_allowance,'nodeCount',13,
  'stateHash',project_org_hierarchy_recovery_state(p.id));
end
$fn$;

-- One owner action; neither creates a mission nor invokes a provider.
-- The failed mission and its assignments stay immutable in the ledger.
create function public.project_org_resume_blocked_management_once(
 p_owner uuid,p_project uuid,p_release text,p_source_mission uuid,
 p_window uuid,p_cutoff timestamptz,p_state_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
declare
 p work_projects;offer jsonb;stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 perform 1 from project_provider_execution where project_id=p_project for update;
 offer:=project_org_blocked_management_retest_offer(p_owner,p_project,p_release);
 if offer->>'stage' is distinct from 'retest'
  or p_source_mission is distinct from (offer->>'sourceMissionId')::uuid
  or p_window is distinct from (offer->>'windowId')::uuid
  or p_cutoff is distinct from (offer->>'cutoff')::timestamptz
  or p_cutoff<=clock_timestamp()+interval '5 minutes'
  or p_state_hash is null or p_state_hash is distinct from offer->>'stateHash'
 then raise exception 'Unexpired exact owner management retest state required';end if;
 stamp:=clock_timestamp();
 insert into project_blocked_management_retest_receipts
  (project_id,source_mission_id,window_id,owner_id,release_sha,prior_release_sha,scope_hash,cutoff,historical_missions,authorized_at)
 values(p.id,p_source_mission,p_window,p_owner,p_release,
  (select continuation_release_sha from project_provider_execution where project_id=p.id),
  p.approved_hash,p_cutoff,78,stamp);
 update work_projects set status='running',active_mission_id=null,
  detail='Owner admitted one corrected management retest within the existing cutoff; prior failed mission retained.',
  updated_at=stamp where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'blocked_management_retest_authorized',
  jsonb_build_object('ownerId',p_owner,'sourceMissionId',p_source_mission,
   'windowId',p_window,'releaseSha',p_release,'scopeHash',p.approved_hash,
   'cutoff',p_cutoff,'historicalMissions',78,'maxMissions',p.max_missions,
   'tokenAllowance',p.token_allowance,'authorizedAt',stamp));
 return jsonb_build_object('projectId',p.id,'stage','admitted','status','running',
  'sourceMissionId',p_source_mission,'windowId',p_window,
  'scopeHash',p.approved_hash,'releaseSha',p_release,
  'cutoff',p_cutoff,'historicalMissions',78,'maxMissions',p.max_missions,
  'tokenAllowance',p.token_allowance,'authorizedAt',stamp,'existing',false);
end
$fn$;

revoke all on function
 public.project_org_blocked_management_retest_offer(uuid,uuid,text),
 public.project_org_resume_blocked_management_once(uuid,uuid,text,uuid,uuid,timestamptz,text)
 from public,anon,authenticated,service_role;
grant execute on function
 public.project_org_blocked_management_retest_offer(uuid,uuid,text),
 public.project_org_resume_blocked_management_once(uuid,uuid,text,uuid,uuid,timestamptz,text)
 to service_role;
commit;

  or a.continued_at is null or not project_provider_continued(p.id)
  or w.owner_id is distinct from p_owner or w.cutoff is distinct from p.deadline
  or w.resume_release_sha is distinct from a.continuation_release_sha
  or s.owner_id is distinct from p_owner or s.authorization_id is distinct from w.authorization_id
  or s.release_sha is distinct from a.continuation_release_sha
  or not project_org_blocked_owner_release(w.authorization_id,a.continuation_release_sha)
  or p_release=a.continuation_release_sha
  or root.id is null or not root.decision_needed or root.deadline is distinct from p.deadline
  or game.id is null or game.deadline is distinct from p.deadline
  or not ('development'=any(root.tools)) or not ('development'=any(game.tools))
  or not exists(select 1 from project_organization_scope_grants g
    where g.node_id=root.id and g.scope_hash=p.approved_hash and g.parent_id is null)
  or not exists(select 1 from project_organization_scope_grants g
    where g.node_id=game.id and g.scope_hash=p.approved_hash and g.parent_id=root.id)
  or exists(with recursive qa as
    (select id from project_organization_nodes where project_id=p.id and area in ('quality_assurance','independent_qa')
     union all select n.id from project_organization_nodes n join qa on n.parent_id=qa.id)
     select 1 from qa join project_organization_nodes n on n.id=qa.id where 'development'=any(n.tools))
  or rat.proposal_id is null or rat.owner_id is distinct from p_owner
  or failed<>2
  or src.id is distinct from '911d15bd-be5f-416e-bbac-fbe86ca6fa90'::uuid
  or src.status<>'blocked' or src.project_kind<>'management' or src.calls<>1
  or src.project_evidence->>'organizationNodeId' is distinct from root.id::text
  or src.project_evidence->>'providerContinuationWindow' is distinct from w.authorization_id::text
  or src.project_evidence->>'providerContinuationRelease' is distinct from a.continuation_release_sha
  or src.project_evidence->>'previousMissionId' is not null
  or not exists(select 1 from mission_assignments j where j.mission_id=src.id and j.status='failed'
    and j.result->>'detail' like '%No delegation change requested%')
  or exists(select 1 from project_work_packages pkg where pkg.project_id=p.id)
  or exists(select 1 from agent_missions m where m.project_id=p.id and m.status in ('draft','running','awaiting_approval'))
  or exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
    where m.project_id=p.id and j.status in ('queued','running','waiting_external'))
  or exists(select 1 from project_organization_work ow where ow.project_id=p.id and ow.status in ('queued','running'))
  or project_provider_request_pending(p.id)
 then raise exception 'Original failed management mission or owner execution authority changed';end if;
 return jsonb_build_object('projectId',p.id,'stage','retest','status',p.status,
  'sourceMissionId',src.id,'windowId',w.authorization_id,
  'scopeHash',p.approved_hash,'releaseSha',p_release,
  'cutoff',p.deadline,'historicalMissions',used,'maxMissions',p.max_missions,
  'tokenAllowance',p.token_allowance,'nodeCount',13,
  'stateHash',project_org_hierarchy_recovery_state(p.id));
end
$fn$;

-- One owner action; neither creates a mission nor invokes a provider.
-- The failed mission and its assignments stay immutable in the ledger.
create function public.project_org_resume_blocked_management_once(
 p_owner uuid,p_project uuid,p_release text,p_source_mission uuid,
 p_window uuid,p_cutoff timestamptz,p_state_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
declare
 p work_projects;offer jsonb;stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 perform 1 from project_provider_execution where project_id=p_project for update;
 offer:=project_org_blocked_management_retest_offer(p_owner,p_project,p_release);
 if offer->>'stage' is distinct from 'retest'
  or p_source_mission is distinct from (offer->>'sourceMissionId')::uuid
  or p_window is distinct from (offer->>'windowId')::uuid
  or p_cutoff is distinct from (offer->>'cutoff')::timestamptz
  or p_cutoff<=clock_timestamp()+interval '5 minutes'
  or p_state_hash is null or p_state_hash is distinct from offer->>'stateHash'
 then raise exception 'Unexpired exact owner management retest state required';end if;
 stamp:=clock_timestamp();
 insert into project_blocked_management_retest_receipts
  (project_id,source_mission_id,window_id,owner_id,release_sha,prior_release_sha,scope_hash,cutoff,historical_missions,authorized_at)
 values(p.id,p_source_mission,p_window,p_owner,p_release,
  (select continuation_release_sha from project_provider_execution where project_id=p.id),
  p.approved_hash,p_cutoff,78,stamp);
 update work_projects set status='running',active_mission_id=null,
  detail='Owner admitted one corrected management retest within the existing cutoff; prior failed mission retained.',
  updated_at=stamp where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'blocked_management_retest_authorized',
  jsonb_build_object('ownerId',p_owner,'sourceMissionId',p_source_mission,
   'windowId',p_window,'releaseSha',p_release,'scopeHash',p.approved_hash,
   'cutoff',p_cutoff,'historicalMissions',78,'maxMissions',p.max_missions,
   'tokenAllowance',p.token_allowance,'authorizedAt',stamp));
 return jsonb_build_object('projectId',p.id,'stage','admitted','status','running',
  'sourceMissionId',p_source_mission,'windowId',p_window,
  'scopeHash',p.approved_hash,'releaseSha',p_release,
  'cutoff',p_cutoff,'historicalMissions',78,'maxMissions',p.max_missions,
  'tokenAllowance',p.token_allowance,'authorizedAt',stamp,'existing',false);
end
$fn$;

revoke all on function
 public.project_org_blocked_management_retest_offer(uuid,uuid,text),
 public.project_org_resume_blocked_management_once(uuid,uuid,text,uuid,uuid,timestamptz,text)
 from public,anon,authenticated,service_role;
grant execute on function
 public.project_org_blocked_management_retest_offer(uuid,uuid,text),
 public.project_org_resume_blocked_management_once(uuid,uuid,text,uuid,uuid,timestamptz,text)
 to service_role;
commit;
