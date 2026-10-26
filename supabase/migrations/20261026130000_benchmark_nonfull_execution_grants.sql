-- Native/Thin use the same gateway grant/account journal as Full, without
-- manufacturing Developer tasks or mission projections.
-- Owner approval is provisioned out-of-band, never by an agent/client RPC.
create or replace function public.benchmark_issue_nonfull_execution_grant(
 p_owner uuid,p_actor uuid,p_chat uuid,p_trial uuid,p_approval uuid,
 p_repository text,p_model text,p_epoch bigint,p_deadline timestamptz,p_digest text)
returns uuid language plpgsql security invoker set search_path=public as $$
declare
 a public.benchmark_native_spending_approvals;
 t public.benchmark_three_arm_trials;
 acc public.benchmark_budget_accounts;
 result uuid;
begin
 if p_digest !~ '^[a-f0-9]{64}$' or p_epoch<>1 or p_deadline<=now()
 then raise exception 'nonfull grant invalid';end if;
 select * into a from public.benchmark_native_spending_approvals
 where id=p_approval for update;
 if not found or a.consumed_at is not null or a.revoked_at is not null
  or a.deadline<=now() or p_deadline>a.deadline
  or a.owner_id is distinct from p_owner or a.actor_id is distinct from p_actor
  or a.chat_id is distinct from p_chat or a.trial_id is distinct from p_trial
  or a.repository is distinct from p_repository or a.model is distinct from p_model
  or a.task_id is not null or a.project_id is not null
  or a.mission_assignment_id is not null
 then raise exception 'nonfull owner grant authorization missing';end if;
 select * into t from public.benchmark_three_arm_trials
 where id=p_trial for update;
 if not found or t.arm not in ('native','thin') or t.state<>'qualified'
  or t.owner_actor_id is distinct from p_actor
 then raise exception 'nonfull qualified trial missing';end if;
 select * into acc from public.benchmark_budget_accounts
 where id=a.account_id for update;
 if not found or acc.trial_id is distinct from t.id
  or acc.arm is distinct from t.arm
  or acc.owner_actor_id is distinct from t.owner_actor_id
  or acc.frozen_at is not null or acc.cap_tokens>a.max_tokens
  or a.protocol_digest is null or a.protocol_digest !~ '^[a-f0-9]{64}$'
 then raise exception 'nonfull canonical account denied';end if;
 if exists(select 1 from public.benchmark_budget_calls c
   where c.account_id=acc.id and c.state in ('overrun','unresolved'))
 then raise exception 'nonfull account has unresolved liability';end if;
 insert into public.benchmark_execution_grants(
 token_digest,trial_id,account_id,owner_actor_id,
 protocol_digest,repository,model,execution_epoch,deadline)
 values(p_digest,t.id,acc.id,t.owner_actor_id,
 a.protocol_digest,p_repository,p_model,p_epoch,p_deadline)
 returning id into result;
 update public.benchmark_three_arm_trials set state='running'
 where id=t.id and state='qualified';
 update public.benchmark_native_spending_approvals
 set consumed_at=now() where id=a.id;
 return result;
end $$;
revoke all on function public.benchmark_issue_nonfull_execution_grant(
 uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)
 from public,anon,authenticated;
grant execute on function public.benchmark_issue_nonfull_execution_grant(
 uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)
 to service_role;
