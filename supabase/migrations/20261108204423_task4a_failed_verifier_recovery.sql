-- One-shot recovery for run 42506385410 only. No financial ceiling increase.
-- The existing final-successor guards and admission functions are unchanged.
create function public.task4a_verifier_history_valid() returns boolean language sql stable security definer set search_path=public as $$
 select coalesce(public.task4a_final_history_valid()
 and exists(select 1 from project_events where id='bfe91e28-6769-4506-b7c9-0e38288fdbaf' and project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'
 and event='task4a_final_execution_claimed' and encode(sha256(convert_to(project_canonical(data),'UTF8')),'hex')='a622f3d5ef5783cd205c50249895e99e3b7c292561020c7642106ef7c2d2c306')
 and exists(select 1 from project_events where id='a7c11f7a-1665-4ae0-92f8-c98977d95820' and project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'
 and event='task4a_final_execution_submitted' and encode(sha256(convert_to(project_canonical(data),'UTF8')),'hex')='dac5a9b34208c0c4bea171a651ac24ada04e6298fd4f6366d627a91e691402a8')
 and exists(select 1 from benchmark_native_spending_approvals a where a.id='1961239b-1722-4901-b671-8e61f4e6af49'
 and a.previous_developer_approval_id='ac443164-faf7-45be-96f1-cc93dfc85346' and a.consumed_at is not null and a.revoked_at is null
 and a.developer_authority->'task4aFinalSuccessor'->>'consentDigest'='fe812287c15db060927a2adf4767d9e9cd28d712deca78734c46bc312429129f')
 and (select count(*) from mission_calls where project_continuation_id='6e4eba28-2dbe-4faa-be93-5f24861dba3a')=0
 and (select sum(greatest(reserved_tokens,actual_tokens)) from mission_calls where job_id='d0e41ff5-149e-4319-9e65-dcc605fb75da' and project_continuation_id='fb331001-f86b-4332-84eb-5d486bae1ee0')=64920
 and (select sum(greatest(project_reserved_microusd,project_actual_microusd)) from mission_calls where job_id='d0e41ff5-149e-4319-9e65-dcc605fb75da' and project_continuation_id='fb331001-f86b-4332-84eb-5d486bae1ee0')=1499654,false)
$$;
-- Install only. Capacity consent never authorizes dispatch, a grant or inference.
create unique index task4a_verifier_one_successor on public.project_events(project_id,event)
 where event in ('task4a_verifier_owner_authorized','task4a_verifier_execution_authorized','task4a_verifier_inference_authorized','task4a_verifier_dispatch_authorized','task4a_verifier_execution_claimed','task4a_verifier_execution_submitted');
create function public.task4a_verifier_immutable() returns trigger language plpgsql set search_path=public as $$
begin
 if old.event in ('task4a_verifier_owner_authorized','task4a_verifier_execution_authorized','task4a_verifier_inference_authorized','task4a_verifier_dispatch_authorized','task4a_verifier_execution_claimed','task4a_verifier_execution_submitted') then raise exception 'TASK4A_VERIFIER_AUDIT_IMMUTABLE';end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger task4a_verifier_immutable before update or delete on public.project_events
 for each row execute function public.task4a_verifier_immutable();

create function public.task4a_verifier_proposal(p_release text,p_checkpoint jsonb)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare p public.work_projects;m public.agent_missions;t public.agent_tasks;j public.mission_assignments;
 a public.benchmark_native_spending_approvals;s public.project_continuation_authorizations;
 acct public.benchmark_budget_accounts;r public.project_runs;price public.model_registry;
 calls bigint;tokens bigint;pending bigint;money numeric;delta_calls bigint;delta_tokens bigint;delta_money numeric; admitted_tokens bigint; admitted_money numeric; ledger jsonb; envelope jsonb;
 limits jsonb;proposal jsonb;claims jsonb;
begin
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
 select * into m from public.agent_missions where id=p.active_mission_id;
 select * into t from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da';
 select * into j from public.mission_assignments where id=t.id;
 select * into r from public.project_runs where project_id=p.id and mission_id=m.id;
 select * into a from public.benchmark_native_spending_approvals where id=(t.external->>'developerApprovalId')::uuid;
 select * into acct from public.benchmark_budget_accounts where id=a.account_id;
 select * into s from public.project_continuation_authorizations where id=public.task4a_current_continuation_id(p.id);
 select * into price from public.model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 select count(*),coalesce(sum(actual_tokens),0),count(*) filter(where state<>'settled' or actual_tokens is null)
 into calls,tokens,pending from public.benchmark_budget_calls where account_id=a.account_id;
 select coalesce(sum(exposure_microusd),0) into money from public.benchmark_dollar_exposures where account_id=a.account_id;
 select count(*),coalesce(sum(actual_tokens),0),coalesce(sum(project_actual_microusd),0)
 into delta_calls,delta_tokens,delta_money from public.mission_calls where job_id=t.id and project_continuation_id=s.id;
 select jsonb_agg(jsonb_build_object('id',id,'event',event,'data',data) order by id) into claims
 from public.project_events where project_id=p.id and id in
  ('f105fde0-1e35-4aaf-80c6-b80645701325'::uuid,'2cbdbff0-cc11-4dd8-8a62-95b0e8ae2534'::uuid,'c156d764-652f-4740-aa50-4ab8c5ab04e4'::uuid);
 limits:=a.developer_authority->'limits';
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0),coalesce(sum(greatest(project_actual_microusd,project_reserved_microusd)),0)
 into admitted_tokens,admitted_money from public.mission_calls where job_id=t.id and project_continuation_id=s.id;
 select jsonb_agg(jsonb_build_object('id',b.id,'request',b.provider_request_id,'actual',b.actual_tokens,'reserved',b.reserved_tokens,'usage',b.provider_usage,'exposure',e.exposure_microusd) order by b.id)
 into ledger from public.benchmark_budget_calls b join public.benchmark_dollar_exposures e on e.call_id=b.id where b.account_id=a.account_id;
 envelope:='{"version":"task4a-successor-envelope-v1","projectId":"6d1c29f1-b31e-47a5-aabb-cbcf1326f388","taskId":"d0e41ff5-149e-4319-9e65-dcc605fb75da","checkpointSha":"d2610d94289a0ba5aafcaa60598cae7c21507cfe","basis":"owner_selected_historical_maximum_reservation_not_forecast","model":"gpt-5.3-codex","requestTokens":23034,"nativeCalls":6,"nativeReservationTokens":138204,"outputTokens":4096,"protocolTokens":1024,"inputAndOpaqueTokens":17914,"additionalNativeTokens":115954,"additionalProjectTokens":136129,"additionalCalls":2,"cumulativeTokens":405574,"developmentTokens":345574,"developmentCalls":22,"continuationTokens":258204,"continuationCalls":18,"continuationMicrousd":7394515,"carriedProjectReservationTokens":64920,"carriedProjectReservationMicrousd":1499654,"assessmentReserveTokens":60000,"completionReserveTokens":60000,"ceilingMicrousd":9000000,"perCallMicrousd":1680000,"nativeRequestBoundMicrousd":322476,"nativeEnvelopeBoundMicrousd":1934856,"projectRequestBoundMicrousd":532086,"projectEnvelopeBoundMicrousd":3192516,"durationSeconds":14400}'::jsonb;
 if p.id is null or m.id is distinct from 'd3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid
  or t.id is null or j.mission_id is distinct from m.id or m.project_id is distinct from p.id
  or p.status is distinct from 'blocked' or m.status is distinct from 'blocked' or t.status is distinct from 'blocked' or j.status is distinct from 'failed'
  or p.phase is distinct from 'development' or j.role is distinct from 'development'
  or p.approved_hash is distinct from 'debdfd441a9bb6b1106d2e09c56b6e7a2c494ce81f23890e104a625c8633c685'
  or p.approval_hash is distinct from p.approved_hash or r.binding is distinct from a.developer_authority->'binding'
  or a.developer_authority->'completionContract' is distinct from p.completion_contract
  or r.binding->'allowedPaths' is distinct from '["app/project-pilots/task4a-preview-probe/"]'::jsonb
  or a.owner_id is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)
  or a.task_id is distinct from t.id or a.project_id is distinct from p.id or a.account_id is distinct from acct.id
  or a.mission_assignment_id is distinct from t.id or a.trial_id is not null or a.continuation_id is not null
  or a.developer_authority->>'version' is distinct from 'ordinary-developer-v1'
  or acct.arm is distinct from 'developer' or acct.developer_project_id is distinct from p.id or acct.developer_task_id is distinct from t.id
  or a.consumed_at is null or a.revoked_at is not null or a.deadline is distinct from s.deadline
  or a.max_tokens is distinct from 405574 or a.model is distinct from 'gpt-5.3-codex' or a.repository is distinct from 'mfackrell/katie'
  or a.developer_authority->'task4aPostpaid'->>'version' is distinct from 'postpaid-same-task-v1'
  or a.developer_authority->>'task4aContinuationId' is distinct from s.id::text
  or s.id is null or s.deadline is distinct from p.deadline or s.revoked_at is not null
  or s.assessment_reserve_tokens<>60000 or s.completion_reserve_tokens<>60000
  or s.assessment_reserve_calls<>6 or s.completion_reserve_calls<>6
  or s.allowed_models is distinct from array['openai:gpt-5.3-codex']::text[]
  or acct.frozen_at is not null or acct.spent_tokens<>tokens
  or calls<>12 or tokens<>147370 or pending<>0 or money<>280798
  or delta_calls<>0 or delta_tokens<>0 or delta_money<>0 or admitted_tokens<>0 or admitted_money<>0
  or s.incremental_tokens<>258204 or s.incremental_calls<>18 or s.incremental_microusd<>7394515
  or a.developer_authority->'task4aSuccessorEnvelope' is distinct from envelope
  or (select count(*) from public.mission_calls where job_id=t.id)<>calls
  or (select count(*) from public.benchmark_dollar_exposures where account_id=a.account_id)<>calls
  or (select count(*) from public.benchmark_execution_grants where account_id=a.account_id)<>4
  or m.calls<>calls or m.actual_tokens<>tokens or m.reserved_tokens<>tokens
  or m.routing_calls is distinct from 0
  or limits is distinct from '{"assessmentCalls":4,"ceilingMicrousd":9000000,"completionCalls":4,"durationSeconds":14400,"perCallMicrousd":1680000,"assessmentTokens":60000,"completionTokens":60000,"cumulativeTokens":405574,"developmentCalls":22,"developmentTokens":345574}'::jsonb
  or jsonb_array_length(claims) is distinct from 3
  or t.external->>'task4aPostpaidDispatchClaimId' is distinct from 'f105fde0-1e35-4aaf-80c6-b80645701325'
  or t.external->>'task4aReplacementClaimId' is distinct from '2cbdbff0-cc11-4dd8-8a62-95b0e8ae2534'
  or a.id is distinct from '1961239b-1722-4901-b671-8e61f4e6af49'::uuid
  or s.id is distinct from '6e4eba28-2dbe-4faa-be93-5f24861dba3a'::uuid
  or t.external->>'task4aCapacityExecutionClaimId' is distinct from 'c156d764-652f-4740-aa50-4ab8c5ab04e4'
  or not public.task4a_verifier_history_valid()
  or t.external->'receipt'->>'run_id' is distinct from '42506385410'
  or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or encode(sha256(convert_to(project_canonical(p_checkpoint),'UTF8')),'hex') is distinct from '5892c1104e8c47dd0269ab59fa41a3c2af8b58b33e5bc0e4eb58b455356aa854'
  or p_checkpoint->>'taskId' is distinct from t.id::text or p_checkpoint->>'projectId' is distinct from p.id::text
  or p_checkpoint->>'phase' is distinct from 'review' or p_checkpoint->>'verification' is distinct from 'unverified'
  or p_checkpoint->'lastCompleted'->'modelCall'->>'operationId' is distinct from '6d51c3f4-a019-444b-ab87-9d424f1b25e2'
  or p_checkpoint->'lastCompleted'->'modelCall'->>'settlement' is distinct from 'settled'
  or p_checkpoint->>'checkpointSha' is distinct from '1d51f2fa7f95fec1cb8c777c0525402e05f34f8e'
  or p_checkpoint->>'runId' is distinct from '42506385410'
  or p_checkpoint->>'approvalId' is distinct from a.id::text
  or p_checkpoint->>'artifactId' is distinct from '13627283749'
  or p_checkpoint->>'artifactSha256' is distinct from '9fc364377baf6fcde8ca415679961569c8b37e29ec548227455ef7fb25e4c40a'
  or p_checkpoint->>'trustedJobId' is distinct from '128809825644'
  or p_checkpoint->>'scopeHash' is distinct from p.approved_hash
  or p_checkpoint->>'releaseSha' is distinct from '61184faf4628d6fd9172cde8f16428e01700468b'
  or p_checkpoint->>'sourceTreeSha' is distinct from '26869fb977fd29b4f96652b9de3d47e0f0e0ffeb'
  or p_checkpoint->>'completedCheckpointSha' is distinct from '6270f88765be34811896f1be93373d9b58037f6b'
  or p_checkpoint->'lastCompleted'->'adaptiveRepair'->>'nextAction' is distinct from 'verification'
  or p_checkpoint->'lastCompleted'->'verification'->>'pending' is distinct from 'true'
  or p_checkpoint->'lastCompleted'->'verification'->>'passed' is distinct from 'false'
  or p_checkpoint->'lastCompleted' ? 'review' or p_checkpoint->'lastCompleted' ? 'initialReview'
  or p_checkpoint->>'baseSha' is distinct from p.baseline_sha
  or p_checkpoint->>'originalBaselineSha' is distinct from p.baseline_sha
  or not exists(select 1 from public.benchmark_execution_grants g where g.id=(p_checkpoint->>'grantId')::uuid and g.id='36d66bdc-c907-49ca-859d-abfed5fc334e'
    and g.developer_approval_id=a.id and g.execution_epoch=4 and g.mission_assignment_id=t.id)
  or price.is_active is distinct from true or price.pricing_status is distinct from 'verified'
  or price.pricing_verified_at is null or price.pricing_verified_at not between clock_timestamp()-interval '24 hours' and clock_timestamp()
  or price.pricing_input_per_1m is distinct from 1.75 or price.pricing_output_per_1m is distinct from 14
  or price.source_metadata->>'pricing_verification_source' is distinct from 'https://developers.openai.com/api/docs/models/gpt-5.3-codex'
  or coalesce(p_release,'')!~'^[a-f0-9]{40}$'
  or exists(select 1 from public.project_events where project_id=p.id and event='task4a_verifier_owner_authorized')
  or exists(select 1 from public.benchmark_native_spending_approvals where previous_developer_approval_id=a.id)
 then return jsonb_build_object('ready',false,'reason','latest_checkpoint_or_capacity_evidence_changed');end if;
 proposal:=jsonb_build_object('version','task4a-failed-verifier-v1','ownerId',a.owner_id,'projectId',p.id,'taskId',t.id,
  'releaseSha',p_release,'priorApprovalId',a.id,'priorContinuationId',s.id,'checkpoint',p_checkpoint,
  'checkpointDigest',encode(sha256(convert_to(public.project_canonical(p_checkpoint),'UTF8')),'hex'),
  'oldDeadline',a.deadline,'renewDeadline',a.deadline<=statement_timestamp(),
  'windowStartsAt',case when a.deadline<=statement_timestamp() then 'authenticated_consent_commit' else 'unchanged_existing_deadline' end,
  'durationSeconds',case when a.deadline<=statement_timestamp() then 14400 else 0 end,
  'previousLimits',limits,'limits',limits,
  'settledCalls',calls,'settledTokens',tokens,'exposureMicrousd',money,'preservedClaims',claims,
  'remainingNativeTokens',138204,'remainingNativeCalls',6,'envelope',envelope,'ledger',ledger,
  'additionalNativeTokens',0,'additionalProjectTokens',0,'additionalCalls',0,'additionalMicrousd',0,
  'preservedAdmittedTokens',64920,'preservedAdmittedMicrousd',1499654,'unusedContinuationAdmittedTokens',admitted_tokens,
  'successorTokens',s.incremental_tokens-admitted_tokens,'successorCalls',s.incremental_calls-delta_calls,
  'successorMicrousd',s.incremental_microusd-admitted_money,
  'historicalTokens',s.historical_tokens+delta_tokens,'historicalCalls',s.historical_calls+delta_calls,
  'pricingEvidence',jsonb_build_object('model','openai:gpt-5.3-codex','verifiedAt',price.pricing_verified_at,
    'source',price.source_metadata->>'pricing_verification_source','inputPerMillionUsd',price.pricing_input_per_1m,'outputPerMillionUsd',price.pricing_output_per_1m),
  'dispatchAuthorized',false,'paidInferenceAuthorized',false,'noAutomaticTokenIncrease',true,'guaranteedCompletion',false,'measurementRequiredBeforeEveryRequest',true);
 if (proposal->>'successorTokens')::bigint<>258204 or (proposal->>'successorCalls')::integer<>18
  or (proposal->>'successorMicrousd')::numeric<>7394515 then
  return jsonb_build_object('ready',false,'reason','remaining_capacity_changed');end if;
 return jsonb_build_object('ready',true,'proposal',proposal,'digest',encode(sha256(convert_to(public.project_canonical(proposal),'UTF8')),'hex'));
end $$;

create function public.task4a_verifier_authorize(p_owner uuid,p_digest text,p_release text,p_checkpoint jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.project_events;offer jsonb;plan jsonb;a public.benchmark_native_spending_approvals;
 s public.project_continuation_authorizations;child uuid;successor uuid;new_deadline timestamptz;receipt uuid;result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into e from public.project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event='task4a_verifier_owner_authorized';
 if e.id is not null then
  if p_owner is null or e.data->>'ownerId' is distinct from p_owner::text or e.data->>'consentDigest' is distinct from p_digest
   or e.data->'proposal'->>'releaseSha' is distinct from p_release or e.data->'proposal'->'checkpoint' is distinct from p_checkpoint
  then raise exception 'TASK4A_VERIFIER_OWNER_CONSENT_DENIED';end if;
  return e.data->'result'; -- Replay never resets the four-hour clock.
 end if;
 offer:=public.task4a_verifier_proposal(p_release,p_checkpoint);plan:=offer->'proposal';
 if p_owner is null or offer->>'ready' is distinct from 'true' or offer->>'digest' is distinct from p_digest
  or plan->>'ownerId' is distinct from p_owner::text then raise exception 'TASK4A_VERIFIER_OWNER_CONSENT_DENIED';end if;
 select * into a from public.benchmark_native_spending_approvals where id=(plan->>'priorApprovalId')::uuid for update;
 select * into s from public.project_continuation_authorizations where id=(plan->>'priorContinuationId')::uuid for update;
 new_deadline:=case when (plan->>'renewDeadline')::boolean then clock_timestamp()+interval '4 hours' else (plan->>'oldDeadline')::timestamptz end;
 if new_deadline<=clock_timestamp() then raise exception 'TASK4A_VERIFIER_CONSENT_EXPIRED';end if;
 if (plan->>'renewDeadline')::boolean then
 insert into public.project_continuation_authorizations(project_id,actor_id,chat_id,source_mission_id,approval_digest,deadline,
  incremental_tokens,incremental_calls,incremental_microusd,assessment_reserve_tokens,completion_reserve_tokens,
  assessment_reserve_calls,completion_reserve_calls,allowed_models,historical_tokens,historical_calls,historical_mission_deadline,pricing_evidence,predecessor_id)
 values(s.project_id,s.actor_id,s.chat_id,s.source_mission_id,p_digest,new_deadline,
  (plan->>'successorTokens')::bigint,(plan->>'successorCalls')::integer,(plan->>'successorMicrousd')::numeric,
  s.assessment_reserve_tokens,s.completion_reserve_tokens,s.assessment_reserve_calls,s.completion_reserve_calls,s.allowed_models,
  (plan->>'historicalTokens')::bigint,(plan->>'historicalCalls')::integer,s.historical_mission_deadline,jsonb_build_array(plan->'pricingEvidence'),s.id)
 returning id into successor;
 else
  -- The immutable chain forbids replacing live financial authority. Reuse its
  -- unused capacity; only a fresh native approval is needed for the consumed run.
  successor:=s.id;
 end if;
 insert into public.benchmark_lifecycle_proposals(id,owner_id,task_id,project_id,snapshot_hash,fingerprint,proposal,checkpoint,expires_at)
 values(p_digest,p_owner,a.task_id,a.project_id,plan->>'checkpointDigest',p_digest,plan,p_checkpoint,new_deadline);
 insert into public.benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,
  max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority,previous_developer_approval_id,developer_proposal_id)
 values(a.owner_id,a.actor_id,a.chat_id,null,a.account_id,a.repository,a.model,a.protocol_digest,(plan->'limits'->>'cumulativeTokens')::bigint,new_deadline,
  a.project_id,a.mission_assignment_id,a.task_id,a.developer_authority||jsonb_build_object('limits',plan->'limits',
   'task4aContinuationId',successor,'checkpoint',p_checkpoint,'releaseSha',p_release,
   'task4aSuccessorEnvelope',plan->'envelope','task4aVerifierRecovery',jsonb_build_object('version','failed-verifier-v1','consentDigest',p_digest,'executionAuthorized',false)),a.id,p_digest)
 returning id into child;
 insert into public.benchmark_lifecycle_decisions(proposal_id,owner_id,decision,developer_approval_id) values(p_digest,p_owner,'approved',child);
 update public.work_projects set deadline=new_deadline,updated_at=clock_timestamp() where id=a.project_id;
 update public.agent_missions set deadline=new_deadline,updated_at=clock_timestamp() where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36';
 update public.agent_tasks set external=external||jsonb_build_object('developerApprovalId',child,'task4aVerifierConsentDigest',p_digest),
  details='Unused capacity transferred; separate replacement, inference and dispatch decisions required.',updated_at=clock_timestamp() where id=a.task_id;
 result:=jsonb_build_object('authorized',true,'approvalId',child,'continuationId',successor,'deadline',new_deadline,
  'dispatchAuthorized',false,'paidInferenceAuthorized',false,'newPaidCalls',0);
 insert into public.project_events(project_id,event,data) values(a.project_id,'task4a_verifier_owner_authorized',
  jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,'proposal',plan,'result',result)) returning id into receipt;
 return result;
end $$;

-- Finance/deadline consent creates capacity only. Each later purpose has a
-- distinct digest and append-only receipt; no endpoint implies another purpose.
create function public.task4a_verifier_execution_proposal(p_release text,p_action text default 'replacement')
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare e project_events;a benchmark_native_spending_approvals;t agent_tasks;p work_projects;s project_continuation_authorizations;proposal jsonb;plan jsonb;
begin
 if p_action not in ('replacement','inference','dispatch') then return jsonb_build_object('ready',false);end if;
 select * into e from project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event='task4a_verifier_owner_authorized';
 plan:=e.data->'proposal';
 select * into a from benchmark_native_spending_approvals where id=(e.data->'result'->>'approvalId')::uuid;
 select * into t from agent_tasks where id=a.task_id;
 select * into p from work_projects where id=a.project_id;
 select * into s from project_continuation_authorizations where id=(a.developer_authority->>'task4aContinuationId')::uuid;
 if e.id is null or a.id is null or a.consumed_at is not null or a.revoked_at is not null or a.deadline<=clock_timestamp()
 or p.deadline is distinct from a.deadline or s.deadline is distinct from a.deadline or s.revoked_at is not null
 or a.previous_developer_approval_id is distinct from '1961239b-1722-4901-b671-8e61f4e6af49'::uuid
 or a.owner_id is distinct from task4a_original_owner_id(p.actor_id,p.chat_id)
 or e.data->>'ownerId' is distinct from a.owner_id::text or a.developer_authority->>'releaseSha' is distinct from p_release
 or plan->>'releaseSha' is distinct from p_release or a.developer_authority->'checkpoint' is distinct from plan->'checkpoint'
 or a.developer_authority->'limits' is distinct from plan->'limits' or a.developer_authority->'task4aSuccessorEnvelope' is distinct from plan->'envelope'
 or a.developer_authority->'task4aVerifierRecovery'->>'consentDigest' is distinct from e.data->>'consentDigest'
 or t.external->>'developerApprovalId' is distinct from a.id::text or t.external->>'task4aVerifierConsentDigest' is distinct from e.data->>'consentDigest'
 or t.external->'receipt'->>'run_id' is distinct from '42506385410' or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
 or p.approved_hash is distinct from plan->'checkpoint'->>'scopeHash' or p.approval_hash is distinct from p.approved_hash
 or p.completion_contract is distinct from a.developer_authority->'completionContract'
 or s.id is distinct from task4a_current_continuation_id(p.id)
 or (case when (plan->>'renewDeadline')::boolean then s.predecessor_id is distinct from '6e4eba28-2dbe-4faa-be93-5f24861dba3a'::uuid else s.id is distinct from '6e4eba28-2dbe-4faa-be93-5f24861dba3a'::uuid end)
 or s.incremental_tokens<>258204 or s.incremental_calls<>18 or s.incremental_microusd<>7394515
 or s.assessment_reserve_tokens<>60000 or s.completion_reserve_tokens<>60000 or s.assessment_reserve_calls<>6 or s.completion_reserve_calls<>6
 or s.allowed_models is distinct from array['openai:gpt-5.3-codex']::text[] or a.max_tokens is distinct from 405574 or a.model is distinct from 'gpt-5.3-codex'
 or not task4a_verifier_history_valid()
 or (select count(*) from benchmark_budget_calls where account_id=a.account_id)<>12
 or (select count(*) from mission_calls where job_id=t.id)<>12
 or (select count(*) from benchmark_dollar_exposures where account_id=a.account_id)<>12
 or (select coalesce(sum(exposure_microusd),0) from benchmark_dollar_exposures where account_id=a.account_id)<>280798
 or (select count(*) from benchmark_execution_grants where account_id=a.account_id)<>4
 or exists(select 1 from benchmark_native_spending_approvals where previous_developer_approval_id=a.id)
 or not exists(select 1 from benchmark_budget_accounts where id=a.account_id and frozen_at is null and spent_tokens=147370 and arm='developer' and developer_task_id=t.id and developer_project_id=p.id)
 or not exists(select 1 from agent_missions m join mission_assignments j on j.mission_id=m.id join project_runs r on r.mission_id=m.id and r.project_id=p.id
 where m.id=p.active_mission_id and j.id=t.id and m.deadline=a.deadline and m.calls=12 and m.routing_calls=0 and m.actual_tokens=147370 and m.reserved_tokens=147370 and r.binding=a.developer_authority->'binding')
 or not exists(select 1 from model_registry where provider_name='openai' and model_id=a.model and is_active and pricing_status='verified'
 and pricing_verified_at between clock_timestamp()-interval '24 hours' and clock_timestamp() and pricing_input_per_1m=1.75 and pricing_output_per_1m=14)
 then return jsonb_build_object('ready',false,'reason','failed_verifier_evidence_unavailable');end if;
 proposal:=jsonb_build_object('version','task4a-verifier-execution-v1','action',p_action,'ownerId',a.owner_id,'approvalId',a.id,'projectId',p.id,'taskId',t.id,
 'releaseSha',p_release,'deadline',a.deadline,'financialConsentDigest',e.data->>'consentDigest','checkpoint',plan->'checkpoint','envelope',plan->'envelope',
 'oneReplacementOnly',true,'noAutomaticRetry',true,'noProductionPublication',true,'guaranteedCompletion',false);
 return jsonb_build_object('ready',true,'proposal',proposal,'digest',encode(sha256(convert_to(project_canonical(proposal),'UTF8')),'hex'));
end $$;
create function public.task4a_verifier_execution_authorize(p_owner uuid,p_digest text,p_release text,p_action text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare offer jsonb;receipt uuid;event_name text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 offer:=task4a_verifier_execution_proposal(p_release,p_action);
 event_name:=case p_action when 'replacement' then 'task4a_verifier_execution_authorized' when 'inference' then 'task4a_verifier_inference_authorized' when 'dispatch' then 'task4a_verifier_dispatch_authorized' end;
 if event_name is null or p_owner is null or offer->>'ready' is distinct from 'true' or offer->>'digest' is distinct from p_digest or offer->'proposal'->>'ownerId' is distinct from p_owner::text
 or exists(select 1 from project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event=event_name)
 then raise exception 'TASK4A_VERIFIER_EXECUTION_CONSENT_DENIED';end if;
 insert into project_events(project_id,event,data) values('6d1c29f1-b31e-47a5-aabb-cbcf1326f388',event_name,jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,'proposal',offer->'proposal')) returning id into receipt;
 return jsonb_build_object('authorized',true,'receiptId',receipt,'dispatched',false,'newPaidCalls',0);
end $$;
create function public.task4a_verifier_execution_authorized(p_release text) returns boolean language plpgsql stable security definer set search_path=public as $$
declare action text;offer jsonb;e project_events;
begin
 foreach action in array array['replacement','inference','dispatch'] loop
 offer:=task4a_verifier_execution_proposal(p_release,action);
 select * into e from project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event=case action when 'replacement' then 'task4a_verifier_execution_authorized' when 'inference' then 'task4a_verifier_inference_authorized' else 'task4a_verifier_dispatch_authorized' end;
 if e.id is null or offer->>'ready' is distinct from 'true' or e.data->>'consentDigest' is distinct from offer->>'digest' or e.data->'proposal' is distinct from offer->'proposal' or e.data->>'ownerId' is distinct from offer->'proposal'->>'ownerId' then return false;end if;
 end loop;
 return true;
end $$;
create function public.task4a_verifier_execution_claim(p_release text)
returns boolean language plpgsql security definer set search_path=public as $$
declare e public.project_events;t public.agent_tasks;claim uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into t from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da' for update;
 if not public.task4a_verifier_execution_authorized(p_release)
  or exists(select 1 from public.project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event='task4a_verifier_execution_claimed')
  or t.status is distinct from 'blocked' or not exists(select 1 from public.work_projects p join public.agent_missions m on m.id=p.active_mission_id
    join public.mission_assignments j on j.mission_id=m.id where p.id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'
    and j.id=t.id and p.status='blocked' and m.status='blocked' and j.status='failed') then return false;end if;
 select * into e from public.project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event='task4a_verifier_execution_authorized';
 insert into public.project_events(project_id,event,data) values(e.project_id,'task4a_verifier_execution_claimed',
  jsonb_build_object('authorizationId',e.id,'approvalId',e.data->'proposal'->>'approvalId','releaseSha',p_release,'consentDigest',e.data->>'consentDigest')) returning id into claim;
 insert into public.project_events(project_id,event,data) values(e.project_id,'developer_native_dispatch_claimed',
  jsonb_build_object('approvalId',e.data->'proposal'->>'approvalId','taskId',t.id,'releaseSha',p_release,'capacityExecutionClaimId',claim,'originalIssueNumber',969));
 update public.work_projects set status='running',lease=null,lease_until=null,impediment=null,updated_at=clock_timestamp() where id=e.project_id;
 update public.agent_missions set status='running',updated_at=clock_timestamp() where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36';
 update public.mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=clock_timestamp(),updated_at=clock_timestamp() where id=t.id;
 update public.agent_tasks set status='dispatching',external=external||jsonb_build_object('developerReleaseSha',p_release,
  'developerDispatchSince',clock_timestamp(),'dispatchStartedAt',clock_timestamp(),'task4aVerifierExecutionClaimId',claim),updated_at=clock_timestamp() where id=t.id;
 return true;
end $$;

create function public.task4a_verifier_execution_ready(p_approval uuid,p_release text)
returns boolean language plpgsql stable security invoker set search_path=public as $$
declare e public.project_events;t public.agent_tasks;
begin
 select * into e from public.project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event='task4a_verifier_execution_claimed';
 select * into t from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da';
 return coalesce(public.task4a_verifier_execution_authorized(p_release) and e.id is not null
  and e.data->>'approvalId'=p_approval::text and e.data->>'releaseSha'=p_release
  and e.data->>'authorizationId'=(select id::text from public.project_events where project_id=e.project_id and event='task4a_verifier_execution_authorized')
  and t.external->>'developerApprovalId'=p_approval::text and t.external->>'developerReleaseSha'=p_release
  and t.external->>'task4aVerifierExecutionClaimId'=e.id::text and t.status in ('dispatching','submitted')
  and exists(select 1 from public.work_projects p join public.agent_missions m on m.id=p.active_mission_id
   join public.mission_assignments j on j.mission_id=m.id where p.id=e.project_id and j.id=t.id
    and p.status='running' and m.status='running' and j.status='waiting_external'),false);
end $$;

create function public.task4a_verifier_execution_submitted(p_release text)
returns boolean language plpgsql security definer set search_path=public as $$
declare e public.project_events;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into e from public.project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event='task4a_verifier_execution_claimed';
 if e.id is null or e.data->>'releaseSha' is distinct from p_release or exists(select 1 from public.project_events where project_id=e.project_id and event='task4a_verifier_execution_submitted') then return false;end if;
 insert into public.project_events(project_id,event,data) values(e.project_id,'task4a_verifier_execution_submitted',jsonb_build_object('claimId',e.id,'releaseSha',p_release,'acceptedByGithubApi',true));
 return true;
end $$;
-- Retain the inherited capacity marker and its old audit. Its readiness adapter
-- delegates only a separately marked final child; all old predicates survive.
alter function task4a_capacity_execution_ready(uuid,text) rename to task4a_capacity_execution_ready_before_verifier;
create function task4a_capacity_execution_ready(p_approval uuid,p_release text) returns boolean language plpgsql stable security definer set search_path=public as $$
begin
 if exists(select 1 from benchmark_native_spending_approvals where id=p_approval and developer_authority ? 'task4aVerifierRecovery') then return task4a_verifier_execution_ready(p_approval,p_release);end if;
 return task4a_capacity_execution_ready_before_verifier(p_approval,p_release);
end $$;

-- Only owner-session server endpoints can reach these RPCs. Internal helpers
-- are deliberately unavailable even to service_role.
do $$ declare r record;begin
 for r in select oid::regprocedure sig,proname from pg_proc where pronamespace='public'::regnamespace and (proname like 'task4a_verifier_%' or proname in ('task4a_capacity_execution_ready_before_verifier','task4a_capacity_execution_ready')) loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',r.sig);
 if r.proname not in ('task4a_verifier_immutable','task4a_verifier_history_valid','task4a_capacity_execution_ready_before_verifier') then execute format('grant execute on function %s to service_role',r.sig);end if;
 end loop;
end $$;
