-- Task 4A: prevent ordinary owner authorization from ever being issued
-- for the continuation-bound original project.
-- The existing ordinary authorization record remains immutable and auditable.
-- No production rows are changed by this migration.
alter function public.developer_initial_snapshot(uuid,uuid)
 rename to developer_initial_snapshot_without_task4a_guard;
revoke all on function public.developer_initial_snapshot_without_task4a_guard(uuid,uuid)
 from public,anon,authenticated,service_role;
create function public.developer_initial_snapshot(p_owner uuid,p_task uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if exists (
  select 1 from public.mission_assignments j
  join public.agent_missions m on m.id=j.mission_id
  where j.id=p_task and m.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
 ) then raise exception 'TASK4A_REQUIRES_CONTINUATION_BOUND_NATIVE_AUTHORITY';end if;
 return public.developer_initial_snapshot_without_task4a_guard(p_owner,p_task);
end $$;
revoke all on function public.developer_initial_snapshot(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.developer_initial_snapshot(uuid,uuid) to service_role;

-- A previously generated ordinary proposal must not evade the new offer gate.
alter function public.developer_decide_initial(uuid,uuid,text,text)
 rename to developer_decide_initial_without_task4a_guard;
revoke all on function public.developer_decide_initial_without_task4a_guard(uuid,uuid,text,text)
 from public,anon,authenticated,service_role;
create function public.developer_decide_initial(
 p_owner uuid,p_task uuid,p_proposal text,p_decision text
) returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if exists (
  select 1 from public.benchmark_lifecycle_proposals o
  where o.id=p_proposal and o.task_id=p_task
   and o.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
 ) then raise exception 'TASK4A_REQUIRES_CONTINUATION_BOUND_NATIVE_AUTHORITY';end if;
 return public.developer_decide_initial_without_task4a_guard(
  p_owner,p_task,p_proposal,p_decision);
end $$;
revoke all on function public.developer_decide_initial(uuid,uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.developer_decide_initial(uuid,uuid,text,text)
 to service_role;

-- The original unbound approval must never be re-claimed or dispatched,
-- even if a future dispatcher regression attempts to use it.
alter function public.developer_claim_dispatch(uuid,text)
 rename to developer_claim_dispatch_without_task4a_guard;
revoke all on function public.developer_claim_dispatch_without_task4a_guard(uuid,text)
 from public,anon,authenticated,service_role;
create function public.developer_claim_dispatch(p_approval uuid,p_release text)
returns boolean language plpgsql security definer set search_path=public as $$
declare a public.benchmark_native_spending_approvals;
 auth record;
begin
 select * into a from public.benchmark_native_spending_approvals where id=p_approval;
 if a.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid then
  select * into auth from public.project_continuation_authorizations
   where id=(a.developer_authority->>'task4aContinuationId')::uuid
    and project_id=a.project_id;
  if auth.id is null or auth.revoked_at is not null or auth.deadline<=clock_timestamp()
   or a.developer_authority->>'task4aContinuationId' is distinct from auth.id::text
  then return false;end if;
 end if;
 return public.developer_claim_dispatch_without_task4a_guard(p_approval,p_release);
exception when invalid_text_representation then return false;
end $$;
revoke all on function public.developer_claim_dispatch(uuid,text)
 from public,anon,authenticated;
grant execute on function public.developer_claim_dispatch(uuid,text) to service_role;
