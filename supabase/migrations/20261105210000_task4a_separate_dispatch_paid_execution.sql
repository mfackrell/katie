-- Task 4A: recovery of the failed GitHub request and paid execution are TWO
-- independent original-owner decisions. No DML here touches live project state.
-- This migration follows #1006 and preserves every prior claim and receipt.

create unique index if not exists task4a_one_paid_execution_consent
 on public.project_events(project_id)
 where event='task4a_failed_dispatch_paid_execution_authorized';

create or replace function public.task4a_paid_execution_receipt_immutable()
returns trigger language plpgsql set search_path=public as $task4a_paid_immutable$
begin
 if old.event='task4a_failed_dispatch_paid_execution_authorized' then
  raise exception 'TASK4A_PAID_EXECUTION_RECEIPT_IMMUTABLE';
 end if;
 return case when tg_op='DELETE' then old else new end;
end $task4a_paid_immutable$;
revoke all on function public.task4a_paid_execution_receipt_immutable() from public,anon,authenticated;
drop trigger if exists task4a_paid_execution_receipt_immutable on public.project_events;
create trigger task4a_paid_execution_receipt_immutable
 before update or delete on public.project_events for each row
 execute function public.task4a_paid_execution_receipt_immutable();

-- The first consent is strictly non-executing. A previous, older combined
-- receipt is NOT sufficient to satisfy the new second-approval gate.
create or replace function public.task4a_authorize_failed_dispatch(
 p_owner uuid,p_digest text,p_release text
) returns jsonb language plpgsql security invoker set search_path=public as $task4a_recovery_only$
declare offer jsonb;p public.work_projects;receipt uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 offer:=public.task4a_failed_dispatch_proposal(p_release);
 if offer->>'ready' is distinct from 'true'
  or offer->>'digest' is distinct from p_digest
  or p_owner is distinct from (offer->'proposal'->>'ownerId')::uuid
  or p_owner is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)
  or exists(select 1 from public.project_events where project_id=p.id and event in
   ('task4a_failed_dispatch_owner_authorized',
    'task4a_failed_dispatch_paid_execution_authorized',
    'task4a_failed_dispatch_recovery_claimed',
    'task4a_failed_dispatch_recovery_submitted'))
 then raise exception 'TASK4A_FAILED_DISPATCH_OWNER_CONSENT_DENIED';end if;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_failed_dispatch_owner_authorized',
  jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,
   'proposal',offer->'proposal','originalClaimId',offer->'proposal'->>'originalClaimId',
   'decisionKind','failed_dispatch_recovery_only','recoveryOnly',true,
   'dispatchAuthorized',false,'paidExecutionAuthorized',false,
   'oneDispatchMayStartPaidExecution',false,'executionGrantsCreated',0,
   'paidCallsCreated',0,'existingNativeCeilingUnchanged',true))
 returning id into receipt;
 return jsonb_build_object('authorized',true,'receiptId',receipt,
  'recoveryOnly',true,'dispatchAuthorized',false,'paidExecutionAuthorized',false,
  'newExecutionGrants',0,'newPaidCalls',0,'originalIssue',969);
end $task4a_recovery_only$;
revoke all on function public.task4a_authorize_failed_dispatch(uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.task4a_authorize_failed_dispatch(uuid,text,text) to service_role;

-- Read-only, freshly bound to the recovery receipt, current release, price,
-- deadline and exact existing account. Never creates grants or paid calls.
create or replace function public.task4a_paid_execution_proposal(p_release text)
returns jsonb language plpgsql stable set search_path=public as $task4a_paid_offer$
declare
 offer jsonb;recovery public.project_events;p public.work_projects;
 a public.benchmark_native_spending_approvals;
 acct public.benchmark_budget_accounts;s public.project_continuation_authorizations;
 price public.model_registry;proposal jsonb;limits jsonb;
begin
 offer:=public.task4a_failed_dispatch_proposal(p_release);
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into recovery from public.project_events
  where project_id=p.id and event='task4a_failed_dispatch_owner_authorized';
 select * into a from public.benchmark_native_spending_approvals
  where id=(offer->'proposal'->>'approvalId')::uuid;
 select * into acct from public.benchmark_budget_accounts where id=a.account_id;
 select * into s from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id);
 select * into price from public.model_registry
  where provider_name='openai' and model_id='gpt-5.3-codex';
 limits:=a.developer_authority->'limits';
 if offer->>'ready' is distinct from 'true'
  or recovery.id is null
  or recovery.data->>'decisionKind' is distinct from 'failed_dispatch_recovery_only'
  or recovery.data->>'recoveryOnly' is distinct from 'true'
  or recovery.data->>'dispatchAuthorized' is distinct from 'false'
  or recovery.data->>'paidExecutionAuthorized' is distinct from 'false'
  or recovery.data->>'oneDispatchMayStartPaidExecution' is distinct from 'false'
  or recovery.data->>'paidCallsCreated' is distinct from '0'
  or recovery.data->>'executionGrantsCreated' is distinct from '0'
  or recovery.data->>'consentDigest' is distinct from offer->>'digest'
  or recovery.data->'proposal' is distinct from offer->'proposal'
  or recovery.data->>'ownerId' is distinct from offer->'proposal'->>'ownerId'
  or recovery.data->>'originalClaimId' is distinct from
     offer->'proposal'->>'originalClaimId'
  or a.id is null or a.id::text is distinct from offer->'proposal'->>'approvalId'
  or a.owner_id::text is distinct from recovery.data->>'ownerId'
  or a.account_id::text is distinct from offer->'proposal'->>'accountId'
  or a.consumed_at is not null or a.revoked_at is not null
  or a.deadline<=clock_timestamp()+interval '5 minutes'
  or acct.id is null or acct.arm is distinct from 'developer'
  or acct.frozen_at is not null or acct.cap_tokens is distinct from 180000
  or acct.spent_tokens is distinct from 0
  or s.id is null or s.revoked_at is not null
  or s.deadline<=clock_timestamp()+interval '5 minutes'
  or s.id::text is distinct from offer->'proposal'->>'continuationId'
  or s.incremental_tokens<180000 or s.incremental_calls<20
  or s.incremental_microusd<2520000
  or p.deadline<=clock_timestamp()+interval '5 minutes'
  or price.pricing_status is distinct from 'verified'
  or price.is_active is distinct from true
  or price.pricing_verified_at not between
    clock_timestamp()-interval '24 hours' and clock_timestamp()
  or price.source_metadata->>'pricing_verification_source' is distinct from
    'https://developers.openai.com/api/docs/models/gpt-5.3-codex'
  or coalesce(price.pricing_input_per_1m between 0.000001 and 28,false) is distinct from true
  or coalesce(price.pricing_output_per_1m between 0.000001 and 28,false) is distinct from true
  or limits->>'cumulativeTokens' is distinct from '180000'
  or limits->>'ceilingMicrousd' is distinct from '2520000'
  or not exists(select 1 from public.project_events
      where project_id=p.id and event='developer_native_dispatch_claimed'
      and id=(offer->'proposal'->>'originalClaimId')::uuid)
  or exists(select 1 from public.benchmark_execution_grants where project_id=p.id)
  or exists(select 1 from public.benchmark_budget_calls where account_id=acct.id)
  or exists(select 1 from public.benchmark_dollar_exposures where account_id=acct.id)
  or exists(select 1 from public.mission_calls where job_id=a.task_id)
 then return jsonb_build_object('ready',false,'reason','distinct_paid_consent_evidence_ineligible');end if;
 proposal:=jsonb_build_object(
  'version',1,'kind','task4a_explicit_bounded_paid_execution',
  'recoveryReceiptId',recovery.id,
  'recoveryDigest',recovery.data->>'consentDigest',
  'originalClaimId',offer->'proposal'->>'originalClaimId',
  'projectId',p.id,'taskId',a.task_id,'issueNumber',969,
  'ownerId',recovery.data->>'ownerId',
  'releaseSha',p_release,'approvalId',a.id,'continuationId',s.id,
  'accountId',acct.id,'model','openai:gpt-5.3-codex',
  'nativeLimits',limits,'expiresAt',offer->'proposal'->>'expiresAt',
  'pricingVerifiedAt',price.pricing_verified_at,
  'pricingInputPerMillion',price.pricing_input_per_1m,
  'pricingOutputPerMillion',price.pricing_output_per_1m,
  'oneWorkflowDispatch',true,'noAdditionalFinancialAuthority',true,
  'originalIssueUnchanged',true,'protectedPreviewOnly',true);
 return jsonb_build_object('ready',true,'proposal',proposal,
  'digest',encode(sha256(convert_to(public.project_canonical(proposal),'UTF8')),'hex'));
end $task4a_paid_offer$;
revoke all on function public.task4a_paid_execution_proposal(text)
 from public,anon,authenticated;
grant execute on function public.task4a_paid_execution_proposal(text) to service_role;

-- The second affirmative decision is an independently hashed and immutable
-- owner receipt. A concurrent or replayed consent always fails closed.
create or replace function public.task4a_authorize_paid_execution(
 p_owner uuid,p_digest text,p_release text
) returns jsonb language plpgsql security invoker set search_path=public as $task4a_paid_authorize$
declare offer jsonb;p public.work_projects;recovery public.project_events;receipt uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into recovery from public.project_events
  where project_id=p.id and event='task4a_failed_dispatch_owner_authorized';
 offer:=public.task4a_paid_execution_proposal(p_release);
 if offer->>'ready' is distinct from 'true'
  or offer->>'digest' is distinct from p_digest
  or p_owner is distinct from (offer->'proposal'->>'ownerId')::uuid
  or p_owner is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)
  or recovery.id is null
  or recovery.id::text is distinct from offer->'proposal'->>'recoveryReceiptId'
  or exists(select 1 from public.project_events where project_id=p.id and event in
   ('task4a_failed_dispatch_paid_execution_authorized',
    'task4a_failed_dispatch_recovery_claimed',
    'task4a_failed_dispatch_recovery_submitted'))
 then raise exception 'TASK4A_SEPARATE_PAID_EXECUTION_CONSENT_DENIED';end if;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_failed_dispatch_paid_execution_authorized',
  jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,
   'proposal',offer->'proposal','recoveryReceiptId',recovery.id,
   'recoveryConsentDigest',recovery.data->>'consentDigest',
   'originalClaimId',offer->'proposal'->>'originalClaimId',
   'exactOneDispatch',true,'boundedPaidDevelopmentAuthorized',true,
   'newFinancialAuthority',false,'newPaidCalls',0,'executionGrantsCreated',0))
 returning id into receipt;
 return jsonb_build_object('authorized',true,'receiptId',receipt,
  'recoveryReceiptId',recovery.id,'paidExecutionAuthorized',true,
  'dispatchClaimed',false,'newFinancialAuthority',false,'newPaidCalls',0);
end $task4a_paid_authorize$;
revoke all on function public.task4a_authorize_paid_execution(uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.task4a_authorize_paid_execution(uuid,text,text) to service_role;

-- Replace the original one-shot claim with a mandatory two-receipt chain.
-- ALL current conditions are recomputed under the same transaction lock.
create or replace function public.task4a_claim_failed_dispatch(p_release text)
returns boolean language plpgsql security invoker set search_path=public as $task4a_two_receipt_claim$
declare p public.work_projects;t public.agent_tasks;offer jsonb;
 recovery public.project_events;paid public.project_events;claim uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into t from public.agent_tasks
  where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid for update;
 offer:=public.task4a_paid_execution_proposal(p_release);
 select * into recovery from public.project_events
  where project_id=p.id and event='task4a_failed_dispatch_owner_authorized';
 select * into paid from public.project_events
  where project_id=p.id and event='task4a_failed_dispatch_paid_execution_authorized';
 if offer->>'ready' is distinct from 'true'
  or recovery.id is null or paid.id is null
  or recovery.data->>'consentDigest' is distinct from offer->'proposal'->>'recoveryDigest'
  or paid.data->>'consentDigest' is distinct from offer->>'digest'
  or paid.data->'proposal' is distinct from offer->'proposal'
  or paid.data->>'ownerId' is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)::text
  or paid.data->>'recoveryReceiptId' is distinct from recovery.id::text
  or paid.data->>'recoveryConsentDigest' is distinct from recovery.data->>'consentDigest'
  or paid.data->>'originalClaimId' is distinct from offer->'proposal'->>'originalClaimId'
  or paid.data->>'boundedPaidDevelopmentAuthorized' is distinct from 'true'
  or paid.data->>'newFinancialAuthority' is distinct from 'false'
  or exists(select 1 from public.project_events where project_id=p.id and event in
   ('task4a_failed_dispatch_recovery_claimed','task4a_failed_dispatch_recovery_submitted'))
 then return false;end if;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_failed_dispatch_recovery_claimed',
  jsonb_build_object('ownerConsentReceiptId',recovery.id,
   'ownerConsentDigest',recovery.data->>'consentDigest',
   'paidExecutionReceiptId',paid.id,
   'paidExecutionDigest',paid.data->>'consentDigest',
   'originalClaimId',offer->'proposal'->>'originalClaimId',
   'previousTaskExternal',t.external,
   'approvalId',offer->'proposal'->>'approvalId',
   'releaseSha',p_release,'issueNumber',969,'noPaidCallYet',true))
 returning id into claim;
 insert into public.project_events(project_id,event,data)
 values(p.id,'developer_native_dispatch_claimed',
  jsonb_build_object('approvalId',offer->'proposal'->>'approvalId',
   'taskId',t.id,'releaseSha',p_release,'recoveryClaimId',claim,
   'ownerConsentReceiptId',recovery.id,'paidExecutionReceiptId',paid.id,
   'originalClaimId',offer->'proposal'->>'originalClaimId'));
 update public.agent_tasks set external=external||jsonb_build_object(
  'developerReleaseSha',p_release,'developerDispatchSince',clock_timestamp(),
  'dispatchStartedAt',clock_timestamp(),'task4aFailedDispatchRecoveryClaimId',claim,
  'task4aPaidExecutionReceiptId',paid.id,
  'originalFailedDispatchClaimId',offer->'proposal'->>'originalClaimId'),
  updated_at=now() where id=t.id;
 return true;
end $task4a_two_receipt_claim$;
revoke all on function public.task4a_claim_failed_dispatch(text)
 from public,anon,authenticated;
grant execute on function public.task4a_claim_failed_dispatch(text) to service_role;

-- Even a bypassed HTTP handler or forged workflow cannot mint a native
-- execution grant before the two receipts AND the actual one-time claim exist.
create or replace function public.task4a_paid_dispatch_grant_ready(
 p_approval uuid,p_release text
) returns boolean language plpgsql stable set search_path=public as $task4a_grant_ready$
declare p public.work_projects;m public.agent_missions;j public.mission_assignments;
 t public.agent_tasks;a public.benchmark_native_spending_approvals;
 acct public.benchmark_budget_accounts;s public.project_continuation_authorizations;
 price public.model_registry;recovery public.project_events;paid public.project_events;
 claim public.project_events;original public.project_events;
begin
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into m from public.agent_missions where id=p.active_mission_id and project_id=p.id;
 select * into j from public.mission_assignments
  where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid and mission_id=m.id;
 select * into t from public.agent_tasks where id=j.id;
 select * into a from public.benchmark_native_spending_approvals
  where id=p_approval and project_id=p.id and task_id=t.id;
 select * into acct from public.benchmark_budget_accounts where id=a.account_id;
 select * into s from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id);
 select * into price from public.model_registry
  where provider_name='openai' and model_id='gpt-5.3-codex';
 select * into recovery from public.project_events where project_id=p.id
  and event='task4a_failed_dispatch_owner_authorized';
 select * into paid from public.project_events where project_id=p.id
  and event='task4a_failed_dispatch_paid_execution_authorized';
 select * into claim from public.project_events where project_id=p.id
  and event='task4a_failed_dispatch_recovery_claimed';
 if claim.id is not null then
  select * into original from public.project_events
   where id=(claim.data->>'originalClaimId')::uuid
    and project_id=p.id and event='developer_native_dispatch_claimed';
 end if;
 return coalesce(
  p.id is not null and p.status='running' and p.phase='development'
  and p.deadline>clock_timestamp()
  and p.approved_hash is not null and p.approved_hash=p.approval_hash
  and m.id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid and m.status='running'
  and j.id is not null and j.role='development' and j.status='waiting_external'
  and t.id is not null and t.status in ('dispatching','submitted')
  and t.external->>'issueNumber'='969'
  and t.external->>'developerApprovalId'=a.id::text
  and t.external->>'developerReleaseSha'=p_release
  and t.external->>'task4aFailedDispatchRecoveryClaimId'=claim.id::text
  and t.external->>'task4aPaidExecutionReceiptId'=paid.id::text
  and a.id is not null and a.owner_id=public.task4a_original_owner_id(p.actor_id,p.chat_id)
  and a.revoked_at is null and a.consumed_at is null
  and a.deadline>clock_timestamp() and a.deadline<=s.deadline
  and a.account_id=acct.id and a.model='gpt-5.3-codex'
  and acct.arm='developer' and acct.frozen_at is null
  and acct.cap_tokens=180000 and acct.spent_tokens=0
  and s.id is not null and s.revoked_at is null and s.deadline>clock_timestamp()
  and a.developer_authority->>'task4aContinuationId'=s.id::text
  and recovery.id is not null and recovery.data->>'recoveryOnly'='true'
  and recovery.data->>'dispatchAuthorized'='false'
  and recovery.data->>'paidExecutionAuthorized'='false'
  and recovery.data->>'consentDigest'=paid.data->>'recoveryConsentDigest'
  and paid.id is not null and paid.data->>'boundedPaidDevelopmentAuthorized'='true'
  and paid.data->>'ownerId'=a.owner_id::text
  and paid.data->>'recoveryReceiptId'=recovery.id::text
  and paid.data->>'consentDigest' ~ '^[a-f0-9]{64}$'
  and paid.data->'proposal'->>'kind'='task4a_explicit_bounded_paid_execution'
  and paid.data->'proposal'->>'releaseSha'=p_release
  and paid.data->'proposal'->>'approvalId'=a.id::text
  and paid.data->'proposal'->>'continuationId'=s.id::text
  and paid.data->'proposal'->>'accountId'=acct.id::text
  and paid.data->'proposal'->>'recoveryReceiptId'=recovery.id::text
  and paid.data->'proposal'->>'recoveryDigest'=recovery.data->>'consentDigest'
  and paid.data->'proposal'->>'originalClaimId'=original.id::text
  and (paid.data->'proposal'->>'expiresAt')::timestamptz>clock_timestamp()
  and claim.id is not null and claim.data->>'ownerConsentReceiptId'=recovery.id::text
  and claim.data->>'paidExecutionReceiptId'=paid.id::text
  and claim.data->>'paidExecutionDigest'=paid.data->>'consentDigest'
  and claim.data->>'approvalId'=a.id::text
  and claim.data->>'releaseSha'=p_release
  and claim.data->>'originalClaimId'=original.id::text
  and original.id is not null and original.data->>'taskId'=t.id::text
  and original.data->>'releaseSha' is distinct from p_release
  and price.pricing_status='verified' and price.is_active=true
  and price.pricing_verified_at between clock_timestamp()-interval '24 hours' and clock_timestamp()
  and price.source_metadata->>'pricing_verification_source'=
    'https://developers.openai.com/api/docs/models/gpt-5.3-codex'
  and price.pricing_input_per_1m between 0.000001 and 28
  and price.pricing_output_per_1m between 0.000001 and 28
  and not exists(select 1 from public.benchmark_execution_grants where project_id=p.id)
  and not exists(select 1 from public.benchmark_budget_calls where account_id=acct.id)
  and not exists(select 1 from public.benchmark_dollar_exposures where account_id=acct.id)
  and not exists(select 1 from public.mission_calls where job_id=t.id)
 ,false);
end $task4a_grant_ready$;
revoke all on function public.task4a_paid_dispatch_grant_ready(uuid,text)
 from public,anon,authenticated;
grant execute on function public.task4a_paid_dispatch_grant_ready(uuid,text) to service_role;

create or replace function public.task4a_distinct_paid_grant_guard()
returns trigger language plpgsql set search_path=public as $task4a_paid_grant_guard$
declare release text;
begin
 if new.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
  and new.mission_assignment_id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid
  and exists(select 1 from public.project_events where project_id=new.project_id
   and event in ('task4a_failed_dispatch_owner_authorized',
                 'task4a_blocked_dispatch_owner_recovered'))
 then
  select external->>'developerReleaseSha' into release
   from public.agent_tasks where id=new.mission_assignment_id;
  if new.developer_approval_id is null
   or not public.task4a_paid_dispatch_grant_ready(new.developer_approval_id,release)
  then raise exception 'TASK4A_SEPARATE_PAID_AUTH_REQUIRED_BEFORE_GRANT';end if;
 end if;
 return new;
end $task4a_paid_grant_guard$;
revoke all on function public.task4a_distinct_paid_grant_guard() from public,anon,authenticated;
drop trigger if exists task4a_distinct_paid_grant_guard on public.benchmark_execution_grants;
create trigger task4a_distinct_paid_grant_guard
 before insert on public.benchmark_execution_grants for each row
 execute function public.task4a_distinct_paid_grant_guard();

-- GitHub 204 is recorded with BOTH receipts. The original claim and every
-- earlier project event remain untouched, including an uncertain response.
create or replace function public.task4a_record_failed_dispatch_submitted(p_release text)
returns boolean language plpgsql security invoker set search_path=public as $task4a_paid_submitted$
declare p public.work_projects;t public.agent_tasks;r public.project_events;
 recovery public.project_events;paid public.project_events;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into t from public.agent_tasks
  where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid for update;
 select * into r from public.project_events where project_id=p.id
  and event='task4a_failed_dispatch_recovery_claimed';
 select * into recovery from public.project_events where project_id=p.id
  and event='task4a_failed_dispatch_owner_authorized';
 select * into paid from public.project_events where project_id=p.id
  and event='task4a_failed_dispatch_paid_execution_authorized';
 if r.id is null or recovery.id is null or paid.id is null
  or t.status<>'dispatching'
  or t.external->>'developerReleaseSha' is distinct from p_release
  or r.data->>'releaseSha' is distinct from p_release
  or r.data->>'ownerConsentReceiptId' is distinct from recovery.id::text
  or r.data->>'paidExecutionReceiptId' is distinct from paid.id::text
  or r.data->>'paidExecutionDigest' is distinct from paid.data->>'consentDigest'
  or paid.data->>'recoveryReceiptId' is distinct from recovery.id::text
  or exists(select 1 from public.project_events where project_id=p.id
    and event='task4a_failed_dispatch_recovery_submitted')
 then return false;end if;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_failed_dispatch_recovery_submitted',
  jsonb_build_object('claimReceiptId',r.id,'ownerConsentReceiptId',recovery.id,
   'paidExecutionReceiptId',paid.id,'paidExecutionDigest',paid.data->>'consentDigest',
   'releaseSha',p_release,'issueNumber',969,'acceptedByGithubApi',true,
   'runIdPending',true));
 update public.agent_tasks set status='submitted',
  external=external||jsonb_build_object('developerDispatchRunPending',true),
  updated_at=now() where id=t.id;
 return true;
end $task4a_paid_submitted$;
revoke all on function public.task4a_record_failed_dispatch_submitted(text)
 from public,anon,authenticated;
grant execute on function public.task4a_record_failed_dispatch_submitted(text) to service_role;
