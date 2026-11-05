-- Task 4A owner-governed recovery of an EXPIRED, watchdog-blocked original dispatch.
-- INSTALL ONLY. No production row is restored, no deadline or spending authority
-- is changed, and no GitHub workflow/provider call is made by this migration.
-- Owner consent and the subsequent paid-dispatch consent are distinct decisions.

create unique index if not exists task4a_one_blocked_dispatch_owner_recovery
 on public.project_events(project_id)
 where event='task4a_blocked_dispatch_owner_recovered';

create or replace function public.task4a_blocked_dispatch_audit_immutable()
returns trigger language plpgsql set search_path=public as $audit$
begin
 if old.event='task4a_blocked_dispatch_owner_recovered'
 then raise exception 'TASK4A_BLOCKED_DISPATCH_AUDIT_IMMUTABLE'; end if;
 return case when tg_op='DELETE' then old else new end;
end $audit$;
revoke all on function public.task4a_blocked_dispatch_audit_immutable() from public,anon,authenticated;
drop trigger if exists task4a_blocked_dispatch_audit_immutable on public.project_events;
create trigger task4a_blocked_dispatch_audit_immutable before update or delete
 on public.project_events for each row
 execute function public.task4a_blocked_dispatch_audit_immutable();

-- Fresh amounts are explicitly owner-entered. They cannot exceed the UNUSED
-- predecessor's token/call/money bounds or the original native account cap.
-- Both old spending instruments remain in the database after consent.
create or replace function public.task4a_blocked_dispatch_proposal(
 p_release text,p_deadline timestamptz,p_tokens bigint,p_calls integer,p_money numeric
) returns jsonb language plpgsql stable set search_path=public as $offer$
declare
 p public.work_projects; m public.agent_missions; j public.mission_assignments;
 t public.agent_tasks; r public.project_runs;
 prev public.project_continuation_authorizations;
 old_native public.benchmark_native_spending_approvals;
 acct public.benchmark_budget_accounts; claim public.project_events;
 pregrant public.project_events; owner uuid; candidate jsonb;
 hist_actual bigint; hist_reserved bigint; hist_calls bigint;
 settled_actual bigint; settled_reserved bigint; settled_conservative bigint; settled_calls bigint;
 unsettled bigint; reserved_exposure numeric; unpriced_exposure numeric; price public.model_registry;
begin
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into m from public.agent_missions where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid and project_id=p.id;
 select * into j from public.mission_assignments where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid and mission_id=m.id;
 select * into t from public.agent_tasks where id=j.id;
 select * into r from public.project_runs where project_id=p.id and mission_id=m.id;
 select * into prev from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id) and project_id=p.id;
 select * into old_native from public.benchmark_native_spending_approvals
  where id=(select (e.data->>'replacementApprovalId')::uuid from public.project_events e
   where e.project_id=p.id and e.event='task4a_native_pregrant_recovered') and project_id=p.id;
 select * into acct from public.benchmark_budget_accounts where id=old_native.account_id;
 select * into claim from public.project_events
  where id='283dd2c4-5bac-4804-b8ed-3358c22896b0'::uuid and project_id=p.id
   and event='developer_native_dispatch_claimed';
 select * into pregrant from public.project_events
  where project_id=p.id and event='task4a_native_pregrant_recovered';
 select * into price from public.model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 owner:=public.task4a_original_owner_id(p.actor_id,p.chat_id);

 if coalesce(p_release,'')!~'^[a-f0-9]{40}$'
  or p_deadline is null or p_deadline<=greatest(p.deadline,clock_timestamp()+interval '30 minutes')
  or p_deadline>clock_timestamp()+interval '48 hours'
  or p_tokens is null or p_tokens<180000 or p_tokens>240000
  or p_calls is null or p_calls<20 or p_calls>24
  or p_money is null or p_money<2520000 or p_money>9000000
  or p.id is null or p.status<>'blocked' or p.phase<>'development'
  or p.deadline<=clock_timestamp()-interval '60 days'
  or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash
  or p.repository_full_name is distinct from 'mfackrell/katie'
  or p.baseline_sha is distinct from '49c8a5f791e66c351436bb97839193b53d7a1cd1'
  or p.active_mission_id is distinct from m.id or m.status<>'blocked'
  or m.project_kind<>'development' or m.deadline is distinct from p.deadline
  or j.id is null or j.role<>'development' or j.status<>'failed'
  or t.status<>'dispatching' or t.repository_full_name is distinct from 'mfackrell/katie'
  or t.external->>'issueNumber' is distinct from '969'
  or t.external->>'developerApprovalId' is distinct from old_native.id::text
  or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or t.external->'receipt'->>'run_id' is distinct from '41673059705'
  or t.external->'receipt'->>'pr_url' is not null
  or t.external->>'developerReleaseSha' is distinct from claim.data->>'releaseSha'
  or r.binding->>'projectId' is distinct from p.id::text
  or r.binding->>'scopeHash' is distinct from p.approved_hash
  or r.binding->>'baselineSha' is distinct from p.baseline_sha
  or r.binding->>'contractHash' is distinct from 'e8b08da72779ae0d7e864ed57c5ecc76b03d1fce6ddc9e14815e9c4c3dff332e'
  or owner is null or old_native.owner_id is distinct from owner
  or old_native.previous_developer_approval_id is distinct from 'ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid
  or old_native.revoked_at is not null or old_native.consumed_at is not null
  or old_native.deadline>clock_timestamp()
  or old_native.model is distinct from 'gpt-5.3-codex'
  or old_native.developer_authority->'task4aRecovery'->>'version' is distinct from 'preinference-invalid-handoff-v1'
  or old_native.developer_authority->'task4aRecovery'->>'oldApprovalId' is distinct from 'ddccc7a1-743f-4031-8ecd-a6926568ca98'
  or old_native.developer_authority->>'task4aContinuationId' is distinct from prev.id::text
  or old_native.developer_authority->'binding' is distinct from r.binding
  or old_native.developer_authority->'limits'->>'cumulativeTokens' is distinct from '180000'
  or old_native.developer_authority->'limits'->>'ceilingMicrousd' is distinct from '2520000'
  or acct.id is null or acct.arm<>'developer' or acct.cap_tokens<>180000
  or acct.spent_tokens<>0 or acct.frozen_at is not null
  or acct.developer_project_id is distinct from p.id or acct.developer_task_id is distinct from t.id
  or prev.predecessor_id is distinct from '405ea82c-6f52-49e5-babf-891ecac64d14'::uuid
  or not exists(select 1 from public.project_events e where e.project_id=p.id
     and e.event='task4a_successor_continuation_authorized'
     and e.data->>'newAuthorityId'=prev.id::text)
  or prev.predecessor_id is distinct from '405ea82c-6f52-49e5-babf-891ecac64d14'::uuid
  or prev.deadline>clock_timestamp() or prev.revoked_at is not null
  or prev.incremental_tokens<180000 or prev.incremental_calls<20 or prev.incremental_microusd<2520000
  or p_tokens>prev.incremental_tokens or p_calls>prev.incremental_calls or p_money>prev.incremental_microusd
  or prev.assessment_reserve_tokens<>60000 or prev.completion_reserve_tokens<>60000
  or prev.assessment_reserve_calls<>6 or prev.completion_reserve_calls<>6
  or not ('openai:gpt-5.3-codex'=any(prev.allowed_models))
  or price.pricing_status is distinct from 'verified' or price.is_active is distinct from true
  or price.pricing_verified_at not between clock_timestamp()-interval '24 hours' and clock_timestamp()
  or price.pricing_input_per_1m<=0 or price.pricing_output_per_1m<=0
  or price.source_metadata->>'pricing_verification_source'
    is distinct from 'https://developers.openai.com/api/docs/models/gpt-5.3-codex'
  or pregrant.id is null or pregrant.data->>'replacementApprovalId' is distinct from old_native.id::text
  or pregrant.data->>'originalTaskId' is distinct from t.id::text
  or pregrant.data->>'accountReused' is distinct from 'true'
  or pregrant.data->>'limitsNotIncreased' is distinct from 'true'
  or pregrant.data->>'paidCallsCreated' is distinct from '0'
  or claim.id is null or claim.data->>'approvalId' is distinct from old_native.id::text
  or claim.data->>'taskId' is distinct from t.id::text
  or claim.created_at not between '2026-11-05T13:40:00Z'::timestamptz and '2026-11-05T14:00:00Z'::timestamptz
  or (select count(*) from public.project_events where project_id=p.id
     and event='developer_native_dispatch_claimed' and data->>'approvalId'=old_native.id::text)<>1
  or exists(select 1 from public.project_events where project_id=p.id
     and event in ('task4a_failed_dispatch_owner_authorized','task4a_failed_dispatch_recovery_claimed',
       'task4a_failed_dispatch_recovery_submitted','task4a_blocked_dispatch_owner_recovered'))
  or exists(select 1 from public.benchmark_native_spending_approvals
     where previous_developer_approval_id=old_native.id)
  or exists(select 1 from public.benchmark_execution_grants where project_id=p.id)
  or exists(select 1 from public.benchmark_budget_calls where account_id=acct.id)
  or exists(select 1 from public.mission_calls where job_id=t.id)
  or exists(select 1 from public.mission_calls where project_continuation_id=prev.id)
 then return jsonb_build_object('ready',false,'reason','original_blocked_dispatch_or_authority_ineligible');end if;

 select coalesce(sum(actual_tokens),0),coalesce(sum(reserved_tokens),0),
  coalesce(sum(calls+routing_calls),0)
  into hist_actual,hist_reserved,hist_calls
  from public.agent_missions where project_id=p.id;
 select coalesce(sum(c.actual_tokens),0),coalesce(sum(c.reserved_tokens),0),
  coalesce(sum(greatest(c.actual_tokens,c.reserved_tokens)),0),
  count(*),count(*) filter(where c.status<>'completed' or c.actual_tokens is null
     or (c.project_actual_microusd is not null and
         c.project_actual_microusd>coalesce(c.project_reserved_microusd,0))),
  coalesce(sum(c.project_reserved_microusd),0),
  coalesce(sum(case when c.project_continuation_id is not null and c.project_actual_microusd is null
       then c.project_reserved_microusd else 0 end),0)
  into settled_actual,settled_reserved,settled_conservative,settled_calls,unsettled,
    reserved_exposure,unpriced_exposure
  from public.mission_calls c join public.mission_assignments ja on ja.id=c.job_id
  join public.agent_missions ma on ma.id=ja.mission_id where ma.project_id=p.id;
 if hist_actual is distinct from settled_actual or hist_calls is distinct from settled_calls
  or hist_reserved<hist_actual or unsettled<>0
  or greatest(hist_actual,hist_reserved,settled_conservative)+p_tokens>p.token_allowance
 then return jsonb_build_object('ready',false,'reason','historical_accounting_unreconciled'); end if;
 candidate:=jsonb_build_object(
  'version',1,'kind','task4a_blocked_dispatch_owner_governed_recovery',
  'projectId',p.id,'missionId',m.id,'taskId',t.id,'issueNumber',969,
  'ownerId',owner,'actorId',p.actor_id,'chatId',p.chat_id,
  'productionReleaseSha',p_release,
  'previousProjectDeadline',p.deadline,'previousMissionDeadline',m.deadline,
  'previousContinuationId',prev.id,'previousNativeApprovalId',old_native.id,
  'originalFailedClaimId',claim.id,'originalFailedClaimAt',claim.created_at,
  'originalNativeAccountId',acct.id,
  'scopeHash',p.approved_hash,'baselineSha',p.baseline_sha,'contractHash',r.binding->>'contractHash',
  'newDeadline',p_deadline,'incrementalTokens',p_tokens,'incrementalCalls',p_calls,
  'incrementalMicrousd',p_money,'assessmentReserveTokens',prev.assessment_reserve_tokens,
  'completionReserveTokens',prev.completion_reserve_tokens,
  'assessmentReserveCalls',prev.assessment_reserve_calls,
  'completionReserveCalls',prev.completion_reserve_calls,
  'allowedModels',to_jsonb(prev.allowed_models),
  'priceEvidence',jsonb_build_object('model','openai:gpt-5.3-codex',
    'verifiedAt',price.pricing_verified_at,
    'source',price.source_metadata->>'pricing_verification_source',
    'inputPerMillionUsd',price.pricing_input_per_1m,'outputPerMillionUsd',price.pricing_output_per_1m),
  'nativeLimits',old_native.developer_authority->'limits',
  'historicalActualTokens',hist_actual,'historicalReservedTokens',hist_reserved,
  'historicalConservativeTokens',greatest(hist_actual,hist_reserved,settled_conservative),
  'historicalReservedExposureMicrousd',reserved_exposure,
  'historicalUnpricedExposureMicrousd',unpriced_exposure,
  'historicalCalls',hist_calls,'historicalSettledTokens',settled_actual,
  'historicalSettledCalls',settled_calls,
  'requiresSeparatePaidDispatchConsent',true,
  'oneTimeStateRestore',true,'noProviderCallsOnConsent',true,'noProductionAppPublication',true);
 return jsonb_build_object('ready',true,'proposal',candidate,
  'digest',encode(sha256(convert_to(public.project_canonical(candidate),'UTF8')),'hex'));
end $offer$;
revoke all on function public.task4a_blocked_dispatch_proposal(text,timestamptz,bigint,integer,numeric) from public,anon,authenticated;
grant execute on function public.task4a_blocked_dispatch_proposal(text,timestamptz,bigint,integer,numeric) to service_role;

-- One owner decision: new project/mission deadline, a unique successor to the
-- expired continuation, a single child of the expired native approval, and an
-- exact restore of blocked project+mission+assignment. All in one transaction.
create or replace function public.task4a_authorize_blocked_dispatch(
 p_owner uuid,p_digest text,p_release text,p_deadline timestamptz,
 p_tokens bigint,p_calls integer,p_money numeric
) returns jsonb language plpgsql security invoker set search_path=public as $consent$
declare offer jsonb; plan jsonb; p public.work_projects; m public.agent_missions;
 j public.mission_assignments; t public.agent_tasks;
 prior public.project_continuation_authorizations;
 old_native public.benchmark_native_spending_approvals;
 child uuid; successor uuid; receipt uuid; old_external jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into m from public.agent_missions where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid for update;
 select * into j from public.mission_assignments where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid for update;
 select * into t from public.agent_tasks where id=j.id for update;
 select * into prior from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id) for update;
 select * into old_native from public.benchmark_native_spending_approvals
  where id=(select (e.data->>'replacementApprovalId')::uuid from public.project_events e
   where e.project_id=p.id and e.event='task4a_native_pregrant_recovered') for update;
 offer:=public.task4a_blocked_dispatch_proposal(p_release,p_deadline,p_tokens,p_calls,p_money);
 if p_owner is null or p_owner is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)
  or offer->>'ready' is distinct from 'true' or offer->>'digest' is distinct from p_digest
  or (offer->'proposal'->>'previousContinuationId') is distinct from prior.id::text
  or (offer->'proposal'->>'previousNativeApprovalId') is distinct from old_native.id::text
 then raise exception 'TASK4A_BLOCKED_DISPATCH_OWNER_CONSENT_DENIED';end if;
 plan:=offer->'proposal';old_external:=t.external;
 insert into public.project_continuation_authorizations(
  project_id,actor_id,chat_id,source_mission_id,approval_digest,deadline,
  incremental_tokens,incremental_calls,incremental_microusd,
  assessment_reserve_tokens,completion_reserve_tokens,assessment_reserve_calls,completion_reserve_calls,
  allowed_models,historical_tokens,historical_calls,historical_mission_deadline,
  pricing_evidence,predecessor_id)
 values(p.id,p.actor_id,p.chat_id,prior.source_mission_id,p_digest,p_deadline,
  p_tokens,p_calls,p_money,prior.assessment_reserve_tokens,prior.completion_reserve_tokens,
  prior.assessment_reserve_calls,prior.completion_reserve_calls,prior.allowed_models,
  (plan->>'historicalActualTokens')::bigint,(plan->>'historicalCalls')::integer,
  prior.historical_mission_deadline,jsonb_build_array(plan->'priceEvidence'),prior.id)
 returning id into successor;
 update public.work_projects set status='running',deadline=p_deadline,lease=null,lease_until=null,
  impediment=null,detail='Owner-authorized exact failed-dispatch recovery; separate dispatch approval required.',
  updated_at=clock_timestamp() where id=p.id;
 update public.agent_missions set status='running',deadline=p_deadline,
  detail='Original Task 4A recovered under renewed owner-approved deadline.',
  updated_at=clock_timestamp() where id=m.id;
 update public.mission_assignments set status='waiting_external',lease=null,lease_until=null,
  available_at=clock_timestamp(),detail='Owner-governed recovery; awaiting distinct one-time dispatch consent.'
  where id=j.id;
 update public.benchmark_native_spending_approvals set revoked_at=clock_timestamp()
  where id=old_native.id;
 insert into public.benchmark_native_spending_approvals(
  owner_id,actor_id,chat_id,trial_id,account_id,repository,model,
  protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,
  developer_authority,previous_developer_approval_id)
 values(old_native.owner_id,old_native.actor_id,old_native.chat_id,null,old_native.account_id,
  old_native.repository,old_native.model,old_native.protocol_digest,old_native.max_tokens,
  p_deadline,old_native.project_id,old_native.mission_assignment_id,old_native.task_id,
  old_native.developer_authority||jsonb_build_object('task4aContinuationId',successor,
    'task4aOwnerRenewal',jsonb_build_object('version','blocked-dispatch-owner-v1',
      'previousApprovalId',old_native.id,'previousContinuationId',prior.id,
      'consentDigest',p_digest,'originalClaimId',plan->>'originalFailedClaimId',
      'issueNumber',969,'productionReleaseSha',p_release)),
  old_native.id)
 returning id into child;
 update public.agent_tasks set
  external=old_external||jsonb_build_object('developerApprovalId',child,
    'task4aBlockedOwnerRecoveryPendingDispatch',true),
  details='Original failed claim retained; newly approved authority awaiting separate dispatch consent.',
  updated_at=clock_timestamp() where id=t.id;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_blocked_dispatch_owner_recovered',
  jsonb_build_object('version',1,'ownerId',p_owner,'consentDigest',p_digest,
   'proposal',plan,'previousContinuationId',prior.id,'newContinuationId',successor,
   'previousNativeApprovalId',old_native.id,'newNativeApprovalId',child,
   'originalFailedClaimId',plan->>'originalFailedClaimId',
   'originalTaskExternal',old_external,'previousProjectDeadline',p.deadline,
   'previousMissionDeadline',m.deadline,'previousAssignmentStatus',j.status,
   'previousProjectStatus',p.status,'previousMissionStatus',m.status,
   'historicalActualTokens',plan->'historicalActualTokens',
   'historicalCalls',plan->'historicalCalls',
   'nativeAccountReused',true,'nativeLimitsNotIncreased',true,
   'historicalClaimPreserved',true,'newPaidCalls',0,
   'separateDispatchConsentRequired',true,'newProjectCreated',false))
 returning id into receipt;
 if not public.task4a_native_authority_ready(p.id,t.id,successor)
 then raise exception 'TASK4A_OWNER_RENEWED_NATIVE_AUTHORITY_NOT_READY';end if;
 return jsonb_build_object('authorized',true,'receiptId',receipt,
  'projectId',p.id,'missionId',m.id,'taskId',t.id,'issueNumber',969,
  'newContinuationId',successor,'newNativeApprovalId',child,
  'newDeadline',p_deadline,'newPaidCalls',0,
  'dispatchAuthorized',false,'requiresSeparatePaidExecutionConsent',true);
end $consent$;
revoke all on function public.task4a_authorize_blocked_dispatch(uuid,text,text,timestamptz,bigint,integer,numeric) from public,anon,authenticated;
grant execute on function public.task4a_authorize_blocked_dispatch(uuid,text,text,timestamptz,bigint,integer,numeric) to service_role;

-- A prior native approval must never become valid merely by rewriting its
-- deadline. Only the new single child bound to the immutable owner receipt
-- may clear the existing deferred developer-decision guard.
create or replace function public.task4a_blocked_dispatch_native_decision_allowed(
 a public.benchmark_native_spending_approvals
) returns boolean language plpgsql stable set search_path=public as $guard$
declare old public.benchmark_native_spending_approvals;
 prev public.project_continuation_authorizations;
 current_auth public.project_continuation_authorizations;
 renewal_receipt public.project_events; original_claim public.project_events;
begin
 if a.project_id is distinct from '6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
  or a.task_id is distinct from 'd0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid
  or a.previous_developer_approval_id is distinct from
     (select (e.data->>'replacementApprovalId')::uuid from public.project_events e
      where e.project_id=a.project_id and e.event='task4a_native_pregrant_recovered')
  or a.developer_authority->'task4aOwnerRenewal'->>'version' is distinct from 'blocked-dispatch-owner-v1'
  or a.developer_proposal_id is not null or a.revoked_at is not null or a.consumed_at is not null
  or a.trial_id is not null then return false;end if;
 select * into old from public.benchmark_native_spending_approvals where id=a.previous_developer_approval_id;
 select * into current_auth from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(a.project_id);
 select * into prev from public.project_continuation_authorizations where id=current_auth.predecessor_id;
 select * into renewal_receipt from public.project_events
  where project_id=a.project_id and event='task4a_blocked_dispatch_owner_recovered';
 select * into original_claim from public.project_events
  where id='283dd2c4-5bac-4804-b8ed-3358c22896b0'::uuid
    and project_id=a.project_id and event='developer_native_dispatch_claimed';
 return coalesce(
  old.id is not null and old.revoked_at is not null and old.consumed_at is null
  and old.previous_developer_approval_id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid
  and prev.predecessor_id='405ea82c-6f52-49e5-babf-891ecac64d14'::uuid
  and current_auth.revoked_at is null and current_auth.deadline>clock_timestamp()
  and a.deadline>clock_timestamp() and a.deadline<=current_auth.deadline
  and a.owner_id=old.owner_id and a.actor_id=old.actor_id and a.chat_id=old.chat_id
  and a.account_id=old.account_id and a.project_id=old.project_id and a.task_id=old.task_id
  and a.repository=old.repository and a.model=old.model and a.model='gpt-5.3-codex'
  and a.protocol_digest=old.protocol_digest and a.max_tokens=old.max_tokens
  and a.mission_assignment_id=old.mission_assignment_id
  and a.developer_authority->'limits'=old.developer_authority->'limits'
  and a.developer_authority->'binding'=old.developer_authority->'binding'
  and a.developer_authority->>'scopeHash'=old.developer_authority->>'scopeHash'
  and a.developer_authority->>'task4aContinuationId'=current_auth.id::text
  and a.developer_authority->'task4aOwnerRenewal'->>'previousApprovalId'=old.id::text
  and a.developer_authority->'task4aOwnerRenewal'->>'previousContinuationId'=prev.id::text
  and a.developer_authority->'task4aOwnerRenewal'->>'originalClaimId'=original_claim.id::text
  and renewal_receipt.id is not null and renewal_receipt.data->>'newNativeApprovalId'=a.id::text
  and renewal_receipt.data->>'newContinuationId'=current_auth.id::text
  and renewal_receipt.data->>'previousNativeApprovalId'=old.id::text
  and renewal_receipt.data->>'ownerId'=a.owner_id::text
  and renewal_receipt.data->>'consentDigest'=a.developer_authority->'task4aOwnerRenewal'->>'consentDigest'
  and renewal_receipt.data->>'originalFailedClaimId'=original_claim.id::text
  and renewal_receipt.data->>'nativeAccountReused'='true'
  and renewal_receipt.data->>'nativeLimitsNotIncreased'='true'
  and renewal_receipt.data->>'newPaidCalls'='0'
  and original_claim.data->>'approvalId'=old.id::text
  and not exists(select 1 from public.benchmark_budget_calls c where c.account_id=a.account_id)
  and not exists(select 1 from public.benchmark_execution_grants g where g.project_id=a.project_id)
  and not exists(select 1 from public.mission_calls c where c.job_id=a.task_id)
  and public.task4a_native_authority_ready(a.project_id,a.task_id,current_auth.id)
 ,false);
end $guard$;
revoke all on function public.task4a_blocked_dispatch_native_decision_allowed(public.benchmark_native_spending_approvals) from public,anon,authenticated;

-- Append only this narrowly verified case to the EXISTING developer-decision
-- trigger. The ordinary/lifecycle and original pregrant guards remain exact.
do $patch_guard$
declare previous_definition text; anchor text;
begin
 previous_definition:=pg_get_functiondef('public.developer_approval_decision_guard()'::regprocedure);
 anchor:=' raise exception ''Ordinary authority requires its committed exact owner decision'';';
 if position('task4a_blocked_dispatch_native_decision_allowed(new::public.benchmark_native_spending_approvals)' in previous_definition)>0
 then return;end if;
 if position(anchor in previous_definition)=0
 then raise exception 'TASK4A_OWNER_RECOVERY_UNEXPECTED_DEVELOPER_GUARD';end if;
 execute replace(previous_definition,anchor,
  ' if public.task4a_blocked_dispatch_native_decision_allowed(new::public.benchmark_native_spending_approvals) then return new;end if;'||
  E'\n'||anchor);
end $patch_guard$;

-- Preserve the old pregrant path, and accept only the new chained approval
-- once its independent owner recovery is committed and still live.
create or replace function public.task4a_pregrant_redispatch_ready(p_task uuid,p_approval uuid)
returns boolean language plpgsql stable set search_path=public as $ready$
declare a public.benchmark_native_spending_approvals;
 old public.benchmark_native_spending_approvals;
 t public.agent_tasks; s uuid;
begin
 select * into a from public.benchmark_native_spending_approvals where id=p_approval and task_id=p_task;
 select * into t from public.agent_tasks where id=p_task;
 s:=public.task4a_current_continuation_id(a.project_id);
 if a.id is null or t.id is null or a.project_id is distinct from '6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
  or t.external->>'issueNumber' is distinct from '969'
  or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or t.external->'receipt'->>'run_id' is distinct from '41673059705'
  or t.external->'receipt'->>'pr_url' is not null
  or t.status not in ('dispatching','submitted')
  or a.revoked_at is not null or a.consumed_at is not null or a.deadline<=clock_timestamp()
  or a.developer_authority->>'task4aContinuationId' is distinct from s::text
  or exists(select 1 from public.benchmark_budget_calls where account_id=a.account_id)
  or exists(select 1 from public.benchmark_execution_grants where project_id=a.project_id)
  or exists(select 1 from public.mission_calls where job_id=p_task)
  or not public.task4a_native_authority_ready(a.project_id,p_task,s)
 then return false;end if;
 select * into old from public.benchmark_native_spending_approvals where id=a.previous_developer_approval_id;
 if a.previous_developer_approval_id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid
 then
  return coalesce(old.revoked_at is not null and old.consumed_at is null
   and a.developer_authority->'task4aRecovery'->>'version'='preinference-invalid-handoff-v1'
   and t.external->>'developerApprovalId' in (old.id::text,a.id::text)
   and exists(select 1 from public.project_events e where e.project_id=a.project_id
     and e.event='task4a_native_pregrant_recovered'
     and e.data->>'replacementApprovalId'=a.id::text
     and e.data->>'consentDigest'=a.developer_authority->'task4aRecovery'->>'ownerConsentDigest'),false);
 end if;
 if a.previous_developer_approval_id=(
     select (e.data->>'replacementApprovalId')::uuid from public.project_events e
      where e.project_id=a.project_id and e.event='task4a_native_pregrant_recovered')
 then
  return coalesce(old.revoked_at is not null and old.consumed_at is null
   and t.external->>'developerApprovalId'=a.id::text
   and a.developer_authority->'task4aOwnerRenewal'->>'version'='blocked-dispatch-owner-v1'
   and exists(select 1 from public.project_events e where e.project_id=a.project_id
    and e.event='task4a_blocked_dispatch_owner_recovered'
    and e.data->>'newNativeApprovalId'=a.id::text
    and e.data->>'newContinuationId'=s::text
    and e.data->>'consentDigest'=a.developer_authority->'task4aOwnerRenewal'->>'consentDigest')
   and exists(select 1 from public.project_events e where e.project_id=a.project_id
    and e.event='task4a_native_pregrant_recovered'
    and e.data->>'replacementApprovalId'=old.id::text),false);
 end if;
 return false;
end $ready$;
revoke all on function public.task4a_pregrant_redispatch_ready(uuid,uuid) from public,anon,authenticated;
grant execute on function public.task4a_pregrant_redispatch_ready(uuid,uuid) to service_role;

-- The pre-existing one-shot dispatch operation remains a SECOND owner gate.
-- Its proposal now recognizes a renewed, signed child approval while requiring
-- the SAME immutable failed claim and zero prior external/native acceptance.
create or replace function public.task4a_failed_dispatch_proposal(p_release text)
returns jsonb language plpgsql stable set search_path=public as $one_shot$
declare
 p public.work_projects; m public.agent_missions; j public.mission_assignments;
 t public.agent_tasks; r public.project_runs;
 a public.benchmark_native_spending_approvals; root public.benchmark_native_spending_approvals;
 legacy public.benchmark_native_spending_approvals;
 acct public.benchmark_budget_accounts; s public.project_continuation_authorizations;
 old_claim public.project_events; pregrant public.project_events;
 renewed_event public.project_events; price public.model_registry;
 owner uuid; renewed boolean; signed_approval uuid; proposal jsonb;
begin
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into m from public.agent_missions where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid and project_id=p.id;
 select * into j from public.mission_assignments where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid and mission_id=m.id;
 select * into t from public.agent_tasks where id=j.id;
 select * into r from public.project_runs where project_id=p.id and mission_id=m.id;
 select * into s from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id) and project_id=p.id;
 select * into a from public.benchmark_native_spending_approvals
  where project_id=p.id and task_id=t.id and revoked_at is null and consumed_at is null
   and developer_authority->>'task4aContinuationId'=s.id::text;
 select * into root from public.benchmark_native_spending_approvals
  where id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid;
 select * into legacy from public.benchmark_native_spending_approvals
  where id=(select (e.data->>'replacementApprovalId')::uuid from public.project_events e
   where e.project_id=p.id and e.event='task4a_native_pregrant_recovered');
 select * into acct from public.benchmark_budget_accounts where id=a.account_id;
 select * into pregrant from public.project_events where project_id=p.id and event='task4a_native_pregrant_recovered';
 select * into renewed_event from public.project_events where project_id=p.id and event='task4a_blocked_dispatch_owner_recovered';
 select * into price from public.model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 owner:=public.task4a_original_owner_id(p.actor_id,p.chat_id);
 renewed:=coalesce(a.developer_authority->'task4aOwnerRenewal'->>'version'='blocked-dispatch-owner-v1',false);
 signed_approval:=case when renewed then legacy.id else a.id end;
 select * into old_claim from public.project_events where project_id=p.id
  and event='developer_native_dispatch_claimed'
  and data->>'approvalId'=signed_approval::text
  and created_at between '2026-11-05T13:40:00Z'::timestamptz and '2026-11-05T14:00:00Z'::timestamptz;
 if coalesce(p_release,'')!~'^[a-f0-9]{40}$'
  or p.id is null or p.status<>'running' or p.phase<>'development'
  or p.deadline<=clock_timestamp()+interval '5 minutes'
  or p.repository_full_name is distinct from 'mfackrell/katie'
  or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash
  or p.active_mission_id is distinct from m.id or m.status<>'running'
  or m.project_kind<>'development' or j.id is null or j.role<>'development'
  or j.status<>'waiting_external'
  or t.status<>'dispatching' or t.repository_full_name is distinct from 'mfackrell/katie'
  or t.external->>'issueNumber' is distinct from '969'
  or t.external->>'developerApprovalId' is distinct from a.id::text
  or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or t.external->'receipt'->>'run_id' is distinct from '41673059705'
  or t.external->'receipt'->>'pr_url' is not null
  or t.external->>'developerReleaseSha' is distinct from old_claim.data->>'releaseSha'
  or r.binding->>'projectId' is distinct from p.id::text
  or r.binding->>'scopeHash' is distinct from p.approved_hash
  or r.binding->>'baselineSha' is distinct from p.baseline_sha
  or r.binding->>'contractHash' is distinct from 'e8b08da72779ae0d7e864ed57c5ecc76b03d1fce6ddc9e14815e9c4c3dff332e'
  or a.id is null or a.model is distinct from 'gpt-5.3-codex'
  or a.owner_id is distinct from owner or owner is null
  or a.deadline<=clock_timestamp()+interval '5 minutes'
  or a.developer_authority->'task4aRecovery'->>'version' is distinct from 'preinference-invalid-handoff-v1'
  or a.developer_authority->>'scopeHash' is distinct from p.approved_hash
  or a.developer_authority->'binding' is distinct from r.binding
  or a.developer_authority->'limits'->>'cumulativeTokens' is distinct from '180000'
  or a.developer_authority->'limits'->>'ceilingMicrousd' is distinct from '2520000'
  or root.id is null or root.revoked_at is null or root.consumed_at is not null
  or legacy.id is null or legacy.owner_id is distinct from owner
  or legacy.account_id is distinct from a.account_id
  or legacy.previous_developer_approval_id is distinct from root.id
  or pregrant.id is null or pregrant.data->>'replacementApprovalId' is distinct from legacy.id::text
  or pregrant.data->>'ownerId' is distinct from owner::text
  or pregrant.data->>'paidCallsCreated' is distinct from '0'
  or pregrant.data->>'accountReused' is distinct from 'true'
  or pregrant.data->>'limitsNotIncreased' is distinct from 'true'
  or acct.id is null or acct.arm<>'developer' or acct.frozen_at is not null
  or acct.developer_project_id is distinct from p.id or acct.developer_task_id is distinct from t.id
  or acct.cap_tokens<>180000 or acct.spent_tokens<>0
  or s.id is null or s.revoked_at is not null or s.deadline<=clock_timestamp()+interval '5 minutes'
  or 'openai:gpt-5.3-codex'<>all(s.allowed_models)
  or price.pricing_status is distinct from 'verified' or price.is_active is distinct from true
  or price.pricing_verified_at not between clock_timestamp()-interval '24 hours' and clock_timestamp()
  or price.source_metadata->>'pricing_verification_source'
   is distinct from 'https://developers.openai.com/api/docs/models/gpt-5.3-codex'
  or old_claim.id is null or old_claim.data->>'taskId' is distinct from t.id::text
  or (select count(*) from public.project_events where project_id=p.id
       and event='developer_native_dispatch_claimed'
       and data->>'approvalId'=signed_approval::text)<>1
  or exists(select 1 from public.project_events where project_id=p.id
       and event in ('task4a_failed_dispatch_recovery_claimed','task4a_failed_dispatch_recovery_submitted'))
  or exists(select 1 from public.benchmark_execution_grants where project_id=p.id)
  or exists(select 1 from public.benchmark_budget_calls where account_id=acct.id)
  or exists(select 1 from public.mission_calls where job_id=t.id)
  or exists(select 1 from public.benchmark_native_spending_approvals
       where previous_developer_approval_id=a.id)
  or not public.task4a_native_authority_ready(p.id,t.id,s.id)
  or not public.task4a_pregrant_redispatch_ready(t.id,a.id)
 then return jsonb_build_object('ready',false,'reason','original_claim_or_authority_ineligible');end if;
 if renewed then
  if a.previous_developer_approval_id is distinct from legacy.id
   or legacy.revoked_at is null or legacy.consumed_at is not null
   or s.predecessor_id is distinct from (renewed_event.data->>'previousContinuationId')::uuid
   or renewed_event.id is null
   or renewed_event.data->>'newNativeApprovalId' is distinct from a.id::text
   or renewed_event.data->>'newContinuationId' is distinct from s.id::text
   or renewed_event.data->>'previousNativeApprovalId' is distinct from legacy.id::text
   or renewed_event.data->>'originalFailedClaimId' is distinct from old_claim.id::text
   or renewed_event.data->>'nativeLimitsNotIncreased' is distinct from 'true'
   or renewed_event.data->>'newPaidCalls' is distinct from '0'
   or a.developer_authority->'task4aOwnerRenewal'->>'consentDigest'
      is distinct from renewed_event.data->>'consentDigest'
  then return jsonb_build_object('ready',false,'reason','renewal_owner_receipt_ineligible');end if;
 else
  if a.id is distinct from legacy.id
   or a.previous_developer_approval_id is distinct from root.id
   or s.predecessor_id is distinct from '405ea82c-6f52-49e5-babf-891ecac64d14'::uuid
   or renewed_event.id is not null
  then return jsonb_build_object('ready',false,'reason','original_pregrant_path_ineligible');end if;
 end if;
 proposal:=jsonb_build_object(
  'version',2,'kind','task4a_one_time_failed_github_dispatch',
  'projectId',p.id,'missionId',m.id,'taskId',t.id,'issueNumber',969,
  'ownerId',owner,'originalClaimId',old_claim.id,'originalClaimAt',old_claim.created_at,
  'originalReleaseSha',old_claim.data->>'releaseSha',
  'newProductionReleaseSha',p_release,'approvalId',a.id,
  'previousApprovalId',a.previous_developer_approval_id,
  'originalSignedApprovalId',signed_approval,
  'continuationId',s.id,'accountId',acct.id,
  'scopeHash',p.approved_hash,'baselineSha',p.baseline_sha,
  'model','openai:gpt-5.3-codex',
  'nativeLimits',a.developer_authority->'limits',
  'projectDeadline',p.deadline,'expiresAt',least(p.deadline,a.deadline,s.deadline),
  'ownerRenewalReceiptId',case when renewed then renewed_event.id else null end,
  'singleGithubWorkflowDispatch',true,
  'mayUseExistingPaidNativeAccount',true,
  'noAdditionalTokenCallOrDollarGrant',true,
  'noProductionAppPublication',true);
 return jsonb_build_object('ready',true,'proposal',proposal,
  'digest',encode(sha256(convert_to(public.project_canonical(proposal),'UTF8')),'hex'));
end $one_shot$;
revoke all on function public.task4a_failed_dispatch_proposal(text) from public,anon,authenticated;
grant execute on function public.task4a_failed_dispatch_proposal(text) to service_role;
