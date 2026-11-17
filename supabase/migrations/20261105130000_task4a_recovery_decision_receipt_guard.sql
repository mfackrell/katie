-- Task 4A: retain the ordinary exact-owner decision requirement; recognize only
-- the separately owner-approved original-task recovery with an immutable receipt.
-- DDL only: never authorizes, revokes, resumes or bills an existing production row.
create or replace function public.developer_approval_decision_guard()
returns trigger language plpgsql security definer set search_path=public as $task4a_decision_guard$
declare
 prior public.benchmark_native_spending_approvals;
 successor public.project_continuation_authorizations;
begin
 if new.developer_authority is null then return new;end if;

 -- Preserve the existing ordinary Developer approval rule without changes.
 if exists(
  select 1 from public.benchmark_lifecycle_decisions d
  join public.benchmark_lifecycle_proposals proposal on proposal.id=d.proposal_id
  where d.developer_approval_id=new.id and d.proposal_id=new.developer_proposal_id
   and d.decision='approved' and d.owner_id=new.owner_id
   and proposal.owner_id=new.owner_id and proposal.task_id=new.task_id
   and proposal.project_id=new.project_id
 ) then return new;end if;

 -- Original Task 4A only. The recovery RPC atomically revokes the unused
 -- historical approval, creates the exact same-account grant and writes the
 -- immutable owner-consent receipt. The deferred constraint sees the receipt
 -- at transaction COMMIT; an ordinary proposal is not forged or reused.
 if new.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
  and new.task_id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid
  and new.developer_proposal_id is null
  and new.previous_developer_approval_id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid
  and new.developer_authority->>'version'='ordinary-developer-v1'
  and new.developer_authority->'task4aRecovery'->>'version'='preinference-invalid-handoff-v1'
  and new.developer_authority->'task4aRecovery'->>'oldApprovalId'=new.previous_developer_approval_id::text
  and new.developer_authority->'task4aRecovery'->>'issueNumber'='969'
  and new.developer_authority->'task4aRecovery'->>'runId'='41673059705'
  and new.developer_authority->'task4aRecovery'->>'ownerConsentDigest' ~ '^[a-f0-9]{64}$'
  and new.consumed_at is null and new.revoked_at is null and new.trial_id is null
 then
  select * into prior from public.benchmark_native_spending_approvals
   where id=new.previous_developer_approval_id;
  select * into successor from public.project_continuation_authorizations
   where id=public.task4a_current_continuation_id(new.project_id)
    and project_id=new.project_id;
  if prior.id is not null and successor.id is not null
   and successor.predecessor_id is not null
   and successor.revoked_at is null and successor.deadline>clock_timestamp()
   and prior.consumed_at is null and prior.revoked_at is not null
   and prior.previous_developer_approval_id is null
   and prior.developer_authority->>'version'='ordinary-developer-v1'
   and not prior.developer_authority ? 'task4aContinuationId'
   and new.account_id=prior.account_id
   and new.owner_id=prior.owner_id and new.actor_id=prior.actor_id and new.chat_id=prior.chat_id
   and new.repository=prior.repository and new.model=prior.model
   and new.model='gpt-5.3-codex'
   and new.protocol_digest=prior.protocol_digest and new.max_tokens=prior.max_tokens
   and new.project_id=prior.project_id and new.task_id=prior.task_id
   and new.mission_assignment_id=prior.mission_assignment_id
   and new.deadline>clock_timestamp() and new.deadline<=successor.deadline
   and new.developer_authority->>'task4aContinuationId'=successor.id::text
   and new.developer_authority->'limits'=prior.developer_authority->'limits'
   and new.developer_authority->'binding'=prior.developer_authority->'binding'
   and new.developer_authority->>'scopeHash'=prior.developer_authority->>'scopeHash'
   and not exists(select 1 from public.benchmark_budget_calls c where c.account_id=new.account_id)
   and not exists(select 1 from public.benchmark_execution_grants g where g.developer_approval_id=new.id)
   and not exists(select 1 from public.mission_calls c where c.job_id=new.task_id)
   and exists(
    select 1 from public.project_events event
     where event.project_id=new.project_id and event.event='task4a_native_pregrant_recovered'
      and event.data->>'originalTaskId'=new.task_id::text
      and event.data->>'originalIssueNumber'='969'
      and event.data->>'originalRunId'='41673059705'
      and event.data->>'previousApprovalId'=prior.id::text
      and event.data->>'replacementApprovalId'=new.id::text
      and event.data->>'continuationId'=successor.id::text
      and event.data->>'ownerId'=new.owner_id::text
      and event.data->>'consentDigest'=new.developer_authority->'task4aRecovery'->>'ownerConsentDigest'
      and event.data->>'paidCallsCreated'='0'
      and event.data->>'accountReused'='true'
      and event.data->>'limitsNotIncreased'='true'
      and event.data->'replacementApproval'=to_jsonb(new)
   )
   and public.task4a_native_authority_ready(new.project_id,new.task_id,successor.id) is true
  then return new;end if;
 end if;
 raise exception 'Ordinary authority requires its committed exact owner decision';
end $task4a_decision_guard$;
revoke all on function public.developer_approval_decision_guard() from public,anon,authenticated,service_role;
