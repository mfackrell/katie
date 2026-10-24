-- Isolated benchmark accounting; separate from existing Take Eleven project budgets.
create table if not exists public.benchmark_budget_accounts (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null,
  arm text not null check (arm in ('direct','orchestrated')),
  owner_actor_id uuid not null,
  cap_tokens bigint not null check (cap_tokens > 0),
  spent_tokens bigint not null default 0 check (spent_tokens >= 0),
  created_at timestamptz not null default now(),
  unique(experiment_id,arm)
);
create table if not exists public.benchmark_budget_calls (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.benchmark_budget_accounts(id),
  request_key text not null,
  model text not null,
  reserved_tokens bigint not null check(reserved_tokens > 0),
  actual_tokens bigint check(actual_tokens >= 0),
  state text not null default 'reserved' check(state in ('reserved','settled','unresolved')),
  created_at timestamptz not null default now(),
  unique(account_id,request_key)
);
create table if not exists public.benchmark_budget_approvals (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.benchmark_budget_accounts(id),
  owner_actor_id uuid not null,
  previous_ceiling bigint not null,
  new_ceiling bigint not null check(new_ceiling>previous_ceiling),
  approved_at timestamptz not null default now(),
  redeemed_at timestamptz
);
alter table public.benchmark_budget_accounts enable row level security;
alter table public.benchmark_budget_calls enable row level security;
alter table public.benchmark_budget_approvals enable row level security;
revoke all on public.benchmark_budget_accounts,public.benchmark_budget_calls,public.benchmark_budget_approvals from public,anon,authenticated;
-- All admission and redemption is backend-only. No public client mutation.
create or replace function public.benchmark_reserve_call(p_account uuid,p_key text,p_model text,p_tokens bigint)
returns uuid language plpgsql security invoker set search_path=public as $$
declare a benchmark_budget_accounts; hold bigint; receipt uuid;
begin
  if p_tokens is null or p_tokens<=0 or nullif(p_key,'') is null then raise exception 'invalid admission'; end if;
  select * into a from benchmark_budget_accounts where id=p_account for update;
  if not found then raise exception 'unknown account'; end if;
  if exists(select 1 from benchmark_budget_calls where account_id=p_account and request_key=p_key) then raise exception 'duplicate request'; end if;
  select coalesce(sum(reserved_tokens),0) into hold from benchmark_budget_calls where account_id=p_account and state in ('reserved','unresolved');
  if a.spent_tokens+hold+p_tokens>a.cap_tokens then raise exception 'benchmark budget exhausted'; end if;
  insert into benchmark_budget_calls(account_id,request_key,model,reserved_tokens) values(p_account,p_key,p_model,p_tokens) returning id into receipt;
  return receipt;
end $$;
create or replace function public.benchmark_settle_call(p_call uuid,p_actual bigint)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c benchmark_budget_calls;
begin
  select * into c from benchmark_budget_calls where id=p_call for update;
  if not found or c.state<>'reserved' or p_actual is null or p_actual<0 or p_actual>c.reserved_tokens then raise exception 'invalid settlement'; end if;
  update benchmark_budget_accounts set spent_tokens=spent_tokens+p_actual where id=c.account_id;
  update benchmark_budget_calls set actual_tokens=p_actual,state='settled' where id=p_call;
  return true;
end $$;
create or replace function public.benchmark_redeem_approval(p_approval uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
declare a benchmark_budget_approvals; acc benchmark_budget_accounts;
begin
  select * into a from benchmark_budget_approvals where id=p_approval for update;
  if not found or a.redeemed_at is not null then raise exception 'approval absent or redeemed'; end if;
  select * into acc from benchmark_budget_accounts where id=a.account_id for update;
  if acc.owner_actor_id<>a.owner_actor_id or acc.cap_tokens<>a.previous_ceiling then raise exception 'approval scope mismatch'; end if;
  update benchmark_budget_accounts set cap_tokens=a.new_ceiling where id=acc.id;
  update benchmark_budget_approvals set redeemed_at=now() where id=a.id;
  return true;
end $$;
revoke all on function public.benchmark_reserve_call(uuid,text,text,bigint),public.benchmark_settle_call(uuid,bigint),public.benchmark_redeem_approval(uuid) from public,anon,authenticated;
grant execute on function public.benchmark_reserve_call(uuid,text,text,bigint),public.benchmark_settle_call(uuid,bigint),public.benchmark_redeem_approval(uuid) to service_role;
