-- Install only. Capacity consent never authorizes dispatch, a grant or inference.
create unique index task4a_capacity_one_successor on public.project_events(project_id,event)
 where event='task4a_capacity_owner_authorized';
create function public.task4a_capacity_immutable() returns trigger language plpgsql set search_path=public as $$
begin
 if old.event='task4a_capacity_owner_authorized' then raise exception 'TASK4A_CAPACITY_AUDIT_IMMUTABLE';end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger task4a_capacity_immutable before update or delete on public.project_events
 for each row execute function public.task4a_capacity_immutable();

create function public.task4a_capacity_proposal(p_release text,p_checkpoint jsonb)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare p public.work_projects;m public.agent_missions;t public.agent_tasks;j public.mission_assignments;
 a public.benchmark_native_spending_approvals;s public.project_continuation_authorizations;
 acct public.benchmark_budget_accounts;r public.project_runs;price public.model_registry;
 calls bigint;tokens bigint;pending bigint;money numeric;delta_calls bigint;delta_tokens bigint;delta_money numeric;
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
  ('f105fde0-1e35-4aaf-80c6-b80645701325'::uuid,'2cbdbff0-cc11-4dd8-8a62-95b0e8ae2534'::uuid);
 limits:=a.developer_authority->'limits';
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
  or a.consumed_at is null or a.revoked_at is not null or a.deadline>clock_timestamp()
  or a.model is distinct from 'gpt-5.3-codex' or a.repository is distinct from 'mfackrell/katie'
  or a.developer_authority->'task4aPostpaid'->>'version' is distinct from 'postpaid-same-task-v1'
  or a.developer_authority->>'task4aContinuationId' is distinct from s.id::text
  or s.id is null or s.deadline>clock_timestamp() or s.revoked_at is not null
  or s.assessment_reserve_tokens<>60000 or s.completion_reserve_tokens<>60000
  or s.assessment_reserve_calls<>6 or s.completion_reserve_calls<>6
  or s.allowed_models is distinct from array['openai:gpt-5.3-codex']::text[]
  or acct.frozen_at is not null or acct.spent_tokens<>tokens
  or calls<>8 or tokens<>102625 or pending<>0 or money<>198756
  or delta_calls<>4 or delta_tokens<>53005 or delta_money<>105831
  or (select count(*) from public.mission_calls where job_id=t.id)<>calls
  or (select count(*) from public.benchmark_dollar_exposures where account_id=a.account_id)<>calls
  or (select count(*) from public.benchmark_execution_grants where account_id=a.account_id)<>2
  or m.calls<>calls or m.actual_tokens<>tokens or m.reserved_tokens<>tokens
  or m.routing_calls is distinct from 0
  or limits is distinct from '{"assessmentCalls":4,"ceilingMicrousd":9000000,"completionCalls":4,"durationSeconds":14400,"perCallMicrousd":1680000,"assessmentTokens":60000,"completionTokens":60000,"cumulativeTokens":289620,"developmentCalls":16,"developmentTokens":229620}'::jsonb
  or jsonb_array_length(claims) is distinct from 2
  or t.external->>'task4aPostpaidDispatchClaimId' is distinct from 'f105fde0-1e35-4aaf-80c6-b80645701325'
  or t.external->>'task4aReplacementClaimId' is distinct from '2cbdbff0-cc11-4dd8-8a62-95b0e8ae2534'
  or not exists(select 1 from public.project_events e where e.id='f105fde0-1e35-4aaf-80c6-b80645701325'
    and e.project_id=p.id and e.event='task4a_postpaid_dispatch_claimed' and e.data->>'approvalId'=a.id::text)
  or not exists(select 1 from public.project_events e where e.id='2cbdbff0-cc11-4dd8-8a62-95b0e8ae2534'
    and e.project_id=p.id and e.event='task4a_replacement_claimed' and e.data->>'approvalId'=a.id::text
    and e.data->>'consumedClaimId'='f105fde0-1e35-4aaf-80c6-b80645701325'
    and e.data->>'releaseSha'=t.external->>'developerReleaseSha')
  or t.external->'receipt'->>'run_id' is distinct from '42405698589'
  or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or p_checkpoint->>'checkpointSha' is distinct from '2667a81d4f18452e9ca59498c8805670b04cfe47'
  or p_checkpoint->>'runId' is distinct from '42405698589'
  or p_checkpoint->>'approvalId' is distinct from a.id::text
  or p_checkpoint->>'scopeHash' is distinct from p.approved_hash
  or p_checkpoint->>'releaseSha' is distinct from '3c148a4ea9a2f8bee9d35b7e430eee0f66ff58a0'
  or p_checkpoint->>'sourceTreeSha' is distinct from '26869fb977fd29b4f96652b9de3d47e0f0e0ffeb'
  or p_checkpoint->>'completedCheckpointSha' is distinct from p.baseline_sha
  or not exists(select 1 from public.benchmark_execution_grants g where g.id=(p_checkpoint->>'grantId')::uuid
    and g.developer_approval_id=a.id and g.execution_epoch=2 and g.mission_assignment_id=t.id)
  or price.is_active is distinct from true or price.pricing_status is distinct from 'verified'
  or price.pricing_verified_at is null or price.pricing_verified_at not between clock_timestamp()-interval '24 hours' and clock_timestamp()
  or price.pricing_input_per_1m is distinct from 1.75 or price.pricing_output_per_1m is distinct from 14
  or price.source_metadata->>'pricing_verification_source' is distinct from 'https://developers.openai.com/api/docs/models/gpt-5.3-codex'
  or coalesce(p_release,'')!~'^[a-f0-9]{40}$'
  or exists(select 1 from public.project_events where project_id=p.id and event='task4a_capacity_owner_authorized')
  or exists(select 1 from public.benchmark_native_spending_approvals where previous_developer_approval_id=a.id)
 then return jsonb_build_object('ready',false,'reason','latest_checkpoint_or_capacity_evidence_changed');end if;
 proposal:=jsonb_build_object('version','task4a-capacity-only-v1','ownerId',a.owner_id,'projectId',p.id,'taskId',t.id,
  'releaseSha',p_release,'priorApprovalId',a.id,'priorContinuationId',s.id,'checkpoint',p_checkpoint,
  'checkpointDigest',encode(sha256(convert_to(public.project_canonical(p_checkpoint),'UTF8')),'hex'),
  'oldDeadline',a.deadline,'windowStartsAt','authenticated_consent_commit','durationSeconds',14400,
  'previousLimits',limits,'limits',limits||'{"developmentCalls":20}'::jsonb,
  'settledCalls',calls,'settledTokens',tokens,'exposureMicrousd',money,'preservedClaims',claims,
  'remainingNativeTokens',66995,'remainingNativeCalls',8,
  'successorTokens',s.incremental_tokens-delta_tokens,'successorCalls',s.incremental_calls-delta_calls,
  'successorMicrousd',s.incremental_microusd-delta_money,
  'historicalTokens',s.historical_tokens+delta_tokens,'historicalCalls',s.historical_calls+delta_calls,
  'pricingEvidence',jsonb_build_object('model','openai:gpt-5.3-codex','verifiedAt',price.pricing_verified_at,
    'source',price.source_metadata->>'pricing_verification_source','inputPerMillionUsd',price.pricing_input_per_1m,'outputPerMillionUsd',price.pricing_output_per_1m),
  'dispatchAuthorized',false,'paidInferenceAuthorized',false,'noAutomaticTokenIncrease',true);
 if (proposal->>'successorTokens')::bigint<>186995 or (proposal->>'successorCalls')::integer<>20
  or (proposal->>'successorMicrousd')::numeric<>8894169 then
  return jsonb_build_object('ready',false,'reason','remaining_capacity_changed');end if;
 return jsonb_build_object('ready',true,'proposal',proposal,'digest',encode(sha256(convert_to(public.project_canonical(proposal),'UTF8')),'hex'));
end $$;

create function public.task4a_capacity_authorize(p_owner uuid,p_digest text,p_release text,p_checkpoint jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.project_events;offer jsonb;plan jsonb;a public.benchmark_native_spending_approvals;
 s public.project_continuation_authorizations;child uuid;successor uuid;new_deadline timestamptz;receipt uuid;result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into e from public.project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388' and event='task4a_capacity_owner_authorized';
 if e.id is not null then
  if p_owner is null or e.data->>'ownerId' is distinct from p_owner::text or e.data->>'consentDigest' is distinct from p_digest
   or e.data->'proposal'->>'releaseSha' is distinct from p_release or e.data->'proposal'->'checkpoint' is distinct from p_checkpoint
  then raise exception 'TASK4A_CAPACITY_OWNER_CONSENT_DENIED';end if;
  return e.data->'result'; -- Replay never resets the four-hour clock.
 end if;
 offer:=public.task4a_capacity_proposal(p_release,p_checkpoint);plan:=offer->'proposal';
 if p_owner is null or offer->>'ready' is distinct from 'true' or offer->>'digest' is distinct from p_digest
  or plan->>'ownerId' is distinct from p_owner::text then raise exception 'TASK4A_CAPACITY_OWNER_CONSENT_DENIED';end if;
 select * into a from public.benchmark_native_spending_approvals where id=(plan->>'priorApprovalId')::uuid for update;
 select * into s from public.project_continuation_authorizations where id=(plan->>'priorContinuationId')::uuid for update;
 new_deadline:=clock_timestamp()+interval '4 hours';
 insert into public.project_continuation_authorizations(project_id,actor_id,chat_id,source_mission_id,approval_digest,deadline,
  incremental_tokens,incremental_calls,incremental_microusd,assessment_reserve_tokens,completion_reserve_tokens,
  assessment_reserve_calls,completion_reserve_calls,allowed_models,historical_tokens,historical_calls,historical_mission_deadline,pricing_evidence,predecessor_id)
 values(s.project_id,s.actor_id,s.chat_id,s.source_mission_id,p_digest,new_deadline,
  (plan->>'successorTokens')::bigint,(plan->>'successorCalls')::integer,(plan->>'successorMicrousd')::numeric,
  s.assessment_reserve_tokens,s.completion_reserve_tokens,s.assessment_reserve_calls,s.completion_reserve_calls,s.allowed_models,
  (plan->>'historicalTokens')::bigint,(plan->>'historicalCalls')::integer,s.historical_mission_deadline,jsonb_build_array(plan->'pricingEvidence'),s.id)
 returning id into successor;
 insert into public.benchmark_lifecycle_proposals(id,owner_id,task_id,project_id,snapshot_hash,fingerprint,proposal,checkpoint,expires_at)
 values(p_digest,p_owner,a.task_id,a.project_id,plan->>'checkpointDigest',p_digest,plan,p_checkpoint,new_deadline);
 insert into public.benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,
  max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority,previous_developer_approval_id,developer_proposal_id)
 values(a.owner_id,a.actor_id,a.chat_id,null,a.account_id,a.repository,a.model,a.protocol_digest,a.max_tokens,new_deadline,
  a.project_id,a.mission_assignment_id,a.task_id,a.developer_authority||jsonb_build_object('limits',plan->'limits',
   'task4aContinuationId',successor,'checkpoint',p_checkpoint,'releaseSha',p_release,
   'task4aCapacityRenewal',jsonb_build_object('version','capacity-only-v1','consentDigest',p_digest,'executionAuthorized',false)),a.id,p_digest)
 returning id into child;
 insert into public.benchmark_lifecycle_decisions(proposal_id,owner_id,decision,developer_approval_id) values(p_digest,p_owner,'approved',child);
 update public.work_projects set deadline=new_deadline,updated_at=clock_timestamp() where id=a.project_id;
 update public.agent_missions set deadline=new_deadline,updated_at=clock_timestamp() where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36';
 update public.agent_tasks set external=external||jsonb_build_object('developerApprovalId',child,'task4aCapacityConsentDigest',p_digest),
  details='Capacity-only successor; separate release and execution decisions required.',updated_at=clock_timestamp() where id=a.task_id;
 result:=jsonb_build_object('authorized',true,'approvalId',child,'continuationId',successor,'deadline',new_deadline,
  'dispatchAuthorized',false,'paidInferenceAuthorized',false,'newPaidCalls',0);
 insert into public.project_events(project_id,event,data) values(a.project_id,'task4a_capacity_owner_authorized',
  jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,'proposal',plan,'result',result)) returning id into receipt;
 return result;
end $$;

-- Capacity is not permission to use it. Block all generic entry points, even
-- if another caller accidentally constructs runnable project/dispatch state.
alter function public.developer_claim_dispatch(uuid,text) rename to developer_claim_dispatch_before_task4a_capacity;
create function public.developer_claim_dispatch(p_approval uuid,p_release text) returns boolean
language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from public.benchmark_native_spending_approvals where id=p_approval and developer_authority ? 'task4aCapacityRenewal') then return false;end if;
 return public.developer_claim_dispatch_before_task4a_capacity(p_approval,p_release);
end $$;
create function public.task4a_capacity_no_execution() returns trigger language plpgsql set search_path=public as $$
begin
 if exists(select 1 from public.benchmark_native_spending_approvals where id=new.developer_approval_id and developer_authority ? 'task4aCapacityRenewal')
 then raise exception 'TASK4A_CAPACITY_ONLY_EXECUTION_FORBIDDEN';end if;
 return new;
end $$;
create trigger task4a_capacity_no_execution before insert on public.benchmark_execution_grants
 for each row execute function public.task4a_capacity_no_execution();
revoke all on function public.task4a_capacity_proposal(text,jsonb),public.task4a_capacity_authorize(uuid,text,text,jsonb),
 public.task4a_capacity_immutable(),public.task4a_capacity_no_execution(),public.developer_claim_dispatch_before_task4a_capacity(uuid,text),
 public.developer_claim_dispatch(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.task4a_capacity_proposal(text,jsonb),public.task4a_capacity_authorize(uuid,text,text,jsonb),
 public.developer_claim_dispatch(uuid,text) to service_role;
