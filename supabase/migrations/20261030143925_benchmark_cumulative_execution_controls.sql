-- No authority is activated by this migration. Original account/mission limits
-- remain immutable evidence; only an authenticated #861 amendment can overlay them.
create table benchmark_dollar_exposures(
 call_id uuid primary key references benchmark_budget_calls(id),
 account_id uuid not null references benchmark_budget_accounts(id),
 reserved_microusd numeric not null check(reserved_microusd>=0),
 exposure_microusd numeric not null check(exposure_microusd>=0),
 price_per_million numeric not null check(price_per_million>0 and price_per_million<=28),
 basis text not null check(basis in ('historical-verified','historical-provision','reserved','receipt-provision')),
 price_evidence jsonb not null,created_at timestamptz not null default now());
alter table benchmark_dollar_exposures enable row level security;
revoke all on benchmark_dollar_exposures from public,anon,authenticated,service_role;
grant select on benchmark_dollar_exposures to service_role;
-- Rates in dollars/million multiplied by tokens yield microdollars. Ignore cache
-- discounts. Missing historical price/usage evidence is charged at the ORIGINAL
-- verified authorization maximum ($28/million), not today's cheaper price.
insert into benchmark_dollar_exposures(call_id,account_id,reserved_microusd,exposure_microusd,price_per_million,basis,price_evidence)
select c.id,c.account_id,28*greatest(c.reserved_tokens,coalesce(c.actual_tokens,0)),
 case when c.state='settled' and c.provider_namespace='openai-responses'
 and c.pricing_snapshot->>'status'='verified' and c.pricing_snapshot->>'serviceTier'='default'
 and (c.pricing_snapshot->>'inputPerMillion')::numeric between 0.000001 and 28
 and (c.pricing_snapshot->>'outputPerMillion')::numeric between 0.000001 and 28
 and (c.provider_usage->>'input_tokens')::bigint+(c.provider_usage->>'output_tokens')::bigint=c.actual_tokens
 then (c.provider_usage->>'input_tokens')::bigint*(c.pricing_snapshot->>'inputPerMillion')::numeric
     +(c.provider_usage->>'output_tokens')::bigint*(c.pricing_snapshot->>'outputPerMillion')::numeric
 else 28*(case when c.state='settled' then coalesce(c.actual_tokens,c.reserved_tokens) else greatest(c.reserved_tokens,coalesce(c.actual_tokens,0)) end) end,
 28,case when c.state='settled' and c.pricing_snapshot->>'status'='verified' and c.pricing_snapshot->>'serviceTier'='default' and c.provider_usage is not null then 'historical-verified' else 'historical-provision' end,
 jsonb_build_object('usage',c.provider_usage,'pricing',c.pricing_snapshot,'fallbackPerMillion',28)
from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id where a.arm='full';

-- Runs inside the existing reservation transaction, serializing all Full native
-- and ordinary DO/assessment calls on their original account row. Native/Thin
-- are untouched. No floating point and no release of unknown outcomes.
create function benchmark_dollar_admission() returns trigger language plpgsql security definer set search_path=public as $$
declare a benchmark_budget_accounts;r model_registry;used numeric;rate numeric;c benchmark_full_continuations;
begin
 select * into a from benchmark_budget_accounts where id=new.account_id for update;
 if a.arm<>'full' then return new;end if;
 select * into c from benchmark_full_continuations where id=new.continuation_id;
 if new.continuation_id is not null and (c.id is null or c.deadline<=clock_timestamp() or not benchmark_continuation_live(c.id,a.id,c.project_id))
 then raise exception 'Full monetary authority expired';end if;
 if new.continuation_id is null and exists(select 1 from benchmark_production_qualifications q where q.experiment_id=a.experiment_id and (q.revoked_at is not null or q.deadline<=clock_timestamp())) then raise exception 'Full monetary qualification expired';end if;
 if new.model='gpt-5.3-codex' and not exists(select 1 from mission_calls mc join benchmark_execution_grants g on g.id=mc.lease
 where mc.id=new.legacy_mission_call_id and g.continuation_id is not distinct from new.continuation_id and g.deadline>clock_timestamp() and g.stopped_at is null and g.revoked_at is null)
 then raise exception 'Full monetary execution grant expired';end if;
 select * into r from model_registry where provider_name='openai' and model_id='gpt-5.3-codex' for share;
 if new.state<>'reserved' or new.actual_tokens is not null or new.model not in ('gpt-5.3-codex','openai:gpt-5.3-codex')
 or r.model_id is null or r.pricing_status is distinct from 'verified' or r.pricing_verified_at is null
 or r.pricing_verified_at<clock_timestamp()-interval '24 hours' or r.pricing_verified_at>clock_timestamp()
 or r.pricing_input_per_1m is null or r.pricing_output_per_1m is null
 or r.pricing_input_per_1m not between 0.000001 and 14 or r.pricing_output_per_1m not between 0.000001 and 14
 then raise exception 'Full monetary pricing admission denied';end if;
 if exists(select 1 from benchmark_budget_calls c left join benchmark_dollar_exposures e on e.call_id=c.id where c.account_id=a.id and c.id<>new.id and e.call_id is null)
 then raise exception 'Full monetary history incomplete';end if;
 rate:=greatest(r.pricing_input_per_1m,r.pricing_output_per_1m);
 select coalesce(sum(exposure_microusd),0) into used from benchmark_dollar_exposures where account_id=a.id;
 if used+new.reserved_tokens*rate>10000000 then raise exception 'Full cumulative dollar ceiling exhausted';end if;
 -- AFTER INSERT guarantees FK existence, but still rolls back the entire token
 -- reservation and counters on denial. No provider call occurs before commit.
 insert into benchmark_dollar_exposures values(new.id,a.id,new.reserved_tokens*rate,new.reserved_tokens*rate,rate,'reserved',
 jsonb_build_object('provider','openai','model','gpt-5.3-codex','serviceTier','default','inputPerMillion',r.pricing_input_per_1m,'outputPerMillion',r.pricing_output_per_1m,'verifiedAt',r.pricing_verified_at),now());
 return new;
end $$;
create trigger benchmark_dollar_admission after insert on benchmark_budget_calls for each row execute function benchmark_dollar_admission();
create function benchmark_dollar_settlement() returns trigger language plpgsql security definer set search_path=public as $$
declare e benchmark_dollar_exposures;cost numeric;
begin
 select * into e from benchmark_dollar_exposures where call_id=new.id;
 if not found or e.basis like 'historical-%' then return new;end if;
 perform 1 from benchmark_budget_accounts where id=e.account_id for update;
 -- Tokens alone, zero-on-error, or a noncanonical receipt never releases dollars.
 if new.state not in ('settled','overrun') or new.provider_namespace is distinct from 'openai-responses'
 or new.provider_request_id is null or new.provider_usage is null
 or coalesce(new.provider_usage->>'input_tokens','')!~'^[0-9]+$'
 or coalesce(new.provider_usage->>'output_tokens','')!~'^[0-9]+$'
 or (new.provider_usage->>'input_tokens')::numeric+(new.provider_usage->>'output_tokens')::numeric is distinct from new.actual_tokens::numeric then return new;end if;
 cost:=new.actual_tokens*e.price_per_million;
 -- Conservative settlement prices EVERY actual token at the most expensive
 -- verified admission rate. Pricing changes cannot retroactively lower exposure.
 update benchmark_dollar_exposures set exposure_microusd=cost,basis='receipt-provision' where call_id=new.id;
 if cost>e.reserved_microusd then update benchmark_budget_accounts set frozen_at=coalesce(frozen_at,now()) where id=e.account_id;end if;
 return new;
end $$;
create trigger benchmark_dollar_settlement after update on benchmark_budget_calls for each row execute function benchmark_dollar_settlement();
revoke all on function benchmark_dollar_admission(),benchmark_dollar_settlement() from public,anon,authenticated,service_role;

alter table benchmark_development_resource_amendments drop constraint benchmark_development_resource_amendmen_development_limit_check;
alter table benchmark_development_resource_amendments add constraint benchmark_development_resource_amendments_development_limit_check check(development_limit in (170000,373279));
-- The original constraints/records stay valid. Version5 creates exactly four
-- hours from the authenticated transaction, never from GET or deployment.
alter table benchmark_full_continuations drop constraint benchmark_full_continuations_check;
alter table benchmark_full_continuations add constraint benchmark_full_continuations_check check((
 (coalesce(plan->>'resourceAmendment','false')<>'true' and deadline=created_at+interval '4 hours') or
 (plan->>'resourceAmendment'='true' and previous_continuation_id is not null and
  ((plan->>'version'='5' and deadline=created_at+interval '4 hours' and plan->>'durationSeconds'='14400') or
   (plan->>'version'='4' and deadline>created_at and deadline<=created_at+interval '4 hours' and deadline=(plan->>'deadline')::timestamptz)))) is true);
create function benchmark_effective_account_cap(p_account uuid) returns bigint language sql stable security invoker set search_path=public as $$
 select coalesce((select 550000 from benchmark_development_resource_amendments am join benchmark_full_continuations c on c.id=am.continuation_id
 where c.account_id=a.id and c.plan->>'version'='5' and c.plan->>'cumulativeTokenCap'='550000'
 and am.development_limit=373279 and am.plan_hash=c.plan_hash and am.deadline=c.deadline
 and c.deadline>now() and not exists(select 1 from benchmark_full_continuations n where n.previous_continuation_id=c.id)),a.cap_tokens)
 from benchmark_budget_accounts a where a.id=p_account;
$$;
create function benchmark_effective_project_cap(p_project uuid) returns bigint language sql stable security invoker set search_path=public as $$
 select greatest(p.token_allowance,coalesce((select benchmark_effective_account_cap(b.account_id) from benchmark_full_project_bindings b where b.project_id=p.id),0)) from work_projects p where p.id=p_project;
$$;
revoke all on function benchmark_effective_account_cap(uuid),benchmark_effective_project_cap(uuid) from public,anon,authenticated;
grant execute on function benchmark_effective_account_cap(uuid),benchmark_effective_project_cap(uuid) to service_role;
-- Integrate the overlay only at existing capacity comparisons. Physical caps,
-- frozen trial identity and original approval records are not changed.
do $$ declare sig text;body text;begin
 foreach sig in array array['benchmark_reserve_call(uuid,text,text,bigint)','benchmark_grant_reserve(text,uuid,bigint,text,text,bigint)',
 'benchmark_full_native_reserve(text,uuid,bigint,text,text,bigint)','benchmark_reserve_mission_call(uuid,uuid,uuid,text,integer,boolean)'] loop
  select pg_get_functiondef(sig::regprocedure) into body;
  if position('>a.cap_tokens' in body)=0 then raise exception 'Account capacity anchor missing: %',sig;end if;
  body:=replace(body,'>a.cap_tokens','>benchmark_effective_account_cap(a.id)');
  body:=replace(body,'used+p_tokens>p.token_allowance','used+p_tokens>benchmark_effective_project_cap(p.id)');execute body;
 end loop;
 foreach sig in array array['try_reserve_mission_capacity(uuid,uuid,uuid,text,integer,boolean)','mission_call_capacity(uuid,uuid)'] loop
  select pg_get_functiondef(sig::regprocedure) into body;
  body:=replace(body,'p.token_allowance','benchmark_effective_project_cap(p.id)');
  body:=replace(body,'select token_allowance into project_limit','select benchmark_effective_project_cap(id) into project_limit');execute body;
 end loop;
 select pg_get_functiondef('benchmark_production_call_guard()'::regprocedure) into body;
 if position('a.spent_tokens+held+new.reserved_tokens>350000' in body)=0 then raise exception 'Production account anchor missing';end if;
 body:=replace(body,'if phase_cap=0',
 $patch$if c.plan->>'version'='5' and m.project_kind='development' and (select count(*) from benchmark_budget_calls bc join mission_calls mc on mc.id::text=coalesce(bc.legacy_mission_call_id::text,bc.request_key) join mission_assignments mj on mj.id=mc.job_id where mj.mission_id=m.id)>=24 then raise exception 'Cumulative development billable call ceiling';end if;
 if phase_cap=0$patch$);
 body:=replace(body,'a.spent_tokens+held+new.reserved_tokens>350000','a.spent_tokens+held+new.reserved_tokens>benchmark_effective_account_cap(a.id)');execute body;
end $$;

create or replace function benchmark_dashboard_development_amendment(p_owner uuid,p_project uuid default null,p_plan_hash text default null,p_approve boolean default false,p_release text default null,p_runtime text default null)
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
 remaining:=294059;
 eligible:=p.phase='development' and p.status='blocked' and m.status='blocked' and m.project_kind='development'
 and j.status='failed' and t.status='blocked' and t.kind='development' and j.payload->>'approved'='true'
 and p.actor_id=q.actor_id and p.approved_hash is not null and p.approved_hash=p.approval_hash and benchmark_full_task_provenance(t.id,p.id)
 and exists(select 1 from project_runs where mission_id=m.id and binding->>'scopeHash'=p.approved_hash)
 and old.id is not null and old.owner_id=p_owner and old.consumed_at is null and old.revoked_at is null
 and old.project_id=p.id and old.account_id=acct.id and old.task_id=t.id and old.mission_assignment_id=j.id and old.continuation_id=prior.id
 and old.actor_id=p.actor_id and old.chat_id=p.chat_id and old.trial_id=b.trial_id
 and old.deadline=prior.deadline
 and prior.plan->>'kind'='development-renewal' and prior.plan->>'developmentTokens'='120000' and prior.plan->>'assessmentTokens'='60000'
 and acct.spent_tokens=195941 and m.actual_tokens=79220 and m.calls=9
 and coalesce(prior.plan->>'resourceAmendment','false')='false'
 and prior.source_mission_id=m.id and prior.plan->>'scopeHash'=p.approved_hash
 and s.id is not null
 and exists(select 1 from benchmark_development_renewals where id=(t.external->>'developmentRenewalId')::uuid and approval_id=old.id and continuation_id=prior.id)
 and g.id is not null and g.revoked_at is null and g.continuation_id<>prior.id and g.mission_assignment_id=t.id and g.account_id=acct.id
 and g.deadline<=now() and g.trial_id=old.trial_id and g.owner_actor_id=old.actor_id and g.protocol_digest=old.protocol_digest and g.model='gpt-5.3-codex' and g.repository='mfackrell/katie'
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
 and acct.frozen_at is null and acct.cap_tokens=350000 and acct.spent_tokens+remaining+60000=550000
 and (select coalesce(sum(actual_tokens),0) from benchmark_budget_calls where account_id=acct.id)=acct.spent_tokens
 and not exists(select 1 from benchmark_budget_calls where account_id=acct.id and (state<>'settled' or actual_tokens is null))
 and not exists(select 1 from benchmark_execution_grants where account_id=acct.id and id<>g.id and stopped_at is null and revoked_at is null and deadline>now())
 and not exists(select 1 from agent_missions where project_id=p.id and status in ('running','awaiting_approval'))
 and (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)+remaining+60000<=550000
 and p.token_allowance<=350000 and (p.lease is null or p.lease_until<=now()) and (j.lease is null or j.lease_until<=now())
 and not exists(select 1 from benchmark_development_renewal_dispatches where renewal_id=(t.external->>'developmentRenewalId')::uuid)
 and not exists(select 1 from benchmark_execution_grants where continuation_id=old.continuation_id)
 and p_release~'^[a-f0-9]{40}$' and p_release<>s.release_sha and p_runtime='provider-input-count-v1'
 and exists(select 1 from model_registry where provider_name='openai' and model_id='gpt-5.3-codex' and pricing_status='verified' and pricing_verified_at>now()-interval '24 hours' and pricing_verified_at<=now() and pricing_input_per_1m between 0.000001 and 14 and pricing_output_per_1m between 0.000001 and 14);
 eligible:=eligible and (select count(*) from benchmark_dollar_exposures where account_id=acct.id)=(select count(*) from benchmark_budget_calls where account_id=acct.id)
 and (select coalesce(sum(exposure_microusd),0) from benchmark_dollar_exposures where account_id=acct.id)+292823*14<=10000000;
 if eligible is distinct from true then if p_approve then raise exception 'Current amendment checkpoint unavailable';end if;return null;end if;
 snap:=jsonb_build_object('trial',(select to_jsonb(tr) from benchmark_three_arm_trials tr where id=b.trial_id),'qualification',to_jsonb(q),'binding',to_jsonb(b),'project',to_jsonb(p),'mission',to_jsonb(m),'assignment',to_jsonb(j),'task',to_jsonb(t),'account',to_jsonb(acct),
 'previousContinuation',to_jsonb(prior)-'source_snapshot','approval',to_jsonb(old),'oldGrant',to_jsonb(g)-'token_digest',
 'executedApproval',(select to_jsonb(x) from benchmark_native_spending_approvals x where x.continuation_id=g.continuation_id and x.task_id=t.id),
 'executedContinuation',(select to_jsonb(x)-'source_snapshot' from benchmark_full_continuations x where x.id=g.continuation_id),
 'dollarExposure',(select coalesce(sum(exposure_microusd),0) from benchmark_dollar_exposures where account_id=acct.id),
 'successor',to_jsonb(s)-'source_snapshot',
 'continuations',(select jsonb_agg(to_jsonb(x)-'source_snapshot' order by created_at,id) from benchmark_full_continuations x where account_id=acct.id),
 'approvals',(select jsonb_agg(to_jsonb(x) order by created_at,id) from benchmark_native_spending_approvals x where account_id=acct.id),
 'grants',(select jsonb_agg(to_jsonb(x)-'token_digest' order by created_at,id) from benchmark_execution_grants x where account_id=acct.id),
 'calls',(select jsonb_agg(to_jsonb(x) order by created_at,id) from benchmark_budget_calls x where account_id=acct.id));
 snapshot_hash:=encode(sha256(convert_to(project_canonical(snap),'UTF8')),'hex');
 plan:=jsonb_build_object('version',5,'kind','development-renewal','resourceAmendment',true,'issue',715,'sourceIssue',650,
 'projectId',p.id,'taskId',t.id,'missionId',m.id,'trialId',b.trial_id,'accountId',acct.id,'scopeHash',p.approved_hash,'baselineSha',b.baseline_sha,'model',b.model,
 'priorRun',(t.external->'receipt'->>'run_id')::bigint,'previousApprovalId',old.id,'previousContinuationId',prior.id,'paidSuccessorId',s.id,'oldGrantId',g.id,
 'sourceSnapshotHash',snapshot_hash,'releaseSha',p_release,'runtimeVersion',p_runtime,'durationSeconds',14400,'windowStartsAtApproval',true,
 'existingAccountTokenCap',350000,'cumulativeTokenCap',550000,'tokenCapIncrease',200000,'dollarCeilingMicrousd',10000000,'monetaryControl','atomic-exposure-v1','serviceTier','default','historicalExposureMicrousd',snap->'dollarExposure','existingArmUsdCents',1000,'newFunds',0,'additionalTokenCap',remaining+60000
 )||jsonb_build_object('remainingAccountTokens',354059,'unallocatedAccountTokens',0,
 'specificationTokens',0,'developmentTokens',373279,'previousDevelopmentTokens',120000,'allocationIncreaseTokens',253279,'nativeAdditionalCallLimit',11,'developmentClosureCalls',4,'developmentClosureTokens',60000,'qualifiedRemainingTokenEnvelope',292823,
 'developmentSpentTokens',m.actual_tokens,'developmentRemainingTokens',remaining,'assessmentTokens',60000,
 'previousMaxCalls',12,'maxCalls',24,'callsUsed',m.calls,'callsRemaining',24-m.calls,
 'repeatResearch',false,'regenerateSpecification',false,'frozenRequirements',true,'scopeApprovalPreserved',true,'taskApprovalPreserved',true,'productionPublication',false);
 hash:=encode(sha256(convert_to(project_canonical(plan),'UTF8')),'hex');
 if not p_approve then return jsonb_build_object('approved',false,'id',null,'projectId',p.id,'trialId',b.trial_id,'accountId',acct.id,'deadline',null,'planHash',hash,'plan',plan,'spentTokens',acct.spent_tokens,'live',false,'sourceSnapshotHash',snapshot_hash);end if;
 if p_project is distinct from p.id or p_plan_hash is distinct from hash then raise exception 'Review exact current resource amendment plan';end if;
 insert into benchmark_full_continuations(owner_id,project_id,trial_id,account_id,source_mission_id,source_snapshot,source_snapshot_hash,plan,plan_hash,spent_at_approval,additional_token_cap,deadline,previous_continuation_id)
 values(p_owner,p.id,b.trial_id,acct.id,m.id,snap,snapshot_hash,plan,hash,acct.spent_tokens,remaining+60000,now()+interval '4 hours',prior.id) returning * into c;
 -- Supersede the unused approval through its existing revocation marker, in
 -- the SAME transaction. Its complete pre-amendment record remains in snap.
 update benchmark_native_spending_approvals set revoked_at=now() where id=old.id and consumed_at is null and revoked_at is null;
 if not found then raise exception 'Superseded approval changed';end if;
 insert into benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,continuation_id)
 values(old.owner_id,old.actor_id,old.chat_id,old.trial_id,old.account_id,old.repository,old.model,old.protocol_digest,550000,c.deadline,p.id,j.id,t.id,c.id) returning * into fresh;
 insert into benchmark_development_renewals(continuation_id,approval_id,previous_approval_id,task_id,mission_id,scope_hash,prior_run,receipt)
 values(c.id,fresh.id,old.id,t.id,m.id,p.approved_hash,(t.external->'receipt'->>'run_id')::bigint,t.external->'receipt') returning * into r;
 insert into benchmark_development_resource_amendments(project_id,task_id,mission_id,successor_id,old_grant_id,renewal_id,approval_id,continuation_id,failed_run,receipt,release_sha,runtime_version,development_limit,call_limit,deadline,plan_hash,source_snapshot,source_snapshot_hash)
 values(p.id,t.id,m.id,s.id,g.id,r.id,fresh.id,c.id,r.prior_run,r.receipt,p_release,p_runtime,373279,24,c.deadline,hash,snap,snapshot_hash) returning * into am;
 update benchmark_execution_grants set stopped_at=coalesce(stopped_at,now()) where id=g.id;
 update agent_tasks set status='dispatching',external=external||jsonb_build_object('resourceAmendmentId',am.id,'developmentRenewalId',r.id),updated_at=now() where id=t.id;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),updated_at=now() where id=j.id;
 update agent_missions set status='running',updated_at=now() where id=m.id;
 update work_projects set deadline=greatest(deadline,c.deadline),status='running',lease=null,lease_until=null,impediment=null,detail='Owner approved the displayed resource amendment with 550000 cumulative tokens, a cumulative $10 ceiling, and four hours from approval.',updated_at=now() where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'benchmark_resource_amendment_approved',jsonb_build_object('amendmentId',am.id,'supersededApprovalId',old.id,'planHash',hash,'deadline',c.deadline,'developmentLimit',373279,'callLimit',24));
 return jsonb_build_object('approved',true,'id',c.id,'projectId',p.id,'trialId',b.trial_id,'accountId',acct.id,'deadline',c.deadline,'planHash',hash,'plan',plan,'spentTokens',acct.spent_tokens,'live',true,'sourceSnapshotHash',snapshot_hash);
end $$;

-- The native SDK may consume at most eleven calls and must leave four calls and
-- 60k development tokens for the DO's queued compose/review (including routing).
-- These are subdivisions of the approved15 calls/294059 tokens, not new funds.
do $$ declare body text;begin
 select pg_get_functiondef('benchmark_full_native_reserve(text,uuid,bigint,text,text,bigint)'::regprocedure) into body;
 if position('if m.calls>=' in body)=0 then raise exception 'Native mission anchor missing';end if;
 body:=replace(body,'if m.calls>=',
 $patch$if exists(select 1 from benchmark_development_resource_amendments am join benchmark_full_continuations c on c.id=am.continuation_id
 where am.continuation_id=g.continuation_id and c.plan->>'version'='5') and
 ((select count(*) from benchmark_budget_calls bc join mission_calls mc on mc.id::text=coalesce(bc.legacy_mission_call_id::text,bc.request_key) join mission_assignments mj on mj.id=mc.job_id where mj.mission_id=m.id)>=20 or greatest(m.reserved_tokens,m.actual_tokens)+p_tokens>313279)
 then raise exception 'Reserved development closure capacity';end if;
 if m.calls>=$patch$);execute body;
end $$;
create function benchmark_full_monetary_control(p_account uuid,p_continuation uuid)
returns jsonb language sql stable security invoker set search_path=public as $$
 select jsonb_build_object('version','atomic-exposure-v1','cumulativeTokenCap',benchmark_effective_account_cap(a.id),'dollarCeilingMicrousd',10000000,
 'exposureMicrousd',(select coalesce(sum(exposure_microusd),0) from benchmark_dollar_exposures where account_id=a.id))
 from benchmark_budget_accounts a join benchmark_full_continuations c on c.account_id=a.id
 where a.id=p_account and c.id=p_continuation and c.plan->>'version'='5'
 and benchmark_continuation_live(c.id,a.id,c.project_id)
 and not exists(select 1 from benchmark_budget_calls bc left join benchmark_dollar_exposures e on e.call_id=bc.id where bc.account_id=a.id and e.call_id is null);
$$;
revoke all on function benchmark_full_monetary_control(uuid,uuid) from public,anon,authenticated;
grant execute on function benchmark_full_monetary_control(uuid,uuid) to service_role;
do $$ declare body text;begin
 select pg_get_functiondef('benchmark_issue_execution_grant(uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)'::regprocedure) into body;
 if position('acc.cap_tokens>a.max_tokens' in body)=0 then raise exception 'Approval ceiling anchor absent';end if;
 body:=replace(body,'acc.cap_tokens>a.max_tokens','benchmark_effective_account_cap(acc.id)>a.max_tokens');execute body;
end $$;
-- Existing bounded plans remain valid; only the exact v5 owner proposal adds
-- the extra cumulative token ceiling. No row or prior plan is rewritten.
alter table benchmark_full_continuations drop constraint benchmark_continuation_bounded_plan;
alter table benchmark_full_continuations add constraint benchmark_continuation_bounded_plan check((
 (previous_continuation_id is null and additional_token_cap=270000) or
 (previous_continuation_id is not null and additional_token_cap=240000 and coalesce(plan->>'kind','specification')='specification') or
 (previous_continuation_id is not null and plan->>'kind'='development-renewal' and additional_token_cap between 1 and 180000 and additional_token_cap=(plan->>'developmentRemainingTokens')::integer+(plan->>'assessmentTokens')::integer) or
 (previous_continuation_id is not null and plan->>'kind'='development-renewal' and plan->>'resourceAmendment'='true' and plan->>'version'='5' and additional_token_cap=354059 and plan->>'developmentRemainingTokens'='294059' and plan->>'assessmentTokens'='60000' and spent_at_approval=195941)
) is true);
alter table benchmark_full_continuations drop constraint benchmark_full_continuations_check1;
alter table benchmark_full_continuations add constraint benchmark_full_continuations_check1 check((
 spent_at_approval+additional_token_cap<=350000 or
 (plan->>'version'='5' and plan->>'resourceAmendment'='true' and plan->>'cumulativeTokenCap'='550000' and spent_at_approval=195941 and additional_token_cap=354059)
) is true);
-- Coordinator receives effective capacity, while the stored scope and original
-- project allowance remain unchanged. Its subsequent SQL admission rechecks it.
do $$ declare body text;begin
 select pg_get_functiondef('claim_work_project()'::regprocedure) into body;
 if position('return to_jsonb(p);' in body)=0 then raise exception 'Project claim capacity anchor missing';end if;
 body:=replace(body,'return to_jsonb(p);',$p$return to_jsonb(p)||jsonb_build_object('token_allowance',benchmark_effective_project_cap(p.id));$p$);execute body;
end $$;
-- Revoking the fresh task approval also stops the later assessment; it cannot
-- survive merely because the continuation record itself is append-only.
do $$ declare body text;begin
 select pg_get_functiondef('benchmark_continuation_live(uuid,uuid,uuid)'::regprocedure) into body;
 if position('and a.arm=' in body)=0 then raise exception 'Continuation authority anchor missing';end if;
 body:=replace(body,'and a.arm=',$p$and (c.plan->>'version' is distinct from '5' or exists(
 select 1 from benchmark_development_resource_amendments am join benchmark_native_spending_approvals approval on approval.id=am.approval_id
 where am.continuation_id=c.id and am.plan_hash=c.plan_hash and approval.continuation_id=c.id
 and approval.revoked_at is null and approval.deadline=c.deadline and approval.max_tokens=550000))
 and a.arm=$p$);execute body;
end $$;
