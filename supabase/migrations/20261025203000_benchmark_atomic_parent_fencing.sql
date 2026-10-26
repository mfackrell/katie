-- Work project and grant are locked before canonical benchmark account reservation.
-- Stop/approval changes and new provider attempts cannot pass each other.
create or replace function public.benchmark_grant_reserve(
 p_digest text,p_trial uuid,p_epoch bigint,p_request_key text,p_model text,p_tokens bigint)
returns uuid language plpgsql security invoker set search_path=public as $$
declare g public.benchmark_execution_grants; a public.benchmark_budget_accounts;
 t public.benchmark_three_arm_trials; p public.work_projects; hold bigint; receipt uuid;
begin
 if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' or
 p_request_key is null or length(p_request_key)<8 or
 p_tokens is null or p_tokens<=0 then raise exception 'invalid gateway request';end if;
 select * into g from public.benchmark_execution_grants
 where token_digest=p_digest and trial_id=p_trial and execution_epoch=p_epoch for update;
 if not found or g.revoked_at is not null or g.stopped_at is not null or g.deadline<=now() or g.model<>p_model
 then raise exception 'grant denied';end if;
 select * into t from public.benchmark_three_arm_trials where id=g.trial_id for update;
 if not found or t.state<>'running' or t.owner_actor_id<>g.owner_actor_id
 then raise exception 'trial denied';end if;
 if t.arm='full' then
  if g.project_id is null then raise exception 'Full trial requires linked Developer project';end if;
  select * into p from public.work_projects where id=g.project_id for update;
  if not found or p.status<>'running' or p.phase<>'development' or
    p.deadline<=now() or p.actor_id<>g.owner_actor_id or
    p.approved_hash is null or p.approved_hash is distinct from p.approval_hash
  then raise exception 'Developer project stopped or approval withdrawn';end if;
  -- Parent validity alone does not preserve mission/project call ceilings.
  -- Full provider calls require an external-session-aware atomic mission bridge.
  raise exception 'Full native admission requires atomic mission bridge';
 end if;
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
