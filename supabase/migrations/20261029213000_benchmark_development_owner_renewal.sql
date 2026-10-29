-- A new owner authorization for the SAME development task. Historical deadlines,
-- approvals, grants, calls, attempts and receipts are never reset.
create table public.benchmark_development_renewals(
 id uuid primary key default gen_random_uuid(),
 continuation_id uuid not null unique references benchmark_full_continuations(id),
 approval_id uuid not null unique references benchmark_native_spending_approvals(id),
 previous_approval_id uuid not null unique references benchmark_native_spending_approvals(id),
 task_id uuid not null references agent_tasks(id),
 mission_id uuid not null references agent_missions(id),
 scope_hash text not null,
 prior_run bigint not null,
 receipt jsonb not null,
 created_at timestamptz not null default now()
);
create table public.benchmark_development_renewal_dispatches(
 renewal_id uuid primary key references benchmark_development_renewals(id),
 release_sha text not null check(release_sha ~ '^[a-f0-9]{40}$'),
 created_at timestamptz not null default now()
);
create table public.benchmark_development_renewal_grants(
 renewal_id uuid primary key references benchmark_development_renewals(id),
 grant_id uuid not null unique references benchmark_execution_grants(id),
 created_at timestamptz not null default now()
);
alter table benchmark_development_renewals enable row level security;
alter table benchmark_development_renewal_dispatches enable row level security;
alter table benchmark_development_renewal_grants enable row level security;
revoke all on benchmark_development_renewals,benchmark_development_renewal_dispatches,benchmark_development_renewal_grants from public,anon,authenticated;
grant select,insert on benchmark_development_renewals,benchmark_development_renewal_dispatches,benchmark_development_renewal_grants to service_role;
alter table benchmark_full_continuations drop constraint benchmark_continuation_bounded_plan;
alter table benchmark_full_continuations add constraint benchmark_continuation_bounded_plan check(
 (previous_continuation_id is null and additional_token_cap=270000) or
 (previous_continuation_id is not null and additional_token_cap=240000 and coalesce(plan->>'kind','specification')='specification') or
 (previous_continuation_id is not null and plan->>'kind'='development-renewal' and additional_token_cap between 1 and 180000
 and additional_token_cap=(plan->>'developmentRemainingTokens')::integer+(plan->>'assessmentTokens')::integer));

-- A scoped overlay, rather than changing the expired mission's original deadline.
create function benchmark_development_renewal_matches(p_mission uuid,p_continuation uuid)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from benchmark_development_renewals r
 join benchmark_full_continuations c on c.id=r.continuation_id
 join benchmark_native_spending_approvals a on a.id=r.approval_id
 join agent_missions m on m.id=r.mission_id
 join work_projects p on p.id=m.project_id
 where r.mission_id=p_mission and r.continuation_id=p_continuation
 and c.project_id=p.id and c.source_mission_id=m.id and c.plan->>'kind'='development-renewal'
 and a.task_id=r.task_id and a.mission_assignment_id=r.task_id and a.project_id=p.id
 and a.continuation_id=c.id and a.revoked_at is null and a.deadline=c.deadline
 and p.active_mission_id=m.id and p.phase='development' and m.project_kind='development'
 and p.approved_hash=r.scope_hash and p.approval_hash=r.scope_hash
 and benchmark_continuation_live(c.id,c.account_id,p.id));
$$;
create function benchmark_effective_mission_deadline(p_mission uuid)
returns timestamptz language sql stable security invoker set search_path=public as $$
 select coalesce((select c.deadline from benchmark_development_renewals r
 join benchmark_full_continuations c on c.id=r.continuation_id
 where r.mission_id=m.id and benchmark_development_renewal_matches(m.id,c.id)
 order by r.created_at desc limit 1),m.deadline) from agent_missions m where m.id=p_mission;
$$;
revoke all on function benchmark_development_renewal_matches(uuid,uuid),benchmark_effective_mission_deadline(uuid) from public,anon,authenticated;
grant execute on function benchmark_development_renewal_matches(uuid,uuid),benchmark_effective_mission_deadline(uuid) to service_role;

alter function benchmark_dashboard_continuation(uuid,uuid,text,boolean) rename to benchmark_dashboard_specification_continuation;
create function benchmark_dashboard_continuation(p_owner uuid,p_project uuid default null,p_plan_hash text default null,p_approve boolean default false)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare q benchmark_production_qualifications; p work_projects; m agent_missions; j mission_assignments; task agent_tasks;
 a benchmark_budget_accounts; c benchmark_full_continuations; prior benchmark_full_continuations;
 old benchmark_native_spending_approvals; fresh benchmark_native_spending_approvals; b benchmark_full_project_bindings;
 dispatch benchmark_development_dispatches; t benchmark_three_arm_trials; renewal benchmark_development_renewals;
 snapshot jsonb; snapshot_hash text; plan jsonb; hash text; remaining bigint; total bigint; eligible boolean;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into q from benchmark_production_qualifications where issue=715 for update;
 if not found and not p_approve then return null;end if;
 if p_owner is null or q.owner_id is distinct from p_owner or q.revoked_at is not null then raise exception 'Authenticated original owner required';end if;
 select * into t from benchmark_three_arm_trials where experiment_id=q.experiment_id and arm='full' and replicate=2 for update;
 select * into b from benchmark_full_project_bindings where trial_id=t.id;
 select * into p from work_projects where id=b.project_id for update;
 if p.phase is distinct from 'development' then return benchmark_dashboard_specification_continuation(p_owner,p_project,p_plan_hash,p_approve);end if;
 select * into prior from benchmark_full_continuations where project_id=p.id order by created_at desc,id desc limit 1;
 select * into a from benchmark_budget_accounts where id=b.account_id for update;
 if prior.id is null then raise exception 'Existing Full continuation required';end if;
 if prior.deadline>now() or (p_approve and p_project=prior.project_id and p_plan_hash=prior.plan_hash) then
  if p_approve and (p_project is distinct from prior.project_id or p_plan_hash is distinct from prior.plan_hash) then raise exception 'Continuation identity differs';end if;
  return jsonb_build_object('approved',true,'id',prior.id,'projectId',p.id,'trialId',t.id,'accountId',a.id,'deadline',prior.deadline,
   'planHash',prior.plan_hash,'plan',prior.plan,'spentTokens',a.spent_tokens,'live',benchmark_continuation_live(prior.id,a.id,p.id),'sourceSnapshotHash',prior.source_snapshot_hash);
 end if;
 select * into m from agent_missions where id=p.active_mission_id for update;
 select * into j from mission_assignments where mission_id=m.id and role='development' order by created_at desc,id desc limit 1 for update;
 select * into task from agent_tasks where id=j.id for update;
 select * into old from benchmark_native_spending_approvals where task_id=task.id order by created_at desc,id desc limit 1 for update;
 select * into dispatch from benchmark_development_dispatches where task_id=task.id;
 remaining:=m.token_allowance-greatest(m.actual_tokens,m.reserved_tokens);
 total:=remaining+60000;
 eligible:=p.status='blocked' and m.status='blocked' and m.project_kind='development' and m.project_id=p.id
 and j.status='failed' and task.status='blocked' and task.kind='development' and task.external->>'attempted'='true'
 and old.id is not null and old.consumed_at is not null and old.revoked_at is null and old.deadline<=now()
 and old.continuation_id=prior.id and old.project_id=p.id and old.account_id=a.id and old.trial_id=t.id
 and old.mission_assignment_id=j.id and old.actor_id=p.actor_id and old.chat_id=p.chat_id
 and benchmark_full_task_provenance(task.id,p.id)
 and p.approved_hash is not null and p.approved_hash=p.approval_hash
 and exists(select 1 from project_runs where mission_id=m.id and binding->>'scopeHash'=p.approved_hash)
 and j.payload->>'approved'='true' and p.actor_id=q.actor_id and p.deadline>now()+interval '4 hours'
 and (p.lease is null or p.lease_until<=now()) and m.calls<m.max_calls and m.token_allowance=120000
 and remaining>0 and total<=180000 and a.spent_tokens+total<=a.cap_tokens and a.cap_tokens=350000 and a.frozen_at is null
 and a.arm='full' and a.trial_id=t.id and a.owner_actor_id=q.actor_id
 and (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)+total<=p.token_allowance
 and p.token_allowance<=350000 and (select count(*) from project_runs where project_id=p.id)+1<=p.max_missions
 and dispatch.status='qualified' and dispatch.trial_id=t.id and dispatch.baseline_sha=t.baseline_sha
 and dispatch.benchmark_contract_hash=t.contract_sha256 and b.model='gpt-5.3-codex'
 and t.baseline_sha='0015bcdb8ac9ad94b7c74d1a4cd76737903b1319' and old.model=b.model and old.repository='mfackrell/katie'
 and task.external->'receipt'->>'outcome'='BLOCKED' and task.external->'receipt'->>'repository'='mfackrell/katie'
 and task.external->'receipt'->>'issue_number'=task.external->>'issueNumber'
 and task.external->'receipt'->>'run_id' ~ '^[0-9]+$'
 and task.external->'receipt'->>'pr_url' is null and task.external->'receipt'->>'tested_head_sha' is null
 and task.external->'receipt'->>'reviewed_head_sha' is null
 and task.external->'receipt'->'checks'='{"build":"failure","test":"","review":"","repair":"skipped","retest":"","final_review":""}'::jsonb
 and not exists(select 1 from benchmark_budget_calls where account_id=a.id and (state<>'settled' or actual_tokens is null))
 and (select coalesce(sum(actual_tokens),0) from benchmark_budget_calls where account_id=a.id)=a.spent_tokens
 and not exists(select 1 from benchmark_execution_grants where account_id=a.id and deadline>now() and revoked_at is null and stopped_at is null)
 and not exists(select 1 from agent_missions where project_id=p.id and status in ('running','awaiting_approval'));
 if eligible is distinct from true then
  if p_approve then raise exception 'Saved development checkpoint is not eligible for renewal';end if;
  return jsonb_build_object('approved',true,'id',prior.id,'projectId',p.id,'trialId',t.id,'accountId',a.id,'deadline',prior.deadline,'planHash',prior.plan_hash,'plan',prior.plan,'spentTokens',a.spent_tokens,'live',false,'sourceSnapshotHash',prior.source_snapshot_hash);
 end if;
 snapshot:=jsonb_build_object('trial',to_jsonb(t),'qualification',to_jsonb(q),'project',to_jsonb(p),'mission',to_jsonb(m),'assignment',to_jsonb(j),'task',to_jsonb(task),
  'approval',to_jsonb(old),'previousContinuation',to_jsonb(prior),'account',to_jsonb(a),'dispatch',to_jsonb(dispatch),
  'calls',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from benchmark_budget_calls x where account_id=a.id),
  'grants',(select coalesce(jsonb_agg(to_jsonb(g) order by id),'[]') from benchmark_execution_grants g where mission_assignment_id=j.id));
 snapshot_hash:=encode(sha256(convert_to(project_canonical(snapshot),'UTF8')),'hex');
 plan:=jsonb_build_object('version',3,'kind','development-renewal','issue',715,'sourceIssue',650,'projectId',p.id,'trialId',t.id,'accountId',a.id,
  'taskId',task.id,'missionId',m.id,'scopeHash',p.approved_hash,'previousApprovalId',old.id,'previousContinuationId',prior.id,
  'priorRun',(task.external->'receipt'->>'run_id')::bigint,'baselineSha',t.baseline_sha,'model',b.model,'additionalTokenCap',total,
  'existingAccountTokenCap',350000,'remainingAccountTokens',350000-a.spent_tokens,'existingArmUsdCents',1000,'newFunds',0,'durationSeconds',14400,
  'specificationTokens',0,'developmentTokens',120000,'developmentSpentTokens',greatest(m.actual_tokens,m.reserved_tokens),
  'developmentRemainingTokens',remaining,'assessmentTokens',60000,'sourceSnapshotHash',snapshot_hash,'frozenRequirements',true,
  'repeatResearch',false,'regenerateSpecification',false,'scopeApprovalPreserved',true,'taskApprovalPreserved',true,'productionPublication',false);
 hash:=encode(sha256(convert_to(project_canonical(plan),'UTF8')),'hex');
 if p_approve then
  if p_project is distinct from p.id or p_plan_hash is distinct from hash then raise exception 'Review current development renewal plan';end if;
  insert into benchmark_full_continuations(owner_id,project_id,trial_id,account_id,source_mission_id,source_snapshot,source_snapshot_hash,plan,plan_hash,spent_at_approval,additional_token_cap,deadline,previous_continuation_id)
   values(p_owner,p.id,t.id,a.id,m.id,snapshot,snapshot_hash,plan,hash,a.spent_tokens,total,now()+interval '4 hours',prior.id) returning * into c;
  insert into benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,continuation_id)
   values(old.owner_id,old.actor_id,old.chat_id,old.trial_id,old.account_id,old.repository,old.model,old.protocol_digest,old.max_tokens,c.deadline,p.id,j.id,task.id,c.id) returning * into fresh;
  insert into benchmark_development_renewals(continuation_id,approval_id,previous_approval_id,task_id,mission_id,scope_hash,prior_run,receipt)
   values(c.id,fresh.id,old.id,task.id,m.id,p.approved_hash,(task.external->'receipt'->>'run_id')::bigint,task.external->'receipt') returning * into renewal;
  update benchmark_execution_grants set stopped_at=coalesce(stopped_at,now()) where mission_assignment_id=j.id;
  update agent_tasks set status='dispatching',external=external||jsonb_build_object('developmentRenewalId',renewal.id),updated_at=now() where id=task.id;
  update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),updated_at=now() where id=j.id;
  update agent_missions set status='running',updated_at=now() where id=m.id;
  update work_projects set status='running',lease=null,lease_until=null,impediment=null,detail='Owner renewed the same approved development task. Original deadlines, attempts and charges remain preserved.',updated_at=now() where id=p.id;
  insert into project_events(project_id,event,data) values(p.id,'benchmark_development_owner_renewed',jsonb_build_object('renewalId',renewal.id,'continuationId',c.id,'taskId',task.id,'previousApprovalId',old.id,'approvalId',fresh.id,'planHash',hash,'deadline',c.deadline));
 end if;
 return jsonb_build_object('approved',p_approve,'id',c.id,'projectId',p.id,'trialId',t.id,'accountId',a.id,'deadline',c.deadline,'planHash',hash,'plan',plan,'spentTokens',a.spent_tokens,'live',p_approve,'sourceSnapshotHash',snapshot_hash);
end $$;
revoke all on function benchmark_dashboard_continuation(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function benchmark_dashboard_continuation(uuid,uuid,text,boolean) to service_role;

create function benchmark_effective_mission_continuation(p_mission uuid)
returns uuid language sql stable security invoker set search_path=public as $$
 select coalesce((select r.continuation_id from benchmark_development_renewals r
 where r.mission_id=m.id and benchmark_development_renewal_matches(m.id,r.continuation_id)
 order by r.created_at desc limit 1),nullif(m.project_evidence->>'benchmarkContinuationId','')::uuid)
 from agent_missions m where m.id=p_mission;
$$;
revoke all on function benchmark_effective_mission_continuation(uuid) from public,anon,authenticated;
grant execute on function benchmark_effective_mission_continuation(uuid) to service_role;

-- Existing mission/account limits remain cumulative. Only explicitly linked owner
-- renewals can supply a later execution window or continuation association.
do $patch$
declare body text; original text; signature text;
begin
 foreach signature in array array[
 'public.mission_call_capacity(uuid,uuid)','public.mission_development_task(uuid,uuid)',
 'public.checkpoint_mission_operational_evidence(uuid,uuid,jsonb)',
 'public.checkpoint_mission_review_model(uuid,uuid,text,jsonb)',
 'public.try_reserve_mission_capacity(uuid,uuid,uuid,text,integer,boolean)',
 'public.benchmark_reserve_mission_call(uuid,uuid,uuid,text,integer,boolean)',
 'public.benchmark_dashboard_full_task(uuid,uuid,text,boolean)',
 'public.claim_mission_work()','public.commit_mission_work(uuid,uuid,jsonb,jsonb,text,text,text)',
 'public.benchmark_full_native_reserve(text,uuid,bigint,text,text,bigint)',
 'public.benchmark_issue_execution_grant(uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamp with time zone,text)',
 'public.benchmark_production_call_guard()'] loop
  select pg_get_functiondef(signature::regprocedure) into body;
  original:=body;
  body:=replace(body,'m.deadline','benchmark_effective_mission_deadline(m.id)');
  if signature like 'public.benchmark_reserve_mission_call%' then
   body:=replace(body,$a$nullif(m.project_evidence->>'benchmarkContinuationId','')::uuid$a$,'benchmark_effective_mission_continuation(m.id)');
  elsif signature='public.claim_mission_work()' then
   body:=replace(body,$a$where status in ('running','awaiting_approval') and deadline<=now();$a$,
    $a$where status in ('running','awaiting_approval') and benchmark_effective_mission_deadline(id)<=now();$a$);
   body:=replace(body,$a$'mission',to_jsonb(m)$a$,$a$'mission',to_jsonb(m)||jsonb_build_object('deadline',benchmark_effective_mission_deadline(m.id))$a$);
  elsif signature like 'public.benchmark_full_native_reserve%' then
   body:=replace(body,$a$if g.continuation_id::text is distinct from m.project_evidence->>'benchmarkContinuationId' then$a$,
    $a$if g.continuation_id::text is distinct from m.project_evidence->>'benchmarkContinuationId' and not benchmark_development_renewal_matches(m.id,g.continuation_id) then$a$);
  elsif signature like 'public.benchmark_issue_execution_grant%' then
   body:=replace(body,$a$if a.continuation_id::text is distinct from m.project_evidence->>'benchmarkContinuationId' then$a$,
    $a$if a.continuation_id::text is distinct from m.project_evidence->>'benchmarkContinuationId' and not benchmark_development_renewal_matches(m.id,a.continuation_id) then$a$);
  elsif signature='public.benchmark_production_call_guard()' then
   body:=replace(body,'  phase_cap:=case m.project_kind', $a$  if c.plan->>'kind'='development-renewal' and m.project_kind='development' and not benchmark_development_renewal_matches(m.id,c.id) then raise exception 'Renewal permits only the preserved development mission';end if;
  phase_cap:=case m.project_kind$a$);
   body:=replace(body,$a$m.id=c.source_mission_id$a$,$a$(m.id=c.source_mission_id and not benchmark_development_renewal_matches(m.id,c.id))$a$);
   body:=replace(body,$a$m.project_evidence->>'benchmarkContinuationId' is distinct from c.id::text$a$,
    $a$(m.project_evidence->>'benchmarkContinuationId' is distinct from c.id::text and not benchmark_development_renewal_matches(m.id,c.id))$a$);
   body:=replace(body,$a$m.created_at<c.created_at$a$,$a$(m.created_at<c.created_at and not benchmark_development_renewal_matches(m.id,c.id))$a$);
  end if;
  if body=original then raise exception 'Expected renewal deadline integration missing: %',signature;end if;
  execute body;
 end loop;
end $patch$;

create function benchmark_claim_development_renewal_dispatch(p_renewal uuid,p_receipt jsonb,p_release text)
returns boolean language plpgsql security invoker set search_path=public as $$
declare r benchmark_development_renewals;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into r from benchmark_development_renewals where id=p_renewal;
 if r.id is null or r.receipt is distinct from p_receipt or p_release is null or p_release !~ '^[a-f0-9]{40}$'
 or not benchmark_development_renewal_matches(r.mission_id,r.continuation_id)
 or not exists(select 1 from agent_tasks where id=r.task_id and status='dispatching' and external->>'developmentRenewalId'=r.id::text and external->'receipt'=r.receipt)
 or not exists(select 1 from benchmark_native_spending_approvals where id=r.approval_id and consumed_at is null and revoked_at is null and deadline>now()) then return false;end if;
 insert into benchmark_development_renewal_dispatches(renewal_id,release_sha) values(r.id,p_release) on conflict do nothing;
 if not found then return false;end if;
 update agent_tasks set external=external||jsonb_build_object('developmentRenewalSince',now(),'developmentRenewalRelease',p_release),updated_at=now() where id=r.task_id;
 return true;
end $$;
create function benchmark_issue_development_renewal_grant(p_renewal uuid,p_digest text,p_approval uuid,p_task uuid,p_release text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare r benchmark_development_renewals; a benchmark_native_spending_approvals; n uuid; epoch bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into r from benchmark_development_renewals where id=p_renewal;
 select * into a from benchmark_native_spending_approvals where id=r.approval_id for update;
 if r.id is null or r.approval_id is distinct from p_approval or r.task_id is distinct from p_task
 or not benchmark_development_renewal_matches(r.mission_id,r.continuation_id)
 or not exists(select 1 from benchmark_development_renewal_dispatches where renewal_id=r.id and release_sha=p_release)
 or exists(select 1 from benchmark_development_renewal_grants where renewal_id=r.id)
 or not exists(select 1 from agent_tasks where id=r.task_id and external->>'developmentRenewalId'=r.id::text)
 or exists(select 1 from benchmark_budget_calls where account_id=a.account_id and state<>'settled') then
 raise exception 'Owner development renewal unavailable';end if;
 select coalesce(max(execution_epoch),0)+1 into epoch from benchmark_execution_grants where trial_id=a.trial_id;
 n:=benchmark_issue_execution_grant(a.owner_id,a.actor_id,a.chat_id,a.trial_id,a.id,a.repository,a.model,epoch,a.deadline,p_digest);
 insert into benchmark_development_renewal_grants(renewal_id,grant_id) values(r.id,n);
 return jsonb_build_object('grantId',n,'executionEpoch',epoch);
end $$;
revoke all on function benchmark_claim_development_renewal_dispatch(uuid,jsonb,text),benchmark_issue_development_renewal_grant(uuid,text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function benchmark_claim_development_renewal_dispatch(uuid,jsonb,text),benchmark_issue_development_renewal_grant(uuid,text,uuid,uuid,text) to service_role;
