-- Task 4A Phase 2: append-only original-project continuation succession.
-- This file only changes schema/functions. It does not grant consent, move the
-- original blocked task, execute paid work, or edit historical authorizations.
alter table public.project_continuation_authorizations
 add column if not exists predecessor_id uuid
 references public.project_continuation_authorizations(id);
-- Permit successive signed grants while retaining the historical root. Other
-- projects retain at most one (root) row.
alter table public.project_continuation_authorizations
 drop constraint if exists project_continuation_authorizations_project_id_key;
create unique index if not exists task4a_continuation_one_root
 on public.project_continuation_authorizations(project_id)
 where predecessor_id is null;
create unique index if not exists task4a_continuation_one_child
 on public.project_continuation_authorizations(predecessor_id)
 where predecessor_id is not null;
create unique index if not exists task4a_continuation_consent_no_replay
 on public.project_continuation_authorizations(approval_digest)
 where predecessor_id is not null;

create or replace function public.task4a_successor_insert_guard()
returns trigger language plpgsql set search_path=public as $$
declare prior public.project_continuation_authorizations;
begin
 if new.predecessor_id is null then return new;end if;
 if new.project_id is distinct from '6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
 then raise exception 'TASK4A_SUCCESSOR_ORIGINAL_PROJECT_ONLY';end if;
 select * into prior from public.project_continuation_authorizations
  where id=new.predecessor_id for update;
 if prior.id is null or prior.project_id is distinct from new.project_id
  or prior.id is distinct from public.task4a_current_continuation_id(new.project_id)
  or (prior.deadline>clock_timestamp() and prior.revoked_at is null)
  or new.actor_id is distinct from prior.actor_id or new.chat_id is distinct from prior.chat_id
  or new.source_mission_id is distinct from prior.source_mission_id
  or new.deadline<=clock_timestamp() or new.authorized_at<prior.authorized_at
 then raise exception 'TASK4A_SUCCESSOR_CHAIN_INVALID';end if;
 return new;
end $$;
drop trigger if exists task4a_successor_insert_guard on public.project_continuation_authorizations;
create trigger task4a_successor_insert_guard before insert
 on public.project_continuation_authorizations for each row
 execute function public.task4a_successor_insert_guard();

-- Audit receipts must be append-only even if a privileged operator later
-- acquires UPDATE or DELETE. Do not alter Phase 1 receipt history.
create or replace function public.task4a_successor_audit_immutable()
returns trigger language plpgsql set search_path=public as $task4a_audit$
begin
 if old.event in ('task4a_successor_continuation_authorized','task4a_native_pregrant_recovered') then
  raise exception 'TASK4A_SUCCESSOR_AUDIT_IMMUTABLE';
 end if;
 return case when tg_op='DELETE' then old else new end;
end $task4a_audit$;
revoke all on function public.task4a_successor_audit_immutable() from public,anon,authenticated;
drop trigger if exists task4a_successor_audit_immutable on public.project_events;
create trigger task4a_successor_audit_immutable
 before update or delete on public.project_events for each row
 execute function public.task4a_successor_audit_immutable();

-- A unique chain tip is required; ambiguity is a denial, never a fallback
-- to the expired root grant.
create or replace function public.task4a_current_continuation_id(p_project uuid)
returns uuid language sql stable set search_path=public as $$
 with tips as (
  select a.id from public.project_continuation_authorizations a
  where a.project_id=p_project and not exists(
   select 1 from public.project_continuation_authorizations child
   where child.predecessor_id=a.id
  )
 )
 -- Cardinality-gated selection: UUID has no MAX aggregate on supported PG.
 -- A value is only returned for exactly one terminal authorization.
 select case when count(*)=1 then (array_agg(id))[1] else null::uuid end from tips;
$$;
revoke all on function public.task4a_current_continuation_id(uuid) from public,anon,authenticated;
grant execute on function public.task4a_current_continuation_id(uuid) to service_role;

-- Proposals bind explicit owner-entered limits to the current identity, current
-- financial evidence, fresh independently verified model prices and predecessor.
-- A read-only call with zero limits returns eligibility/ledger, never authority.
create or replace function public.task4a_successor_proposal(
 p_tokens bigint,p_calls integer,p_money numeric,
 p_assess_tokens bigint,p_complete_tokens bigint,
 p_assess_calls integer,p_complete_calls integer,
 p_seconds integer,p_models text[]
) returns jsonb language plpgsql stable set search_path=public as $$
declare
 p public.work_projects;m public.agent_missions;t public.agent_tasks;
 bad public.benchmark_native_spending_approvals;acct public.benchmark_budget_accounts;
 prior public.project_continuation_authorizations;
 owner uuid;mission_actual bigint;mission_held bigint;mission_calls bigint;
 call_actual bigint;call_reserved bigint;call_conservative bigint;call_count bigint;
 unresolved bigint;bound_held_money numeric;bound_recorded_money numeric;
 unpriced_money numeric;call_overrun_tokens bigint;call_overrun_count bigint;conservative_used bigint;remaining bigint;
 price_rows integer;prices jsonb;proposal jsonb; r public.project_runs;
begin
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into m from public.agent_missions
  where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid and project_id=p.id;
 select * into t from public.agent_tasks
  where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid;
 select * into prior from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id) and project_id=p.id;
 select * into bad from public.benchmark_native_spending_approvals
  where id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid and task_id=t.id;
 select * into acct from public.benchmark_budget_accounts where id=bad.account_id;
 select * into r from public.project_runs where project_id=p.id and mission_id=m.id;
 owner:=public.task4a_original_owner_id(p.actor_id,p.chat_id);
 if p.id is null or m.id is null or t.id is null or prior.id is null or owner is null
  or p.status<>'blocked' or p.phase<>'development'
  or p.active_mission_id is distinct from m.id
  or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash
  or p.baseline_sha is distinct from '49c8a5f791e66c351436bb97839193b53d7a1cd1'
  or p.repository_full_name is distinct from 'mfackrell/katie'
  or m.status<>'blocked' or m.project_kind<>'development'
  or t.status<>'blocked' or t.repository_full_name<>'mfackrell/katie'
  or t.external->>'issueNumber' is distinct from '969'
  or t.external->>'developerApprovalId' is distinct from bad.id::text
  or t.external->'receipt'->>'run_id' is distinct from '41673059705'
  or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or t.external->'receipt'->>'pr_url' is not null
  or r.binding->>'projectId' is distinct from p.id::text
  or r.binding->>'scopeHash' is distinct from p.approved_hash
  or r.binding->>'baselineSha' is distinct from p.baseline_sha
  or r.binding->>'contractHash' is distinct from 'e8b08da72779ae0d7e864ed57c5ecc76b03d1fce6ddc9e14815e9c4c3dff332e'
  or prior.actor_id is distinct from p.actor_id or prior.chat_id is distinct from p.chat_id
  or prior.deadline>clock_timestamp() and prior.revoked_at is null
  or bad.owner_id is distinct from owner or bad.revoked_at is not null
  or bad.consumed_at is not null
  or acct.id is null or acct.arm<>'developer' or acct.frozen_at is not null
  or acct.developer_project_id is distinct from p.id
  or acct.developer_task_id is distinct from t.id
  or bad.developer_authority->>'version' is distinct from 'ordinary-developer-v1'
  or bad.developer_authority ? 'task4aContinuationId'
  or bad.developer_authority->'binding' is distinct from r.binding
  or bad.model is distinct from 'gpt-5.3-codex'
  or acct.cap_tokens is distinct from 180000
  -- A second unrelated approval/account is still a duplicate authority even
  -- if it does not point back to the invalid original as its predecessor.
  or exists(select 1 from public.benchmark_native_spending_approvals another
     where another.project_id=p.id and another.id<>bad.id)
  or exists(select 1 from public.benchmark_budget_accounts another
     where another.developer_project_id=p.id and another.id<>acct.id)
  or exists(select 1 from public.benchmark_execution_grants g
     where g.project_id=p.id)
  or exists(select 1 from public.mission_calls prior_call
      join public.mission_assignments assignment on assignment.id=prior_call.job_id
      where assignment.mission_id=m.id)
  or exists(select 1 from public.benchmark_native_spending_approvals
    where previous_developer_approval_id=bad.id)
  or exists(select 1 from public.benchmark_budget_calls where account_id=acct.id)
  or exists(select 1 from public.benchmark_execution_grants where developer_approval_id=bad.id)
  or exists(select 1 from public.project_events where project_id=p.id and event='task4a_native_pregrant_recovered')
  or p.deadline<=clock_timestamp()+interval '5 minutes'
 then return jsonb_build_object('ready',false,'reason','original_project_or_authority_not_eligible');end if;
 select coalesce(sum(actual_tokens),0),coalesce(sum(reserved_tokens),0),
  coalesce(sum(greatest(actual_tokens,reserved_tokens)),0),
  coalesce(sum(calls+routing_calls),0)
 into mission_actual,mission_held,conservative_used,mission_calls
 from public.agent_missions where project_id=p.id;
 select coalesce(sum(c.actual_tokens),0),coalesce(sum(c.reserved_tokens),0),
  coalesce(sum(greatest(c.actual_tokens,c.reserved_tokens)),0),count(*),
  count(*) filter(where c.status<>'completed' or c.actual_tokens is null),
  coalesce(sum(c.project_reserved_microusd),0),
  coalesce(sum(c.project_actual_microusd),0),
  coalesce(sum(case when c.project_continuation_id is not null
    and c.project_actual_microusd is null then c.project_reserved_microusd else 0 end),0),
  coalesce(sum(greatest(coalesce(c.actual_tokens,0)-c.reserved_tokens,0)),0),
  count(*) filter(where c.actual_tokens>c.reserved_tokens)
 into call_actual,call_reserved,call_conservative,call_count,unresolved,
  bound_held_money,bound_recorded_money,unpriced_money,call_overrun_tokens,call_overrun_count
 from public.mission_calls c
 join public.mission_assignments j on j.id=c.job_id
 join public.agent_missions part on part.id=j.mission_id where part.project_id=p.id;
 conservative_used:=greatest(conservative_used,call_conservative);
 remaining:=p.token_allowance-conservative_used;
 if unresolved<>0 or call_count<>mission_calls or call_actual<>mission_actual
  or mission_actual<0 or conservative_used<mission_actual or remaining<=0
 then return jsonb_build_object('ready',false,'reason','historical_ledger_unreconciled');end if;
 proposal:=jsonb_build_object(
  'version',2,'kind','task4a_original_development_successor',
  'projectId',p.id,'missionId',m.id,'taskId',t.id,'originalIssue',969,
  'predecessorId',prior.id,'originalRootId','405ea82c-6f52-49e5-babf-891ecac64d14',
  'ownerId',owner,'actorId',p.actor_id,'chatId',p.chat_id,
  'projectDeadline',p.deadline,'scopeHash',p.approved_hash,
  'contractHash',r.binding->>'contractHash','baselineSha',p.baseline_sha,
  'nativeAccountId',acct.id,'originalNativeApprovalId',bad.id,
  'projectTokenAllowance',p.token_allowance,'historicalActualTokens',mission_actual,
  'historicalMissionReservedTokens',mission_held,
  'historicalCallActualTokens',call_actual,'historicalCallReservedTokens',call_reserved,
  'historicalConservativeTokens',conservative_used,'historicalCalls',call_count,
  'historicalOverrunTokens',call_overrun_tokens,'historicalOverrunCalls',call_overrun_count,
  'historicalReservedExposureMicrousd',bound_held_money,
  'historicalRecordedActualMicrousd',bound_recorded_money,
  'historicalUnpricedActualExposureMicrousd',unpriced_money,
  'previousAuthorityCeilingMicrousd',prior.incremental_microusd,
  'previousAuthorityTokens',prior.incremental_tokens,
  'previousAuthorityCalls',prior.incremental_calls,
  'maximumNewTokens',remaining,
  'incrementalTokens',p_tokens,'incrementalCalls',p_calls,
  'incrementalMicrousd',p_money,
  'assessmentReserveTokens',p_assess_tokens,'completionReserveTokens',p_complete_tokens,
  'assessmentReserveCalls',p_assess_calls,'completionReserveCalls',p_complete_calls,
  'durationSeconds',p_seconds,'models',to_jsonb(p_models),
  'newOwnerConsentRequired',true,'newNativeConsentRequired',true,
  'noAutomaticRenewal',true,'noProductionPublication',true);
 if p_tokens is null or p_calls is null or p_money is null
  or p_assess_tokens is null or p_complete_tokens is null or
     p_assess_calls is null or p_complete_calls is null or p_seconds is null
  or p_models is null or cardinality(p_models)=0
 then return jsonb_build_object('ready',false,'reason','owner_limits_required',
   'ledger',proposal);end if;
 if p_tokens<=p_assess_tokens+p_complete_tokens or p_tokens>remaining
  or p_calls<=p_assess_calls+p_complete_calls or p_calls>200
  or p_money<=0 or p_money>100000000
  or p_assess_tokens<prior.assessment_reserve_tokens
  or p_complete_tokens<prior.completion_reserve_tokens
  or p_assess_calls<prior.assessment_reserve_calls
  or p_complete_calls<prior.completion_reserve_calls
  or p_seconds<300 or p_seconds>172800
  or clock_timestamp()+make_interval(secs=>p_seconds)>=p.deadline
  or cardinality(p_models)<>(
    select count(distinct value)::int from unnest(p_models) as names(value))
  or not p_models<@array['openai:gpt-5.6-sol','openai:gpt-5.3-codex']::text[]
  or not ('openai:gpt-5.3-codex'=any(p_models))
 then return jsonb_build_object('ready',false,'reason','owner_limits_exceed_safe_or_available_bounds',
   'ledger',proposal);end if;
 select count(*),coalesce(jsonb_agg(jsonb_build_object(
  'model',provider_name||':'||model_id,
  'inputPerMillionUsd',pricing_input_per_1m,
  'outputPerMillionUsd',pricing_output_per_1m,
  'verifiedAt',pricing_verified_at,
  'source',source_metadata->>'pricing_verification_source'
 ) order by model_id),'[]'::jsonb)
 into price_rows,prices from public.model_registry
 where provider_name='openai'
  and 'openai:'||model_id=any(p_models)
  and is_active=true and pricing_status='verified'
  and pricing_verified_at between now()-interval '24 hours' and now()
  and pricing_input_per_1m>0 and pricing_output_per_1m>0
  and source_metadata->>'pricing_verification_source'
   ='https://developers.openai.com/api/docs/models/'||model_id;
 if price_rows<>cardinality(p_models) then
  return jsonb_build_object('ready',false,'reason','fresh_verified_model_pricing_required',
   'ledger',proposal);end if;
 proposal:=proposal||jsonb_build_object('pricingEvidence',prices);
 return jsonb_build_object('ready',true,'proposal',proposal,
  'digest',encode(sha256(convert_to(public.project_canonical(proposal),'UTF8')),'hex'));
end $$;
revoke all on function public.task4a_successor_proposal(
 bigint,integer,numeric,bigint,bigint,integer,integer,integer,text[]
) from public,anon,authenticated;
grant execute on function public.task4a_successor_proposal(
 bigint,integer,numeric,bigint,bigint,integer,integer,integer,text[]
) to service_role;

create or replace function public.task4a_authorize_successor(
 p_owner uuid,p_digest text,p_tokens bigint,p_calls integer,p_money numeric,
 p_assess_tokens bigint,p_complete_tokens bigint,p_assess_calls integer,p_complete_calls integer,
 p_seconds integer,p_models text[]
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare shown jsonb;candidate jsonb;p public.work_projects;
 prior public.project_continuation_authorizations;new_auth uuid; event_id uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into prior from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id) for update;
 shown:=public.task4a_successor_proposal(p_tokens,p_calls,p_money,
  p_assess_tokens,p_complete_tokens,p_assess_calls,p_complete_calls,p_seconds,p_models);
 if p_owner is null or p_owner is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)
  or shown->>'ready' is distinct from 'true'
  or shown->>'digest' is distinct from p_digest
  or shown->'proposal'->>'predecessorId' is distinct from prior.id::text
 then raise exception 'TASK4A_SUCCESSOR_STALE_OR_UNAUTHORIZED';end if;
 candidate:=shown->'proposal';
 insert into public.project_continuation_authorizations(
  project_id,actor_id,chat_id,source_mission_id,approval_digest,deadline,
  incremental_tokens,incremental_calls,incremental_microusd,
  assessment_reserve_tokens,completion_reserve_tokens,
  assessment_reserve_calls,completion_reserve_calls,allowed_models,
  historical_tokens,historical_calls,historical_mission_deadline,
  pricing_evidence,predecessor_id)
 values(p.id,p.actor_id,p.chat_id,prior.source_mission_id,p_digest,
  clock_timestamp()+make_interval(secs=>p_seconds),
  p_tokens,p_calls,p_money,p_assess_tokens,p_complete_tokens,p_assess_calls,
  p_complete_calls,p_models,(candidate->>'historicalActualTokens')::bigint,
  (candidate->>'historicalCalls')::integer,prior.historical_mission_deadline,
  candidate->'pricingEvidence',prior.id)
 returning id into new_auth;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_successor_continuation_authorized',
  jsonb_build_object('version',2,'oldAuthorityId',prior.id,'newAuthorityId',new_auth,
  'ownerId',p_owner,'ownerConsentDigest',p_digest,'proposal',candidate,
  'originalIssue',969,'originalTaskId','d0e41ff5-149e-4319-9e65-dcc605fb75da',
  'noNativeDispatch',true,'noProviderCallsCreated',true))
 returning id into event_id;
 return jsonb_build_object('authorized',true,'authorizationId',new_auth,
  'predecessorId',prior.id,'receiptId',event_id,'projectId',p.id,
  'digest',p_digest,'nativeRecoveryStillRequiresSeparateOwnerConsent',true,
  'developmentDispatched',false);
end $$;
revoke all on function public.task4a_authorize_successor(
 uuid,text,bigint,integer,numeric,bigint,bigint,integer,integer,integer,text[]
) from public,anon,authenticated;
grant execute on function public.task4a_authorize_successor(
 uuid,text,bigint,integer,numeric,bigint,bigint,integer,integer,integer,text[]
) to service_role;


-- Preserve Phase 1 task4a_bind_native_mission_call with current append-only successor tip.
CREATE OR REPLACE FUNCTION public.task4a_bind_native_mission_call()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare m public.agent_missions;j public.mission_assignments;
 a public.project_continuation_authorizations;g public.benchmark_execution_grants;
 approval public.benchmark_native_spending_approvals;price public.model_registry;
 used_tokens bigint;used_calls bigint;used_money numeric;held_money numeric;
begin
 select * into j from public.mission_assignments where id=new.job_id;
 select * into m from public.agent_missions where id=j.mission_id;
 if m.project_id is null then return new;end if;
 select * into a from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(m.project_id) for update;
 if a.id is null then
  if m.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
   and (exists(select 1 from public.project_continuation_authorizations existing
     where existing.project_id=m.project_id)
     or exists(select 1 from public.work_projects project_state
       where project_state.id=m.project_id and project_state.phase in ('development','assessment')))
  then raise exception 'TASK4A_NO_UNAMBIGUOUS_CURRENT_AUTHORITY';end if;
  return new;
 end if;
 if a.revoked_at is not null or a.deadline<=clock_timestamp()
 then raise exception 'Task 4A owner grant expired or revoked';end if;
 if new.project_continuation_id is not null then
  -- Project-level reservations may prebind research/assessment calls. The
  -- original native development task MUST use the signed execution-grant
  -- adapter below, never a caller-supplied prebound continuation/price.
  if m.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
    and (j.role='development' or m.project_kind='development')
  then raise exception 'TASK4A_DEVELOPMENT_REQUIRES_NATIVE_ADMISSION';end if;
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
end $function$;

-- Preserve Phase 1 try_reserve_mission_capacity with current append-only successor tip.
CREATE OR REPLACE FUNCTION public.try_reserve_mission_capacity(p_id uuid, p_lease uuid, p_call uuid, p_model text, p_tokens integer, p_routing boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
 j mission_assignments; m agent_missions; project_limit bigint; project_used bigint;
 authority project_continuation_authorizations; price model_registry;
 existing_tokens bigint; existing_calls integer; existing_dollars numeric;
 upper_dollars numeric; evidence jsonb; model_provider text; chosen_model text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id;if not found then return false;end if;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into j from mission_assignments where id=p_id for update;
 if m.project_id is not null then
  select benchmark_effective_project_cap(id) into project_limit from work_projects
   where id=m.project_id and status='running' and active_mission_id=m.id and deadline>now();
  if not found then return false;end if;
 end if;
 if m.status not in ('running','awaiting_approval')
  or benchmark_effective_mission_deadline(m.id)<=now()
  or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now()
 then return false;end if;
 if p_tokens is null or p_tokens not between 1 and 120000 or p_call is null or p_routing is null
  or coalesce(length(p_model),0) not between 1 and 300
  or exists(select 1 from mission_calls where id=p_call) then return false;end if;
 if (p_routing and m.routing_calls>=benchmark_effective_mission_call_limit(m.id,benchmark_effective_mission_continuation(m.id))*3)
  or (not p_routing and m.calls>=benchmark_effective_mission_call_limit(m.id,benchmark_effective_mission_continuation(m.id)))
  or greatest(m.reserved_tokens,m.actual_tokens)+p_tokens>benchmark_effective_mission_allowance(m.id,benchmark_effective_mission_continuation(m.id))
 then return false;end if;
 if m.project_id is not null then
  select coalesce(sum(greatest(reserved_tokens,actual_tokens)),0) into project_used
   from agent_missions where project_id=m.project_id;
  if project_used+p_tokens>project_limit then return false;end if;
  select * into authority from project_continuation_authorizations
   where id=public.task4a_current_continuation_id(m.project_id);
  -- Never turn missing or ambiguous Task 4A successor authority into an
  -- unmetered mission-call reservation. Unrelated ordinary projects keep
  -- their existing no-Task4A-continuation behavior.
  if m.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
     and authority.id is null and (exists(select 1 from public.project_continuation_authorizations existing
     where existing.project_id=m.project_id)
     or exists(select 1 from public.work_projects project_state
       where project_state.id=m.project_id and project_state.phase in ('development','assessment')))
  then return false;end if;
  if found then
   if authority.deadline<=clock_timestamp() or authority.revoked_at is not null or authority.authorized_at>clock_timestamp()
    or p_model<>all(authority.allowed_models) then return false;end if;
   model_provider:=split_part(p_model,':',1);
   chosen_model:=substring(p_model from length(model_provider)+2);
   select * into price from model_registry where provider_name=model_provider and model_id=chosen_model;
   if not found or price.is_active is distinct from true
    or price.pricing_status is distinct from 'verified'
    or price.pricing_verified_at is null or price.pricing_verified_at<now()-interval '24 hours'
    or price.pricing_verified_at>now()
    or coalesce(price.pricing_input_per_1m,0)<=0 or coalesce(price.pricing_output_per_1m,0)<=0
    or price.source_metadata->>'pricing_verification_source'
       is distinct from 'https://developers.openai.com/api/docs/models/'||chosen_model
    or model_provider<>'openai' then return false;end if;
   select coalesce(sum(greatest(c.reserved_tokens,coalesce(c.actual_tokens,0))),0),
          count(*),coalesce(sum(c.project_reserved_microusd),0)
     into existing_tokens,existing_calls,existing_dollars
    from mission_calls c where c.project_continuation_id=authority.id;
   if exists(select 1 from mission_calls c where c.project_continuation_id=authority.id
     and (c.status='uncertain' or c.actual_tokens>c.reserved_tokens)) then return false;end if;
   upper_dollars:=ceil(p_tokens*greatest(price.pricing_input_per_1m,price.pricing_output_per_1m)*1.65);
   if existing_tokens+p_tokens>authority.incremental_tokens
    or existing_calls+1>authority.incremental_calls
    or existing_dollars+upper_dollars>authority.incremental_microusd then return false;end if;
   -- Protect final assessment and completion capacity until the assigned stage.
   if m.project_kind<>'assessment' and
      (existing_tokens+p_tokens+authority.assessment_reserve_tokens+authority.completion_reserve_tokens>authority.incremental_tokens
       or existing_calls+1+authority.assessment_reserve_calls+authority.completion_reserve_calls>authority.incremental_calls)
    then return false;end if;
   if m.project_kind='assessment' and j.role<>'review' and
      (existing_tokens+p_tokens+authority.completion_reserve_tokens>authority.incremental_tokens
       or existing_calls+1+authority.completion_reserve_calls>authority.incremental_calls)
    then return false;end if;
   evidence:=jsonb_build_object('source',price.source_metadata->>'pricing_verification_source',
    'verifiedAt',price.pricing_verified_at,'model',p_model,
    'inputPerMillionUsd',price.pricing_input_per_1m,
    'outputPerMillionUsd',price.pricing_output_per_1m,
    'upperBoundMultiplier',1.65,'priceBasis','conservative_reserved_tokens',
    'phase',m.project_kind,'role',j.role);
  end if;
 end if;
 insert into mission_calls(id,job_id,lease,model,reserved_tokens,
  project_continuation_id,project_reserved_microusd,project_pricing_evidence)
 values(p_call,j.id,p_lease,p_model,p_tokens,
  authority.id,case when authority.id is null then null else upper_dollars end,evidence);
 update agent_missions set calls=calls+case when p_routing then 0 else 1 end,
   routing_calls=routing_calls+case when p_routing then 1 else 0 end,
   reserved_tokens=reserved_tokens+p_tokens,updated_at=now() where id=m.id;
 update mission_assignments set heartbeat_at=now(),lease_until=now()+interval '6 minutes' where id=j.id;
 return true;
end $function$;

-- Preserve Phase 1 task4a_native_authority_ready with current append-only successor tip.
CREATE OR REPLACE FUNCTION public.task4a_native_authority_ready(p_project uuid, p_task uuid, p_authority uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare a public.project_continuation_authorizations;ok boolean;
begin
 if p_project is distinct from '6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid then return false;end if;
 select * into a from public.project_continuation_authorizations
  where id=p_authority and project_id=p_project
   and id=public.task4a_current_continuation_id(p_project);
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
end $function$;

-- Preserve Phase 1 task4a_prepare_native_development with current append-only successor tip.
CREATE OR REPLACE FUNCTION public.task4a_prepare_native_development(p_project uuid, p_task uuid, p_scope text, p_contract text, p_baseline text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  where id=public.task4a_current_continuation_id(p_project) for update;
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
end $function$;

-- Preserve Phase 1 task4a_native_live with current append-only successor tip.
CREATE OR REPLACE FUNCTION public.task4a_native_live(p_digest text, p_project uuid, p_epoch bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  where project_id=p_project and id=(a.developer_authority->>'task4aContinuationId')::uuid
   and id=public.task4a_current_continuation_id(p_project);
 return owner_grant.id is not null and owner_grant.revoked_at is null
  and owner_grant.deadline>clock_timestamp()
  and public.task4a_native_authority_ready(p_project,a.task_id,owner_grant.id);
exception when invalid_text_representation then return false;
end $function$;

-- Preserve Phase 1 developer_claim_dispatch with current append-only successor tip.
CREATE OR REPLACE FUNCTION public.developer_claim_dispatch(p_approval uuid, p_release text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.benchmark_native_spending_approvals;
 auth record;
begin
 select * into a from public.benchmark_native_spending_approvals where id=p_approval;
 if a.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid then
  select * into auth from public.project_continuation_authorizations
   where id=(a.developer_authority->>'task4aContinuationId')::uuid
    and project_id=a.project_id;
  if auth.id is null or auth.id is distinct from public.task4a_current_continuation_id(a.project_id)
   or auth.revoked_at is not null or auth.deadline<=clock_timestamp()
   or a.developer_authority->>'task4aContinuationId' is distinct from auth.id::text
  then return false;end if;
 end if;
 return public.developer_claim_dispatch_without_task4a_guard(p_approval,p_release);
exception when invalid_text_representation then return false;
end $function$;

-- Preserve Phase 1 task4a_native_recovery_proposal with current append-only successor tip.
CREATE OR REPLACE FUNCTION public.task4a_native_recovery_proposal()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare p work_projects; m agent_missions; j mission_assignments; t agent_tasks;
 bad benchmark_native_spending_approvals; acct benchmark_budget_accounts;
 a project_continuation_authorizations; r project_runs;
 limits jsonb; proposal jsonb; deadline timestamptz;
begin
 select * into p from work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into m from agent_missions where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid and project_id=p.id;
 select * into j from mission_assignments where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid and mission_id=m.id;
 select * into t from agent_tasks where id=j.id;
 select * into r from project_runs where project_id=p.id and mission_id=m.id;
 select * into bad from benchmark_native_spending_approvals
  where id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid and project_id=p.id and task_id=t.id;
 select * into acct from benchmark_budget_accounts where id=bad.account_id;
 select * into a from project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id) and project_id=p.id;
 -- Without a separately owner-approved successor, the Phase 1 native
 -- deadline remains a hard fence. Only a validated append-only successor may
 -- propose a new native grant after the historical native expiry.
 if a.predecessor_id is null then
  deadline:=least(bad.deadline,a.deadline,p.deadline);
 else
  deadline:=least(a.deadline,p.deadline);
 end if;
 limits:=bad.developer_authority->'limits';
 if p.id is null or p.status<>'blocked' or p.phase<>'development'
  or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash
  or p.active_mission_id is distinct from m.id
  or p.baseline_sha is distinct from '49c8a5f791e66c351436bb97839193b53d7a1cd1'
  or p.repository_full_name is distinct from 'mfackrell/katie'
  or m.status<>'blocked' or m.project_kind<>'development'
  or j.role<>'development' or j.status<>'failed'
  or t.status<>'blocked' or t.repository_full_name<>'mfackrell/katie'
  or t.external->>'developerApprovalId' is distinct from bad.id::text
  or t.external->>'issueNumber' is distinct from '969'
  or t.external->'receipt'->>'run_id' is distinct from '41673059705'
  or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or t.external->'receipt'->>'pr_url' is not null
  or t.external->>'attempted' is distinct from 'true'
  or r.binding->>'projectId' is distinct from p.id::text
  or r.binding->>'scopeHash' is distinct from p.approved_hash
  or r.binding->>'baselineSha' is distinct from p.baseline_sha
  or r.binding->>'contractHash' is distinct from 'e8b08da72779ae0d7e864ed57c5ecc76b03d1fce6ddc9e14815e9c4c3dff332e'
  or bad.consumed_at is not null or bad.revoked_at is not null
  or bad.previous_developer_approval_id is not null
  or bad.developer_authority->>'version'<>'ordinary-developer-v1'
  or bad.developer_authority ? 'task4aContinuationId'
  or bad.developer_authority->'binding' is distinct from r.binding
  or bad.model is distinct from 'gpt-5.3-codex'
  or bad.owner_id is distinct from task4a_original_owner_id(p.actor_id,p.chat_id)
  or acct.arm<>'developer' or acct.developer_task_id is distinct from t.id
  or acct.developer_project_id is distinct from p.id or acct.id is null
  or acct.cap_tokens is distinct from 180000
  or acct.frozen_at is not null
  or a.id is null or a.revoked_at is not null or deadline<=clock_timestamp()+interval '60 seconds'
  or p.deadline<=clock_timestamp()
  or limits->>'cumulativeTokens' is distinct from '180000'
  or limits->>'developmentTokens' is distinct from '120000'
  or limits->>'ceilingMicrousd' is distinct from '2520000'
  or limits->>'developmentCalls' is distinct from '12'
  or limits->>'assessmentCalls' is distinct from '4'
  or limits->>'completionCalls' is distinct from '4'
  or exists(select 1 from benchmark_native_spending_approvals child where child.previous_developer_approval_id=bad.id)
  or exists(select 1 from benchmark_execution_grants g where g.developer_approval_id=bad.id)
  or exists(select 1 from benchmark_budget_calls c where c.account_id=acct.id)
  or exists(select 1 from mission_calls c join mission_assignments assignment on assignment.id=c.job_id where assignment.mission_id=m.id)
  or exists(select 1 from project_events e where e.project_id=p.id and e.event='task4a_native_pregrant_recovered')
 then return null;end if;
 proposal:=jsonb_build_object('version',1,'kind','task4a_preinference_failed_gate_replacement',
  'projectId',p.id,'missionId',m.id,'taskId',t.id,'ownerId',bad.owner_id,
  'oldApprovalId',bad.id,'accountId',acct.id,'continuationId',a.id,
  'issueNumber',969,'failedRunId',41673059705,
  'scopeHash',p.approved_hash,'contractHash',r.binding->>'contractHash',
  'baselineSha',p.baseline_sha,'model',bad.model,
  'limits',limits,'originalNativeDeadline',bad.deadline,
  'continuationDeadline',a.deadline,'replacementDeadline',deadline,
  'consumedNativeCalls',0,'consumedNativeTokens',0,
  'originalApprovalPreserved',true,'oldApprovalRevokedOnConsent',true,
  'sameAccountSameCeiling',true,'productionPublicationAllowed',false,
  'newExplicitOwnerConsentRequired',true);
 return jsonb_build_object('ready',true,'proposal',proposal,
  'digest',encode(sha256(convert_to(project_canonical(proposal),'UTF8')),'hex'));
end $function$;

-- Preserve Phase 1 task4a_confirm_pregrant_recovery with current append-only successor tip.
CREATE OR REPLACE FUNCTION public.task4a_confirm_pregrant_recovery(p_owner uuid, p_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare visible jsonb; proposal jsonb;p work_projects;m agent_missions;
 j mission_assignments;t agent_tasks;
 bad benchmark_native_spending_approvals;child benchmark_native_spending_approvals;
 a project_continuation_authorizations; receipt uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into bad from benchmark_native_spending_approvals
  where id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid for update;
 select * into a from project_continuation_authorizations where id=public.task4a_current_continuation_id(p.id) for update;
 select * into t from agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid for update;
 select * into j from mission_assignments where id=t.id for update;
 select * into m from agent_missions where id=j.mission_id for update;
 visible:=task4a_native_recovery_proposal();
 if visible is null or visible->>'digest' is distinct from p_digest
  or p_owner is null or bad.owner_id is distinct from p_owner
  or bad.owner_id is distinct from task4a_original_owner_id(p.actor_id,p.chat_id)
 then raise exception 'TASK4A_NATIVE_RECOVERY_STALE_OR_UNAUTHORIZED';end if;
 proposal:=visible->'proposal';
 -- Keep the old immutable approval and all historical owner decisions.
 update benchmark_native_spending_approvals set revoked_at=clock_timestamp() where id=bad.id;
 insert into benchmark_native_spending_approvals(
  owner_id,actor_id,chat_id,trial_id,account_id,repository,model,
  protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,
  developer_authority,previous_developer_approval_id)
 values(bad.owner_id,bad.actor_id,bad.chat_id,null,bad.account_id,bad.repository,bad.model,
  bad.protocol_digest,bad.max_tokens,(proposal->>'replacementDeadline')::timestamptz,
  bad.project_id,bad.mission_assignment_id,bad.task_id,
  bad.developer_authority||jsonb_build_object('task4aContinuationId',a.id,
   'task4aRecovery',jsonb_build_object(
    'version','preinference-invalid-handoff-v1','oldApprovalId',bad.id,
    'issueNumber',969,'runId',41673059705,'ownerConsentDigest',p_digest)),
  bad.id) returning * into child;
 update work_projects set status='running',lease=null,lease_until=null,impediment=null,
  detail='Owner-confirmed Task 4A native pre-inference authorization correction; same saved issue and task.' where id=p.id;
 update agent_missions set status='running',detail='Recovering one original Task 4A native pre-inference dispatch.' where id=m.id;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,
  detail='Original Task 4A native handoff failed before inference; owner-confirmed corrected dispatch.',
  available_at=now() where id=j.id;
 update agent_tasks set status='dispatching',details='Owner-confirmed continuation-bound native dispatch, original issue retained.'
  where id=t.id;
 if not task4a_native_authority_ready(p.id,t.id,a.id)
 then raise exception 'TASK4A_NATIVE_RECOVERY_AUTHORITY_NOT_LIVE';end if;
 insert into project_events(project_id,event,data) values(p.id,'task4a_native_pregrant_recovered',
  jsonb_build_object('version',1,'originalTaskId',t.id,'originalIssueNumber',969,
   'originalRunId',41673059705,'previousApprovalId',bad.id,
   'replacementApprovalId',child.id,'continuationId',a.id,'ownerId',p_owner,
   'consentDigest',p_digest,'originalApproval',to_jsonb(bad),
   'replacementApproval',to_jsonb(child),'proposal',proposal,
   'originalTaskExternal',t.external,'originalAssignmentResult',j.result,
   'paidCallsCreated',0,'accountReused',true,'limitsNotIncreased',true))
 returning id into receipt;
 perform project_publish(p.id,'Task 4A owner-confirmed native authority repair saved. Original issue #969 is eligible for a single bounded redispatch; protected preview remains required.');
 return jsonb_build_object('recovered',true,'receiptId',receipt,'projectId',p.id,
  'taskId',t.id,'originalIssueNumber',969,'oldApprovalId',bad.id,
  'newApprovalId',child.id,'continuationId',a.id,'nativeDeadline',child.deadline,
  'ownerConsentRecorded',true,'developmentDispatched',false);
end $function$;

-- Preserve Phase 1 task4a_pregrant_redispatch_ready with current append-only successor tip.
CREATE OR REPLACE FUNCTION public.task4a_pregrant_redispatch_ready(p_task uuid, p_approval uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare a benchmark_native_spending_approvals;t agent_tasks;
begin
 select * into a from benchmark_native_spending_approvals
  where id=p_approval and task_id=p_task;
 select * into t from agent_tasks where id=p_task;
 return coalesce(a.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
  and a.previous_developer_approval_id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid
  and a.developer_authority->'task4aRecovery'->>'version'='preinference-invalid-handoff-v1'
  and a.developer_authority->'task4aRecovery'->>'oldApprovalId'=a.previous_developer_approval_id::text
  and t.external->>'issueNumber'='969'
  and t.external->'receipt'->>'run_id'='41673059705'
  and t.external->'receipt'->>'outcome'='BLOCKED'
  and t.external->'receipt'->>'pr_url' is null
  and t.external->>'developerApprovalId' in (a.previous_developer_approval_id::text,a.id::text)
  and t.status in ('dispatching','submitted')
  and not exists(select 1 from benchmark_budget_calls c where c.account_id=a.account_id)
  and not exists(select 1 from benchmark_execution_grants g where g.developer_approval_id=a.id)
  and not exists(select 1 from mission_calls c join mission_assignments j on j.id=c.job_id
    where j.id=p_task)
  and a.revoked_at is null and a.consumed_at is null
  and a.deadline>clock_timestamp()
  and a.developer_authority->>'task4aContinuationId'=public.task4a_current_continuation_id(a.project_id)::text
  and exists(select 1 from benchmark_native_spending_approvals old
   where old.id=a.previous_developer_approval_id and old.revoked_at is not null
    and old.consumed_at is null)
  and exists(select 1 from project_events e where e.project_id=a.project_id
   and e.event='task4a_native_pregrant_recovered'
   and e.data->>'replacementApprovalId'=a.id::text
   and e.data->>'consentDigest'=a.developer_authority->'task4aRecovery'->>'ownerConsentDigest')
  and task4a_native_authority_ready(a.project_id,p_task,
   (a.developer_authority->>'task4aContinuationId')::uuid),false);
end $function$;
