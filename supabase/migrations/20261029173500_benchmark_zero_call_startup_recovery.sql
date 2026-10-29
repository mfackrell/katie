-- Restore one lost, unused execution capability, never owner consent or spending.
create table public.benchmark_startup_recoveries(
 id uuid primary key default gen_random_uuid(),
 approval_id uuid not null unique references public.benchmark_native_spending_approvals(id),
 task_id uuid not null unique references public.agent_tasks(id),
 old_grant_id uuid not null unique references public.benchmark_execution_grants(id),
 prior_run bigint not null,
 release_sha text not null check(release_sha ~ '^[a-f0-9]{40}$'),
 scope_hash text not null,
 evidence jsonb not null,
 created_at timestamptz not null default now()
);
create table public.benchmark_startup_recovery_grants(
 recovery_id uuid primary key references public.benchmark_startup_recoveries(id),
 grant_id uuid not null unique references public.benchmark_execution_grants(id),
 created_at timestamptz not null default now()
);
alter table public.benchmark_startup_recoveries enable row level security;
alter table public.benchmark_startup_recovery_grants enable row level security;
revoke all on public.benchmark_startup_recoveries,public.benchmark_startup_recovery_grants from public,anon,authenticated;
grant select,insert on public.benchmark_startup_recoveries,public.benchmark_startup_recovery_grants to service_role;

create function public.benchmark_prepare_startup_recovery(p_task uuid,p_run bigint,p_receipt jsonb,p_release text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare t agent_tasks; j mission_assignments; m agent_missions; p work_projects;
 a benchmark_native_spending_approvals; g benchmark_execution_grants; r benchmark_startup_recoveries;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into t from agent_tasks where id=p_task for update;
 select * into j from mission_assignments where id=p_task for update;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into p from work_projects where id=m.project_id for update;
 select * into a from benchmark_native_spending_approvals where task_id=p_task for update;
 select * into g from benchmark_execution_grants where mission_assignment_id=p_task order by execution_epoch desc limit 1 for update;
 if t.id is null or j.id is null or m.id is null or p.id is null or a.id is null or g.id is null or
   t.status<>'blocked' or j.status<>'failed' or m.status<>'blocked' or p.status<>'blocked' or
   t.kind<>'development' or j.role<>'development' or p.phase<>'development' or p.active_mission_id<>m.id or
   a.actor_id is distinct from p.actor_id or a.chat_id is distinct from p.chat_id or
   a.project_id is distinct from p.id or a.mission_assignment_id is distinct from j.id or
   not benchmark_full_task_provenance(t.id,p.id) or
   p.approved_hash is null or p.approved_hash is distinct from p.approval_hash or
   not exists(select 1 from project_runs where mission_id=m.id and binding->>'scopeHash'=p.approved_hash) or
   a.consumed_at is null or a.revoked_at is not null or a.deadline<=now() or p.deadline<=now() or m.deadline<=now() or
   a.continuation_id is null or not benchmark_continuation_live(a.continuation_id,a.account_id,p.id) or
   g.trial_id<>a.trial_id or g.account_id<>a.account_id or g.owner_actor_id<>a.actor_id or
   g.project_id is distinct from p.id or g.protocol_digest<>a.protocol_digest or
   g.repository<>a.repository or g.model<>a.model or g.continuation_id is distinct from a.continuation_id or
   g.revoked_at is not null or g.deadline<=now() or
   t.external->'receipt' is distinct from p_receipt or (p_receipt->>'run_id')::bigint is distinct from p_run or
   p_receipt->>'outcome' is distinct from 'BLOCKED' or p_receipt->>'repository' is distinct from a.repository or
   p_receipt->>'issue_number' is distinct from t.external->>'issueNumber' or
   p_receipt->>'pr_url' is not null or p_receipt->>'tested_head_sha' is not null or p_receipt->>'reviewed_head_sha' is not null or
   p_receipt->'checks' is distinct from '{"build":"failure","test":"","review":"","repair":"skipped","retest":"","final_review":""}'::jsonb or
   (p_release is null or p_release !~ '^[a-f0-9]{40}$') or
   m.calls<>0 or m.actual_tokens<>0 or m.reserved_tokens<>0 or
   exists(select 1 from mission_calls c join mission_assignments x on x.id=c.job_id where x.mission_id=m.id) or
   exists(select 1 from benchmark_budget_calls where account_id=a.account_id and created_at>=g.created_at) or
   exists(select 1 from benchmark_startup_recoveries where approval_id=a.id) or
   exists(select 1 from mission_assignments where mission_id=m.id and id<>j.id and status='failed') then
  raise exception 'Unused native startup recovery is not eligible';
 end if;
 insert into benchmark_startup_recoveries(approval_id,task_id,old_grant_id,prior_run,release_sha,scope_hash,evidence)
 values(a.id,t.id,g.id,p_run,p_release,p.approved_hash,jsonb_build_object('task',to_jsonb(t),'assignment',to_jsonb(j),'mission',to_jsonb(m),'projectStatus',p.status,'receipt',p_receipt)) returning * into r;
 update benchmark_execution_grants set stopped_at=coalesce(stopped_at,now()) where id=g.id;
 update agent_tasks set status='dispatching',external=external||jsonb_build_object('startupRecoveryId',r.id,'startupRecoverySince',r.created_at,'startupRecoveryRelease',p_release),updated_at=now() where id=t.id;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),updated_at=now() where id=j.id;
 update agent_missions set status='running',updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,impediment=null,detail='Restoring the same approved unused native execution after a verified startup failure.',updated_at=now() where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'native_startup_recovered',jsonb_build_object('recovery',r.id,'task',t.id,'priorRun',p_run,'priorGrant',g.id,'release',p_release));
 return to_jsonb(r);
end $$;

create function public.benchmark_issue_startup_recovery_grant(p_recovery uuid,p_digest text,p_approval uuid,p_task uuid,p_release text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare r benchmark_startup_recoveries; a benchmark_native_spending_approvals; g benchmark_execution_grants;
 p work_projects; j mission_assignments; m agent_missions; acc benchmark_budget_accounts; n uuid; epoch bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into r from benchmark_startup_recoveries where id=p_recovery;
 select * into a from benchmark_native_spending_approvals where id=r.approval_id for update;
 select * into g from benchmark_execution_grants where id=r.old_grant_id for update;
 select * into p from work_projects where id=a.project_id for update;
 select * into j from mission_assignments where id=r.task_id for update;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into acc from benchmark_budget_accounts where id=a.account_id for update;
 if r.id is null or r.approval_id is distinct from p_approval or r.task_id is distinct from p_task or r.release_sha is distinct from p_release or a.id is null or g.id is null or p.id is null or j.id is null or m.id is null or acc.id is null or
   (p_digest is null or p_digest !~ '^[a-f0-9]{64}$') or a.revoked_at is not null or a.consumed_at is null or a.deadline<=now() or
   p.status<>'running' or p.phase<>'development' or p.deadline<=now() or p.approved_hash is distinct from r.scope_hash or p.approval_hash is distinct from r.scope_hash or
   not benchmark_full_task_provenance(r.task_id,p.id) or a.actor_id is distinct from p.actor_id or a.chat_id is distinct from p.chat_id or
   p.active_mission_id<>m.id or m.project_id<>p.id or m.status<>'running' or m.deadline<=now() or j.status<>'waiting_external' or
   not exists(select 1 from agent_tasks where id=r.task_id and status in ('submitted','dispatching') and external->>'startupRecoveryId'=r.id::text) or
   not benchmark_continuation_live(a.continuation_id,a.account_id,p.id) or g.stopped_at is null or g.revoked_at is not null or
   acc.frozen_at is not null or acc.cap_tokens<>350000 or acc.cap_tokens>a.max_tokens or acc.spent_tokens>=acc.cap_tokens or
   not exists(select 1 from benchmark_startup_recovery_dispatches where recovery_id=r.id) or
   exists(select 1 from benchmark_startup_recovery_grants where recovery_id=r.id) or
   m.calls<>0 or m.actual_tokens<>0 or m.reserved_tokens<>0 or
   exists(select 1 from mission_calls c join mission_assignments x on x.id=c.job_id where x.mission_id=m.id) or
   exists(select 1 from benchmark_budget_calls where account_id=a.account_id and created_at>=g.created_at) then
  raise exception 'Unused native startup capability unavailable';
 end if;
 select coalesce(max(execution_epoch),0)+1 into epoch from benchmark_execution_grants where trial_id=a.trial_id;
 insert into benchmark_execution_grants(token_digest,trial_id,account_id,owner_actor_id,protocol_digest,repository,model,execution_epoch,deadline,project_id,mission_assignment_id,continuation_id)
 values(p_digest,a.trial_id,a.account_id,a.actor_id,a.protocol_digest,a.repository,a.model,epoch,least(a.deadline,g.deadline,m.deadline,p.deadline),p.id,j.id,a.continuation_id) returning id into n;
 insert into benchmark_startup_recovery_grants(recovery_id,grant_id) values(r.id,n);
 return jsonb_build_object('grantId',n,'executionEpoch',epoch);
end $$;
revoke all on function public.benchmark_prepare_startup_recovery(uuid,bigint,jsonb,text),public.benchmark_issue_startup_recovery_grant(uuid,text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.benchmark_prepare_startup_recovery(uuid,bigint,jsonb,text),public.benchmark_issue_startup_recovery_grant(uuid,text,uuid,uuid,text) to service_role;
-- Claim the external side effect once. Ambiguous GitHub acceptance is not retried.
create table public.benchmark_startup_recovery_dispatches(
 recovery_id uuid primary key references public.benchmark_startup_recoveries(id),
 created_at timestamptz not null default now()
);
alter table public.benchmark_startup_recovery_dispatches enable row level security;
revoke all on public.benchmark_startup_recovery_dispatches from public,anon,authenticated;
grant select,insert on public.benchmark_startup_recovery_dispatches to service_role;
create function public.benchmark_claim_startup_recovery_dispatch(p_recovery uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
begin
 insert into benchmark_startup_recovery_dispatches(recovery_id)
 select r.id from benchmark_startup_recoveries r join benchmark_native_spending_approvals a on a.id=r.approval_id
 where r.id=p_recovery and a.deadline>now() and a.revoked_at is null and
 benchmark_continuation_live(a.continuation_id,a.account_id,a.project_id)
 on conflict do nothing;
 return found;
end $$;
revoke all on function public.benchmark_claim_startup_recovery_dispatch(uuid) from public,anon,authenticated;
grant execute on function public.benchmark_claim_startup_recovery_dispatch(uuid) to service_role;

revoke update,delete,truncate on public.benchmark_startup_recoveries,public.benchmark_startup_recovery_grants,public.benchmark_startup_recovery_dispatches from service_role;
