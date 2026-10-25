-- Owner-reviewed spending authority, separate from existing self-tool grants.
-- Provision only through privileged owner-approval process, never through chat.
create table if not exists public.benchmark_native_spending_approvals(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null,
 actor_id uuid not null,
 chat_id uuid not null,
 trial_id uuid not null references public.benchmark_three_arm_trials(id),
 account_id uuid not null references public.benchmark_budget_accounts(id),
 repository text not null,
 model text not null,
 protocol_digest text not null check(protocol_digest ~ '^[a-f0-9]{64}$'),
 max_tokens bigint not null check(max_tokens>0),
 deadline timestamptz not null,
 revoked_at timestamptz,
 consumed_at timestamptz,
 created_at timestamptz not null default now()
);
alter table public.benchmark_native_spending_approvals enable row level security;
revoke all on public.benchmark_native_spending_approvals from public,anon,authenticated;
-- Approval creation is intentionally absent from every public RPC.
create or replace function public.benchmark_issue_execution_grant(
 p_owner uuid,p_actor uuid,p_chat uuid,p_trial uuid,p_approval uuid,
 p_repository text,p_model text,p_epoch bigint,p_deadline timestamptz,p_digest text)
returns uuid language plpgsql security invoker set search_path=public as $$
declare a public.benchmark_native_spending_approvals;
 t public.benchmark_three_arm_trials; acc public.benchmark_budget_accounts;
 result uuid;
begin
 if p_digest !~ '^[a-f0-9]{64}$' or p_epoch<=0 or p_deadline<=now()
 then raise exception 'invalid grant';end if;
 select * into a from public.benchmark_native_spending_approvals
 where id=p_approval for update;
 if not found or a.consumed_at is not null or a.revoked_at is not null
 or a.deadline<=now() or p_deadline>a.deadline or
 a.owner_id<>p_owner or a.actor_id<>p_actor or a.chat_id<>p_chat or
 a.trial_id<>p_trial or a.repository<>p_repository or a.model<>p_model
 then raise exception 'owner spending authorization missing';end if;
 select * into t from public.benchmark_three_arm_trials where id=a.trial_id for update;
 select * into acc from public.benchmark_budget_accounts where id=a.account_id for update;
 if t.id is null or acc.id is null or t.state not in ('qualified','running') or
 t.owner_actor_id<>a.actor_id or acc.owner_actor_id<>a.actor_id or
 acc.trial_id<>t.id or a.protocol_digest !~ '^[a-f0-9]{64} 'spending binding mismatch';end if;
 if acc.cap_tokens>a.max_tokens or acc.frozen_at is not null
 then raise exception 'approval ceiling invalid';end if;
 insert into public.benchmark_execution_grants(token_digest,trial_id,account_id,
 owner_actor_id,protocol_digest,repository,model,execution_epoch,deadline)
 values(p_digest,p_trial,a.account_id,a.actor_id,a.protocol_digest,
 p_repository,p_model,p_epoch,p_deadline) returning id into result;
 update public.benchmark_native_spending_approvals set consumed_at=now() where id=a.id;
 return result;
end $$;
revoke all on function public.benchmark_issue_execution_grant(uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)
 from public,anon,authenticated;
grant execute on function public.benchmark_issue_execution_grant(uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)
 to service_role;

 then raise exception 'spending binding mismatch';end if;
 if acc.cap_tokens>a.max_tokens or acc.frozen_at is not null
 then raise exception 'approval ceiling invalid';end if;
 insert into public.benchmark_execution_grants(token_digest,trial_id,account_id,
 owner_actor_id,protocol_digest,repository,model,execution_epoch,deadline)
 values(p_digest,p_trial,a.account_id,a.actor_id,a.protocol_digest,
 p_repository,p_model,p_epoch,p_deadline) returning id into result;
 update public.benchmark_native_spending_approvals set consumed_at=now() where id=a.id;
 return result;
end $$;
revoke all on function public.benchmark_issue_execution_grant(uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)
 from public,anon,authenticated;
grant execute on function public.benchmark_issue_execution_grant(uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)
 to service_role;
