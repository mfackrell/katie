-- Server issues random bearer capability; only its digest is stored.
-- A grant is not created from a 'qualified' flag or a benchmark plan.
create table if not exists public.benchmark_execution_grants(
 id uuid primary key default gen_random_uuid(),
 token_digest text not null unique check(token_digest ~ '^[a-f0-9]{64}$'),
 trial_id uuid not null references public.benchmark_three_arm_trials(id),
 account_id uuid not null references public.benchmark_budget_accounts(id),
 owner_actor_id uuid not null,
 protocol_digest text not null check(protocol_digest ~ '^[a-f0-9]{64}$'),
 repository text not null,
 model text not null,
 execution_epoch bigint not null check(execution_epoch>0),
 deadline timestamptz not null,
 revoked_at timestamptz,
 created_at timestamptz not null default now(),
 unique(trial_id,execution_epoch)
);
alter table public.benchmark_execution_grants enable row level security;
revoke all on public.benchmark_execution_grants from public,anon,authenticated;

create or replace function public.benchmark_grant_reserve(
 p_digest text,p_trial uuid,p_epoch bigint,p_request_key text,p_model text,p_tokens bigint)
returns uuid language plpgsql security invoker set search_path=public as $$
declare g public.benchmark_execution_grants; a public.benchmark_budget_accounts;
 t public.benchmark_three_arm_trials; hold bigint; receipt uuid;
begin
 if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' or
 p_request_key is null or length(p_request_key)<8 or
 p_tokens is null or p_tokens<=0 then raise exception 'invalid gateway request';end if;
 select * into g from public.benchmark_execution_grants
 where token_digest=p_digest and trial_id=p_trial and execution_epoch=p_epoch for update;
 if not found or g.revoked_at is not null or g.deadline<=now() or g.model<>p_model
 then raise exception 'grant denied';end if;
 select * into t from public.benchmark_three_arm_trials where id=g.trial_id for update;
 if not found or t.state<>'running' or t.owner_actor_id<>g.owner_actor_id
 then raise exception 'trial denied';end if;
 select * into a from public.benchmark_budget_accounts where id=g.account_id for update;
 if not found or a.trial_id<>g.trial_id or a.owner_actor_id<>g.owner_actor_id or
 a.frozen_at is not null or exists(select 1 from public.benchmark_budget_calls
 where account_id=a.id and state='overrun')
 then raise exception 'account denied';end if;
 if exists(select 1 from public.benchmark_budget_calls where account_id=a.id
 and request_key=p_request_key) then raise exception 'duplicate provider attempt';end if;
 select coalesce(sum(reserved_tokens),0) into hold from public.benchmark_budget_calls
 where account_id=a.id and state in ('reserved','unresolved');
 if a.spent_tokens+hold+p_tokens>a.cap_tokens then raise exception 'gateway ceiling exhausted';end if;
 insert into public.benchmark_budget_calls(account_id,request_key,model,reserved_tokens)
 values(a.id,p_request_key,p_model,p_tokens) returning id into receipt;
 return receipt;
end $$;
revoke all on function public.benchmark_grant_reserve(text,uuid,bigint,text,text,bigint) from public,anon,authenticated;
grant execute on function public.benchmark_grant_reserve(text,uuid,bigint,text,text,bigint) to service_role;
