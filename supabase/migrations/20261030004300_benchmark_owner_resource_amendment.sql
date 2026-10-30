-- Explicit owner amendment; GET never opens authority. Original limits and usage stay intact.
create table benchmark_development_resource_amendments(
 id uuid primary key default gen_random_uuid(),project_id uuid not null unique references work_projects(id),
 task_id uuid not null unique references agent_tasks(id),mission_id uuid not null unique references agent_missions(id),
 successor_id uuid not null unique references benchmark_development_paid_successors(id),
 old_grant_id uuid not null unique references benchmark_execution_grants(id),
 renewal_id uuid not null unique references benchmark_development_renewals(id),
 approval_id uuid not null unique references benchmark_native_spending_approvals(id),
 continuation_id uuid not null unique references benchmark_full_continuations(id),
 failed_run bigint not null,receipt jsonb not null,release_sha text not null check(release_sha~'^[a-f0-9]{40}$'),
 runtime_version text not null check(runtime_version='provider-input-count-v1'),
 development_limit integer not null check(development_limit=170000),call_limit integer not null check(call_limit=24),
 deadline timestamptz not null,plan_hash text not null,source_snapshot jsonb not null,source_snapshot_hash text not null,
 created_at timestamptz not null default now());
create table benchmark_development_amendment_dispatches(amendment_id uuid primary key references benchmark_development_resource_amendments(id),created_at timestamptz not null default now());
create table benchmark_development_amendment_grants(amendment_id uuid primary key references benchmark_development_resource_amendments(id),grant_id uuid not null unique references benchmark_execution_grants(id),created_at timestamptz not null default now());
alter table benchmark_development_resource_amendments enable row level security;
alter table benchmark_development_amendment_dispatches enable row level security;
alter table benchmark_development_amendment_grants enable row level security;
revoke all on benchmark_development_resource_amendments,benchmark_development_amendment_dispatches,benchmark_development_amendment_grants from public,anon,authenticated,service_role;
grant select,insert on benchmark_development_resource_amendments,benchmark_development_amendment_dispatches,benchmark_development_amendment_grants to service_role;
-- Only the explicitly identified resource amendment may inherit a shorter existing deadline.
alter table benchmark_full_continuations drop constraint benchmark_full_continuations_check;
alter table benchmark_full_continuations add constraint benchmark_full_continuations_check check((
 (coalesce(plan->>'resourceAmendment','false')<>'true' and deadline=created_at+interval '4 hours') or
 (plan->>'resourceAmendment'='true' and previous_continuation_id is not null and deadline>created_at and deadline<=created_at+interval '4 hours' and deadline=(plan->>'deadline')::timestamptz)) is true);
create function benchmark_effective_mission_allowance(p_mission uuid,p_continuation uuid)
returns bigint language sql stable security invoker set search_path=public as $$
 select coalesce((select a.development_limit from benchmark_development_resource_amendments a
 join benchmark_full_continuations c on c.id=a.continuation_id
 where a.mission_id=m.id and a.continuation_id=p_continuation and a.deadline=c.deadline and a.plan_hash=c.plan_hash
 and c.plan->>'resourceAmendment'='true' and benchmark_development_renewal_matches(m.id,c.id)),m.token_allowance)
 from agent_missions m where m.id=p_mission;
$$;
create function benchmark_effective_mission_call_limit(p_mission uuid,p_continuation uuid)
returns integer language sql stable security invoker set search_path=public as $$
 select coalesce((select a.call_limit from benchmark_development_resource_amendments a
 join benchmark_full_continuations c on c.id=a.continuation_id
 where a.mission_id=m.id and a.continuation_id=p_continuation and a.deadline=c.deadline and a.plan_hash=c.plan_hash
 and c.plan->>'resourceAmendment'='true' and benchmark_development_renewal_matches(m.id,c.id)),m.max_calls)
 from agent_missions m where m.id=p_mission;
$$;
-- The native path supplies its exact grant continuation. Generic capacity views
-- use the mission's live continuation; stopped old native grants never inherit it.
do $$ declare signature text;body text;context text;begin
 foreach signature in array array['benchmark_full_native_reserve(text,uuid,bigint,text,text,bigint)',
 'try_reserve_mission_capacity(uuid,uuid,uuid,text,integer,boolean)','mission_call_capacity(uuid,uuid)'] loop
  select pg_get_functiondef(signature::regprocedure) into body;
  context:=case when signature like 'benchmark_full_native_reserve%' then 'g.continuation_id' else 'benchmark_effective_mission_continuation(m.id)' end;
  if position('m.token_allowance' in body)=0 or position('m.max_calls' in body)=0 then raise exception 'Effective limit integration anchor absent';end if;
  body:=replace(body,'m.token_allowance','benchmark_effective_mission_allowance(m.id,'||context||')');
  body:=replace(body,'m.max_calls','benchmark_effective_mission_call_limit(m.id,'||context||')');execute body;
 end loop;
 select pg_get_functiondef('benchmark_production_call_guard()'::regprocedure) into body;
 if position('m.token_allowance>phase_cap' in body)=0 then raise exception 'Phase allowance anchor absent';end if;
 body:=replace(body,'m.token_allowance>phase_cap','benchmark_effective_mission_allowance(m.id,c.id)>phase_cap');execute body;
end $$;

create function benchmark_dashboard_development_amendment(p_owner uuid,p_project uuid default null,p_plan_hash text default null,p_approve boolean default false,p_release text default null,p_runtime text default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare q benchmark_production_qualifications;p work_projects;m agent_missions;j mission_assignments;t agent_tasks;
 b benchmark_full_project_bindings;acct benchmark_budget_accounts;prior benchmark_full_continuations;c benchmark_full_continuations;
 old benchmark_native_spending_approvals;fresh benchmark_native_spending_approvals;r benchmark_development_renewals;
 s benchmark_development_paid_successors;g benchmark_execution_grants;am benchmark_development_resource_amendments;
 snap jsonb;plan jsonb;hash text;snapshot_hash text;remaining bigint;eligible boolean;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into q from benchmark_production_qualifications where issue=715;
 if p_owner is null or q.owner_id is distinct from p_owner or q.revoked_at is not null then raise exception 'Authenticated original owner required';end if;
 select * into b from benchmark_full_project_bindings where trial_id in(select id from benchmark_three_arm_trials where experiment_id=q.experiment_id and arm='full' and replicate=2);
 select * into p from work_projects where id=b.project_id for update;
 select * into acct from benchmark_budget_accounts where id=b.account_id for update;
 select * into am from benchmark_development_resource_amendments where project_id=p.id;
 if am.id is not null then
  select * into c from benchmark_full_continuations where id=am.continuation_id;
  if p_approve and (p_project is distinct from p.id or p_plan_hash is distinct from c.plan_hash) then raise exception 'Amendment already approved with different plan';end if;
  return jsonb_build_object('approved',true,'id',c.id,'projectId',p.id,'trialId',c.trial_id,'accountId',acct.id,'deadline',c.deadline,'planHash',c.plan_hash,'plan',c.plan,'spentTokens',acct.spent_tokens,'live',benchmark_continuation_live(c.id,acct.id,p.id),'sourceSnapshotHash',c.source_snapshot_hash);
 end if;
 select * into m from agent_missions where id=p.active_mission_id for update;
 select * into j from mission_assignments where mission_id=m.id and role='development' order by created_at desc limit 1 for update;
 select * into t from agent_tasks where id=j.id for update;
 select * into prior from benchmark_full_continuations where project_id=p.id order by created_at desc,id desc limit 1;
 select * into old from benchmark_native_spending_approvals where task_id=t.id order by created_at desc,id desc limit 1 for update;
 select * into s from benchmark_development_paid_successors where id=(t.external->>'paidSuccessorId')::uuid;
 select eg.* into g from benchmark_execution_grants eg join benchmark_development_paid_successor_grants sg on sg.grant_id=eg.id where sg.successor_id=s.id for update of eg;
 remaining:=170000-m.actual_tokens;
 eligible:=p.phase='development' and p.status='blocked' and m.status='blocked' and m.project_kind='development'
 and j.status='failed' and t.status='blocked' and t.kind='development' and j.payload->>'approved'='true'
 and p.actor_id=q.actor_id and p.approved_hash is not null and p.approved_hash=p.approval_hash and benchmark_full_task_provenance(t.id,p.id)
 and exists(select 1 from project_runs where mission_id=m.id and binding->>'scopeHash'=p.approved_hash)
 and old.id is not null and old.owner_id=p_owner and old.consumed_at is not null and old.revoked_at is null
 and old.project_id=p.id and old.account_id=acct.id and old.task_id=t.id and old.mission_assignment_id=j.id and old.continuation_id=prior.id
 and old.actor_id=p.actor_id and old.chat_id=p.chat_id and old.trial_id=b.trial_id
 and old.deadline=prior.deadline and prior.deadline>now() and p.deadline>=prior.deadline
 and prior.plan->>'kind'='development-renewal' and prior.plan->>'developmentTokens'='120000' and prior.plan->>'assessmentTokens'='60000'
 and remaining+60000<=180000 and remaining+60000-(prior.additional_token_cap-(acct.spent_tokens-prior.spent_at_approval))=50000
 and coalesce(prior.plan->>'resourceAmendment','false')='false'
 and benchmark_development_renewal_matches(m.id,prior.id)
 and s.id is not null and s.renewal_id=(t.external->>'developmentRenewalId')::uuid
 and exists(select 1 from benchmark_development_renewals where id=s.renewal_id and approval_id=old.id and continuation_id=prior.id)
 and g.id is not null and g.revoked_at is null and g.stopped_at is null and g.continuation_id=prior.id and g.mission_assignment_id=t.id and g.account_id=acct.id
 and g.deadline=prior.deadline and g.trial_id=old.trial_id and g.owner_actor_id=old.actor_id and g.protocol_digest=old.protocol_digest and g.model='gpt-5.3-codex' and g.repository='mfackrell/katie'
 and exists(select 1 from mission_calls where job_id=t.id and lease=g.id and actual_tokens>0)
 and t.external->'receipt'->>'outcome'='BLOCKED' and t.external->'receipt'->>'repository'='mfackrell/katie'
 and t.external->'receipt'->>'issue_number'=t.external->>'issueNumber' and t.external->'receipt'->>'run_id'~'^[0-9]+$'
 and (t.external->'receipt'->>'run_id')::bigint<>s.failed_run and t.external->>'paidSuccessorRelease'=s.release_sha
 and t.external->'receipt'->>'pr_url' is null and t.external->'receipt'->>'tested_head_sha' is null and t.external->'receipt'->>'reviewed_head_sha' is null
 and t.external->'receipt'->'checks'='{"build":"failure","test":"","review":"","repair":"skipped","retest":"","final_review":""}'::jsonb
 and m.token_allowance=120000 and m.max_calls=12 and m.calls<24 and m.actual_tokens=m.reserved_tokens and remaining>0
 and m.calls=(select count(*) from mission_calls where job_id=t.id)
 and m.actual_tokens=(select coalesce(sum(actual_tokens),0) from mission_calls where job_id=t.id)
 and not exists(select 1 from mission_calls where job_id=t.id and (status<>'completed' or actual_tokens is null))
 and acct.frozen_at is null and acct.cap_tokens=350000 and acct.spent_tokens+remaining+60000<=350000
 and (select coalesce(sum(actual_tokens),0) from benchmark_budget_calls where account_id=acct.id)=acct.spent_tokens
 and not exists(select 1 from benchmark_budget_calls where account_id=acct.id and (state<>'settled' or actual_tokens is null))
 and not exists(select 1 from benchmark_execution_grants where account_id=acct.id and id<>g.id and stopped_at is null and revoked_at is null and deadline>now())
 and not exists(select 1 from agent_missions where project_id=p.id and status in ('running','awaiting_approval'))
 and (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)+remaining+60000<=p.token_allowance
 and p.token_allowance<=350000 and (p.lease is null or p.lease_until<=now()) and (j.lease is null or j.lease_until<=now())
 and p_release~'^[a-f0-9]{40}$' and p_release<>s.release_sha and p_runtime='provider-input-count-v1'
 and exists(select 1 from model_registry where provider_name='openai' and model_id='gpt-5.3-codex' and pricing_status='verified' and pricing_verified_at>now()-interval '24 hours' and pricing_verified_at<=now() and pricing_input_per_1m between 0.000001 and 28 and pricing_output_per_1m between 0.000001 and 28);
 if eligible is distinct from true then if p_approve then raise exception 'Current amendment checkpoint unavailable';end if;return null;end if;
 snap:=jsonb_build_object('trial',(select to_jsonb(tr) from benchmark_three_arm_trials tr where id=b.trial_id),'qualification',to_jsonb(q),'binding',to_jsonb(b),'project',to_jsonb(p),'mission',to_jsonb(m),'assignment',to_jsonb(j),'task',to_jsonb(t),'account',to_jsonb(acct),
 'previousContinuation',to_jsonb(prior)-'source_snapshot','approval',to_jsonb(old),'oldGrant',to_jsonb(g)-'token_digest',
 'successor',to_jsonb(s)-'source_snapshot',
 'continuations',(select jsonb_agg(to_jsonb(x)-'source_snapshot' order by created_at,id) from benchmark_full_continuations x where account_id=acct.id),
 'approvals',(select jsonb_agg(to_jsonb(x) order by created_at,id) from benchmark_native_spending_approvals x where account_id=acct.id),
 'grants',(select jsonb_agg(to_jsonb(x)-'token_digest' order by created_at,id) from benchmark_execution_grants x where account_id=acct.id),
 'calls',(select jsonb_agg(to_jsonb(x) order by created_at,id) from benchmark_budget_calls x where account_id=acct.id));
 snapshot_hash:=encode(sha256(convert_to(project_canonical(snap),'UTF8')),'hex');
 plan:=jsonb_build_object('version',4,'kind','development-renewal','resourceAmendment',true,'issue',715,'sourceIssue',650,
 'projectId',p.id,'taskId',t.id,'missionId',m.id,'trialId',b.trial_id,'accountId',acct.id,'scopeHash',p.approved_hash,'baselineSha',b.baseline_sha,'model',b.model,
 'priorRun',(t.external->'receipt'->>'run_id')::bigint,'previousApprovalId',old.id,'previousContinuationId',prior.id,'paidSuccessorId',s.id,'oldGrantId',g.id,
 'sourceSnapshotHash',snapshot_hash,'releaseSha',p_release,'runtimeVersion',p_runtime,'deadline',prior.deadline,'deadlinePreserved',true,
 'existingAccountTokenCap',350000,'existingArmUsdCents',1000,'newFunds',0,'additionalTokenCap',remaining+60000,
 'remainingAccountTokens',350000-acct.spent_tokens,'unallocatedAccountTokens',350000-acct.spent_tokens-remaining-60000,
 'specificationTokens',0,'developmentTokens',170000,'previousDevelopmentTokens',120000,'allocationIncreaseTokens',50000,
 'developmentSpentTokens',m.actual_tokens,'developmentRemainingTokens',remaining,'assessmentTokens',60000,
 'previousMaxCalls',12,'maxCalls',24,'callsUsed',m.calls,'callsRemaining',24-m.calls,
 'repeatResearch',false,'regenerateSpecification',false,'frozenRequirements',true,'scopeApprovalPreserved',true,'taskApprovalPreserved',true,'productionPublication',false);
 hash:=encode(sha256(convert_to(project_canonical(plan),'UTF8')),'hex');
 if not p_approve then return jsonb_build_object('approved',false,'id',null,'projectId',p.id,'trialId',b.trial_id,'accountId',acct.id,'deadline',prior.deadline,'planHash',hash,'plan',plan,'spentTokens',acct.spent_tokens,'live',false,'sourceSnapshotHash',snapshot_hash);end if;
 if p_project is distinct from p.id or p_plan_hash is distinct from hash then raise exception 'Review exact current resource amendment plan';end if;
 insert into benchmark_full_continuations(owner_id,project_id,trial_id,account_id,source_mission_id,source_snapshot,source_snapshot_hash,plan,plan_hash,spent_at_approval,additional_token_cap,deadline,previous_continuation_id)
 values(p_owner,p.id,b.trial_id,acct.id,m.id,snap,snapshot_hash,plan,hash,acct.spent_tokens,remaining+60000,prior.deadline,prior.id) returning * into c;
 insert into benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,continuation_id)
 values(old.owner_id,old.actor_id,old.chat_id,old.trial_id,old.account_id,old.repository,old.model,old.protocol_digest,old.max_tokens,prior.deadline,p.id,j.id,t.id,c.id) returning * into fresh;
 insert into benchmark_development_renewals(continuation_id,approval_id,previous_approval_id,task_id,mission_id,scope_hash,prior_run,receipt)
 values(c.id,fresh.id,old.id,t.id,m.id,p.approved_hash,(t.external->'receipt'->>'run_id')::bigint,t.external->'receipt') returning * into r;
 insert into benchmark_development_resource_amendments(project_id,task_id,mission_id,successor_id,old_grant_id,renewal_id,approval_id,continuation_id,failed_run,receipt,release_sha,runtime_version,development_limit,call_limit,deadline,plan_hash,source_snapshot,source_snapshot_hash)
 values(p.id,t.id,m.id,s.id,g.id,r.id,fresh.id,c.id,r.prior_run,r.receipt,p_release,p_runtime,170000,24,prior.deadline,hash,snap,snapshot_hash) returning * into am;
 update benchmark_execution_grants set stopped_at=coalesce(stopped_at,now()) where id=g.id;
 update agent_tasks set status='dispatching',external=external||jsonb_build_object('resourceAmendmentId',am.id,'developmentRenewalId',r.id),updated_at=now() where id=t.id;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),updated_at=now() where id=j.id;
 update agent_missions set status='running',updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,impediment=null,detail='Owner approved the displayed resource amendment within the same Full budget and original deadline.',updated_at=now() where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'benchmark_resource_amendment_approved',jsonb_build_object('amendmentId',am.id,'planHash',hash,'deadline',prior.deadline,'developmentLimit',170000,'callLimit',24));
 return jsonb_build_object('approved',true,'id',c.id,'projectId',p.id,'trialId',b.trial_id,'accountId',acct.id,'deadline',c.deadline,'planHash',hash,'plan',plan,'spentTokens',acct.spent_tokens,'live',true,'sourceSnapshotHash',snapshot_hash);
end $$;
create function benchmark_development_amendment_ready(p_amendment uuid,p_release text)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from benchmark_development_resource_amendments am
 join benchmark_development_renewals r on r.id=am.renewal_id
 join benchmark_native_spending_approvals a on a.id=am.approval_id
 join benchmark_execution_grants old on old.id=am.old_grant_id
 join benchmark_budget_accounts acct on acct.id=a.account_id
 join agent_missions m on m.id=am.mission_id
 join work_projects p on p.id=am.project_id
 join mission_assignments j on j.id=am.task_id
 join agent_tasks t on t.id=j.id
 where am.id=p_amendment and am.release_sha=p_release and am.runtime_version='provider-input-count-v1'
 and benchmark_development_renewal_matches(m.id,am.continuation_id)
 and a.consumed_at is null and a.revoked_at is null and a.deadline=am.deadline and am.deadline>now()
 and old.stopped_at is not null and old.revoked_at is null and p.status='running' and m.status='running' and j.status='waiting_external'
 and t.status in ('dispatching','submitted') and t.external->>'resourceAmendmentId'=am.id::text and t.external->'receipt'=am.receipt
 and m.token_allowance=120000 and m.max_calls=12 and m.actual_tokens=(am.source_snapshot->'mission'->>'actual_tokens')::bigint
 and m.reserved_tokens=m.actual_tokens and m.calls=(am.source_snapshot->'mission'->>'calls')::integer
 and acct.spent_tokens=(am.source_snapshot->'account'->>'spent_tokens')::bigint and acct.frozen_at is null
 and not exists(select 1 from benchmark_budget_calls where account_id=acct.id and (state<>'settled' or actual_tokens is null))
 and not exists(select 1 from benchmark_execution_grants where account_id=acct.id and stopped_at is null and revoked_at is null and deadline>now())
 and exists(select 1 from model_registry where provider_name='openai' and model_id='gpt-5.3-codex' and pricing_status='verified' and pricing_verified_at>now()-interval '24 hours' and pricing_verified_at<=now() and pricing_input_per_1m between 0.000001 and 28 and pricing_output_per_1m between 0.000001 and 28));
$$;
create function benchmark_claim_development_amendment(p_amendment uuid,p_release text)
returns boolean language plpgsql security invoker set search_path=public as $$
declare am benchmark_development_resource_amendments;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if not benchmark_development_amendment_ready(p_amendment,p_release) then return false;end if;
 select * into am from benchmark_development_resource_amendments where id=p_amendment;
 insert into benchmark_development_amendment_dispatches(amendment_id) values(am.id) on conflict do nothing;if not found then return false;end if;
 update agent_tasks set external=external||jsonb_build_object('resourceAmendmentSince',now(),'resourceAmendmentRelease',p_release),updated_at=now() where id=am.task_id;
 return true;
end $$;
create function benchmark_issue_development_amendment_grant(p_amendment uuid,p_digest text,p_approval uuid,p_task uuid,p_release text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare am benchmark_development_resource_amendments;a benchmark_native_spending_approvals;n uuid;epoch bigint;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into am from benchmark_development_resource_amendments where id=p_amendment;
 select * into a from benchmark_native_spending_approvals where id=am.approval_id for update;
 if am.id is null or am.approval_id is distinct from p_approval or am.task_id is distinct from p_task
 or p_digest is null or p_digest!~'^[a-f0-9]{64}$' or not benchmark_development_amendment_ready(am.id,p_release)
 or not exists(select 1 from benchmark_development_amendment_dispatches where amendment_id=am.id)
 or exists(select 1 from benchmark_development_amendment_grants where amendment_id=am.id)
 then raise exception 'Owner resource amendment unavailable';end if;
 select coalesce(max(execution_epoch),0)+1 into epoch from benchmark_execution_grants where trial_id=a.trial_id;
 n:=benchmark_issue_execution_grant(a.owner_id,a.actor_id,a.chat_id,a.trial_id,a.id,a.repository,a.model,epoch,am.deadline,p_digest);
 insert into benchmark_development_amendment_grants(amendment_id,grant_id) values(am.id,n);
 insert into benchmark_development_renewal_grants(renewal_id,grant_id) values(am.renewal_id,n);
 return jsonb_build_object('grantId',n,'executionEpoch',epoch);
end $$;
-- This authority has exactly one dispatch and grant. Older retry machinery cannot
-- treat it as another ordinary renewal or mint an automatic paid successor.
do $$ declare signature text;body text;anchor text;begin
 foreach signature in array array['benchmark_claim_development_renewal_dispatch(uuid,jsonb,text)','benchmark_issue_development_renewal_grant(uuid,text,uuid,uuid,text)'] loop
  select pg_get_functiondef(signature::regprocedure) into body;anchor:='begin';
  if position(anchor in lower(body))=0 then raise exception 'Renewal entry anchor absent';end if;
  body:=replace(body,E'begin\n',E'begin\n if exists(select 1 from benchmark_development_resource_amendments where renewal_id=p_renewal) then raise exception ''Resource amendment transport required'';end if;\n');execute body;
 end loop;
 select pg_get_functiondef('benchmark_development_pregrant_unused(uuid)'::regprocedure) into body;
 if position('where r.id=p_renewal' in body)=0 then raise exception 'Pregrant eligibility anchor absent';end if;
 body:=replace(body,'where r.id=p_renewal','where r.id=p_renewal and not exists(select 1 from benchmark_development_resource_amendments where renewal_id=r.id)');execute body;
 select pg_get_functiondef('benchmark_development_paid_successor_capacity(uuid,uuid)'::regprocedure) into body;
 if position('where r.id=p_renewal' in body)=0 then raise exception 'Paid successor eligibility anchor absent';end if;
 body:=replace(body,'where r.id=p_renewal','where r.id=p_renewal and not exists(select 1 from benchmark_development_resource_amendments where renewal_id=r.id)');execute body;
end $$;
revoke all on function benchmark_effective_mission_allowance(uuid,uuid),benchmark_effective_mission_call_limit(uuid,uuid),benchmark_dashboard_development_amendment(uuid,uuid,text,boolean,text,text),benchmark_development_amendment_ready(uuid,text),benchmark_claim_development_amendment(uuid,text),benchmark_issue_development_amendment_grant(uuid,text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function benchmark_effective_mission_allowance(uuid,uuid),benchmark_effective_mission_call_limit(uuid,uuid),benchmark_dashboard_development_amendment(uuid,uuid,text,boolean,text,text),benchmark_development_amendment_ready(uuid,text),benchmark_claim_development_amendment(uuid,text),benchmark_issue_development_amendment_grant(uuid,text,uuid,uuid,text) to service_role;
