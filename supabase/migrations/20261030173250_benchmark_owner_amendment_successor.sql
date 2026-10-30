-- One explicit owner consent; reuse the existing paid-successor, dispatch and grant records.
create table benchmark_amendment_successor_consents(
 id uuid primary key default gen_random_uuid(),
 amendment_id uuid not null unique references benchmark_development_resource_amendments(id),
 renewal_id uuid not null unique references benchmark_development_renewals(id),
 old_grant_id uuid not null unique references benchmark_execution_grants(id),
 owner_id uuid not null, plan jsonb not null, plan_hash text not null,
 release_sha text not null check(release_sha~'^[a-f0-9]{40}$'),
 deadline timestamptz not null, created_at timestamptz not null default clock_timestamp());
alter table benchmark_amendment_successor_consents enable row level security;
revoke all on benchmark_amendment_successor_consents from public,anon,authenticated,service_role;
grant select,insert on benchmark_amendment_successor_consents to service_role;

create function benchmark_amendment_successor_capacity(p_renewal uuid,p_grant uuid)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from benchmark_development_resource_amendments am
 join benchmark_development_renewals r on r.id=am.renewal_id
 join benchmark_full_continuations c on c.id=am.continuation_id
 join benchmark_native_spending_approvals a on a.id=am.approval_id
 join benchmark_execution_grants g on g.id=p_grant
 join benchmark_budget_accounts b on b.id=a.account_id
 join agent_missions m on m.id=am.mission_id
 join work_projects p on p.id=am.project_id
 where r.id=p_renewal and c.plan->>'version'='5' and c.plan->>'resourceAmendment'='true'
 and am.deadline=c.deadline and a.deadline=c.deadline and g.deadline=c.deadline and c.deadline>clock_timestamp()
 and a.consumed_at is not null and a.revoked_at is null and g.revoked_at is null
 and a.owner_id=c.owner_id and a.actor_id=p.actor_id and a.chat_id=p.chat_id
 and a.task_id=am.task_id and a.mission_assignment_id=am.task_id and a.project_id=p.id
 and g.continuation_id=c.id and g.project_id=p.id and g.mission_assignment_id=am.task_id
 and g.trial_id=a.trial_id and g.account_id=b.id and g.owner_actor_id=a.actor_id
 and g.model=a.model and g.repository=a.repository and g.protocol_digest=a.protocol_digest
 and exists(select 1 from benchmark_development_amendment_grants where amendment_id=am.id and grant_id=g.id)
 and benchmark_development_renewal_matches(m.id,c.id) and benchmark_full_task_provenance(am.task_id,p.id)
 and p.active_mission_id=m.id and p.phase='development' and p.approved_hash=p.approval_hash
 and p.approved_hash=r.scope_hash and b.frozen_at is null and b.cap_tokens=350000 and a.max_tokens=550000
 and benchmark_effective_account_cap(b.id)=550000 and am.development_limit=373279 and am.call_limit=24
 and m.calls<20 and m.actual_tokens<am.development_limit-60000 and m.reserved_tokens=m.actual_tokens
 and m.calls=(select count(*) from mission_calls where job_id=am.task_id)
 and m.actual_tokens=(select coalesce(sum(actual_tokens),0) from mission_calls where job_id=am.task_id)
 and not exists(select 1 from mission_calls where job_id=am.task_id and (status<>'completed' or actual_tokens is null))
 and not exists(select 1 from benchmark_budget_calls where account_id=b.id and (state<>'settled' or actual_tokens is null))
 and b.spent_tokens=(select coalesce(sum(actual_tokens),0) from benchmark_budget_calls where account_id=b.id)
 and b.spent_tokens+(am.development_limit-m.actual_tokens)+60000<=550000
 and (select count(*) from benchmark_dollar_exposures where account_id=b.id)=(select count(*) from benchmark_budget_calls where account_id=b.id)
 and (select coalesce(sum(exposure_microusd),0) from benchmark_dollar_exposures where account_id=b.id)<10000000
 and exists(select 1 from mission_calls where job_id=am.task_id and lease=g.id and actual_tokens>0)
 and not exists(select 1 from benchmark_execution_grants x where x.account_id=b.id and x.id<>g.id and x.revoked_at is null and x.stopped_at is null and x.deadline>clock_timestamp())
 and exists(select 1 from model_registry where provider_name='openai' and model_id=a.model and pricing_status='verified'
 and pricing_verified_at>clock_timestamp()-interval '24 hours' and pricing_verified_at<=clock_timestamp()
 and pricing_input_per_1m>0 and pricing_input_per_1m<=14 and pricing_output_per_1m>0 and pricing_output_per_1m<=14));
$$;

-- The legacy automatic path stays closed unless the exact owner consent exists.
do $$ declare body text;begin
 select pg_get_functiondef('benchmark_development_paid_successor_capacity(uuid,uuid)'::regprocedure) into body;
 if position(' select exists(' in body)=0 or position('pricing_output_per_1m<=28));' in body)=0 then raise exception 'Successor capacity integration changed';end if;
 body:=replace(body,' select exists(', $b$ select (exists(select 1 from benchmark_amendment_successor_consents sc
 where sc.renewal_id=p_renewal and sc.old_grant_id=p_grant and sc.deadline>clock_timestamp()
 and benchmark_amendment_successor_capacity(p_renewal,p_grant)) or exists($b$);
 body:=replace(body,'pricing_output_per_1m<=28));','pricing_output_per_1m<=28)));');
 execute body;
 select pg_get_functiondef('benchmark_prepare_development_paid_successor(uuid,uuid,bigint,jsonb,text,text,timestamptz,timestamptz,text)'::regprocedure) into body;
 if position('coalesce(t.external' in body)=0 then raise exception 'Successor prepare integration changed';end if;
 body:=replace(body,$search$coalesce(t.external->>'pregrantRecoveryRelease',t.external->>'developmentRenewalRelease') is distinct from p_failed_release$search$,
 $b$(case when exists(select 1 from benchmark_amendment_successor_consents sc where sc.renewal_id=r.id and sc.old_grant_id=g.id and sc.release_sha=p_release and sc.deadline=g.deadline)
 then t.external->>'resourceAmendmentRelease' else coalesce(t.external->>'pregrantRecoveryRelease',t.external->>'developmentRenewalRelease') end) is distinct from p_failed_release$b$);
 execute body;
 -- Consent also binds the exact release at claim and grant time.
 foreach body in array array['benchmark_claim_development_paid_successor(uuid,text)','benchmark_issue_development_paid_successor_grant(uuid,text,uuid,uuid,text)'] loop
  declare definition text;begin
   select pg_get_functiondef(body::regprocedure) into definition;
   if position('s.id is null or s.release_sha is distinct from p_release' in definition)=0 then raise exception 'Successor grant integration changed';end if;
   definition:=replace(definition,'s.id is null or s.release_sha is distinct from p_release',
   $b$s.id is null or (exists(select 1 from benchmark_development_resource_amendments where renewal_id=r.id) and not exists(select 1 from benchmark_amendment_successor_consents sc where sc.renewal_id=r.id and sc.old_grant_id=s.old_grant_id and sc.release_sha=p_release and sc.deadline>clock_timestamp())) or s.release_sha is distinct from p_release$b$);
   execute definition;
  end;
 end loop;
end $$;

create function benchmark_dashboard_amendment_successor(p_owner uuid,p_release text,p_project uuid default null,p_plan_hash text default null,p_approve boolean default false,p_run jsonb default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare am benchmark_development_resource_amendments;g benchmark_execution_grants;a benchmark_native_spending_approvals;
 t agent_tasks;m agent_missions;p work_projects;b benchmark_budget_accounts;sc benchmark_amendment_successor_consents;
 plan jsonb;hash text;exposure bigint;snapshot_hash text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if p_owner is null or not exists(select 1 from benchmark_production_qualifications where issue=715 and owner_id=p_owner and revoked_at is null) then raise exception 'Authenticated original owner required';end if;
 select am0.* into am from benchmark_development_resource_amendments am0 join benchmark_native_spending_approvals a0 on a0.id=am0.approval_id where a0.owner_id=p_owner order by am0.created_at desc limit 1;
 if am.id is null then return null;end if;
 select * into p from work_projects where id=am.project_id;
 select * into a from benchmark_native_spending_approvals where id=am.approval_id;
 select * into b from benchmark_budget_accounts where id=a.account_id;
 select * into m from agent_missions where id=am.mission_id;
 select * into t from agent_tasks where id=am.task_id;
 select eg.* into g from benchmark_execution_grants eg join benchmark_development_amendment_grants ag on ag.grant_id=eg.id where ag.amendment_id=am.id;
 select * into sc from benchmark_amendment_successor_consents where amendment_id=am.id;
 if sc.id is not null then
  if p_approve and (p_project is distinct from p.id or p_plan_hash is distinct from sc.plan_hash or p_release is distinct from sc.release_sha) then raise exception 'Review exact successor plan';end if;
  return jsonb_build_object('approved',true,'id',sc.id,'projectId',p.id,'trialId',a.trial_id,'accountId',b.id,'deadline',sc.deadline,'planHash',sc.plan_hash,'plan',sc.plan,'spentTokens',b.spent_tokens,'live',sc.deadline>clock_timestamp(),'sourceSnapshotHash',sc.plan->>'sourceSnapshotHash');
 end if;
 if p_release is null or p_release!~'^[a-f0-9]{40}$' or p_release=am.release_sha
 or not benchmark_amendment_successor_capacity(am.renewal_id,g.id) or g.stopped_at is not null
 or p.status<>'blocked' or m.status<>'blocked' or t.status<>'blocked'
 or not exists(select 1 from mission_assignments where id=t.id and status='failed' and (lease is null or lease_until<=clock_timestamp()))
 or (p.lease is not null and p.lease_until>clock_timestamp())
 or t.external->>'resourceAmendmentId' is distinct from am.id::text or t.external->>'resourceAmendmentRelease' is distinct from am.release_sha
 or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
 or t.external->'receipt'->>'repository' is distinct from 'mfackrell/katie'
 or t.external->'receipt'->>'issue_number' is distinct from t.external->>'issueNumber'
 or t.external->'receipt'->>'run_id' !~'^[0-9]+$'
 or t.external->'receipt'->'checks' is distinct from '{"build":"failure","test":"","review":"","repair":"skipped","retest":"","final_review":""}'::jsonb
 then if p_approve then raise exception 'Successor checkpoint unavailable or expired';end if;return null;end if;
 select coalesce(sum(exposure_microusd),0) into exposure from benchmark_dollar_exposures where account_id=b.id;
 snapshot_hash:=encode(sha256(convert_to(project_canonical(jsonb_build_object('receipt',t.external->'receipt','spent',b.spent_tokens,'calls',m.calls,'actual',m.actual_tokens,'exposure',exposure,'grant',g.id,'approval',a.id,'scope',p.approved_hash)),'UTF8')),'hex');
 plan:=jsonb_build_object('ownerSuccessor',true,'resourceAmendment',true,'kind','development-renewal','projectId',p.id,'taskId',t.id,'amendmentId',am.id,'priorRun',t.external->'receipt'->'run_id','releaseSha',p_release,'sourceSnapshotHash',snapshot_hash,'deadline',am.deadline,'additionalTokenCap',550000-b.spent_tokens,'cumulativeTokenCap',550000,'dollarCeilingMicrousd',10000000,'historicalExposureMicrousd',exposure,'remainingDollarMicrousd',10000000-exposure,'specificationTokens',0,'developmentTokens',am.development_limit,'developmentRemainingTokens',am.development_limit-m.actual_tokens,'assessmentTokens',60000,'maxCalls',24,'callsUsed',m.calls,'callsRemaining',24-m.calls,'nativeCallsRemaining',20-m.calls,'developmentClosureCalls',4,'developmentClosureTokens',60000,'automaticRetry',false,'evidenceVersion','bounded-execution-v1');
 hash:=encode(sha256(convert_to(project_canonical(plan),'UTF8')),'hex');
 if p_approve then
  if p_project is distinct from p.id or p_plan_hash is distinct from hash then raise exception 'Review exact successor plan';end if;
  if p_run->>'id' is distinct from t.external->'receipt'->>'run_id' or p_run->>'head_sha' is distinct from am.release_sha then raise exception 'Terminal run differs';end if;
  insert into benchmark_amendment_successor_consents(amendment_id,renewal_id,old_grant_id,owner_id,plan,plan_hash,release_sha,deadline) values(am.id,am.renewal_id,g.id,p_owner,plan,hash,p_release,am.deadline) returning * into sc;
  perform benchmark_prepare_development_paid_successor(am.renewal_id,g.id,(p_run->>'id')::bigint,t.external->'receipt',am.release_sha,p_release,(p_run->>'started_at')::timestamptz,(p_run->>'finished_at')::timestamptz,'bounded-schema-v1');
  update agent_tasks set external=(external-'paidSuccessorSince'-'paidSuccessorRelease')||jsonb_build_object('ownerSuccessorConsentId',sc.id) where id=t.id;
  insert into project_events(project_id,event,data) values(p.id,'benchmark_amendment_successor_approved',jsonb_build_object('consentId',sc.id,'planHash',hash,'failedRun',p_run->'id','deadline',am.deadline));
 end if;
 return jsonb_build_object('approved',p_approve,'id',sc.id,'projectId',p.id,'trialId',a.trial_id,'accountId',b.id,'deadline',am.deadline,'planHash',hash,'plan',plan,'spentTokens',b.spent_tokens,'live',true,'sourceSnapshotHash',snapshot_hash);
end $$;
revoke all on function benchmark_amendment_successor_capacity(uuid,uuid),benchmark_dashboard_amendment_successor(uuid,text,uuid,text,boolean,jsonb) from public,anon,authenticated;
grant execute on function benchmark_amendment_successor_capacity(uuid,uuid),benchmark_dashboard_amendment_successor(uuid,text,uuid,text,boolean,jsonb) to service_role;
