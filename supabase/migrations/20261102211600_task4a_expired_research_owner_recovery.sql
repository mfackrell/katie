-- Task 4A: one owner-authenticated continuation of an expired saved research
-- milestone. No production data is modified merely by installing this code.
-- There is no paid inference in this migration.
create or replace function public.task4a_continuation_proposal(p_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare p work_projects; old_m agent_missions; sample work_projects;
 used bigint; prior_calls integer; benchmark_tokens bigint; benchmark_calls integer;
 verified_prices jsonb; verified_count integer; expected_models text[];
 upper_microusd numeric; max_tokens bigint; payload jsonb; fingerprint text;
begin
 select * into p from work_projects where id=p_id;
 if not found or p.status<>'paused' or p.phase<>'research'
  or p.approved_hash is not null or p.active_mission_id is null
  or p.deadline<=now()+interval '4 hours'
  or exists(select 1 from project_continuation_authorizations where project_id=p.id)
  or exists(select 1 from project_events where project_id=p.id and event='task4a_expired_research_continued')
 then return null;end if;
 select * into old_m from agent_missions where id=p.active_mission_id and project_id=p.id;
 if not found or old_m.status<>'blocked' or old_m.deadline>now()
  or old_m.project_kind<>'research'
  or (select count(*) from mission_assignments where mission_id=old_m.id and role='work' and status='completed')<2
  or exists(select 1 from mission_assignments where mission_id=old_m.id and role='work' and status<>'completed')
  or not exists(select 1 from mission_assignments where mission_id=old_m.id and role='plan' and status='completed')
  or not exists(select 1 from mission_assignments where mission_id=old_m.id and role='compose'
    and length(coalesce(result->>'rejectedDeliverableResponse',''))>100)
  or not exists(select 1 from mission_assignments where mission_id=old_m.id and role='review' and status='queued')
  or exists(select 1 from mission_calls c join mission_assignments j on j.id=c.job_id
    where j.mission_id=old_m.id and c.status<>'completed')
 then return null;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0),
        coalesce(sum(calls+routing_calls),0)
 into used,prior_calls from agent_missions where project_id=p.id;
 -- Prior completed, comparable browser-app pilot. It had two full coding stages,
 -- so its observed 440k/53-call lifecycle is a conservative planning ceiling,
 -- not a guarantee of success or fabricated Task 4A usage.
 select * into sample from work_projects
  where id='a03df077-9cf9-4e26-a819-fd40535b57e3'::uuid and status='completed';
 if not found then return jsonb_build_object('ready',false,'reason','measured_comparable_unavailable');end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0),
        coalesce(sum(calls+routing_calls),0)
 into benchmark_tokens,benchmark_calls from agent_missions where project_id=sample.id;
 if benchmark_tokens<200000 or benchmark_calls<20 then
  return jsonb_build_object('ready',false,'reason','measured_comparable_insufficient');
 end if;
 max_tokens:=least(p.token_allowance-used,benchmark_tokens);
 if max_tokens<240000 or benchmark_calls<20 or
    (select count(*) from project_runs where project_id=p.id)+1>p.max_missions then
  return jsonb_build_object('ready',false,'reason','project_remaining_resources_insufficient');
 end if;
 expected_models:=array['openai:gpt-5.6-sol','openai:gpt-5.3-codex']::text[];
 select count(*),coalesce(jsonb_agg(jsonb_build_object(
  'model',provider_name||':'||model_id,'inputPerMillionUsd',pricing_input_per_1m,
  'outputPerMillionUsd',pricing_output_per_1m,
  'verifiedAt',pricing_verified_at,
  'source',source_metadata->>'pricing_verification_source'
 ) order by model_id),'[]'::jsonb) into verified_count,verified_prices
 from model_registry where provider_name='openai' and model_id in ('gpt-5.6-sol','gpt-5.3-codex')
  and is_active=true and pricing_status='verified' and pricing_verified_at>=now()-interval '24 hours'
  and pricing_verified_at<=now() and pricing_input_per_1m>0 and pricing_output_per_1m>0
  and source_metadata->>'pricing_verification_source'='https://developers.openai.com/api/docs/models/'||model_id;
 if verified_count<>2 then return jsonb_build_object('ready',false,
  'reason','verified_model_pricing_required','models',expected_models,
  'verifiedCount',verified_count);end if;
 -- Full-token worst-case output rate plus long-context/regional cushion.
 -- No token discount is assumed; external web/tool requests are not authorized.
 select ceil(max_tokens*max(pricing_output_per_1m)*1.65/1000000)*1000000
 into upper_microusd from model_registry where provider_name='openai' and model_id in ('gpt-5.6-sol','gpt-5.3-codex');
 payload:=jsonb_build_object(
  'version',1,'scope','task4a_original_expired_research_only',
  'projectId',p.id,'actorId',p.actor_id,'chatId',p.chat_id,
  'sourceMissionId',old_m.id,'sourceDeadline',old_m.deadline,
  'parentDeadline',p.deadline,'projectTokenAllowance',p.token_allowance,
  'historicalTokens',used,'historicalCalls',prior_calls,
  'comparableProjectId',sample.id,'comparableCompletedTokens',benchmark_tokens,
  'comparableCompletedCalls',benchmark_calls,
  'incrementalTokens',max_tokens,'incrementalCalls',benchmark_calls,
  'incrementalDollarCeilingMicrousd',upper_microusd,
  'assessReserveTokens',60000,'completionReserveTokens',60000,
  'assessReserveCalls',6,'completionReserveCalls',6,
  'durationSeconds',14400,'models',to_jsonb(expected_models),
  'pricingEvidence',verified_prices,
  'scopeApprovalStillRequired',true,'noProductionRelease',true);
 fingerprint:=encode(sha256(convert_to(project_canonical(payload),'UTF8')),'hex');
 return jsonb_build_object('ready',true,'digest',fingerprint,'proposal',payload);
end $$;
revoke all on function public.task4a_continuation_proposal(uuid)
 from public,anon,authenticated;
grant execute on function public.task4a_continuation_proposal(uuid) to service_role;

-- This is a single, atomic, backend-only owner decision. The HTTP caller MUST
-- first verify an actual owner bearer and same-origin context. Possession of
-- actor/chat IDs or a digest alone never authorizes the RPC.
create or replace function public.authorize_task4a_expired_research(
 p_id uuid,p_actor uuid,p_chat uuid,p_digest text
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare
 p work_projects; old_m agent_missions; old_plan mission_assignments;
 old_compose mission_assignments; old_review mission_assignments;
 mid uuid; auth project_continuation_authorizations;
 candidate jsonb; proposal jsonb; payload jsonb; used bigint; prior_calls integer;
 ordinal_next integer; completed_count integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status<>'paused' or p.phase<>'research'
   or p.approved_hash is not null or p.deadline<=now()+interval '4 hours'
 then raise exception 'Original paused project or owner identity unavailable';end if;
 proposal:=task4a_continuation_proposal(p_id);
 if proposal is null or proposal->>'ready' is distinct from 'true'
  or proposal->>'digest' is distinct from p_digest then
  raise exception 'Exact verified continuation proposal is unavailable or stale';end if;
 payload:=proposal->'proposal';
 select * into old_m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 select * into old_plan from mission_assignments where mission_id=old_m.id and job_key='plan' and status='completed' for update;
 select * into old_compose from mission_assignments where mission_id=old_m.id and job_key='compose'
  and role='compose' and length(coalesce(result->>'rejectedDeliverableResponse',''))>100 for update;
 select * into old_review from mission_assignments where mission_id=old_m.id and role='review' and status='queued' for update;
 if old_plan.id is null or old_compose.id is null or old_review.id is null
  or old_m.status<>'blocked' or old_m.deadline>now() then
  raise exception 'Original saved research lineage changed';end if;
 select count(*) into completed_count from mission_assignments
  where mission_id=old_m.id and role='work' and status='completed';
 if completed_count<2 or exists(select 1 from mission_assignments
  where mission_id=old_m.id and status in ('running','waiting_external','awaiting_approval'))
  or exists(select 1 from mission_calls c join mission_assignments j on j.id=c.job_id
    where j.mission_id=old_m.id and c.status<>'completed')
 then raise exception 'Saved research not safely reusable';end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0),
    coalesce(sum(calls+routing_calls),0) into used,prior_calls
 from agent_missions where project_id=p.id;
 if used<>(payload->>'historicalTokens')::bigint or
    prior_calls<>(payload->>'historicalCalls')::integer or
    used+(payload->>'incrementalTokens')::bigint>p.token_allowance
 then raise exception 'Stale historical accounting or capacity';end if;
 if exists(select 1 from project_continuation_authorizations where project_id=p.id)
  or exists(select 1 from project_events where project_id=p.id and event='task4a_expired_research_continued')
 then raise exception 'Continuation was already authorized';end if;
 insert into project_continuation_authorizations(
  project_id,actor_id,chat_id,source_mission_id,approval_digest,deadline,
  incremental_tokens,incremental_calls,incremental_microusd,
  assessment_reserve_tokens,completion_reserve_tokens,
  assessment_reserve_calls,completion_reserve_calls,
  allowed_models,historical_tokens,historical_calls,
  historical_mission_deadline,pricing_evidence)
 values(p.id,p.actor_id,p.chat_id,old_m.id,p_digest,
  least(clock_timestamp()+interval '4 hours',p.deadline),
  (payload->>'incrementalTokens')::bigint,(payload->>'incrementalCalls')::integer,
  (payload->>'incrementalDollarCeilingMicrousd')::numeric,
  (payload->>'assessReserveTokens')::bigint,(payload->>'completionReserveTokens')::bigint,
  (payload->>'assessReserveCalls')::integer,(payload->>'completionReserveCalls')::integer,
  array(select jsonb_array_elements_text(payload->'models')),
  used,prior_calls,old_m.deadline,payload->'pricingEvidence')
 returning * into auth;
 ordinal_next:=(select coalesce(max(ordinal),0)+1 from project_runs where project_id=p.id);
 if ordinal_next>p.max_missions then raise exception 'Project milestone limit reached';end if;
 mid:=gen_random_uuid();
 perform create_mission(mid,old_m.objective,p.team,120,null);
 update agent_missions set team=old_m.team,
  token_allowance=least(120000,p.token_allowance-used),
  project_id=p.id,project_kind='research',
  project_evidence=coalesce(old_m.project_evidence,'{}'::jsonb)||
   jsonb_build_object('expiredResearchRecovery',jsonb_build_object(
    'originalMissionId',old_m.id,'originalComposeJobId',old_compose.id,
    'originalReviewJobId',old_review.id,'savedComposeResult',old_compose.result,
    'approvalDigest',p_digest,'requiresIndependentReview',true))
 where id=mid;
 perform control_mission(mid,'start');
 update agent_missions set deadline=least(deadline,auth.deadline,p.deadline)
 where id=mid;
 update mission_assignments set status='completed',attempts=0,
  result=old_plan.result,
  payload=jsonb_build_object('reusedFromOriginalJob',old_plan.id)
 where mission_id=mid and job_key='plan';
 insert into mission_assignments(
  mission_id,job_key,role,agent_id,instruction,dependencies,payload,
  status,attempts,result)
 select mid,job_key,role,agent_id,instruction,dependencies,
  jsonb_build_object('reusedFromOriginalJob',id),
  'completed',0,result
 from mission_assignments where mission_id=old_m.id and role='work' and status='completed';
 insert into mission_assignments(mission_id,job_key,role,agent_id,
  instruction,dependencies,payload,status,attempts,result)
 values(mid,'compose','compose',old_compose.agent_id,
  'Repair the original saved research composition to at most 700 words using retained evidence. Keep all material source facts and citations. Do not repeat research or assert independent review passed.',
  array(select job_key from mission_assignments where mission_id=mid and role='work'),
  jsonb_build_object('reusedFromOriginalJob',old_compose.id),
  'queued',0,old_compose.result);
 insert into mission_assignments(mission_id,job_key,role,agent_id,
  instruction,dependencies,payload,status,attempts,result)
 values(mid,'review','review',old_review.agent_id,
  'Independently review the exact saved, repaired research result against the original objective and sources. Do not waive word limits, source checks or substantive discrepancies.',
  array['compose']::text[],
  jsonb_build_object('reusedFromOriginalJob',old_review.id),
  'queued',0,null);
 update project_runs set outcome=jsonb_build_object('expiredResearchRecovery',true,
  'continuationMissionId',mid,'preservedHistoricalTokens',used,
  'preservedHistoricalCalls',prior_calls)
 where project_id=p.id and mission_id=old_m.id and outcome is null;
 insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index)
 values(p.id,mid,'research',ordinal_next,p.milestone_index);
 update work_projects set status='running',active_mission_id=mid,
   lease=null,lease_until=null,failures=0,
   detail='Owner-approved bounded research continuation. Original completed work, deadline, billing and scope approvals preserved; independent research review pending.',
   updated_at=clock_timestamp() where id=p.id;
 insert into project_events(project_id,event,data) values
 (p.id,'task4a_expired_research_continued',jsonb_build_object(
  'authorizationId',auth.id,'approvalDigest',p_digest,'oldMissionId',old_m.id,
  'newMissionId',mid,'oldDeadline',old_m.deadline,'historicalTokens',used,
  'historicalCalls',prior_calls,'additionalTokens',auth.incremental_tokens,
  'additionalCalls',auth.incremental_calls,
  'additionalMicrousd',auth.incremental_microusd,'scopeApproved',false));
 perform project_publish(p.id,'Owner-authorized Task 4A continuation resumed the saved research. Prior charges and results remain intact; new calls are bounded by verified pricing and the approved ceiling.');
 return jsonb_build_object('authorized',true,'projectId',p.id,
  'oldMissionId',old_m.id,'newMissionId',mid,'authorizationId',auth.id,
  'originalCalls',prior_calls,'originalTokens',used,
  'additionalTokens',auth.incremental_tokens,
  'additionalCalls',auth.incremental_calls,
  'additionalMicrousd',auth.incremental_microusd,
  'approvalDigest',p_digest,'scopeApproved',false);
end $$;
revoke all on function public.authorize_task4a_expired_research(uuid,uuid,uuid,text)
 from public,anon,authenticated;
grant execute on function public.authorize_task4a_expired_research(uuid,uuid,uuid,text) to service_role;
