-- Task 4A native bridge. No project data or owner grant is created by installing this migration.
-- The existing ordinary native host and canonical mission_calls ledger remain authoritative.
-- Both old benchmark and ordinary Developer execution retain their existing paths.
alter table public.mission_calls
 add column project_provider_request_id text,
 add column project_provider_usage jsonb,
 add column project_actual_microusd numeric(20,0);
create unique index task4a_provider_receipt_once
 on public.mission_calls(project_provider_request_id)
 where project_provider_request_id is not null;

-- The owner may revoke a continuation but no worker may silently clear revocation.
create or replace function public.task4a_authority_immutable()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if (to_jsonb(new)-'revoked_at') is distinct from (to_jsonb(old)-'revoked_at')
   or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
 then raise exception 'Task 4A continuation authority is immutable';end if;
 return new;
end $$;
create trigger task4a_authority_immutable_update before update
 on public.project_continuation_authorizations for each row
 execute function public.task4a_authority_immutable();
revoke all on function public.task4a_authority_immutable()
 from public,anon,authenticated;

-- Read-only, exact-project principal resolution. The generic service role has
-- no direct SELECT on standalone_owner_bindings and must not gain it.
create or replace function public.task4a_original_owner_id(p_actor uuid,p_chat uuid)
returns uuid language plpgsql stable security definer set search_path=public as $$
declare p public.work_projects;found_owner uuid;
begin
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
   and actor_id=p_actor and chat_id=p_chat;
 if p.id is null then return null;end if;
 select b.owner_id into found_owner from public.standalone_owner_bindings b
  where b.actor_id=p.actor_id and b.chat_id=p.chat_id and b.revoked_at is null;
 if found_owner is null
  or public.standalone_verify_scope(found_owner,p.actor_id,p.chat_id) is distinct from true
 then return null;end if;
 return found_owner;
end $$;
revoke all on function public.task4a_original_owner_id(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.task4a_original_owner_id(uuid,uuid)
 to service_role;

-- Only the approved original project may use this type of signed native grant.
-- A paused project, a changed scope, an unbound task or an inactive price deny it.
create or replace function public.task4a_native_authority_ready(
 p_project uuid,p_task uuid,p_authority uuid
) returns boolean language plpgsql security invoker set search_path=public as $$
declare a public.project_continuation_authorizations;ok boolean;
begin
 if p_project is distinct from '6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid then return false;end if;
 select * into a from public.project_continuation_authorizations
  where id=p_authority and project_id=p_project;
 if a.id is null or a.revoked_at is not null or a.deadline<=clock_timestamp()
 then return false;end if;
 select exists(
  select 1 from public.work_projects p
  join public.agent_missions m on m.id=p.active_mission_id and m.project_id=p.id
  join public.mission_assignments j on j.mission_id=m.id and j.id=p_task
  join public.agent_tasks t on t.id=j.id
  join public.project_runs r on r.project_id=p.id and r.mission_id=m.id
  join public.repo_sync_runs repo on repo.id=p.repository_id
  join public.benchmark_native_spending_approvals approval
    on approval.task_id=t.id and approval.project_id=p.id
  join public.benchmark_budget_accounts acct
    on acct.id=approval.account_id and acct.developer_task_id=t.id
  where p.id=p_project and p.status='running' and p.phase='development'
    and p.deadline>clock_timestamp() and m.status='running'
    and m.project_kind='development' and j.role='development'
    and p.approved_hash is not null and p.approved_hash=p.approval_hash
    and r.binding->>'scopeHash'=p.approved_hash
    and r.binding->>'projectId'=p.id::text
    and r.binding->>'contractHash' ~ '^[a-f0-9]{64}$'
    and r.binding->>'baselineSha'=p.baseline_sha
    and repo.repository_full_name='mfackrell/katie'
    and p.repository_full_name='mfackrell/katie'
    and t.repository_full_name='mfackrell/katie' and t.repository_id=p.repository_id
    and t.kind='development' and t.agent_id=j.agent_id
    and approval.owner_id=public.task4a_original_owner_id(p.actor_id,p.chat_id)
    and approval.model='gpt-5.3-codex'
    and approval.actor_id=p.actor_id and approval.chat_id=p.chat_id
    and approval.trial_id is null and approval.continuation_id is null
    and approval.revoked_at is null and approval.deadline>clock_timestamp()
    and approval.developer_authority->>'task4aContinuationId'=a.id::text
    and approval.developer_authority->'binding'=r.binding
    and approval.developer_authority->>'scopeHash'=p.approved_hash
    and acct.arm='developer' and acct.frozen_at is null
    and acct.developer_project_id=p.id
    and 'openai:gpt-5.3-codex'=any(a.allowed_models)
    and exists(select 1 from public.model_registry price
     where price.provider_name='openai' and price.model_id='gpt-5.3-codex'
      and price.is_active=true and price.pricing_status='verified'
      and price.pricing_verified_at between now()-interval '24 hours' and now()
      and price.pricing_input_per_1m>0 and price.pricing_output_per_1m>0
      and price.source_metadata->>'pricing_verification_source'
       ='https://developers.openai.com/api/docs/models/gpt-5.3-codex')
 ) into ok;
 return coalesce(ok,false);
end $$;

-- Create one existing native Developer task-specific approval under an already
-- authenticated and consumed Task 4A project continuation + approved scope.
-- It is not a second owner spending consent and cannot authorize new research.
create or replace function public.task4a_prepare_native_development(
 p_project uuid,p_task uuid,p_scope text,p_contract text,p_baseline text
) returns boolean language plpgsql security invoker set search_path=public as $$
declare p public.work_projects;j public.mission_assignments;m public.agent_missions;
 t public.agent_tasks;r public.project_runs;
 a public.project_continuation_authorizations;
 owner_id uuid;acct_id uuid;limits jsonb;binding jsonb;earlier uuid;expires timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if p_project is distinct from '6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
 then return false;end if;
 select * into p from public.work_projects where id=p_project for update;
 select * into a from public.project_continuation_authorizations
  where project_id=p_project for update;
 if p.id is null or a.id is null or a.revoked_at is not null
  or a.deadline<=clock_timestamp()+interval '60 seconds'
  or p.status<>'running' or p.phase<>'development'
  or p.deadline<=clock_timestamp()+interval '60 seconds'
  or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash
  or p.approved_hash is distinct from p_scope
  or p.baseline_sha is distinct from p_baseline
  or 'openai:gpt-5.3-codex'<>all(a.allowed_models)
  or p.repository_full_name not in ('mfackrell/katie') and p.repository_full_name is not null
  or not exists(select 1 from public.repo_sync_runs repo where repo.id=p.repository_id
    and repo.repository_full_name='mfackrell/katie')
 then return false;end if;
 select * into t from public.agent_tasks where id=p_task for update;
 select * into j from public.mission_assignments where id=p_task for update;
 select * into m from public.agent_missions where id=j.mission_id for update;
 select * into r from public.project_runs where project_id=p.id and mission_id=m.id;
 if t.id is null or j.id is null or m.id is null or r.id is null
  or p.active_mission_id is distinct from m.id
  or m.project_id is distinct from p.id or m.project_kind<>'development'
  or m.status<>'running' or j.role<>'development' or t.kind<>'development'
  or t.status<>'dispatching' or t.agent_id is distinct from j.agent_id
  or t.repository_id is distinct from p.repository_id
  or t.repository_full_name<>'mfackrell/katie'
  or coalesce(t.external->>'attempted','false')<>'false'
  or t.external ?| array['issueNumber','prUrl','receipt']
  or r.binding->>'projectId' is distinct from p.id::text
  or r.binding->>'scopeHash' is distinct from p_scope
  or r.binding->>'contractHash' is distinct from p_contract
  or r.binding->>'baselineSha' is distinct from p_baseline
  or not exists(select 1 from public.model_registry price where
      price.provider_name='openai' and price.model_id='gpt-5.3-codex'
      and price.is_active=true and price.pricing_status='verified'
      and price.pricing_verified_at between now()-interval '24 hours' and now()
      and price.pricing_input_per_1m=1.75 and price.pricing_output_per_1m=14
      and price.source_metadata->>'pricing_verification_source'
       ='https://developers.openai.com/api/docs/models/gpt-5.3-codex')
 then return false;end if;
 owner_id:=public.task4a_original_owner_id(p.actor_id,p.chat_id);
 if owner_id is null
 then return false;end if;
 select id into earlier from public.benchmark_native_spending_approvals where task_id=p_task;
 if earlier is not null then
  return public.task4a_native_authority_ready(p_project,p_task,a.id);
 end if;
 if exists(select 1 from public.benchmark_budget_accounts where developer_task_id=p_task)
  or exists(select 1 from public.benchmark_mission_bindings where mission_id=m.id)
  or exists(select 1 from public.mission_calls c
   join public.mission_assignments assignment on assignment.id=c.job_id
   where assignment.mission_id=m.id and assignment.role='development')
 then return false;end if;
 expires:=least(p.deadline,a.deadline);
 limits:=jsonb_build_object(
  'cumulativeTokens',a.incremental_tokens,
  'developmentTokens',a.incremental_tokens-a.assessment_reserve_tokens,
  'assessmentTokens',a.assessment_reserve_tokens,
  'completionTokens',a.completion_reserve_tokens,
  'developmentCalls',a.incremental_calls-a.assessment_reserve_calls,
  'completionCalls',a.completion_reserve_calls,
  'assessmentCalls',a.assessment_reserve_calls,
  'perCallMicrousd',a.incremental_microusd,
  'ceilingMicrousd',a.incremental_microusd,
  'durationSeconds',floor(extract(epoch from (expires-clock_timestamp())))::bigint);
 if not public.developer_validate_limits(limits) then return false;end if;
 -- Resolve only the canonical repository name from the already linked repository.
 if p.repository_full_name is null then
  update public.work_projects set repository_full_name='mfackrell/katie'
  where id=p.id and repository_full_name is null;
 end if;
 binding:=r.binding;
 insert into public.benchmark_budget_accounts(
  experiment_id,arm,owner_actor_id,cap_tokens,developer_project_id,developer_task_id)
 values(null,'developer',p.actor_id,a.incremental_tokens,p.id,p_task)
 returning id into acct_id;
 insert into public.benchmark_mission_bindings(
  mission_id,account_id,experiment_id,baseline_sha,developer_project_id)
 values(m.id,acct_id,null,p.baseline_sha,p.id);
 insert into public.benchmark_native_spending_approvals(
  owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,
  max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority)
 values(owner_id,p.actor_id,p.chat_id,null,acct_id,'mfackrell/katie',
  'gpt-5.3-codex',p.approved_hash,a.incremental_tokens,expires,p.id,p_task,p_task,
  jsonb_build_object('version','ordinary-developer-v1',
    'task4aContinuationId',a.id,'scopeHash',p.approved_hash,
    'binding',binding,'completionContract',p.completion_contract,
    'limits',limits,'originalTaskId',p_task));
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_native_development_prepared',
  jsonb_build_object('authorizationId',a.id,'taskId',p_task,
   'scopeHash',p.approved_hash,'contractHash',p_contract,'baselineSha',p_baseline));
 return true;
end $$;

-- Every native mission_calls INSERT must pass the same continuation ledger,
-- even if an older native gateway mistakenly calls developer_native_reserve.
-- Existing benchmark and ordinary projects do not enter this branch.
create or replace function public.task4a_bind_native_mission_call()
returns trigger language plpgsql security invoker set search_path=public as $$
declare m public.agent_missions;j public.mission_assignments;
 a public.project_continuation_authorizations;g public.benchmark_execution_grants;
 approval public.benchmark_native_spending_approvals;price public.model_registry;
 used_tokens bigint;used_calls bigint;used_money numeric;held_money numeric;
begin
 select * into j from public.mission_assignments where id=new.job_id;
 select * into m from public.agent_missions where id=j.mission_id;
 if m.project_id is null then return new;end if;
 select * into a from public.project_continuation_authorizations
  where project_id=m.project_id for update;
 if a.id is null then return new;end if;
 if a.revoked_at is not null or a.deadline<=clock_timestamp()
 then raise exception 'Task 4A owner grant expired or revoked';end if;
 if new.project_continuation_id is not null then
  if new.project_continuation_id is distinct from a.id
   or new.project_reserved_microusd is null
   or jsonb_typeof(new.project_pricing_evidence) is distinct from 'object'
  then raise exception 'Task 4A canonical ledger mismatch';end if;
  return new;
 end if;
 if j.role<>'development' or m.project_kind<>'development'
 then raise exception 'Task 4A unmetered project call denied';end if;
 select * into g from public.benchmark_execution_grants
  where id=new.lease and mission_assignment_id=j.id and project_id=m.project_id
   and developer_approval_id is not null;
 select * into approval from public.benchmark_native_spending_approvals
  where id=g.developer_approval_id;
 if g.id is null or approval.id is null
  or approval.developer_authority->>'task4aContinuationId' is distinct from a.id::text
  or approval.task_id is distinct from j.id
  or approval.revoked_at is not null or approval.deadline<=clock_timestamp()
  or approval.consumed_at is null
  or not public.developer_gateway_execution_live(g.token_digest,g.project_id,g.execution_epoch)
 then raise exception 'Task 4A native grant mismatch';end if;
 if new.model is distinct from 'gpt-5.3-codex'
  or 'openai:gpt-5.3-codex'<>all(a.allowed_models)
 then raise exception 'Task 4A native model denied';end if;
 select * into price from public.model_registry
 where provider_name='openai' and model_id='gpt-5.3-codex';
 if price.is_active is distinct from true or price.pricing_status is distinct from 'verified'
  or price.pricing_verified_at is null
  or price.pricing_verified_at not between now()-interval '24 hours' and now()
  or price.pricing_input_per_1m<=0 or price.pricing_output_per_1m<=0
  or price.source_metadata->>'pricing_verification_source'
   is distinct from 'https://developers.openai.com/api/docs/models/gpt-5.3-codex'
 then raise exception 'Task 4A native pricing unverified';end if;
 select coalesce(sum(greatest(c.actual_tokens,c.reserved_tokens)),0),
        count(*),coalesce(sum(c.project_reserved_microusd),0)
  into used_tokens,used_calls,used_money
 from public.mission_calls c where c.project_continuation_id=a.id;
 if exists(select 1 from public.mission_calls c
   join public.mission_assignments prior on prior.id=c.job_id
   where c.project_continuation_id=a.id
    and (c.status<>'completed' or c.actual_tokens>c.reserved_tokens
      or c.project_actual_microusd>c.project_reserved_microusd
      or (prior.role='development' and c.project_provider_request_id is null)))
 then raise exception 'Task 4A unresolved or overrun native usage';end if;
 held_money:=ceil(new.reserved_tokens*
   greatest(price.pricing_input_per_1m,price.pricing_output_per_1m)*1.65);
 if used_tokens+new.reserved_tokens+a.assessment_reserve_tokens+
       a.completion_reserve_tokens>a.incremental_tokens
   or used_calls+1+a.assessment_reserve_calls+
       a.completion_reserve_calls>a.incremental_calls
   or used_money+held_money>a.incremental_microusd
 then raise exception 'Task 4A native capacity or protected reserve exhausted';end if;
 new.project_continuation_id:=a.id;
 new.project_reserved_microusd:=held_money;
 new.project_pricing_evidence:=jsonb_build_object(
  'source',price.source_metadata->>'pricing_verification_source',
  'verifiedAt',price.pricing_verified_at,'model','openai:gpt-5.3-codex',
  'inputPerMillionUsd',price.pricing_input_per_1m,
  'outputPerMillionUsd',price.pricing_output_per_1m,
  'upperBoundMultiplier',1.65,'phase','development',
  'taskId',j.id,'grantId',g.id);
 return new;
end $$;
create trigger task4a_native_mission_call_guard before insert
 on public.mission_calls for each row
 execute function public.task4a_bind_native_mission_call();

create or replace function public.task4a_native_live(
 p_digest text,p_project uuid,p_epoch bigint
) returns boolean language plpgsql security invoker set search_path=public as $$
declare g public.benchmark_execution_grants;a public.benchmark_native_spending_approvals;
 owner_grant public.project_continuation_authorizations;
begin
 if public.developer_gateway_execution_live(p_digest,p_project,p_epoch) is distinct from true
 then return false;end if;
 select * into g from public.benchmark_execution_grants where token_digest=p_digest
  and project_id=p_project and execution_epoch=p_epoch
  and developer_approval_id is not null;
 select * into a from public.benchmark_native_spending_approvals where id=g.developer_approval_id;
 select * into owner_grant from public.project_continuation_authorizations
  where project_id=p_project and id=(a.developer_authority->>'task4aContinuationId')::uuid;
 return owner_grant.id is not null and owner_grant.revoked_at is null
  and owner_grant.deadline>clock_timestamp()
  and public.task4a_native_authority_ready(p_project,a.task_id,owner_grant.id);
exception when invalid_text_representation then return false;
end $$;

-- No new ledger: old Developer native reserve inserts its linked mission_call
-- and native operation; the above trigger enforces Task4A at the same insert.
create or replace function public.task4a_native_reserve(
 p_digest text,p_project uuid,p_epoch bigint,p_request_key text,p_model text,p_tokens bigint
) returns uuid language plpgsql security invoker set search_path=public as $$
declare operation uuid;bound uuid;
begin
 if public.task4a_native_live(p_digest,p_project,p_epoch) is distinct from true
 then raise exception 'Task 4A native execution not authorized';end if;
 operation:=public.developer_native_reserve(
  p_digest,p_project,p_epoch,p_request_key,p_model,p_tokens);
 select project_continuation_id into bound from public.mission_calls
  where id=p_request_key::uuid;
 if bound is null then raise exception 'Task 4A canonical financial hold missing';end if;
 return operation;
end $$;

-- The existing linked receipt is settled in the SAME PostgreSQL transaction
-- as Task4A receipt identity and cost. Error/ambiguity rolls both back.
create or replace function public.task4a_native_reconcile_provider_usage(
 p_call uuid,p_provider_request text,p_usage jsonb,p_linked boolean default true
) returns text language plpgsql security invoker set search_path=public as $$
declare c public.mission_calls;b public.benchmark_budget_calls;
 a public.project_continuation_authorizations;settled text;actual_money numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if p_linked is distinct from true or coalesce(length(p_provider_request),0) not between 8 and 300
 then raise exception 'Task 4A authoritative linked receipt required';end if;
 select * into c from public.mission_calls where id=p_call for update;
 select * into b from public.benchmark_budget_calls where legacy_mission_call_id=p_call for update;
 select * into a from public.project_continuation_authorizations
  where id=c.project_continuation_id for update;
 if c.id is null or b.id is null or a.id is null
  or a.revoked_at is not null and c.status='reserved'
  or c.project_pricing_evidence->>'model' is distinct from 'openai:gpt-5.3-codex'
  or c.project_provider_request_id is not null and c.project_provider_request_id<>p_provider_request
  or c.project_provider_usage is not null and c.project_provider_usage<>p_usage
 then raise exception 'Task 4A native receipt association denied';end if;
 settled:=public.benchmark_reconcile_provider_usage(p_call,p_provider_request,p_usage,true);
 select * into c from public.mission_calls where id=p_call for update;
 select * into b from public.benchmark_budget_calls where legacy_mission_call_id=p_call for update;
 if b.provider_request_id is distinct from p_provider_request or b.provider_usage is distinct from p_usage
  or c.actual_tokens is distinct from (p_usage->>'total_tokens')::integer
 then raise exception 'Task 4A provider receipt reconciliation mismatch';end if;
 actual_money:=ceil((p_usage->>'input_tokens')::numeric*
    (c.project_pricing_evidence->>'inputPerMillionUsd')::numeric+
    (p_usage->>'output_tokens')::numeric*
    (c.project_pricing_evidence->>'outputPerMillionUsd')::numeric);
 update public.mission_calls set
  project_provider_request_id=coalesce(project_provider_request_id,p_provider_request),
  project_provider_usage=coalesce(project_provider_usage,p_usage),
  project_actual_microusd=coalesce(project_actual_microusd,actual_money)
 where id=p_call;
 return settled;
end $$;

revoke all on function public.task4a_native_authority_ready(uuid,uuid,uuid),
 public.task4a_prepare_native_development(uuid,uuid,text,text,text),
 public.task4a_bind_native_mission_call(),
 public.task4a_native_live(text,uuid,bigint),
 public.task4a_native_reserve(text,uuid,bigint,text,text,bigint),
 public.task4a_native_reconcile_provider_usage(uuid,text,jsonb,boolean)
 from public,anon,authenticated;
grant execute on function public.task4a_native_authority_ready(uuid,uuid,uuid),
 public.task4a_prepare_native_development(uuid,uuid,text,text,text),
 public.task4a_native_live(text,uuid,bigint),
 public.task4a_native_reserve(text,uuid,bigint,text,text,bigint),
 public.task4a_native_reconcile_provider_usage(uuid,text,jsonb,boolean)
 to service_role;
