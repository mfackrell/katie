-- One-time original Task 4A recovery of a GitHub workflow_dispatch request rejected
-- before GitHub accepted it. No historical claim/approval/call is deleted or reset.
-- Owner consent is separate from the successor/native approvals and is explicitly
-- consent to ONE workflow_dispatch that may incur charges under the existing cap.
create unique index if not exists task4a_failed_dispatch_one_owner
 on public.project_events(project_id) where event='task4a_failed_dispatch_owner_authorized';
create unique index if not exists task4a_failed_dispatch_one_claim
 on public.project_events(project_id) where event='task4a_failed_dispatch_recovery_claimed';
create unique index if not exists task4a_failed_dispatch_one_submitted
 on public.project_events(project_id) where event='task4a_failed_dispatch_recovery_submitted';

create or replace function public.task4a_failed_dispatch_event_immutable()
returns trigger language plpgsql set search_path=public as $task4a_event$
begin
 if old.event in ('task4a_failed_dispatch_owner_authorized',
                  'task4a_failed_dispatch_recovery_claimed',
                  'task4a_failed_dispatch_recovery_submitted')
 then raise exception 'TASK4A_FAILED_DISPATCH_AUDIT_IMMUTABLE';end if;
 return case when tg_op='DELETE' then old else new end;
end $task4a_event$;
revoke all on function public.task4a_failed_dispatch_event_immutable() from public,anon,authenticated;
drop trigger if exists task4a_failed_dispatch_event_immutable on public.project_events;
create trigger task4a_failed_dispatch_event_immutable before update or delete
 on public.project_events for each row
 execute function public.task4a_failed_dispatch_event_immutable();

-- This proposal NEVER claims, dispatches, creates an execution grant, or bills.
-- The caller must independently verify GitHub's workflow run inventory and
-- the exact signed issue before offering consent or using a saved consent.
create or replace function public.task4a_failed_dispatch_proposal(p_release text)
returns jsonb language plpgsql stable set search_path=public as $task4a_offer$
declare
 p public.work_projects;m public.agent_missions;j public.mission_assignments;
 t public.agent_tasks;a public.benchmark_native_spending_approvals;
 acct public.benchmark_budget_accounts;s public.project_continuation_authorizations;
 old_claim public.project_events;root public.benchmark_native_spending_approvals;
 price public.model_registry;proposal jsonb;owner uuid;deadline timestamptz;
begin
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into m from public.agent_missions where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid and project_id=p.id;
 select * into j from public.mission_assignments where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid and mission_id=m.id;
 select * into t from public.agent_tasks where id=j.id;
 select * into a from public.benchmark_native_spending_approvals where id='c8dfdbf2-56e2-474d-a8b4-82267001fb47'::uuid and task_id=t.id;
 select * into root from public.benchmark_native_spending_approvals where id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid;
 select * into acct from public.benchmark_budget_accounts where id=a.account_id;
 select * into s from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id) and project_id=p.id;
 select * into price from public.model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 select * into old_claim from public.project_events where project_id=p.id
  and event='developer_native_dispatch_claimed'
  and data->>'approvalId'=a.id::text;
 owner:=public.task4a_original_owner_id(p.actor_id,p.chat_id);
 deadline:=least(p.deadline,a.deadline,s.deadline);
 if coalesce(p_release,'')!~'^[a-f0-9]{40}$'
  or p.id is null or p.status<>'running' or p.phase<>'development'
  or p.repository_full_name is distinct from 'mfackrell/katie'
  or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash
  or p.active_mission_id is distinct from m.id or m.status<>'running'
  or m.project_kind<>'development' or j.id is null or j.role<>'development'
  or j.status<>'waiting_external'
  or t.status<>'dispatching' or t.repository_full_name<>'mfackrell/katie'
  or t.external->>'issueNumber' is distinct from '969'
  or t.external->>'developerApprovalId' is distinct from a.id::text
  or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or t.external->'receipt'->>'run_id' is distinct from '41673059705'
  or t.external->'receipt'->>'pr_url' is not null
  or a.id is null or a.project_id is distinct from p.id
  or a.model is distinct from 'gpt-5.3-codex'
  or a.owner_id is distinct from owner or owner is null
  or a.previous_developer_approval_id is distinct from root.id
  or a.consumed_at is not null or a.revoked_at is not null
  or a.developer_authority->>'task4aContinuationId' is distinct from s.id::text
  or a.developer_authority->>'scopeHash' is distinct from p.approved_hash
  or root.id is null or root.consumed_at is not null or root.revoked_at is null
  or acct.id is null or acct.arm<>'developer' or acct.frozen_at is not null
  or acct.developer_project_id is distinct from p.id or acct.developer_task_id is distinct from t.id
  or acct.cap_tokens is distinct from 180000 or acct.spent_tokens<>0
  or s.id is null or s.predecessor_id is distinct from '405ea82c-6f52-49e5-babf-891ecac64d14'::uuid
  or s.revoked_at is not null or deadline<=clock_timestamp()+interval '5 minutes'
  or 'openai:gpt-5.3-codex'<>all(s.allowed_models)
  or price.pricing_status is distinct from 'verified' or price.is_active is distinct from true
  or price.pricing_verified_at not between clock_timestamp()-interval '24 hours' and clock_timestamp()
  or price.source_metadata->>'pricing_verification_source'
      is distinct from 'https://developers.openai.com/api/docs/models/gpt-5.3-codex'
  or not public.task4a_native_authority_ready(p.id,t.id,s.id)
  or old_claim.id is null or old_claim.data->>'taskId' is distinct from t.id::text
  or old_claim.data->>'releaseSha' is distinct from t.external->>'developerReleaseSha'
  or old_claim.created_at < '2026-11-05T13:40:00Z'::timestamptz
  or old_claim.created_at > '2026-11-05T14:00:00Z'::timestamptz
  or (select count(*) from public.project_events where project_id=p.id
      and event='developer_native_dispatch_claimed' and data->>'approvalId'=a.id::text)<>1
  or exists(select 1 from public.project_events where project_id=p.id
      and event in ('task4a_failed_dispatch_recovery_claimed','task4a_failed_dispatch_recovery_submitted'))
  or exists(select 1 from public.benchmark_execution_grants where project_id=p.id)
  or exists(select 1 from public.benchmark_budget_calls where account_id=acct.id)
  or exists(select 1 from public.mission_calls where job_id=t.id)
  or exists(select 1 from public.benchmark_native_spending_approvals
      where previous_developer_approval_id=a.id)
 then return jsonb_build_object('ready',false,'reason','original_claim_or_authority_ineligible');end if;
 proposal:=jsonb_build_object(
  'version',1,'kind','task4a_one_time_failed_github_dispatch',
  'projectId',p.id,'missionId',m.id,'taskId',t.id,'issueNumber',969,
  'ownerId',owner,'originalClaimId',old_claim.id,
  'originalClaimAt',old_claim.created_at,'originalReleaseSha',old_claim.data->>'releaseSha',
  'newProductionReleaseSha',p_release,'approvalId',a.id,
  'previousApprovalId',root.id,'continuationId',s.id,'accountId',acct.id,
  'scopeHash',p.approved_hash,'baselineSha',p.baseline_sha,
  'model','openai:gpt-5.3-codex',
  'nativeLimits',a.developer_authority->'limits',
  'projectDeadline',p.deadline,'expiresAt',deadline,
  'singleGithubWorkflowDispatch',true,
  'mayUseExistingPaidNativeAccount',true,
  'noAdditionalTokenCallOrDollarGrant',true,
  'noProductionAppPublication',true);
 return jsonb_build_object('ready',true,'proposal',proposal,
  'digest',encode(sha256(convert_to(public.project_canonical(proposal),'UTF8')),'hex'));
end $task4a_offer$;
revoke all on function public.task4a_failed_dispatch_proposal(text) from public,anon,authenticated;
grant execute on function public.task4a_failed_dispatch_proposal(text) to service_role;

-- Exact owner consent is recorded on its own, before any GitHub request.
create or replace function public.task4a_authorize_failed_dispatch(
 p_owner uuid,p_digest text,p_release text
) returns jsonb language plpgsql security invoker set search_path=public as $task4a_consent$
declare offer jsonb;p public.work_projects;receipt uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 offer:=public.task4a_failed_dispatch_proposal(p_release);
 if offer->>'ready' is distinct from 'true'
  or offer->>'digest' is distinct from p_digest
  or p_owner is distinct from (offer->'proposal'->>'ownerId')::uuid
  or p_owner is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)
  or exists(select 1 from public.project_events where project_id=p.id
      and event='task4a_failed_dispatch_owner_authorized')
 then raise exception 'TASK4A_FAILED_DISPATCH_OWNER_CONSENT_DENIED';end if;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_failed_dispatch_owner_authorized',
  jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,
  'proposal',offer->'proposal','originalClaimId',offer->'proposal'->>'originalClaimId',
  'oneDispatchMayStartPaidExecution',true,'existingNativeCeilingUnchanged',true))
 returning id into receipt;
 return jsonb_build_object('authorized',true,'receiptId',receipt,'digest',p_digest,
  'taskId',offer->'proposal'->>'taskId','issueNumber',969,'dispatched',false);
end $task4a_consent$;
revoke all on function public.task4a_authorize_failed_dispatch(uuid,text,text) from public,anon,authenticated;
grant execute on function public.task4a_authorize_failed_dispatch(uuid,text,text) to service_role;

-- The existing native dispatch worker, NOT an independent coding agent, claims
-- the one consent. A claim is deliberately never reset after a network error:
-- external GitHub acceptance may be unknown and must be reconciled manually.
create or replace function public.task4a_claim_failed_dispatch(p_release text)
returns boolean language plpgsql security invoker set search_path=public as $task4a_claim$
declare p public.work_projects;t public.agent_tasks;offer jsonb;consent public.project_events;claim uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into t from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid for update;
 offer:=public.task4a_failed_dispatch_proposal(p_release);
 select * into consent from public.project_events where project_id=p.id and event='task4a_failed_dispatch_owner_authorized';
 if offer->>'ready' is distinct from 'true' or consent.id is null
  or consent.data->>'consentDigest' is distinct from offer->>'digest'
  or consent.data->'proposal' is distinct from offer->'proposal'
  or consent.data->>'ownerId' is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)::text
  or exists(select 1 from public.project_events where project_id=p.id
    and event in ('task4a_failed_dispatch_recovery_claimed','task4a_failed_dispatch_recovery_submitted'))
 then return false;end if;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_failed_dispatch_recovery_claimed',
  jsonb_build_object('ownerConsentReceiptId',consent.id,'ownerConsentDigest',offer->>'digest',
  'originalClaimId',offer->'proposal'->>'originalClaimId',
  'previousTaskExternal',t.external,'approvalId',offer->'proposal'->>'approvalId',
  'releaseSha',p_release,'issueNumber',969,'noPaidCallYet',true))
 returning id into claim;
 -- Native's existing exact-SHA grant admission expects a dispatch claim for
 -- THIS release. Preserve the original claim and append the new one.
 insert into public.project_events(project_id,event,data)
 values(p.id,'developer_native_dispatch_claimed',
  jsonb_build_object('approvalId',offer->'proposal'->>'approvalId',
  'taskId',t.id,'releaseSha',p_release,
  'recoveryClaimId',claim,'originalClaimId',offer->'proposal'->>'originalClaimId'));
 update public.agent_tasks
 set external=external||jsonb_build_object(
  'developerReleaseSha',p_release,'developerDispatchSince',clock_timestamp(),
  'dispatchStartedAt',clock_timestamp(),'task4aFailedDispatchRecoveryClaimId',claim,
  'originalFailedDispatchClaimId',offer->'proposal'->>'originalClaimId'),
  updated_at=now()
 where id=t.id;
 return true;
end $task4a_claim$;
revoke all on function public.task4a_claim_failed_dispatch(text) from public,anon,authenticated;
grant execute on function public.task4a_claim_failed_dispatch(text) to service_role;

create or replace function public.task4a_record_failed_dispatch_submitted(p_release text)
returns boolean language plpgsql security invoker set search_path=public as $task4a_sent$
declare p public.work_projects;t public.agent_tasks;r public.project_events;approved public.project_events;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into t from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid for update;
 select * into r from public.project_events where project_id=p.id and event='task4a_failed_dispatch_recovery_claimed';
 select * into approved from public.project_events where project_id=p.id and event='task4a_failed_dispatch_owner_authorized';
 if r.id is null or approved.id is null or t.status<>'dispatching'
  or t.external->>'developerReleaseSha' is distinct from p_release
  or r.data->>'releaseSha' is distinct from p_release
  or r.data->>'ownerConsentReceiptId' is distinct from approved.id::text
  or exists(select 1 from public.project_events where project_id=p.id and event='task4a_failed_dispatch_recovery_submitted')
 then return false;end if;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_failed_dispatch_recovery_submitted',
  jsonb_build_object('claimReceiptId',r.id,'ownerConsentReceiptId',approved.id,
   'releaseSha',p_release,'issueNumber',969,'acceptedByGithubApi',true,'runIdPending',true));
 update public.agent_tasks set status='submitted',
  external=external||jsonb_build_object('developerDispatchRunPending',true),updated_at=now()
 where id=t.id;
 return true;
end $task4a_sent$;
revoke all on function public.task4a_record_failed_dispatch_submitted(text) from public,anon,authenticated;
grant execute on function public.task4a_record_failed_dispatch_submitted(text) to service_role;
