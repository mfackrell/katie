-- Preserve known provider overruns instead of losing actual usage.
-- Forward-only migration; existing ledger/charges remain intact.
alter table public.benchmark_budget_calls
  drop constraint if exists benchmark_budget_calls_state_check;
alter table public.benchmark_budget_calls
  add constraint benchmark_budget_calls_state_check
  check (state in ('reserved','settled','unresolved','overrun'));

create or replace function public.benchmark_record_overrun(p_call uuid,p_actual bigint)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls;
begin
  select * into c from public.benchmark_budget_calls where id=p_call for update;
  if not found or c.state <> 'reserved' or p_actual is null
     or p_actual <= c.reserved_tokens then
    raise exception 'invalid benchmark overrun';
  end if;
  update public.benchmark_budget_accounts
    set spent_tokens=spent_tokens+p_actual where id=c.account_id;
  update public.benchmark_budget_calls
    set actual_tokens=p_actual,state='overrun' where id=c.id;
  return true;
end $$;
revoke all on function public.benchmark_record_overrun(uuid,bigint)
  from public,anon,authenticated;
grant execute on function public.benchmark_record_overrun(uuid,bigint)
  to service_role;

-- Idempotent provider receipt reconciliation. Never clear uncertain charges
-- without an immutable external request identifier and actual usage.
alter table public.benchmark_budget_calls
 add column if not exists provider_request_id text;
create unique index if not exists benchmark_provider_receipt_uniq
 on public.benchmark_budget_calls(provider_request_id)
 where provider_request_id is not null;

create or replace function public.benchmark_reconcile_receipt(
 p_call uuid,p_provider_request text,p_actual bigint)
returns text language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls; next_state text;
begin
 if nullif(btrim(p_provider_request),'') is null or p_actual is null or p_actual<0 then
   raise exception 'provider receipt incomplete';
 end if;
 select * into c from public.benchmark_budget_calls where id=p_call for update;
 if not found then raise exception 'unknown call'; end if;
 if c.state in ('settled','overrun') then
   if c.provider_request_id=p_provider_request and c.actual_tokens=p_actual then
     return c.state;
   end if;
   raise exception 'receipt reconciliation conflict';
 end if;
 if c.provider_request_id is not null and c.provider_request_id<>p_provider_request then
   raise exception 'provider receipt identity changed';
 end if;
 next_state:=case when p_actual>c.reserved_tokens then 'overrun' else 'settled' end;
 update public.benchmark_budget_accounts
   set spent_tokens=spent_tokens+p_actual where id=c.account_id;
 update public.benchmark_budget_calls
   set actual_tokens=p_actual,state=next_state,provider_request_id=p_provider_request
   where id=c.id;
 return next_state;
end $$;
revoke all on function public.benchmark_reconcile_receipt(uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.benchmark_reconcile_receipt(uuid,text,bigint) to service_role;

-- Reconcile receipts without double charging; quarantine every observed overrun.
alter table public.benchmark_budget_accounts add column if not exists frozen_at timestamptz;
alter table public.benchmark_budget_calls add column if not exists provider_namespace text;
drop index if exists public.benchmark_provider_receipt_uniq;
create unique index if not exists benchmark_provider_receipt_namespace_uniq
 on public.benchmark_budget_calls(provider_namespace,provider_request_id)
 where provider_namespace is not null and provider_request_id is not null;

-- Keep the legacy admission RPC's original predicates and lock ordering.
create or replace function public.benchmark_reserve_call(p_account uuid,p_key text,p_model text,p_tokens bigint)
returns uuid language plpgsql security invoker set search_path=public as $$
declare a public.benchmark_budget_accounts; hold bigint; receipt uuid;
begin
 if p_tokens is null or p_tokens<=0 or nullif(p_key,'') is null then raise exception 'invalid admission'; end if;
 select * into a from public.benchmark_budget_accounts where id=p_account for update;
 if not found then raise exception 'unknown account'; end if;
 if a.frozen_at is not null or exists(select 1 from public.benchmark_budget_calls where account_id=p_account and state='overrun') then
   raise exception 'benchmark account quarantined';
 end if;
 if exists(select 1 from public.benchmark_budget_calls where account_id=p_account and request_key=p_key) then raise exception 'duplicate request'; end if;
 select coalesce(sum(reserved_tokens),0) into hold from public.benchmark_budget_calls where account_id=p_account and state in ('reserved','unresolved');
 if a.spent_tokens+hold+p_tokens>a.cap_tokens then raise exception 'benchmark budget exhausted'; end if;
 insert into public.benchmark_budget_calls(account_id,request_key,model,reserved_tokens) values(p_account,p_key,p_model,p_tokens) returning id into receipt;
 return receipt;
end $$;

create or replace function public.benchmark_record_overrun(p_call uuid,p_actual bigint)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls;
begin
 select * into c from public.benchmark_budget_calls where id=p_call for update;
 if not found or c.state<>'reserved' or p_actual is null or p_actual<=c.reserved_tokens then raise exception 'invalid benchmark overrun'; end if;
 update public.benchmark_budget_accounts set spent_tokens=spent_tokens+p_actual,frozen_at=coalesce(frozen_at,now()) where id=c.account_id;
 update public.benchmark_budget_calls set actual_tokens=p_actual,state='overrun' where id=c.id;
 return true;
end $$;

create or replace function public.benchmark_reconcile_receipt(p_call uuid,p_namespace text,p_provider_request text,p_actual bigint)
returns text language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls; new_state text;
begin
 if nullif(btrim(p_namespace),'') is null or nullif(btrim(p_provider_request),'') is null or p_actual is null or p_actual<0 then raise exception 'provider receipt incomplete'; end if;
 select * into c from public.benchmark_budget_calls where id=p_call for update;
 if not found then raise exception 'unknown call'; end if;
 if c.provider_request_id is not null and (c.provider_request_id<>p_provider_request or c.provider_namespace is distinct from p_namespace) then raise exception 'receipt identity conflict'; end if;
 if c.state in ('settled','overrun') then
  if c.actual_tokens<>p_actual then raise exception 'receipt usage conflict'; end if;
  -- First trusted receipt may be attached after an earlier settlement. No new charge.
  update public.benchmark_budget_calls set provider_namespace=p_namespace,provider_request_id=p_provider_request where id=c.id;
  return c.state;
 end if;
 new_state:=case when p_actual>c.reserved_tokens then 'overrun' else 'settled' end;
 update public.benchmark_budget_accounts set spent_tokens=spent_tokens+p_actual,
   frozen_at=case when new_state='overrun' then coalesce(frozen_at,now()) else frozen_at end where id=c.account_id;
 update public.benchmark_budget_calls set actual_tokens=p_actual,state=new_state,
   provider_namespace=p_namespace,provider_request_id=p_provider_request where id=c.id;
 return new_state;
end $$;
-- Remove the obsolete three-argument overload: it cannot bind provider namespace.
drop function if exists public.benchmark_reconcile_receipt(uuid,text,bigint);
revoke all on function public.benchmark_reconcile_receipt(uuid,text,text,bigint) from public,anon,authenticated;
grant execute on function public.benchmark_reconcile_receipt(uuid,text,text,bigint) to service_role;

-- Trusted server-side association. Never authorize from model-generated project evidence.
create table if not exists public.benchmark_mission_bindings (
 mission_id uuid primary key references public.agent_missions(id),
 account_id uuid not null references public.benchmark_budget_accounts(id),
 experiment_id uuid not null,
 baseline_sha text not null check (baseline_sha ~ '^[a-f0-9]{40}$'),
 created_at timestamptz not null default now()
);
alter table public.benchmark_mission_bindings enable row level security;
revoke all on public.benchmark_mission_bindings from public,anon,authenticated;
-- This table intentionally provides no client-side admission path.

-- Atomically preserve legacy mission admission AND reserve the benchmark projection.
-- A rejected benchmark reservation rolls back the legacy mission call/counters.
create or replace function public.benchmark_reserve_mission_call(
 p_job uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer,p_routing boolean)
returns uuid language plpgsql security invoker set search_path=public as $$
declare j public.mission_assignments; m public.agent_missions;
 b public.benchmark_mission_bindings; a public.benchmark_budget_accounts;
 hold bigint; receipt uuid; accepted boolean;
begin
 -- Same global lock used by the existing legacy admission path. Consistent order:
 -- legacy mission lock -> mission/assignment rows -> benchmark account.
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from public.mission_assignments where id=p_job;
 if not found then return null; end if;
 select * into m from public.agent_missions where id=j.mission_id;
 select * into b from public.benchmark_mission_bindings where mission_id=m.id;
 if not found then return null; end if;
 select * into a from public.benchmark_budget_accounts where id=b.account_id for update;
 if not found or b.experiment_id<>a.experiment_id or a.arm<>'orchestrated'
    then return null; end if;
 if exists(select 1 from public.benchmark_budget_calls
           where account_id=a.id and state='overrun') then return null; end if;
 select coalesce(sum(reserved_tokens),0) into hold
 from public.benchmark_budget_calls where account_id=a.id
   and state in ('reserved','unresolved');
 if a.spent_tokens+hold+p_tokens>a.cap_tokens then return null; end if;
 if exists(select 1 from public.benchmark_budget_calls
           where account_id=a.id and request_key=p_call::text) then return null; end if;
 -- Original function owns deadline, lease, parent, call count and legacy budget checks.
 accepted:=public.try_reserve_mission_capacity(p_job,p_lease,p_call,p_model,p_tokens,p_routing);
 if not accepted then return null; end if;
 insert into public.benchmark_budget_calls(account_id,request_key,model,reserved_tokens)
 values(a.id,p_call::text,p_model,p_tokens) returning id into receipt;
 return receipt;
end $$;
revoke all on function public.benchmark_reserve_mission_call(uuid,uuid,uuid,text,integer,boolean)
 from public,anon,authenticated;
grant execute on function public.benchmark_reserve_mission_call(uuid,uuid,uuid,text,integer,boolean)
 to service_role;

-- One transaction settles the legacy mission projection and benchmark account.
-- Legacy function is authoritative for mission accounting; no separate provider call.
create or replace function public.benchmark_finish_mission_call(
 p_call uuid,p_tokens integer)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.mission_calls; b public.benchmark_budget_calls;
 a public.benchmark_budget_accounts;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into c from public.mission_calls where id=p_call for update;
 if not found then raise exception 'missing legacy call'; end if;
 select bc.* into b from public.benchmark_budget_calls bc
  join public.benchmark_mission_bindings mb on mb.account_id=bc.account_id
  join public.mission_assignments ma on ma.mission_id=mb.mission_id
  where ma.id=c.job_id and bc.request_key=p_call::text for update of bc;
 if not found then raise exception 'missing benchmark projection'; end if;
 select * into a from public.benchmark_budget_accounts where id=b.account_id for update;
 if c.status='completed' and b.state in ('settled','overrun') then
  if c.actual_tokens is distinct from p_tokens or b.actual_tokens is distinct from p_tokens
  then raise exception 'settlement replay conflict'; end if;
  return true;
 end if;
 if c.status<>'reserved' or b.state<>'reserved' then raise exception 'settlement state mismatch'; end if;
 if p_tokens is not null and p_tokens<0 then raise exception 'invalid provider usage'; end if;
 perform public.finish_mission_call(p_call,p_tokens);
 if p_tokens is null then
  update public.benchmark_budget_calls set state='unresolved' where id=b.id;
 else
  update public.benchmark_budget_accounts set spent_tokens=spent_tokens+p_tokens
   where id=a.id;
  update public.benchmark_budget_calls set actual_tokens=p_tokens,
   state=case when p_tokens>b.reserved_tokens then 'overrun' else 'settled' end where id=b.id;
  if p_tokens>b.reserved_tokens then
   -- No further admission after a known provider overrun, even below account cap.
   -- Admission checks any recorded overrun state before allowing another call.
  end if;
 end if;
 return true;
end $$;
revoke all on function public.benchmark_finish_mission_call(uuid,integer) from public,anon,authenticated;
grant execute on function public.benchmark_finish_mission_call(uuid,integer) to service_role;

-- Reconcile an uncertain benchmark-bound provider call into BOTH accounting
-- projections in one transaction, without clearing its hold on a guess.
-- Requires the provider namespace/receipt columns introduced by #739.
create or replace function public.benchmark_reconcile_uncertain_mission_call(
 p_call uuid,p_namespace text,p_provider_request text,p_actual integer)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.mission_calls; b public.benchmark_budget_calls;
 a public.benchmark_budget_accounts; bound_mission_id uuid;
begin
 if nullif(btrim(p_namespace),'') is null
 or nullif(btrim(p_provider_request),'') is null
 or p_actual is null or p_actual<0 then raise exception 'verified usage receipt required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into c from public.mission_calls where id=p_call for update;
 if not found then raise exception 'mission call missing'; end if;
 select ma.mission_id into bound_mission_id from public.mission_assignments ma where ma.id=c.job_id;
 select bc.* into b from public.benchmark_budget_calls bc
 join public.benchmark_mission_bindings mb on mb.account_id=bc.account_id
 where mb.mission_id=bound_mission_id and bc.request_key=p_call::text for update of bc;
 if not found then raise exception 'benchmark projection missing'; end if;
 select * into a from public.benchmark_budget_accounts where id=b.account_id for update;
 if c.status='completed' and b.state in ('settled','overrun') then
  if c.actual_tokens=p_actual and b.actual_tokens=p_actual
     and b.provider_namespace=p_namespace and b.provider_request_id=p_provider_request
  then return true; end if;
  raise exception 'conflicting provider receipt';
 end if;
 if c.status<>'uncertain' or b.state<>'unresolved' then raise exception 'call not reconcilable'; end if;
 if b.provider_request_id is not null and
    (b.provider_request_id<>p_provider_request or b.provider_namespace is distinct from p_namespace)
 then raise exception 'provider receipt changed'; end if;
 update public.mission_calls set actual_tokens=p_actual,status='completed' where id=p_call;
 update public.agent_missions set actual_tokens=actual_tokens+p_actual,
   reserved_tokens=reserved_tokens-c.reserved_tokens+p_actual where id=bound_mission_id;
 update public.benchmark_budget_accounts set spent_tokens=spent_tokens+p_actual,
   frozen_at=case when p_actual>b.reserved_tokens then coalesce(frozen_at,now()) else frozen_at end
   where id=a.id;
 update public.benchmark_budget_calls set actual_tokens=p_actual,
   state=case when p_actual>b.reserved_tokens then 'overrun' else 'settled' end,
   provider_namespace=p_namespace,provider_request_id=p_provider_request where id=b.id;
 return true;
end $$;
revoke all on function public.benchmark_reconcile_uncertain_mission_call(uuid,text,text,integer)
 from public,anon,authenticated;
grant execute on function public.benchmark_reconcile_uncertain_mission_call(uuid,text,text,integer)
 to service_role;

-- Additive, non-billable experiment registry. Does not change legacy accounts,
-- admission functions, existing projects, approvals, or spending authority.
create table if not exists public.benchmark_three_arm_trials (
 id uuid primary key default gen_random_uuid(),
 experiment_id uuid not null,
 replicate integer not null check(replicate between 1 and 1000),
 arm text not null check(arm in ('native','thin','full')),
 owner_actor_id uuid not null,
 contract_sha256 text not null check(contract_sha256 ~ '^[a-f0-9]{64}$'),
 baseline_sha text not null check(baseline_sha ~ '^[a-f0-9]{40}$'),
 model_policy_sha256 text not null check(model_policy_sha256 ~ '^[a-f0-9]{64}$'),
 tool_profile_sha256 text not null check(tool_profile_sha256 ~ '^[a-f0-9]{64}$'),
 acceptance_sha256 text not null check(acceptance_sha256 ~ '^[a-f0-9]{64}$'),
 runtime_sha256 text not null check(runtime_sha256 ~ '^[a-f0-9]{64}$'),
 state text not null default 'planned'
   check(state in ('planned','qualified','running','submitted','reviewed','blocked')),
 created_at timestamptz not null default now(),
 unique(experiment_id,replicate,arm)
);
create index if not exists benchmark_three_arm_trials_experiment
 on public.benchmark_three_arm_trials(experiment_id,replicate);
alter table public.benchmark_three_arm_trials enable row level security;
revoke all on public.benchmark_three_arm_trials from public,anon,authenticated;
-- Never turn registration into executable owner approval. No client policies.

-- Forward-only integration on top of #737, #739, and the three-arm registry.
-- Does not touch existing grants, historical reservations, or actual charges.
alter table public.benchmark_budget_accounts
 drop constraint if exists benchmark_budget_accounts_arm_check;
alter table public.benchmark_budget_accounts
 add constraint benchmark_budget_accounts_arm_check
 check (arm in ('direct','orchestrated','native','thin','full'));
alter table public.benchmark_budget_accounts
 add column if not exists trial_id uuid
 references public.benchmark_three_arm_trials(id);
create unique index if not exists benchmark_budget_accounts_trial_unique
 on public.benchmark_budget_accounts(trial_id) where trial_id is not null;
-- Existing two-arm accounts retain their original experiment/arm uniqueness.
-- New trial accounts require replica-aware uniqueness instead.
alter table public.benchmark_budget_accounts
 drop constraint if exists benchmark_budget_accounts_experiment_id_arm_key;
create unique index if not exists benchmark_legacy_account_identity_unique
 on public.benchmark_budget_accounts(experiment_id,arm)
 where trial_id is null;
-- Make any new experimental account's trial/owner/arm agreement immutable.
create or replace function public.benchmark_validate_trial_account()
returns trigger language plpgsql security invoker set search_path=public as $$
declare t public.benchmark_three_arm_trials;
begin
 if new.trial_id is null then
  if new.arm in ('native','thin','full') then
   raise exception 'three-arm account requires a trial identity';
  end if;
  return new;
 end if;
 select * into t from public.benchmark_three_arm_trials where id=new.trial_id;
 if not found or t.experiment_id<>new.experiment_id
    or t.arm<>new.arm or t.owner_actor_id<>new.owner_actor_id then
  raise exception 'account identity does not match trial';
 end if;
 if tg_op='UPDATE' and (new.trial_id is distinct from old.trial_id or
   new.experiment_id is distinct from old.experiment_id or
   new.owner_actor_id is distinct from old.owner_actor_id or new.arm is distinct from old.arm)
 then raise exception 'trial account identity immutable';end if;
 return new;
end $$;
drop trigger if exists benchmark_account_trial_identity on public.benchmark_budget_accounts;
create trigger benchmark_account_trial_identity before insert or update on public.benchmark_budget_accounts
for each row execute function public.benchmark_validate_trial_account();
revoke all on function public.benchmark_validate_trial_account() from public,anon,authenticated;
-- Bind canonical provider operation explicitly to its legacy mission projection.
alter table public.benchmark_budget_calls
 add column if not exists legacy_mission_call_id uuid
 references public.mission_calls(id);
create unique index if not exists benchmark_legacy_mission_projection_unique
 on public.benchmark_budget_calls(legacy_mission_call_id)
 where legacy_mission_call_id is not null;
-- Generic single-ledger settlement cannot mutate linked work behind the bridge.
create or replace function public.benchmark_settle_call(p_call uuid,p_actual bigint)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls;
begin
 select * into c from public.benchmark_budget_calls where id=p_call for update;
 if not found then raise exception 'unknown benchmark call';end if;
 if c.legacy_mission_call_id is not null then
  raise exception 'linked operation requires atomic mission settlement';
 end if;
 if c.state<>'reserved' or p_actual is null or p_actual<0 or p_actual>c.reserved_tokens
 then raise exception 'invalid settlement';end if;
 update public.benchmark_budget_accounts set spent_tokens=spent_tokens+p_actual where id=c.account_id;
 update public.benchmark_budget_calls set actual_tokens=p_actual,state='settled' where id=c.id;
 return true;
end $$;

