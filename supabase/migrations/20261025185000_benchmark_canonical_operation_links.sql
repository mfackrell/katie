-- Establish the canonical link during the existing #737 reservation insert.
-- Existing unlinked historical benchmark calls are not changed.
create or replace function public.benchmark_link_mission_projection()
returns trigger language plpgsql security invoker set search_path=public as $$
declare linked uuid; expected uuid;
begin
 if new.legacy_mission_call_id is not null then linked:=new.legacy_mission_call_id;
 elsif new.request_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  select id into linked from public.mission_calls where id=new.request_key::uuid;
 end if;
 if linked is null then return new;end if;
 select mb.account_id into expected from public.mission_calls mc
 join public.mission_assignments ma on ma.id=mc.job_id
 join public.benchmark_mission_bindings mb on mb.mission_id=ma.mission_id
 where mc.id=linked;
 if expected is distinct from new.account_id or new.request_key<>linked::text
 then raise exception 'canonical operation mission/account mismatch';end if;
 new.legacy_mission_call_id:=linked;
 return new;
end $$;
drop trigger if exists benchmark_link_mission_projection on public.benchmark_budget_calls;
create trigger benchmark_link_mission_projection before insert on public.benchmark_budget_calls
for each row execute function public.benchmark_link_mission_projection();
revoke all on function public.benchmark_link_mission_projection() from public,anon,authenticated;

-- Fully enforce account quarantine in the Full mission admission path;
-- #737 already rejects recorded overrun rows and uses the mission advisory lock.
create or replace function public.benchmark_account_is_frozen(p_account uuid)
returns boolean language sql security invoker set search_path=public as $$
 select coalesce((select frozen_at is not null from public.benchmark_budget_accounts
 where id=p_account),true)
 or exists(select 1 from public.benchmark_budget_calls
 where account_id=p_account and state='overrun');
$$;
revoke all on function public.benchmark_account_is_frozen(uuid) from public,anon,authenticated;
grant execute on function public.benchmark_account_is_frozen(uuid) to service_role;
