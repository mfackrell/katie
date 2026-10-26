-- Bind Full native execution to a real approved Developer project.
-- Project stop/deadline/approval predicates are repeated under row lock for
-- every new reservation; the earlier grant alone never authorizes spending.
alter table public.benchmark_native_spending_approvals
 add column if not exists project_id uuid references public.work_projects(id);
alter table public.benchmark_execution_grants
 add column if not exists project_id uuid references public.work_projects(id);
create or replace function public.benchmark_issue_execution_grant(
 p_owner uuid,p_actor uuid,p_chat uuid,p_trial uuid,p_approval uuid,
 p_repository text,p_model text,p_epoch bigint,p_deadline timestamptz,p_digest text)
returns uuid language plpgsql security invoker set search_path=public as $$
declare a public.benchmark_native_spending_approvals;
 t public.benchmark_three_arm_trials; acc public.benchmark_budget_accounts;
 p public.work_projects;
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
 acc.trial_id<>t.id or a.protocol_digest !~ '^[a-f0-9]{64}$'
 then raise exception 'spending binding mismatch';end if;
 if t.arm='full' then
  select * into p from public.work_projects where id=a.project_id for update;
  if not found or p.actor_id<>a.actor_id or p.chat_id<>a.chat_id or
    p.status<>'running' or p.phase<>'development' or
    p.deadline<=now() or p.approved_hash is null or
    p.approved_hash is distinct from p.approval_hash
  then raise exception 'live approved Developer project required';end if;
 end if;
 if acc.cap_tokens>a.max_tokens or acc.frozen_at is not null
 then raise exception 'approval ceiling invalid';end if;
 insert into public.benchmark_execution_grants(token_digest,trial_id,account_id,
 owner_actor_id,protocol_digest,repository,model,execution_epoch,deadline,project_id)
 values(p_digest,p_trial,a.account_id,a.actor_id,a.protocol_digest,
 p_repository,p_model,p_epoch,p_deadline,a.project_id) returning id into result;
 update public.benchmark_native_spending_approvals set consumed_at=now() where id=a.id;
 return result;
end $$;
revoke all on function public.benchmark_issue_execution_grant(uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)
 from public,anon,authenticated;
grant execute on function public.benchmark_issue_execution_grant(uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)
 to service_role;

