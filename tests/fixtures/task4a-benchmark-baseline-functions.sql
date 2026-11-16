-- Disposable project SQL runner installs the ordinary-project behavior of
-- benchmark_effective_* helpers. Full benchmark/ordinary Developer special
-- binding semantics are independently exercised in their own CI migrations.
-- This file is NOT a production migration.
create or replace function public.benchmark_effective_project_cap(p_project uuid)
returns bigint language sql stable security invoker set search_path=public as $$
 select token_allowance::bigint from work_projects where id=p_project;
$$;
create or replace function public.benchmark_effective_mission_continuation(p_mission uuid)
returns uuid language sql stable security invoker set search_path=public as $$
 select null::uuid;
$$;
create or replace function public.benchmark_effective_mission_deadline(p_mission uuid)
returns timestamptz language sql stable security invoker set search_path=public as $$
 select deadline from agent_missions where id=p_mission;
$$;
create or replace function public.benchmark_effective_mission_call_limit(p_mission uuid,p_continuation uuid)
returns integer language sql stable security invoker set search_path=public as $$
 select max_calls from agent_missions where id=p_mission;
$$;
create or replace function public.benchmark_effective_mission_allowance(p_mission uuid,p_continuation uuid)
returns bigint language sql stable security invoker set search_path=public as $$
 select token_allowance::bigint from agent_missions where id=p_mission;
$$;
