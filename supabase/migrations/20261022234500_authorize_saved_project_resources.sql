-- Owner-authorized changes to a saved project. Forecasts never confer spending authorization.
-- This function is backend-only and does NOT resume projects or reset any usage.
create or replace function public.authorize_work_project_resources(
 p_id uuid, p_actor uuid, p_chat uuid, p_expected_allowance integer,
 p_authorized_allowance integer, p_max_missions integer, p_deadline timestamptz,
 p_approval_ref uuid, p_approval_note text)
returns jsonb language plpgsql security invoker set search_path=public as $fn$
declare p work_projects; charged bigint; changed boolean:=false;
begin
 if p_approval_ref is null or length(trim(coalesce(p_approval_note,''))) not between 20 and 2000 then
   raise exception 'Explicit scoped authorization evidence required';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status in ('completed','stopped') then raise exception 'Project unavailable for renewal'; end if;
 if p.token_allowance is distinct from p_expected_allowance then raise exception 'Stale project allowance'; end if;
 if exists(select 1 from project_events where project_id=p.id and event='resource_authorization'
   and data->>'approvalRef'=p_approval_ref::text) then raise exception 'Approval already applied'; end if;
 if p.active_mission_id is not null and exists(
   select 1 from agent_missions where id=p.active_mission_id and status in ('draft','running','awaiting_approval')
 ) then raise exception 'Cannot renew resources while a project mission is active'; end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0)::bigint into charged
 from agent_missions where project_id=p.id;
 if p_authorized_allowance is not null then
   if p_authorized_allowance <= p.token_allowance or p_authorized_allowance < charged
      or p_authorized_allowance > 2147483647 then raise exception 'Invalid new authorization'; end if;
   changed:=true;
 end if;
 if p_max_missions is not null then
   if p_max_missions <= p.max_missions or p_max_missions > 1000 then raise exception 'Invalid mission safeguard renewal'; end if;
   changed:=true;
 end if;
 if p_deadline is not null then
   if p_deadline <= greatest(p.deadline,now()+interval '30 minutes')
      or p_deadline > now()+interval '365 days' then raise exception 'Invalid deadline renewal'; end if;
   changed:=true;
 end if;
 if not changed then raise exception 'No authorized resource change supplied'; end if;
 update work_projects set
   token_allowance=coalesce(p_authorized_allowance,token_allowance),
   budget_authorization_source=case when p_authorized_allowance is not null then 'user_approved' else budget_authorization_source end,
   max_missions=coalesce(p_max_missions,max_missions),
   deadline=coalesce(p_deadline,deadline),
   updated_at=clock_timestamp()
 where id=p.id;
 insert into project_events(project_id,event,data) values(
   p.id,'resource_authorization',jsonb_build_object(
     'approvalRef',p_approval_ref,'approvalNote',trim(p_approval_note),
     'oldAllowance',p.token_allowance,'newAllowance',coalesce(p_authorized_allowance,p.token_allowance),
     'oldMaxMissions',p.max_missions,'newMaxMissions',coalesce(p_max_missions,p.max_missions),
     'oldDeadline',p.deadline,'newDeadline',coalesce(p_deadline,p.deadline),
     'chargedOrReservedTokensAtApproval',charged,
     'preservedStatus',p.status,'preservedActiveMission',p.active_mission_id));
 return jsonb_build_object('projectId',p.id,'authorizedTokens',coalesce(p_authorized_allowance,p.token_allowance),
    'chargedOrReservedTokens',charged,'maxMissions',coalesce(p_max_missions,p.max_missions),
    'deadline',coalesce(p_deadline,p.deadline),'status',p.status,'approvalRef',p_approval_ref);
end $fn$;
revoke all on function public.authorize_work_project_resources(uuid,uuid,uuid,integer,integer,integer,timestamptz,uuid,text)
 from public,anon,authenticated;
grant execute on function public.authorize_work_project_resources(uuid,uuid,uuid,integer,integer,integer,timestamptz,uuid,text)
 to service_role;
