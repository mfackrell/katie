-- One new owner-approved capacity renewal. No authority is activated by DDL.
alter table benchmark_development_resource_amendments add column capacity_renewal boolean not null default false;
alter table benchmark_development_resource_amendments drop constraint benchmark_development_resource_amendments_project_id_key;
alter table benchmark_development_resource_amendments drop constraint benchmark_development_resource_amendments_task_id_key;
alter table benchmark_development_resource_amendments drop constraint benchmark_development_resource_amendments_mission_id_key;
create unique index benchmark_one_capacity_renewal on benchmark_development_resource_amendments(project_id) where capacity_renewal;
create unique index benchmark_original_resource_amendment on benchmark_development_resource_amendments(project_id) where not capacity_renewal;
alter table benchmark_development_resource_amendments drop constraint benchmark_development_resource_amendments_development_limit_check;
alter table benchmark_development_resource_amendments drop constraint benchmark_development_resource_amendments_call_limit_check;
alter table benchmark_development_resource_amendments add constraint benchmark_amendment_limits check((capacity_renewal and development_limit=448279 and call_limit=32) or (not capacity_renewal and development_limit in (170000,373279) and call_limit=24));
-- Extend the existing plan constraints for exactly this separately approved offer.
do $$ declare c record;definition text;begin
 for c in select conname,pg_get_constraintdef(oid) def from pg_constraint where conrelid='benchmark_full_continuations'::regclass and conname in ('benchmark_continuation_bounded_plan','benchmark_full_continuations_check1','benchmark_full_continuations_check') loop
  definition:=c.def;
  if c.conname='benchmark_full_continuations_check' then
   definition:=replace(definition,$s$(plan ->> 'version'::text) = '5'::text$s$,$s$(plan ->> 'version'::text) in ('5','6')$s$);
  else
   definition:='CHECK (('||substring(definition from 8 for length(definition)-8)||') OR ((plan->>''version''=''6'' AND plan->>''capacityRenewal''=''true'' AND plan->>''resourceAmendment''=''true'' AND plan->>''kind''=''development-renewal'' AND previous_continuation_id IS NOT NULL AND plan->>''cumulativeTokenCap''=''625000'' AND spent_at_approval=287895 AND additional_token_cap=337105 AND plan->>''developmentRemainingTokens''=''277105'' AND plan->>''assessmentTokens''=''60000'' AND plan->>''maxCalls''=''32'') IS TRUE))';
  end if;
  execute format('alter table benchmark_full_continuations drop constraint %I',c.conname);
  execute format('alter table benchmark_full_continuations add constraint %I %s',c.conname,definition);
 end loop;
end $$;
create or replace function benchmark_dashboard_capacity_renewal(p_owner uuid,p_project uuid default null,p_plan_hash text default null,p_approve boolean default false,p_release text default null,p_runtime text default null,p_run jsonb default null)
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
 select * into am from benchmark_development_resource_amendments where project_id=p.id and capacity_renewal;
 if am.id is not null then
  select * into c from benchmark_full_continuations where id=am.continuation_id;
  if p_approve and (p_project is distinct from p.id or p_plan_hash is distinct from c.plan_hash) then raise exception 'Amendment already approved with different plan';end if;
  return jsonb_build_object('approved',true,'id',c.id,'projectId',p.id,'trialId',c.trial_id,'accountId',acct.id,'deadline',c.deadline,'planHash',c.plan_hash,'plan',c.plan,'spentTokens',acct.spent_tokens,'live',benchmark_continuation_live(c.id,acct.id,p.id),'sourceSnapshotHash',c.source_snapshot_hash);
 end if;
 select * into m from agent_missions where id=p.active_mission_id for update;
 select * into j from mission_assignments where mission_id=m.id and role='development' order by created_at desc limit 1 for update;
 select * into t from agent_tasks where id=j.id for update;
 select * into prior from benchmark_full_continuations c0 where project_id=p.id and not exists(select 1 from benchmark_full_continuations newer where newer.previous_continuation_id=c0.id);
 select * into old from benchmark_native_spending_approvals where task_id=t.id order by created_at desc,id desc limit 1 for update;
 select * into s from benchmark_development_paid_successors where id=(t.external->>'paidSuccessorId')::uuid;
 select eg.* into g from benchmark_execution_grants eg join benchmark_development_paid_successor_grants sg on sg.grant_id=eg.id where sg.successor_id=s.id for update of eg;
 remaining:=277105;
 eligible:=p.phase='development' and p.status='blocked' and m.status='blocked' and m.project_kind='development'
 and j.status='failed' and t.status='blocked' and t.kind='development' and j.payload->>'approved'='true'
 and p.actor_id=q.actor_id and p.approved_hash is not null and p.approved_hash=p.approval_hash and benchmark_full_task_provenance(t.id,p.id)
 and exists(select 1 from project_runs where mission_id=m.id and binding->>'scopeHash'=p.approved_hash)
 and old.id is not null and old.owner_id=p_owner and old.consumed_at is not null and old.revoked_at is null
 and old.project_id=p.id and old.account_id=acct.id and old.task_id=t.id and old.mission_assignment_id=j.id and old.continuation_id=prior.id
 and old.actor_id=p.actor_id and old.chat_id=p.chat_id and old.trial_id=b.trial_id
 and old.deadline=prior.deadline
 and prior.plan->>'kind'='development-renewal' and prior.plan->>'developmentTokens'='373279' and prior.plan->>'assessmentTokens'='60000'
 and acct.spent_tokens=287895 and m.actual_tokens=171174 and m.calls=17
 and prior.plan->>'resourceAmendment'='true' and prior.plan->>'version'='5' and prior.deadline<=now()
 and exists(select 1 from benchmark_development_resource_amendments predecessor join benchmark_amendment_successor_consents sc on sc.amendment_id=predecessor.id where predecessor.continuation_id=prior.id and sc.renewal_id=s.renewal_id and sc.release_sha=s.release_sha and t.external->>'ownerSuccessorConsentId'=sc.id::text)
 and prior.source_mission_id=m.id and prior.plan->>'scopeHash'=p.approved_hash
 and s.id is not null
 and exists(select 1 from benchmark_development_renewals where id=(t.external->>'developmentRenewalId')::uuid and approval_id=old.id and continuation_id=prior.id)
 and g.id is not null and g.revoked_at is null and g.continuation_id=prior.id and g.mission_assignment_id=t.id and g.account_id=acct.id
 and g.deadline<=now() and g.trial_id=old.trial_id and g.owner_actor_id=old.actor_id and g.protocol_digest=old.protocol_digest and g.model='gpt-5.3-codex' and g.repository='mfackrell/katie'
 and exists(select 1 from mission_calls where job_id=t.id and lease=g.id and actual_tokens>0)
 and t.external->'receipt'->>'outcome'='BLOCKED' and t.external->'receipt'->>'repository'='mfackrell/katie'
 and t.external->'receipt'->>'issue_number'=t.external->>'issueNumber' and t.external->'receipt'->>'run_id'~'^[0-9]+$'
 and (t.external->'receipt'->>'run_id')::bigint<>s.failed_run and t.external->>'paidSuccessorRelease'=s.release_sha
 and t.external->'receipt'->>'pr_url' is null and t.external->'receipt'->>'tested_head_sha' is null and t.external->'receipt'->>'reviewed_head_sha' is null
 and t.external->'receipt'->'checks'='{"build":"failure","test":"","review":"","repair":"skipped","retest":"","final_review":""}'::jsonb
 and m.token_allowance=120000 and m.max_calls=12 and m.calls<32 and m.actual_tokens=m.reserved_tokens and remaining>0
 and m.calls=(select count(*) from mission_calls where job_id=t.id)
 and m.actual_tokens=(select coalesce(sum(actual_tokens),0) from mission_calls where job_id=t.id)
 and not exists(select 1 from mission_calls where job_id=t.id and (status<>'completed' or actual_tokens is null))
 and acct.frozen_at is null and acct.cap_tokens=350000 and acct.spent_tokens+remaining+60000=625000
 and (select coalesce(sum(actual_tokens),0) from benchmark_budget_calls where account_id=acct.id)=acct.spent_tokens
 and not exists(select 1 from benchmark_budget_calls where account_id=acct.id and (state<>'settled' or actual_tokens is null))
 and not exists(select 1 from benchmark_execution_grants where account_id=acct.id and id<>g.id and stopped_at is null and revoked_at is null and deadline>now())
 and not exists(select 1 from agent_missions where project_id=p.id and status in ('running','awaiting_approval'))
 and (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)+remaining+60000<=625000
 and p.token_allowance<=350000 and (p.lease is null or p.lease_until<=now()) and (j.lease is null or j.lease_until<=now())

 and p_release~'^[a-f0-9]{40}$' and p_release<>s.release_sha and p_runtime='provider-input-count-v1'
 and exists(select 1 from model_registry where provider_name='openai' and model_id='gpt-5.3-codex' and pricing_status='verified' and pricing_verified_at>now()-interval '24 hours' and pricing_verified_at<=now() and pricing_input_per_1m between 0.000001 and 14 and pricing_output_per_1m between 0.000001 and 14);
 eligible:=eligible and (select count(*) from benchmark_dollar_exposures where account_id=acct.id)=(select count(*) from benchmark_budget_calls where account_id=acct.id)
 and (select coalesce(sum(exposure_microusd),0) from benchmark_dollar_exposures where account_id=acct.id)+3500000<=10000000;
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
 plan:=jsonb_build_object('version',6,'capacityRenewal',true,'kind','development-renewal','resourceAmendment',true,'issue',715,'sourceIssue',650,
 'projectId',p.id,'taskId',t.id,'missionId',m.id,'trialId',b.trial_id,'accountId',acct.id,'scopeHash',p.approved_hash,'baselineSha',b.baseline_sha,'model',b.model,
 'priorRun',(t.external->'receipt'->>'run_id')::bigint,'previousApprovalId',old.id,'previousContinuationId',prior.id,'paidSuccessorId',s.id,'oldGrantId',g.id,
 'sourceSnapshotHash',snapshot_hash,'releaseSha',p_release,'runtimeVersion',p_runtime,'durationSeconds',14400,'windowStartsAtApproval',true,
 'existingAccountTokenCap',350000,'cumulativeTokenCap',625000,'tokenCapIncrease',75000,'dollarCeilingMicrousd',10000000,'monetaryControl','atomic-exposure-v1','serviceTier','default','historicalExposureMicrousd',snap->'dollarExposure','existingArmUsdCents',1000,'newFunds',0,'additionalTokenCap',remaining+60000
 )||jsonb_build_object('remainingAccountTokens',337105,'unallocatedAccountTokens',0,
 'specificationTokens',0,'developmentTokens',448279,'previousDevelopmentTokens',373279,'allocationIncreaseTokens',75000,'nativeAdditionalCallLimit',11,'developmentClosureCalls',4,'developmentClosureTokens',60000,'qualifiedRemainingTokenEnvelope',318033,'planningTokenBuffer',19072,'estimatedAdditionalCostMicrousd',3500000,'remainingDollarMicrousd',10000000-(snap->>'dollarExposure')::numeric,'estimateIsGuarantee',false,
 'developmentSpentTokens',m.actual_tokens,'developmentRemainingTokens',remaining,'assessmentTokens',60000,
 'previousMaxCalls',24,'maxCalls',32,'callsUsed',m.calls,'callsRemaining',32-m.calls,'nativeCallsRemaining',28-m.calls,
 'repeatResearch',false,'regenerateSpecification',false,'frozenRequirements',true,'scopeApprovalPreserved',true,'taskApprovalPreserved',true,'productionPublication',false);
 hash:=encode(sha256(convert_to(project_canonical(plan),'UTF8')),'hex');
 if not p_approve then return jsonb_build_object('approved',false,'id',null,'projectId',p.id,'trialId',b.trial_id,'accountId',acct.id,'deadline',null,'planHash',hash,'plan',plan,'spentTokens',acct.spent_tokens,'live',false,'sourceSnapshotHash',snapshot_hash);end if;
 if p_project is distinct from p.id or p_plan_hash is distinct from hash then raise exception 'Review exact current resource amendment plan';end if;
 if p_run->>'id' is distinct from t.external->'receipt'->>'run_id' or p_run->>'head_sha' is distinct from s.release_sha then raise exception 'Verified terminal run differs';end if;
 insert into benchmark_full_continuations(owner_id,project_id,trial_id,account_id,source_mission_id,source_snapshot,source_snapshot_hash,plan,plan_hash,spent_at_approval,additional_token_cap,deadline,previous_continuation_id)
 values(p_owner,p.id,b.trial_id,acct.id,m.id,snap,snapshot_hash,plan,hash,acct.spent_tokens,remaining+60000,now()+interval '4 hours',prior.id) returning * into c;
 insert into benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,continuation_id)
 values(old.owner_id,old.actor_id,old.chat_id,old.trial_id,old.account_id,old.repository,old.model,old.protocol_digest,625000,c.deadline,p.id,j.id,t.id,c.id) returning * into fresh;
 insert into benchmark_development_renewals(continuation_id,approval_id,previous_approval_id,task_id,mission_id,scope_hash,prior_run,receipt)
 values(c.id,fresh.id,old.id,t.id,m.id,p.approved_hash,(t.external->'receipt'->>'run_id')::bigint,t.external->'receipt') returning * into r;
 insert into benchmark_development_resource_amendments(project_id,task_id,mission_id,successor_id,old_grant_id,renewal_id,approval_id,continuation_id,failed_run,receipt,release_sha,runtime_version,development_limit,call_limit,deadline,plan_hash,source_snapshot,source_snapshot_hash,capacity_renewal)
 values(p.id,t.id,m.id,s.id,g.id,r.id,fresh.id,c.id,r.prior_run,r.receipt,p_release,p_runtime,448279,32,c.deadline,hash,snap,snapshot_hash,true) returning * into am;
 update benchmark_execution_grants set stopped_at=coalesce(stopped_at,now()) where id=g.id;
 update agent_tasks set status='dispatching',external=(external-'ownerSuccessorConsentId'-'resourceAmendmentSince'-'resourceAmendmentRelease')||jsonb_build_object('resourceAmendmentId',am.id,'developmentRenewalId',r.id),updated_at=now() where id=t.id;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),updated_at=now() where id=j.id;
 update agent_missions set status='running',updated_at=now() where id=m.id;
 update work_projects set deadline=greatest(deadline,c.deadline),status='running',lease=null,lease_until=null,impediment=null,detail='Owner approved the displayed resource amendment with 625000 cumulative tokens and 32 cumulative development calls, a cumulative $10 ceiling, and four hours from approval.',updated_at=now() where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'benchmark_resource_amendment_approved',jsonb_build_object('amendmentId',am.id,'supersededApprovalId',old.id,'planHash',hash,'deadline',c.deadline,'developmentLimit',448279,'callLimit',32));
 return jsonb_build_object('approved',true,'id',c.id,'projectId',p.id,'trialId',b.trial_id,'accountId',acct.id,'deadline',c.deadline,'planHash',hash,'plan',plan,'spentTokens',acct.spent_tokens,'live',true,'sourceSnapshotHash',snapshot_hash);
end $$;


revoke all on function benchmark_dashboard_capacity_renewal(uuid,uuid,text,boolean,text,text,jsonb) from public,anon,authenticated;
grant execute on function benchmark_dashboard_capacity_renewal(uuid,uuid,text,boolean,text,text,jsonb) to service_role;
create or replace function benchmark_effective_account_cap(p_account uuid) returns bigint language sql stable security invoker set search_path=public as $$
 select coalesce((select case when am.capacity_renewal then 625000 else 550000 end from benchmark_development_resource_amendments am join benchmark_full_continuations c on c.id=am.continuation_id
 where c.account_id=a.id and ((not am.capacity_renewal and c.plan->>'version'='5' and c.plan->>'cumulativeTokenCap'='550000' and am.development_limit=373279) or (am.capacity_renewal and c.plan->>'version'='6' and c.plan->>'cumulativeTokenCap'='625000' and am.development_limit=448279))
 and am.plan_hash=c.plan_hash and am.deadline=c.deadline and c.deadline>now() and not exists(select 1 from benchmark_full_continuations n where n.previous_continuation_id=c.id)),a.cap_tokens)
 from benchmark_budget_accounts a where a.id=p_account;
$$;
do $$ declare body text;begin
 select pg_get_functiondef('benchmark_continuation_live(uuid,uuid,uuid)'::regprocedure) into body;
 body:=replace(body,$s$c.plan->>'version' is distinct from '5'$s$, $s$(c.plan->>'version' is distinct from '5' and c.plan->>'version' is distinct from '6')$s$);
 body:=replace(body,'approval.max_tokens=550000',$s$approval.max_tokens=case when c.plan->>'version'='6' then 625000 else 550000 end$s$);execute body;
 select pg_get_functiondef('benchmark_full_monetary_control(uuid,uuid)'::regprocedure) into body;
 body:=replace(body,$s$c.plan->>'version'='5'$s$,$s$c.plan->>'version' in ('5','6')$s$);execute body;
 select pg_get_functiondef('benchmark_production_call_guard()'::regprocedure) into body;
 body:=replace(body,$s$c.plan->>'version'='5'$s$,$s$c.plan->>'version' in ('5','6')$s$);
 body:=replace(body,$s$>=24 then raise exception 'Cumulative$s$, $s$>=benchmark_effective_mission_call_limit(m.id,c.id) then raise exception 'Cumulative$s$);execute body;
 select pg_get_functiondef('benchmark_full_native_reserve(text,uuid,bigint,text,text,bigint)'::regprocedure) into body;
 body:=replace(body,$s$c.plan->>'version'='5'$s$,$s$c.plan->>'version' in ('5','6')$s$);
 body:=replace(body,')>=20 or greatest',')>=benchmark_effective_mission_call_limit(m.id,g.continuation_id)-4 or greatest');
 body:=replace(body,'+p_tokens>313279','+p_tokens>benchmark_effective_mission_allowance(m.id,g.continuation_id)-60000');execute body;
end $$;
