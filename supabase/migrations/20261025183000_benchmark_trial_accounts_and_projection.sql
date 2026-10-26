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
