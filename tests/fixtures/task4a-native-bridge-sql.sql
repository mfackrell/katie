-- Disposable Task4A native bridge fixture only; never deploy to production.
-- The real ordinary Developer grants and accounting are exercised by existing
-- native/ordinary qualification. Here the real Task4A SQL runs against synthetic
-- linked native operations with no provider, owner, or production credential.
-- The full production account schema generates primary keys; the shared
-- lightweight project fixture pre-creates its ID column without a default.
alter table public.benchmark_budget_accounts alter column id set default gen_random_uuid();
alter table public.benchmark_budget_accounts
 add column if not exists owner_actor_id uuid,
 add column if not exists developer_project_id uuid,
 add column if not exists developer_task_id uuid,
 add column if not exists trial_id uuid,
 add column if not exists frozen_at timestamptz,
 add column if not exists spent_tokens bigint not null default 0;
create table if not exists public.benchmark_mission_bindings(
 mission_id uuid primary key,account_id uuid,experiment_id uuid,
 baseline_sha text not null,developer_project_id uuid);
create table if not exists public.benchmark_native_spending_approvals(
 id uuid primary key default gen_random_uuid(),owner_id uuid,actor_id uuid,chat_id uuid,
 trial_id uuid,account_id uuid,repository text,model text,protocol_digest text,
 max_tokens bigint,deadline timestamptz,revoked_at timestamptz,consumed_at timestamptz,
 project_id uuid,mission_assignment_id uuid,task_id uuid,
 developer_authority jsonb,continuation_id uuid);
alter table public.benchmark_native_spending_approvals
 add column if not exists previous_developer_approval_id uuid references public.benchmark_native_spending_approvals(id);
create table if not exists public.benchmark_execution_grants(
 id uuid primary key default gen_random_uuid(),token_digest text,project_id uuid,
 execution_epoch bigint,developer_approval_id uuid,mission_assignment_id uuid,
 revoked_at timestamptz,stopped_at timestamptz,deadline timestamptz);
create table if not exists public.benchmark_budget_calls(
 id uuid primary key default gen_random_uuid(),account_id uuid,request_key text,
 model text,reserved_tokens bigint,actual_tokens bigint,state text default 'reserved',
 legacy_mission_call_id uuid,provider_request_id text,provider_usage jsonb);
create table if not exists public.standalone_owner_bindings(
 owner_id uuid,actor_id uuid,chat_id uuid,revoked_at timestamptz,
 unique(owner_id,actor_id,chat_id));
grant all on public.benchmark_budget_accounts,public.benchmark_mission_bindings,
 public.benchmark_native_spending_approvals,public.benchmark_execution_grants,
 public.benchmark_budget_calls,public.standalone_owner_bindings to service_role;

create or replace function public.developer_validate_limits(limits jsonb)
returns boolean language sql stable as $$
 select jsonb_typeof(limits)='object'
 and (limits->>'developmentTokens')::bigint>0
 and (limits->>'completionTokens')::bigint>0;
$$;
create or replace function public.standalone_verify_scope(p_owner uuid,p_actor uuid,p_chat uuid)
returns boolean language sql stable as $$
 select exists(select 1 from standalone_owner_bindings where owner_id=p_owner
  and actor_id=p_actor and chat_id=p_chat and revoked_at is null);
$$;
create or replace function public.developer_gateway_execution_live(
 p_digest text,p_project uuid,p_epoch bigint
) returns boolean language sql stable as $$
 select exists(select 1 from benchmark_execution_grants g
  join benchmark_native_spending_approvals a on a.id=g.developer_approval_id
  join work_projects p on p.id=g.project_id
  where g.token_digest=p_digest and g.project_id=p_project
   and g.execution_epoch=p_epoch and g.revoked_at is null
   and g.stopped_at is null and g.deadline>now()
   and a.consumed_at is not null and a.revoked_at is null
   and a.deadline>now() and p.status='running'
   and p.phase='development' and p.approved_hash=p.approval_hash);
$$;
create or replace function public.developer_native_reserve(
 p_digest text,p_project uuid,p_epoch bigint,p_request_key text,p_model text,p_tokens bigint
) returns uuid language plpgsql security invoker set search_path=public as $$
declare g benchmark_execution_grants;a benchmark_native_spending_approvals;op uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if not developer_gateway_execution_live(p_digest,p_project,p_epoch)
 or p_request_key !~ '^[a-f0-9-]{36}$'
 or p_tokens not between 1 and 120000
 then raise exception 'Synthetic native admission denied';end if;
 select * into g from benchmark_execution_grants
  where token_digest=p_digest and project_id=p_project and execution_epoch=p_epoch;
 select * into a from benchmark_native_spending_approvals where id=g.developer_approval_id;
 if a.task_id is distinct from g.mission_assignment_id
 then raise exception 'Synthetic task mismatch';end if;
 insert into mission_calls(id,job_id,lease,model,reserved_tokens)
 values(p_request_key::uuid,g.mission_assignment_id,g.id,p_model,p_tokens::integer);
 insert into benchmark_budget_calls(account_id,request_key,model,reserved_tokens,legacy_mission_call_id)
 values(a.account_id,p_request_key,p_model,p_tokens,p_request_key::uuid) returning id into op;
 update agent_missions set calls=calls+1,reserved_tokens=reserved_tokens+p_tokens
 where id=(select mission_id from mission_assignments where id=g.mission_assignment_id);
 return op;
end $$;
create or replace function public.benchmark_reconcile_provider_usage(
 p_call uuid,p_provider_request text,p_usage jsonb,p_linked boolean default false
) returns text language plpgsql security invoker set search_path=public as $$
declare c mission_calls;b benchmark_budget_calls;total integer;
begin
 if p_linked is distinct from true or p_provider_request is null
 or p_usage->>'total_tokens' is null or
 (p_usage->>'input_tokens')::integer+(p_usage->>'output_tokens')::integer
   is distinct from (p_usage->>'total_tokens')::integer
 then raise exception 'Synthetic linked usage unavailable';end if;
 total:=(p_usage->>'total_tokens')::integer;
 select * into c from mission_calls where id=p_call for update;
 select * into b from benchmark_budget_calls where legacy_mission_call_id=p_call for update;
 if c.id is null or b.id is null or
  (b.provider_request_id is not null and b.provider_request_id<>p_provider_request)
  or (b.provider_usage is not null and b.provider_usage<>p_usage)
  or (c.status='completed' and c.actual_tokens is distinct from total)
 then raise exception 'Synthetic replay conflict';end if;
 if c.status='reserved' then
  update mission_calls set actual_tokens=total,status='completed' where id=c.id;
  update benchmark_budget_calls set actual_tokens=total,
   state=case when total>b.reserved_tokens then 'overrun' else 'settled' end
   where id=b.id;
  update agent_missions set actual_tokens=actual_tokens+total,
   reserved_tokens=reserved_tokens-c.reserved_tokens+total
   where id=(select mission_id from mission_assignments where id=c.job_id);
 end if;
 update benchmark_budget_calls set provider_request_id=p_provider_request,
  provider_usage=p_usage where id=b.id;
 return case when total>b.reserved_tokens then 'overrun' else 'settled' end;
end $$;
revoke all on function public.developer_native_reserve(text,uuid,bigint,text,text,bigint),
 public.benchmark_reconcile_provider_usage(uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.developer_native_reserve(text,uuid,bigint,text,text,bigint),
 public.benchmark_reconcile_provider_usage(uuid,text,jsonb,boolean),
 public.developer_gateway_execution_live(text,uuid,bigint),
 public.developer_validate_limits(jsonb),
 public.standalone_verify_scope(uuid,uuid,uuid) to service_role;
