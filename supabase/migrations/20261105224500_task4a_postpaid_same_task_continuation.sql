-- Task 4A: install-only, post-paid same-task recovery.
-- Requires 20261105210000_task4a_separate_dispatch_paid_execution.sql.
-- Four settled calls and the original WIP remain immutable. No execution here.
create unique index if not exists task4a_postpaid_unique_receipts
 on public.project_events(project_id,event)
 where event in ('task4a_postpaid_owner_authorized',
  'task4a_postpaid_redispatch_authorized','task4a_postpaid_paid_authorized',
  'task4a_postpaid_dispatch_claimed','task4a_postpaid_dispatch_submitted');

create or replace function public.task4a_postpaid_immutable()
returns trigger language plpgsql set search_path=public as $$
begin
 if old.event in ('task4a_postpaid_owner_authorized',
  'task4a_postpaid_redispatch_authorized','task4a_postpaid_paid_authorized',
  'task4a_postpaid_dispatch_claimed','task4a_postpaid_dispatch_submitted')
 then raise exception 'TASK4A_POSTPAID_AUDIT_IMMUTABLE';end if;
 return old;
end $$;
create trigger task4a_postpaid_immutable before update or delete on public.project_events
 for each row execute function public.task4a_postpaid_immutable();

-- The API independently authenticates the latest WIP tag, commit/tree,
-- failed workflow, and last settled provider operation before calling this.
-- Every PostgreSQL source row is also validated, not inferred from UI inputs.
create or replace function public.task4a_postpaid_proposal(
 p_release text,p_checkpoint text,p_checkpoint_digest text,p_limits jsonb default null
) returns jsonb language plpgsql stable set search_path=public as $$
declare p public.work_projects;m public.agent_missions;j public.mission_assignments;
 t public.agent_tasks;r public.project_runs;a public.benchmark_native_spending_approvals;
 acct public.benchmark_budget_accounts;g public.benchmark_execution_grants;
 prior public.project_continuation_authorizations;price public.model_registry;
 owner_id uuid;calls bigint;tokens bigint;pending bigint;mc_count bigint;exposure_count bigint;
 other_tokens bigint;dollars numeric;min_next bigint:=21864;evidence jsonb;proposal jsonb;
begin
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into m from public.agent_missions where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid and project_id=p.id;
 select * into j from public.mission_assignments where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid and mission_id=m.id;
 select * into t from public.agent_tasks where id=j.id;
 select * into r from public.project_runs where project_id=p.id and mission_id=m.id;
 select * into a from public.benchmark_native_spending_approvals
  where id=(t.external->>'developerApprovalId')::uuid and task_id=t.id;
 select * into acct from public.benchmark_budget_accounts where id=a.account_id;
 select * into g from public.benchmark_execution_grants where developer_approval_id=a.id;
 select * into prior from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id);
 select * into price from public.model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 owner_id:=public.task4a_original_owner_id(p.actor_id,p.chat_id);
 select count(*),coalesce(sum(actual_tokens),0),
   count(*) filter(where state<>'settled' or actual_tokens is null)
 into calls,tokens,pending from public.benchmark_budget_calls where account_id=acct.id;
 select count(*) into mc_count from public.mission_calls where job_id=t.id;
 select count(*),coalesce(sum(exposure_microusd),0) into exposure_count,dollars
  from public.benchmark_dollar_exposures where account_id=acct.id;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into other_tokens
  from public.agent_missions where project_id=p.id and id<>m.id;
 evidence:=jsonb_build_object('kind','task4a_postpaid_evidence_v1',
  'projectId',p.id,'missionId',m.id,'taskId',t.id,'issueNumber',969,
  'failedRunId',42102615797,'checkpointSha',p_checkpoint,
  'checkpointDigest',p_checkpoint_digest,
  'checkpointTag','refs/tags/katie-wip/d0e41ff5-149e-4319-9e65-dcc605fb75da/42102615797-1/2',
  'checkpointTree','26869fb977fd29b4f96652b9de3d47e0f0e0ffeb',
  'completedCheckpointSha','49c8a5f791e66c351436bb97839193b53d7a1cd1',
  'ownerId',owner_id,'priorApprovalId',a.id,'priorGrantId',g.id,
  'priorContinuationId',prior.id,'nativeAccountId',acct.id,
  'scopeHash',p.approved_hash,'contractHash',r.binding->>'contractHash',
  'baselineSha',p.baseline_sha,'oldDeadline',p.deadline,
  'settledCalls',calls,'settledTokens',tokens,'committedMicrousd',dollars,
  'heldCalls',pending,'otherHistoricalProjectTokens',other_tokens,
  'projectTokenCeiling',p.token_allowance,
  'protectedAssessmentTokens',60000,'protectedCompletionTokens',60000,
  'protectedAssessmentCalls',prior.assessment_reserve_calls,
  'protectedCompletionCalls',prior.completion_reserve_calls,
  'nativeAssessmentCalls',4,'nativeCompletionCalls',4,
  'observedNextRequestReservation',min_next,
  'minimumAdditionalTokens',greatest(0,tokens+120000+min_next-a.max_tokens),
  'minimumAdditionalNativeCalls',12,
  'unfinishedStages',jsonb_build_array('implementation','verification',
     'initial_review','possible_repair','final_review','completion',
     'assessment','protected_preview_acceptance'),
  'remainingTokenEstimate',null,'incrementalDollarEstimate',null,
  'remainingTimeEstimate',null,
  'uncertainties',jsonb_build_array('future_context_growth','repair_count',
   'missing_comparable_completed_phases','review_and_assessment_usage',
   'browser_delivery_cost'),'guaranteedCompletion',false);
 -- Immutable predecessor authorization cannot be silently reduced or revoked.
 -- The existing chain guard requires expiration before an owner can add a
 -- successor. Surface this dependency before showing a commit-ready quote.
 if prior.id is not null and prior.deadline>clock_timestamp()
   and prior.revoked_at is null
 then return jsonb_build_object('ready',false,
   'reason','existing_continuation_must_expire_before_successor',
   'predecessorExpiresAt',prior.deadline,'evidence',evidence);end if;
 if p.id is null or m.id is null or j.id is null or t.id is null or a.id is null
  or g.id is null or prior.id is null or owner_id is null or r.id is null
  or p.status<>'blocked' or p.phase<>'development'
  or m.status<>'blocked' or j.status<>'failed' or t.status<>'blocked'
  or p.active_mission_id is distinct from m.id or p.approved_hash is null
  or p.approved_hash is distinct from p.approval_hash
  or p.baseline_sha is distinct from '49c8a5f791e66c351436bb97839193b53d7a1cd1'
  or r.binding->>'scopeHash' is distinct from p.approved_hash
  or r.binding->>'contractHash' is distinct from 'e8b08da72779ae0d7e864ed57c5ecc76b03d1fce6ddc9e14815e9c4c3dff332e'
  or a.owner_id is distinct from owner_id or a.model is distinct from 'gpt-5.3-codex'
  or a.developer_authority->>'task4aContinuationId' is distinct from prior.id::text
  or a.consumed_at is null or a.revoked_at is not null
  or acct.arm<>'developer' or acct.frozen_at is not null
  or acct.developer_task_id is distinct from t.id or acct.developer_project_id is distinct from p.id
  or acct.cap_tokens<>180000 or acct.spent_tokens<>49620 or a.max_tokens<>180000
  or prior.assessment_reserve_tokens<>60000 or prior.completion_reserve_tokens<>60000
  or prior.assessment_reserve_calls<>6 or prior.completion_reserve_calls<>6
  or t.external->>'issueNumber' is distinct from '969'
  or t.external->'receipt'->>'run_id' is distinct from '42102615797'
  or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or t.external->'receipt'->>'pr_url' is not null
  or g.account_id is distinct from acct.id or g.project_id is distinct from p.id
  or g.mission_assignment_id is distinct from t.id or g.execution_epoch<>1
  or (select count(*) from public.benchmark_execution_grants where project_id=p.id)<>1
  or calls<>4 or tokens<>49620 or pending<>0 or mc_count<>4 or exposure_count<>4
  or m.actual_tokens<>49620 or m.reserved_tokens<>49620 or m.calls<>4 or m.routing_calls<>0
  or exists(select 1 from public.benchmark_budget_calls c
    left join public.mission_calls mc on mc.id=c.legacy_mission_call_id
    left join public.benchmark_dollar_exposures e on e.call_id=c.id and e.account_id=c.account_id
    where c.account_id=acct.id and (mc.id is null or mc.job_id<>t.id or mc.status<>'completed'
      or mc.actual_tokens is distinct from c.actual_tokens or e.call_id is null
      or c.provider_request_id is null or c.provider_usage is null))
  or not exists(select 1 from public.project_events where project_id=p.id
    and event='task4a_failed_dispatch_recovery_submitted')
  or exists(select 1 from public.project_events where project_id=p.id
    and event='task4a_postpaid_owner_authorized')
  or coalesce(p_release,'')!~'^[a-f0-9]{40}$'
  or p_checkpoint is distinct from '8e53ce01693303fc50daf5da1567e93e725f9b2d'
  or coalesce(p_checkpoint_digest,'')!~'^[a-f0-9]{64}$'
 then return jsonb_build_object('ready',false,'reason','original_postpaid_evidence_unavailable','evidence',evidence);end if;
 if price.is_active is distinct from true or price.pricing_status is distinct from 'verified'
  or price.pricing_verified_at not between clock_timestamp()-interval '24 hours' and clock_timestamp()
  or price.pricing_input_per_1m<>1.75 or price.pricing_output_per_1m<>14
  or price.source_metadata->>'pricing_verification_source'
    is distinct from 'https://developers.openai.com/api/docs/models/gpt-5.3-codex'
 then return jsonb_build_object('ready',false,'reason','fresh_official_model_pricing_required','evidence',evidence);end if;
 if p_limits is null then return jsonb_build_object('ready',false,
   'reason','explicit_owner_limits_required','evidence',evidence);end if;
 if jsonb_typeof(p_limits)<>'object' or
  (select count(*) from jsonb_object_keys(p_limits))<>10 or
  not public.developer_validate_limits(p_limits)
 then return jsonb_build_object('ready',false,'reason','invalid_owner_limits','evidence',evidence);end if;
 if (p_limits->>'assessmentTokens')::bigint<>60000
  or (p_limits->>'completionTokens')::bigint<>60000
  or (p_limits->>'assessmentCalls')::integer<>4
  or (p_limits->>'completionCalls')::integer<>4
  or (p_limits->>'perCallMicrousd')::numeric<>1680000
  or (p_limits->>'ceilingMicrousd')::numeric<2520000
  or (p_limits->>'ceilingMicrousd')::numeric>9000000
  or (p_limits->>'cumulativeTokens')::bigint<tokens+120000+min_next
  or (p_limits->>'developmentTokens')::bigint<tokens+60000+min_next
  or (p_limits->>'cumulativeTokens')::bigint<
       (p_limits->>'developmentTokens')::bigint+60000
  or (p_limits->>'cumulativeTokens')::bigint>p.token_allowance-other_tokens
  or (p_limits->>'developmentCalls')::integer<16
  or (p_limits->>'developmentCalls')::integer>100
  or (p_limits->>'durationSeconds')::integer<3600
  or (p_limits->>'durationSeconds')::integer>172800
 then return jsonb_build_object('ready',false,'reason','owner_limits_insufficient_or_exceed_bounds','evidence',evidence);end if;
 proposal:=evidence||jsonb_build_object('version',1,
  'kind','task4a_postpaid_same_task_continuation',
  'releaseSha',p_release,'nativeLimits',p_limits,
  'deadlineSemantics','duration_from_authenticated_owner_commit',
  'newContinuationTokenCap',(p_limits->>'cumulativeTokens')::bigint-tokens,
  'newContinuationCallCap',((p_limits->>'developmentCalls')::integer-4)+12,
  'pricingEvidence',jsonb_build_object('model','openai:gpt-5.3-codex',
     'verifiedAt',price.pricing_verified_at,
     'source',price.source_metadata->>'pricing_verification_source',
     'inputPerMillionUsd',price.pricing_input_per_1m,
     'outputPerMillionUsd',price.pricing_output_per_1m),
  'separateRedispatchConsent',true,'separatePaidInferenceConsent',true,
  'noNewProject',true,'noProviderCallsOnApproval',true);
 return jsonb_build_object('ready',true,'proposal',proposal,
  'digest',encode(sha256(convert_to(public.project_canonical(proposal),'UTF8')),'hex'));
end $$;

-- Owner approval never dispatches or runs inference. The original project and
-- task stay blocked until separate redispatch AND separate paid consent.
create or replace function public.task4a_postpaid_authorize(
 p_owner uuid,p_digest text,p_release text,p_checkpoint text,
 p_checkpoint_digest text,p_limits jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare offer jsonb;plan jsonb;p public.work_projects;m public.agent_missions;
 j public.mission_assignments;t public.agent_tasks;a public.benchmark_native_spending_approvals;
 g public.benchmark_execution_grants;prior public.project_continuation_authorizations;
 successor uuid;child uuid;receipt uuid;new_deadline timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into m from public.agent_missions
  where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid for update;
 select * into j from public.mission_assignments
  where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid for update;
 select * into t from public.agent_tasks where id=j.id for update;
 select * into a from public.benchmark_native_spending_approvals
  where id=(t.external->>'developerApprovalId')::uuid for update;
 select * into g from public.benchmark_execution_grants
  where developer_approval_id=a.id for update;
 select * into prior from public.project_continuation_authorizations
  where id=public.task4a_current_continuation_id(p.id) for update;
 offer:=public.task4a_postpaid_proposal(p_release,p_checkpoint,p_checkpoint_digest,p_limits);
 plan:=offer->'proposal';
 if p_owner is null or p_owner is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)
  or offer->>'ready' is distinct from 'true' or offer->>'digest' is distinct from p_digest
  or plan->>'priorApprovalId' is distinct from a.id::text
  or plan->>'priorContinuationId' is distinct from prior.id::text
  or plan->>'priorGrantId' is distinct from g.id::text
 then raise exception 'TASK4A_POSTPAID_OWNER_CONSENT_DENIED';end if;
 new_deadline:=clock_timestamp()+make_interval(secs=>(p_limits->>'durationSeconds')::integer);
 insert into public.project_continuation_authorizations(
  project_id,actor_id,chat_id,source_mission_id,approval_digest,deadline,
  incremental_tokens,incremental_calls,incremental_microusd,
  assessment_reserve_tokens,completion_reserve_tokens,
  assessment_reserve_calls,completion_reserve_calls,
  allowed_models,historical_tokens,historical_calls,historical_mission_deadline,
  pricing_evidence,predecessor_id)
 values(p.id,p.actor_id,p.chat_id,prior.source_mission_id,p_digest,new_deadline,
  (plan->>'newContinuationTokenCap')::bigint,
  (plan->>'newContinuationCallCap')::integer,
  (p_limits->>'ceilingMicrousd')::numeric,
  60000,60000,6,6,array['openai:gpt-5.3-codex']::text[],
  prior.historical_tokens+49620,prior.historical_calls+4,
  prior.historical_mission_deadline,jsonb_build_array(plan->'pricingEvidence'),prior.id)
 returning id into successor;
 insert into public.benchmark_lifecycle_proposals(
  id,owner_id,task_id,project_id,snapshot_hash,fingerprint,proposal,checkpoint,expires_at)
 values(p_digest,p_owner,t.id,p.id,p_checkpoint_digest,p_digest,plan,
  jsonb_build_object('checkpointSha',p_checkpoint,
   'digest',p_checkpoint_digest,'failedRunId',42102615797,'priorGrantId',g.id),
  new_deadline);
 insert into public.benchmark_native_spending_approvals(
  owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,
  max_tokens,deadline,project_id,mission_assignment_id,task_id,
  developer_authority,previous_developer_approval_id,developer_proposal_id)
 values(a.owner_id,a.actor_id,a.chat_id,null,a.account_id,a.repository,a.model,
  a.protocol_digest,(p_limits->>'cumulativeTokens')::bigint,new_deadline,
  a.project_id,a.mission_assignment_id,a.task_id,
  a.developer_authority||jsonb_build_object(
   'limits',p_limits,'task4aContinuationId',successor,
   'checkpoint',jsonb_build_object('checkpointSha',p_checkpoint,
      'scopeHash',p.approved_hash,'runId','42102615797','digest',p_checkpoint_digest),
   'task4aPostpaid',jsonb_build_object('version','postpaid-same-task-v1',
     'ownerDigest',p_digest,'priorApprovalId',a.id,'priorGrantId',g.id,
     'priorContinuationId',prior.id,'newContinuationId',successor,
     'failedRunId',42102615797,'checkpointSha',p_checkpoint)),
  a.id,p_digest)
 returning id into child;
 insert into public.benchmark_lifecycle_decisions(
  proposal_id,owner_id,decision,developer_approval_id)
 values(p_digest,p_owner,'approved',child);
 update public.benchmark_execution_grants
  set stopped_at=coalesce(stopped_at,clock_timestamp()) where id=g.id;
 update public.benchmark_native_spending_approvals
  set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=a.id;
 update public.work_projects set deadline=new_deadline,updated_at=clock_timestamp()
  where id=p.id;
 update public.agent_missions set deadline=new_deadline,updated_at=clock_timestamp()
  where id=m.id;
 update public.agent_tasks set
  external=external||jsonb_build_object('developerApprovalId',child,
   'task4aPostpaidOwnerApprovalDigest',p_digest),
  details='Postpaid successor awaiting separate redispatch and paid authorization.',
  updated_at=clock_timestamp() where id=t.id;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_postpaid_owner_authorized',
  jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,'proposal',plan,
   'checkpointSha',p_checkpoint,'priorGrantId',g.id,
   'priorApprovalId',a.id,'newApprovalId',child,
   'priorContinuationId',prior.id,'newContinuationId',successor,
   'priorDeadline',p.deadline,'newDeadline',new_deadline,
   'settledCalls',4,'settledTokens',49620,
   'protectedAssessmentTokens',60000,'protectedCompletionTokens',60000,
   'protectedAssessmentCalls',6,'protectedCompletionCalls',6,
   'originalIssue',969,'noWorkflowDispatch',true,'noPaidCalls',true,
   'noNewProject',true))
 returning id into receipt;
 return jsonb_build_object('authorized',true,'receiptId',receipt,
  'newApprovalId',child,'newContinuationId',successor,
  'deadline',new_deadline,'dispatchAuthorized',false,
  'paidInferenceAuthorized',false,'newPaidCalls',0);
end $$;

-- Owner approval #1: permission to REDISPATCH, not to spend.
create or replace function public.task4a_postpaid_redispatch_proposal(p_release text)
returns jsonb language plpgsql stable set search_path=public as $$
declare e public.project_events;p public.work_projects;t public.agent_tasks;
 a public.benchmark_native_spending_approvals;candidate jsonb;
begin
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into t from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid;
 select * into e from public.project_events where project_id=p.id and event='task4a_postpaid_owner_authorized';
 select * into a from public.benchmark_native_spending_approvals
  where id=(e.data->>'newApprovalId')::uuid;
 if e.id is null or p.status<>'blocked' or t.status<>'blocked'
  or t.external->>'developerApprovalId' is distinct from a.id::text
  or a.revoked_at is not null or a.consumed_at is not null
  or a.deadline<=clock_timestamp() or coalesce(p_release,'')!~'^[a-f0-9]{40}$'
  or exists(select 1 from public.project_events where project_id=p.id
   and event in ('task4a_postpaid_redispatch_authorized','task4a_postpaid_dispatch_claimed'))
 then return jsonb_build_object('ready',false,'reason','postpaid_redispatch_unavailable');end if;
 candidate:=jsonb_build_object('kind','task4a_postpaid_redispatch_v1',
  'ownerId',a.owner_id,'projectId',p.id,'taskId',t.id,'originalIssue',969,
  'ownerAuthorityReceiptId',e.id,'ownerDigest',e.data->>'consentDigest',
  'approvalId',a.id,'releaseSha',p_release,
  'checkpointSha','8e53ce01693303fc50daf5da1567e93e725f9b2d',
  'noPaidInference',true,'noDispatchOnConsent',true);
 return jsonb_build_object('ready',true,'proposal',candidate,
  'digest',encode(sha256(convert_to(public.project_canonical(candidate),'UTF8')),'hex'));
end $$;
create or replace function public.task4a_postpaid_authorize_redispatch(
 p_owner uuid,p_digest text,p_release text
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare p public.work_projects;offer jsonb;receipt uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 offer:=public.task4a_postpaid_redispatch_proposal(p_release);
 if p_owner is null or p_owner is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)
  or offer->>'ready' is distinct from 'true' or offer->>'digest' is distinct from p_digest
 then raise exception 'TASK4A_POSTPAID_REDISPATCH_DENIED';end if;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_postpaid_redispatch_authorized',
  jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,
   'proposal',offer->'proposal','paidInferenceAuthorized',false,
   'noGitHubRequestOnConsent',true,'newPaidCalls',0))
 returning id into receipt;
 return jsonb_build_object('authorized',true,'receiptId',receipt,
  'paidInferenceAuthorized',false,'dispatched',false,'newPaidCalls',0);
end $$;

-- Owner approval #2: BOUNDED PAID EXECUTION. Pricing is checked anew.
-- This receipt STILL does not start a workflow or create an execution grant.
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
  or redispatch.data->'proposal'->>'releaseSha' is distinct from p_release
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
  'oneOriginalIssueDispatch',true,'noNewFinancialAuthority',true);
 return jsonb_build_object('ready',true,'proposal',candidate,
  'digest',encode(sha256(convert_to(public.project_canonical(candidate),'UTF8')),'hex'));
end $$;
create or replace function public.task4a_postpaid_authorize_paid(
 p_owner uuid,p_digest text,p_release text
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare p public.work_projects;offer jsonb;receipt uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 offer:=public.task4a_postpaid_paid_proposal(p_release);
 if p_owner is null or p_owner is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)
  or offer->>'ready' is distinct from 'true' or offer->>'digest' is distinct from p_digest
  or exists(select 1 from public.project_events where project_id=p.id
    and event='task4a_postpaid_paid_authorized')
 then raise exception 'TASK4A_POSTPAID_PAID_INFERENCE_DENIED';end if;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_postpaid_paid_authorized',
  jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,
   'proposal',offer->'proposal',
   'redispatchReceiptId',offer->'proposal'->>'redispatchReceiptId',
   'distinctOwnerConsent',true,'noNewFinancialAuthority',true,'newPaidCalls',0))
 returning id into receipt;
 return jsonb_build_object('authorized',true,'receiptId',receipt,
  'paidExecutionAuthorized',true,'newPaidCalls',0);
end $$;

-- A one-time claim, following BOTH distinct owner receipts. It is the only
-- transition of the original blocked task into the existing native dispatcher.
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
   'releaseSha',p_release,'issueNumber',969,'noPaidCallYet',true))
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
create or replace function public.task4a_distinct_paid_grant_guard()
returns trigger language plpgsql set search_path=public as $$
declare a public.benchmark_native_spending_approvals;release text;
begin
 if new.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
  and new.mission_assignment_id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid
 then
  select * into a from public.benchmark_native_spending_approvals
   where id=new.developer_approval_id;
  select external->>'developerReleaseSha' into release
   from public.agent_tasks where id=new.mission_assignment_id;
  if a.developer_authority->'task4aPostpaid'->>'version'='postpaid-same-task-v1' then
   if not public.task4a_postpaid_grant_ready(new.developer_approval_id,release)
   then raise exception 'TASK4A_POSTPAID_SEPARATE_PAID_OWNER_CONSENT_REQUIRED';end if;
   return new;
  end if;
  if exists(select 1 from public.project_events where project_id=new.project_id
    and event in ('task4a_failed_dispatch_owner_authorized',
                  'task4a_blocked_dispatch_owner_recovered'))
    and (new.developer_approval_id is null
      or not public.task4a_paid_dispatch_grant_ready(new.developer_approval_id,release))
   then raise exception 'TASK4A_SEPARATE_PAID_AUTH_REQUIRED_BEFORE_GRANT';end if;
 end if;
 return new;
end $$;
create or replace function public.task4a_postpaid_record_submitted(
 p_release text
) returns boolean language plpgsql security invoker set search_path=public as $$
declare p public.work_projects;t public.agent_tasks;c public.project_events;receipt uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into t from public.agent_tasks
  where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid for update;
 select * into c from public.project_events where project_id=p.id
  and event='task4a_postpaid_dispatch_claimed';
 if c.id is null or t.status<>'dispatching'
  or t.external->>'task4aPostpaidDispatchClaimId' is distinct from c.id::text
  or c.data->>'releaseSha' is distinct from p_release
  or exists(select 1 from public.project_events where project_id=p.id
   and event='task4a_postpaid_dispatch_submitted') then return false;end if;
 insert into public.project_events(project_id,event,data)
 values(p.id,'task4a_postpaid_dispatch_submitted',
  jsonb_build_object('claimReceiptId',c.id,'releaseSha',p_release,
   'issueNumber',969,'acceptedByGithubApi',true,'runIdPending',true))
 returning id into receipt;
 update public.agent_tasks set status='submitted',
  external=external||jsonb_build_object('attempted',true,'developerDispatchRunPending',true),
  details='Original Task 4A issue #969 resubmitted after three independent owner decisions.',
  updated_at=clock_timestamp() where id=t.id;
 return true;
end $$;
revoke all on function
 public.task4a_postpaid_immutable(),
 public.task4a_postpaid_proposal(text,text,text,jsonb),
 public.task4a_postpaid_authorize(uuid,text,text,text,text,jsonb),
 public.task4a_postpaid_redispatch_proposal(text),
 public.task4a_postpaid_authorize_redispatch(uuid,text,text),
 public.task4a_postpaid_paid_proposal(text),
 public.task4a_postpaid_authorize_paid(uuid,text,text),
 public.task4a_postpaid_claim(text),
 public.task4a_postpaid_grant_ready(uuid,text),
 public.task4a_postpaid_record_submitted(text)
 from public,anon,authenticated,service_role;
grant execute on function
 public.task4a_postpaid_proposal(text,text,text,jsonb),
 public.task4a_postpaid_authorize(uuid,text,text,text,text,jsonb),
 public.task4a_postpaid_redispatch_proposal(text),
 public.task4a_postpaid_authorize_redispatch(uuid,text,text),
 public.task4a_postpaid_paid_proposal(text),
 public.task4a_postpaid_authorize_paid(uuid,text,text),
 public.task4a_postpaid_claim(text),
 public.task4a_postpaid_grant_ready(uuid,text),
 public.task4a_postpaid_record_submitted(text)
 to service_role;
