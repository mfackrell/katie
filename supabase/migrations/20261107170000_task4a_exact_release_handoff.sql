-- Exact Task 4A executor release handoff; no additional financial authority.
-- Owner consent is separately authenticated and digest-bound by the existing route.

-- One immutable, explicitly owner-consented bridge between the original
-- paid-execution SHA and the reviewed executor SHA. NO new budget or grant.
create unique index if not exists task4a_postpaid_release_handoff_one
 on public.project_events(project_id,event)
 where event='task4a_postpaid_release_handoff_authorized';

create or replace function public.task4a_postpaid_immutable()
returns trigger language plpgsql set search_path=public as $$
begin
 if old.event in ('task4a_postpaid_owner_authorized',
  'task4a_postpaid_redispatch_authorized','task4a_postpaid_paid_authorized',
  'task4a_postpaid_dispatch_claimed','task4a_postpaid_dispatch_submitted',
  'task4a_postpaid_release_handoff_authorized')
 then raise exception 'TASK4A_POSTPAID_AUDIT_IMMUTABLE';end if;
 return old;
end $$;


create or replace function public.task4a_postpaid_release_handoff_proposal(p_release text)
returns jsonb language plpgsql stable set search_path=public as $$
declare p public.work_projects;m public.agent_missions;j public.mission_assignments;
 t public.agent_tasks;a public.benchmark_native_spending_approvals;
 s public.project_continuation_authorizations;price public.model_registry;
 authority public.project_events;redispatch public.project_events;paid public.project_events;
 candidate jsonb;legacy_release text;
begin
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into m from public.agent_missions where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid;
 select * into j from public.mission_assignments where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid;
 select * into t from public.agent_tasks where id=j.id;
 select * into authority from public.project_events where project_id=p.id and event='task4a_postpaid_owner_authorized';
 select * into redispatch from public.project_events where project_id=p.id and event='task4a_postpaid_redispatch_authorized';
 select * into paid from public.project_events where project_id=p.id and event='task4a_postpaid_paid_authorized';
 select * into a from public.benchmark_native_spending_approvals where id=(authority.data->>'newApprovalId')::uuid;
 select * into s from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id);
 select * into price from public.model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 legacy_release:=paid.data->'proposal'->>'releaseSha';
 if not coalesce(
   p.id is not null and m.id=p.active_mission_id and j.mission_id=m.id and t.id=j.id
   and p.status='blocked' and p.phase='development' and m.status='blocked'
   and j.status='failed' and t.status='blocked'
   and p.deadline>clock_timestamp() and m.deadline=p.deadline
   and a.id is not null and a.owner_id=public.task4a_original_owner_id(p.actor_id,p.chat_id)
   and a.revoked_at is null and a.consumed_at is null and a.deadline>clock_timestamp()
   and t.external->>'developerApprovalId'=a.id::text and t.external->>'issueNumber'='969'
   and t.external->'receipt'->>'outcome'='BLOCKED'
   and t.external->'receipt'->>'run_id'='42102615797'
   and a.developer_authority->'task4aPostpaid'->>'version'='postpaid-same-task-v1'
   and a.model='gpt-5.3-codex' and s.id=a.developer_authority->>'task4aContinuationId'
   and s.deadline>clock_timestamp() and s.revoked_at is null
   and s.assessment_reserve_tokens=60000 and s.completion_reserve_tokens=60000
   and s.assessment_reserve_calls=6 and s.completion_reserve_calls=6
   and a.developer_authority->'limits'->>'cumulativeTokens'='289620'
   and a.developer_authority->'limits'->>'developmentTokens'='229620'
   and a.developer_authority->'limits'->>'developmentCalls'='16'
   and a.developer_authority->'limits'->>'ceilingMicrousd'='9000000'
   and authority.id is not null and redispatch.id is not null and paid.id is not null
   and authority.data->>'ownerId'=a.owner_id::text
   and authority.data->>'newApprovalId'=a.id::text
   and redispatch.data->>'ownerId'=a.owner_id::text
   and redispatch.data->>'paidInferenceAuthorized'='false'
   and redispatch.data->'proposal'->>'approvalId'=a.id::text
   and redispatch.data->'proposal'->>'ownerAuthorityReceiptId'=authority.id::text
   and redispatch.data->>'consentDigest'=encode(sha256(convert_to(
     public.project_canonical(redispatch.data->'proposal'),'UTF8')),'hex')
   and paid.data->>'ownerId'=a.owner_id::text
   and paid.data->>'redispatchReceiptId'=redispatch.id::text
   and paid.data->'proposal'->>'approvalId'=a.id::text
   and paid.data->'proposal'->>'authorityReceiptId'=authority.id::text
   and paid.data->'proposal'->>'redispatchReceiptId'=redispatch.id::text
   and paid.data->>'consentDigest'=encode(sha256(convert_to(
     public.project_canonical(paid.data->'proposal'),'UTF8')),'hex')
   and legacy_release='2147b910ad7bba849e8f4de7cf91f36a3410595e'
   and redispatch.data->'proposal'->>'releaseSha'=legacy_release
   and authority.data->'proposal'->>'releaseSha'=legacy_release
   and p_release ~ '^[a-f0-9]{40}$' and p_release<>legacy_release
   and price.is_active=true and price.pricing_status='verified'
   and price.pricing_verified_at between clock_timestamp()-interval '24 hours' and clock_timestamp()
   and price.pricing_input_per_1m=1.75 and price.pricing_output_per_1m=14
   and price.source_metadata->>'pricing_verification_source'
     ='https://developers.openai.com/api/docs/models/gpt-5.3-codex'
   and exists(select 1 from public.benchmark_budget_accounts b
    where b.id=a.account_id and b.developer_project_id=p.id
      and b.developer_task_id=t.id and b.frozen_at is null and b.spent_tokens=49620)
   and (select count(*) from public.benchmark_execution_grants where project_id=p.id)=1
   and (select count(*) from public.benchmark_budget_calls where account_id=a.account_id)=4
   and (select count(*) from public.benchmark_budget_calls where account_id=a.account_id
      and (state<>'settled' or actual_tokens is null))=0
   and (select coalesce(sum(actual_tokens),0) from public.benchmark_budget_calls
     where account_id=a.account_id)=49620
   and not exists(select 1 from public.project_events where project_id=p.id
     and event in ('task4a_postpaid_dispatch_claimed','task4a_postpaid_dispatch_submitted',
       'task4a_postpaid_release_handoff_authorized'))
 ,false) then return jsonb_build_object('ready',false,'reason','original_release_handoff_not_eligible');end if;

 candidate:=jsonb_build_object(
  'kind','task4a_postpaid_release_handoff_v1','ownerId',a.owner_id,
  'projectId',p.id,'taskId',t.id,'originalIssue',969,
  'releaseSha',p_release,'priorReleaseSha',legacy_release,
  'authorityReceiptId',authority.id,'redispatchReceiptId',redispatch.id,
  'paidReceiptId',paid.id,'paidDigest',paid.data->>'consentDigest',
  'nativeApprovalId',a.id,'nativeLimits',a.developer_authority->'limits',
  'continuationId',s.id,
  'checkpointSha','8e53ce01693303fc50daf5da1567e93e725f9b2d',
  'pinnedModel','gpt-5.3-codex','pricingVerifiedAt',price.pricing_verified_at,
  'pricingSource',price.source_metadata->>'pricing_verification_source',
  'noNewFinancialAuthority',true,'noNewPaidCallOnConsent',true,
  'oneDispatchOnly',true,'noAutomaticRetry',true);
 return jsonb_build_object('ready',true,'proposal',candidate,
  'digest',encode(sha256(convert_to(public.project_canonical(candidate),'UTF8')),'hex'));
end $$;

create or replace function public.task4a_postpaid_release_handoff_authorize(
 p_owner uuid,p_digest text,p_release text
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare p public.work_projects; offer jsonb;receipt uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 offer:=public.task4a_postpaid_release_handoff_proposal(p_release);
 if p_owner is null or p_owner is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)
   or offer->>'ready' is distinct from 'true' or offer->>'digest' is distinct from p_digest
   or exists(select 1 from public.project_events where project_id=p.id
     and event in ('task4a_postpaid_release_handoff_authorized','task4a_postpaid_dispatch_claimed'))
 then raise exception 'TASK4A_RELEASE_HANDOFF_CONSENT_DENIED';end if;
 insert into public.project_events(project_id,event,data) values(p.id,
  'task4a_postpaid_release_handoff_authorized',
  jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,
   'proposal',offer->'proposal','originalPaidReceiptId',
    offer->'proposal'->>'paidReceiptId',
   'newPaidCalls',0,'noAdditionalBudget',true,'noDispatchOnConsent',true))
 returning id into receipt;
 return jsonb_build_object('authorized',true,'receiptId',receipt,
  'newPaidCalls',0,'newFinancialAuthority',false,'dispatched',false);
end $$;

-- The immutable handoff stays verifiable even *after* task status changes
-- or new paid calls are settled; no original consent or child authority changes.
create or replace function public.task4a_postpaid_release_handoff_authentic(p_release text)
returns boolean language plpgsql stable set search_path=public as $$
declare h public.project_events;auth public.project_events;r public.project_events;
 paid public.project_events;a public.benchmark_native_spending_approvals;
 p public.work_projects;proposal jsonb;lim jsonb;
begin
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into h from public.project_events
  where project_id=p.id and event='task4a_postpaid_release_handoff_authorized';
 select * into auth from public.project_events
  where project_id=p.id and event='task4a_postpaid_owner_authorized';
 select * into r from public.project_events
  where project_id=p.id and event='task4a_postpaid_redispatch_authorized';
 select * into paid from public.project_events
  where project_id=p.id and event='task4a_postpaid_paid_authorized';
 select * into a from public.benchmark_native_spending_approvals
  where id=(auth.data->>'newApprovalId')::uuid;
 proposal:=h.data->'proposal';lim:=a.developer_authority->'limits';
 return coalesce(
  h.id is not null and paid.id is not null and r.id is not null and auth.id is not null
  and h.data->>'ownerId'=a.owner_id::text
  and h.data->>'originalPaidReceiptId'=paid.id::text
  and h.data->>'consentDigest'=encode(sha256(convert_to(
    public.project_canonical(proposal),'UTF8')),'hex')
  and proposal->>'kind'='task4a_postpaid_release_handoff_v1'
  and proposal->>'ownerId'=a.owner_id::text
  and proposal->>'projectId'=p.id::text
  and proposal->>'taskId'='d0e41ff5-149e-4319-9e65-dcc605fb75da'
  and proposal->>'originalIssue'='969'
  and proposal->>'releaseSha'=p_release
  and proposal->>'priorReleaseSha'='2147b910ad7bba849e8f4de7cf91f36a3410595e'
  and proposal->>'authorityReceiptId'=auth.id::text
  and proposal->>'redispatchReceiptId'=r.id::text
  and proposal->>'paidReceiptId'=paid.id::text
  and proposal->>'paidDigest'=paid.data->>'consentDigest'
  and proposal->>'nativeApprovalId'=a.id::text
  and proposal->'nativeLimits'=lim
  and proposal->>'continuationId'=a.developer_authority->>'task4aContinuationId'
  and proposal->>'checkpointSha'='8e53ce01693303fc50daf5da1567e93e725f9b2d'
  and proposal->>'pinnedModel'='gpt-5.3-codex'
  and paid.data->'proposal'->>'releaseSha'='2147b910ad7bba849e8f4de7cf91f36a3410595e'
  and paid.data->>'consentDigest'=encode(sha256(convert_to(
    public.project_canonical(paid.data->'proposal'),'UTF8')),'hex')
  and proposal->>'noNewFinancialAuthority'='true'
  and proposal->>'oneDispatchOnly'='true'
  and proposal->>'noAutomaticRetry'='true'
  and p_release~'^[a-f0-9]{40}$'
 ,false);
end $$;

create or replace function public.task4a_postpaid_paid_proposal(p_release text)
returns jsonb language plpgsql stable set search_path=public as $$
declare p public.work_projects;t public.agent_tasks;a public.benchmark_native_spending_approvals;
 authority public.project_events;redispatch public.project_events;
 price public.model_registry;candidate jsonb;
begin
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into t from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid;
 select * into authority from public.project_events where project_id=p.id and event='task4a_postpaid_owner_authorized';
 select * into redispatch from public.project_events where project_id=p.id and event='task4a_postpaid_redispatch_authorized';
 select * into a from public.benchmark_native_spending_approvals
  where id=(authority.data->>'newApprovalId')::uuid;
 select * into price from public.model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 if authority.id is null or redispatch.id is null
  or p.status<>'blocked' or t.status<>'blocked'
  or t.external->>'developerApprovalId' is distinct from a.id::text
  or a.revoked_at is not null or a.consumed_at is not null
  or a.deadline<=clock_timestamp() or p.deadline<=clock_timestamp()
  or redispatch.data->>'ownerId' is distinct from a.owner_id::text
  or redispatch.data->>'paidInferenceAuthorized' is distinct from 'false'
  or (redispatch.data->'proposal'->>'releaseSha' is distinct from p_release
    and public.task4a_postpaid_release_handoff_authentic(p_release) is distinct from true)
  or coalesce(p_release,'')!~'^[a-f0-9]{40}$'
  or exists(select 1 from public.project_events where project_id=p.id
    and event='task4a_postpaid_dispatch_claimed')
  or price.is_active is distinct from true or price.pricing_status is distinct from 'verified'
  or price.pricing_verified_at not between clock_timestamp()-interval '24 hours' and clock_timestamp()
  or price.pricing_input_per_1m<>1.75 or price.pricing_output_per_1m<>14
  or price.source_metadata->>'pricing_verification_source'
    is distinct from 'https://developers.openai.com/api/docs/models/gpt-5.3-codex'
  or (select count(*) from public.benchmark_execution_grants where project_id=p.id)<>1
  or (select count(*) from public.benchmark_budget_calls where account_id=a.account_id)<>4
  or exists(select 1 from public.benchmark_budget_calls
    where account_id=a.account_id and state<>'settled')
 then return jsonb_build_object('ready',false,'reason','fresh_paid_admission_evidence_required');end if;
 if redispatch.data->'proposal'->>'releaseSha' is distinct from p_release then
   -- Reuse the *exact* already-signed paid proposal and digest; never forge
   -- a second paid authorization for the updated executor.
   return jsonb_build_object('ready',true,'proposal',
      (select e.data->'proposal' from public.project_events e
       where e.project_id=p.id and e.event='task4a_postpaid_paid_authorized'),
     'digest',(select e.data->>'consentDigest' from public.project_events e
       where e.project_id=p.id and e.event='task4a_postpaid_paid_authorized'),
     'releaseHandoff',true);
 end if;
 candidate:=jsonb_build_object('kind','task4a_postpaid_paid_v1',
  'ownerId',a.owner_id,'projectId',p.id,'taskId',t.id,'originalIssue',969,
  'releaseSha',p_release,'approvalId',a.id,
  'continuationId',a.developer_authority->>'task4aContinuationId',
  'nativeLimits',a.developer_authority->'limits',
  'authorityReceiptId',authority.id,'redispatchReceiptId',redispatch.id,
  'redispatchDigest',redispatch.data->>'consentDigest',
  'checkpointSha','8e53ce01693303fc50daf5da1567e93e725f9b2d',
  'pricingVerifiedAt',price.pricing_verified_at,
  'pricingSource',price.source_metadata->>'pricing_verification_source',
  'providerAuthorizationMode','provider_enforced_at_responses_execution',
  'modelLookupProvesInferencePermission',false,
  'oneOriginalIssueDispatch',true,'noNewFinancialAuthority',true);
 return jsonb_build_object('ready',true,'proposal',candidate,
  'digest',encode(sha256(convert_to(public.project_canonical(candidate),'UTF8')),'hex'));
end $$;

create or replace function public.task4a_postpaid_claim(p_release text)
returns boolean language plpgsql security invoker set search_path=public as $$
declare p public.work_projects;m public.agent_missions;j public.mission_assignments;
 t public.agent_tasks;a public.benchmark_native_spending_approvals;
 authority public.project_events;redispatch public.project_events;
 paid public.project_events;offer jsonb;claim uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into m from public.agent_missions where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid for update;
 select * into j from public.mission_assignments where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid for update;
 select * into t from public.agent_tasks where id=j.id for update;
 select * into authority from public.project_events where project_id=p.id and event='task4a_postpaid_owner_authorized';
 select * into redispatch from public.project_events where project_id=p.id and event='task4a_postpaid_redispatch_authorized';
 select * into paid from public.project_events where project_id=p.id and event='task4a_postpaid_paid_authorized';
 select * into a from public.benchmark_native_spending_approvals where id=(authority.data->>'newApprovalId')::uuid for update;
 offer:=public.task4a_postpaid_paid_proposal(p_release);
 if offer->>'ready' is distinct from 'true'
  or p.status<>'blocked' or m.status<>'blocked' or j.status<>'failed' or t.status<>'blocked'
  or a.id is null or t.external->>'developerApprovalId' is distinct from a.id::text
  or authority.id is null or redispatch.id is null or paid.id is null
  or paid.data->>'ownerId' is distinct from a.owner_id::text
  or paid.data->>'redispatchReceiptId' is distinct from redispatch.id::text
  or paid.data->>'consentDigest' is distinct from offer->>'digest'
  or paid.data->'proposal' is distinct from offer->'proposal'
  or redispatch.data->>'paidInferenceAuthorized' is distinct from 'false'
  or exists(select 1 from public.project_events where project_id=p.id
    and event='task4a_postpaid_dispatch_claimed')
 then return false;end if;
 update public.work_projects set status='running',lease=null,lease_until=null,
   progress_signature=null,progress_since=clock_timestamp(),
   error_signature=null,repeated_errors=0,impediment=null,
   detail='Original Task 4A checkpoint continuation authorized for one dispatch.',
   updated_at=clock_timestamp() where id=p.id;
 update public.agent_missions set status='running',updated_at=clock_timestamp() where id=m.id;
 update public.mission_assignments set status='waiting_external',lease=null,lease_until=null,
   available_at=clock_timestamp(),updated_at=clock_timestamp() where id=j.id;
 update public.agent_tasks set status='dispatching',
   external=external||jsonb_build_object('developerReleaseSha',p_release,
    'developerDispatchSince',clock_timestamp(),'dispatchStartedAt',clock_timestamp()),
   updated_at=clock_timestamp() where id=t.id;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_postpaid_dispatch_claimed',
  jsonb_build_object('ownerAuthorityReceiptId',authority.id,
   'redispatchReceiptId',redispatch.id,'paidReceiptId',paid.id,
   'paidDigest',paid.data->>'consentDigest','approvalId',a.id,
   'priorRunId',42102615797,
   'checkpointSha','8e53ce01693303fc50daf5da1567e93e725f9b2d',
   'releaseSha',p_release,'issueNumber',969,'noPaidCallYet',true,
    'releaseHandoffReceiptId',
      (select e.id from public.project_events e where e.project_id=p.id
        and e.event='task4a_postpaid_release_handoff_authorized'
        and public.task4a_postpaid_release_handoff_authentic(p_release))))
 returning id into claim;
 insert into public.project_events(project_id,event,data)
 values(p.id,'developer_native_dispatch_claimed',
  jsonb_build_object('approvalId',a.id,'taskId',t.id,
   'releaseSha',p_release,'postpaidClaimId',claim,'originalIssueNumber',969));
 update public.agent_tasks set external=external||jsonb_build_object(
   'task4aPostpaidDispatchClaimId',claim,'task4aPostpaidPaidReceiptId',paid.id),
   updated_at=clock_timestamp() where id=t.id;
 return true;
end $$;

-- The existing native grant remains fenced by the paid-consent chain.
-- Replacing only the trigger function preserves the old pre-provider rule.

create or replace function public.task4a_postpaid_grant_ready(
 p_approval uuid,p_release text
) returns boolean language plpgsql stable set search_path=public as $$
declare a public.benchmark_native_spending_approvals;p public.work_projects;
 t public.agent_tasks;m public.agent_missions;j public.mission_assignments;
 claim public.project_events;paid public.project_events;
 price public.model_registry;s public.project_continuation_authorizations;
begin
 select * into a from public.benchmark_native_spending_approvals where id=p_approval;
 select * into p from public.work_projects where id=a.project_id;
 select * into t from public.agent_tasks where id=a.task_id;
 select * into m from public.agent_missions where id=p.active_mission_id;
 select * into j from public.mission_assignments where id=a.task_id;
 select * into claim from public.project_events where project_id=p.id
  and event='task4a_postpaid_dispatch_claimed';
 select * into paid from public.project_events where project_id=p.id
  and event='task4a_postpaid_paid_authorized';
 select * into s from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id);
 select * into price from public.model_registry
  where provider_name='openai' and model_id='gpt-5.3-codex';
 return coalesce(
  p.id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
  and p.status='running' and p.phase='development'
  and p.deadline>clock_timestamp() and m.status='running'
  and j.id=a.task_id and j.status='waiting_external' and j.role='development'
  and t.id=a.task_id and t.status in ('dispatching','submitted')
  and t.external->>'issueNumber'='969'
  and t.external->>'developerApprovalId'=a.id::text
  and t.external->>'developerReleaseSha'=p_release
  and t.external->>'task4aPostpaidDispatchClaimId'=claim.id::text
  and a.consumed_at is null and a.revoked_at is null and a.deadline>clock_timestamp()
  and a.owner_id=public.task4a_original_owner_id(p.actor_id,p.chat_id)
  and a.model='gpt-5.3-codex'
  and a.developer_authority->'task4aPostpaid'->>'version'='postpaid-same-task-v1'
  and a.developer_authority->>'task4aContinuationId'=s.id::text
  and s.revoked_at is null and s.deadline>clock_timestamp()
  and s.assessment_reserve_tokens=60000 and s.completion_reserve_tokens=60000
  and s.assessment_reserve_calls=6 and s.completion_reserve_calls=6
  and claim.id is not null and claim.data->>'approvalId'=a.id::text
  and claim.data->>'paidReceiptId'=paid.id::text
  and claim.data->>'releaseSha'=p_release
  and (
    (paid.data->'proposal'->>'releaseSha'=p_release
      and coalesce(claim.data->>'releaseHandoffReceiptId','')='')
    or (public.task4a_postpaid_release_handoff_authentic(p_release)
      and claim.data->>'releaseHandoffReceiptId'=(select e.id::text
         from public.project_events e where e.project_id=p.id
          and e.event='task4a_postpaid_release_handoff_authorized'))
  )
  and paid.id is not null and paid.data->>'ownerId'=a.owner_id::text
  and paid.data->>'consentDigest'=claim.data->>'paidDigest'
  and paid.data->'proposal'->>'approvalId'=a.id::text
  and exists(select 1 from public.benchmark_budget_accounts acct
    where acct.id=a.account_id and acct.developer_project_id=p.id
      and acct.developer_task_id=t.id and acct.frozen_at is null and acct.spent_tokens=49620)
  and price.is_active=true and price.pricing_status='verified'
  and price.pricing_verified_at between clock_timestamp()-interval '24 hours' and clock_timestamp()
  and price.pricing_input_per_1m=1.75 and price.pricing_output_per_1m=14
  and price.source_metadata->>'pricing_verification_source'
   ='https://developers.openai.com/api/docs/models/gpt-5.3-codex'
  and (select count(*) from public.benchmark_execution_grants where project_id=p.id)=1
  and (select count(*) from public.benchmark_budget_calls where account_id=a.account_id)=4
  and (select count(*) from public.benchmark_budget_calls
    where account_id=a.account_id and state<>'settled')=0
 ,false);
end $$;


-- These new entrypoints are unavailable to browser/anonymous roles.
revoke all on function
 public.task4a_postpaid_release_handoff_proposal(text),
 public.task4a_postpaid_release_handoff_authorize(uuid,text,text),
 public.task4a_postpaid_release_handoff_authentic(text)
 from public,anon,authenticated,service_role;
grant execute on function
 public.task4a_postpaid_release_handoff_proposal(text),
 public.task4a_postpaid_release_handoff_authorize(uuid,text,text),
 public.task4a_postpaid_release_handoff_authentic(text)
 to service_role;
