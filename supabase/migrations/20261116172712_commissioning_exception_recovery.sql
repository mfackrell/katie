-- #1061: retain failed SMART diagnostics in the runtime, and recover only the
-- evidenced ready/open-exception dead end through normal management admission.
-- Installation changes no project data, contracts, history or execution window.
begin;
alter function public.project_org_decide(uuid,uuid,jsonb) rename to project_org_decide_before_exception_recovery;
create function public.project_org_decide(p_job uuid,p_lease uuid,p_commands jsonb) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare n project_organization_nodes;
begin
 n:=project_org_principal(p_job,p_lease);
 if jsonb_typeof(p_commands)='array' then
  if jsonb_array_length(p_commands)>0
   and not exists(select 1 from jsonb_array_elements(p_commands) c where (c->>'action') is distinct from 'ready')
   and exists(select 1 from project_organization_exceptions where project_id=n.project_id and owner_id=n.id and status='open')
  then raise exception 'Ready-only response cannot abandon an owned open exception';end if;
 end if;
 return project_org_decide_before_exception_recovery(p_job,p_lease,p_commands);
end $$;

alter function public.project_org_schedule(uuid,uuid) rename to project_org_schedule_before_exception_recovery;
create function public.project_org_schedule(p_project uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r jsonb; recovered uuid;
begin
 -- Preserve the original scheduler's lease, phase, dependency, mission-cap and
 -- one-shot behavior before considering the stranded state.
 r:=project_org_schedule_before_exception_recovery(p_project,p_lease);
 if r->>'detail' is distinct from 'Functional Director must commission the next approved coding package.' then return r;end if;
 -- A wait can come from the ordinary fallback even when provider continuation
 -- membership is invalid. Require the existing authority predicate before our
 -- new mutation; projects without provider-controlled authority remain ordinary.
 if exists(select 1 from project_provider_execution where project_id=p_project)
  and not project_provider_continued(p_project) then return r;end if;
 select n.id into recovered from project_organization_nodes n
 join work_projects p on p.id=n.project_id
 join lateral (
  select j.id,j.status,m.status mission_status from project_organization_assignments a
  join mission_assignments j on j.id=a.assignment_id
  join agent_missions m on m.id=j.mission_id and m.project_id=n.project_id
  where a.node_id=n.id
  order by m.created_at desc,j.created_at desc,a.created_at desc,j.id desc limit 1
 ) latest on latest.status='completed' and latest.mission_status='completed'
 join project_organization_decisions d on d.assignment_id=latest.id and d.node_id=n.id and d.project_id=p.id
 where p.id=p_project and p.status='running' and p.phase='development' and p.active_mission_id is null
 and p.lease=p_lease and p_lease is not null and p.lease_until>now() and p.deadline>now()
 and n.kind<>'worker' and n.status='active' and not n.decision_needed and n.deadline>now()
 and jsonb_typeof(d.decision)='array' and jsonb_array_length(d.decision)>0
 and not exists(select 1 from jsonb_array_elements(d.decision) c where (c->>'action') is distinct from 'ready')
 and exists(select 1 from project_organization_exceptions e where e.project_id=p.id and e.owner_id=n.id and e.status='open' and e.created_at<=d.created_at)
 order by n.depth desc,n.created_at,n.id limit 1;
 if recovered is null then return r;end if;
 update project_organization_nodes set decision_needed=true where id=recovered;
 -- The newly scheduled assignment supersedes the old ready decision. Failure
 -- retries/escalation remain bounded by the existing historical failure counts.
 return project_org_schedule_before_exception_recovery(p_project,p_lease);
end $$;
revoke all on function public.project_org_decide_before_exception_recovery(uuid,uuid,jsonb),
 public.project_org_schedule_before_exception_recovery(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_decide(uuid,uuid,jsonb),public.project_org_schedule(uuid,uuid) from public,anon,authenticated;
grant execute on function public.project_org_decide(uuid,uuid,jsonb),public.project_org_schedule(uuid,uuid) to service_role;
commit;
