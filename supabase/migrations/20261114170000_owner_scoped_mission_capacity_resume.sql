begin;

-- Pair the existing auditable resource_authorization approval with an explicit,
-- one-shot recovery of the ORIGINAL scoped development project. Never add
-- mission allowance, restart a project, or dispatch a worker implicitly.
create or replace function public.project_org_resume_after_capacity_authorization(
 p_owner uuid, p_project uuid, p_release text, p_scope_hash text,
 p_approval_ref uuid, p_expected_old_max integer, p_approved_max integer
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $fn$
declare
 p work_projects; a project_provider_execution; ev project_events;
 root project_organization_nodes; consumed integer; stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 if p.id is null or p_owner is null or a.owner_id is distinct from p_owner
    or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 then raise exception 'Authenticated original project owner required';end if;
 if p_release is null or p_release !~ '^[a-f0-9]{40}$'
    or p_scope_hash is null or p_scope_hash !~ '^[a-f0-9]{64}$'
    or p_approval_ref is null or p_expected_old_max is null or p_approved_max is null
 then raise exception 'Exact release, scope and owner authorization required';end if;
 select * into ev from project_events
  where project_id=p.id and event='resource_authorization'
    and data->>'approvalRef'=p_approval_ref::text
  order by created_at desc,id desc limit 1;
 if ev.id is null or ev.created_at<clock_timestamp()-interval '30 minutes'
    or (ev.data->>'oldMaxMissions')::integer is distinct from p_expected_old_max
    or (ev.data->>'newMaxMissions')::integer is distinct from p_approved_max
    or ev.data->>'oldAllowance' is distinct from ev.data->>'newAllowance'
    or ev.data->>'oldDeadline' is distinct from ev.data->>'newDeadline'
    or position(p_release in coalesce(ev.data->>'approvalNote',''))=0
    or position(p_scope_hash in coalesce(ev.data->>'approvalNote',''))=0
    or ev.data->>'preservedStatus' is distinct from 'blocked'
    or ev.data->>'preservedActiveMission' is not null
 then raise exception 'Fresh owner-approved mission-only resource receipt required';end if;
 select count(*)::integer into consumed from agent_missions where project_id=p.id;
 select * into root from project_organization_nodes
  where project_id=p.id and kind='project_director'
    and parent_id is null and status='active' for update;
 if p.organization_version<>1 or not project_provider_mode(p.id)
    or p.status<>'blocked' or p.phase<>'development'
    or p.detail is distinct from 'Approved project mission limit reached'
    or p.active_mission_id is not null or p.lease is not null
    or p.lease_until is not null or p.deadline<=clock_timestamp()+interval '5 minutes'
    or p.approval_hash is distinct from p_scope_hash
    or p.approved_hash is distinct from p_scope_hash
    or a.approved_scope is distinct from p_scope_hash
    or a.deadline is distinct from p.deadline or a.continued_at is null
    or root.id is null or root.deadline<p.deadline or not root.decision_needed
    or p.max_missions is distinct from p_approved_max
    or p_approved_max-p_expected_old_max not between 1 and 32
    or consumed<p_expected_old_max or consumed>=p_approved_max
    or exists(select 1 from project_work_packages where project_id=p.id)
    or (select count(*) from project_organization_scope_grants g
         join project_organization_nodes n on n.id=g.node_id
         where n.project_id=p.id)<>1
    or not exists(select 1 from project_organization_scope_grants g
         where g.node_id=root.id and g.parent_id is null and g.scope_hash=p_scope_hash)
    or exists(select 1 from agent_missions
         where project_id=p.id and status in ('draft','running','awaiting_approval'))
    or project_provider_request_pending(p.id)
    or exists(select 1 from project_events
         where project_id=p.id and event='project_capacity_resumed'
           and data->>'approvalRef'=p_approval_ref::text)
 then raise exception 'Blocked capacity state, immutable scope or execution authority changed';end if;
 stamp:=clock_timestamp();
 update work_projects set status='running',lease=null,lease_until=null,
  detail='Owner-authorized scoped mission capacity recovery; awaiting normal scheduler',
  updated_at=stamp where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'project_capacity_resumed',
  jsonb_build_object('approvalRef',p_approval_ref,'ownerId',p_owner,'releaseSha',p_release,
    'scopeHash',p_scope_hash,'oldMaxMissions',p_expected_old_max,
    'approvedMaxMissions',p_approved_max,'historicalMissions',consumed,
    'deadline',p.deadline,'rootNodeId',root.id,'resumedAt',stamp));
 return jsonb_build_object('projectId',p.id,'approvalRef',p_approval_ref,
    'oldMaxMissions',p_expected_old_max,'approvedMaxMissions',p_approved_max,
    'historicalMissions',consumed,'status','running','releaseSha',p_release,
    'scopeHash',p_scope_hash,'resumedAt',stamp);
end $fn$;

revoke all on function public.project_org_resume_after_capacity_authorization(uuid,uuid,text,text,uuid,integer,integer)
 from public,anon,authenticated,service_role;
grant execute on function public.project_org_resume_after_capacity_authorization(uuid,uuid,text,text,uuid,integer,integer)
 to service_role;

commit;
