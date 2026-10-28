-- Recover one review that was refused before creating any call, after pricing
-- is freshly verified. Every normal atomic reservation gate still runs again.
create or replace function public.recover_verified_price_review(p_id uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
declare p work_projects; m agent_missions; j mission_assignments; c benchmark_full_continuations; price model_registry; recovery_event project_events;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id for update;
 if not found or p.profile<>'game' or p.phase<>'specification' or p.status<>'blocked' or p.approved_hash is not null
  or p.deadline<=now() or (p.lease is not null and p.lease_until>now()) then return false;end if;
 if p.active_mission_id is null then
  select * into recovery_event from project_events where project_id=p.id and event='game_specification_checkpoint_recovered'
   order by created_at desc,id desc limit 1;
  if not found or recovery_event.data->>'recoveryType' is distinct from 'saved_composition_fresh_review' then return false;end if;
  select * into m from agent_missions where id::text=recovery_event.data->>'sourceMissionId' and project_id=p.id for update;
  if not found or not exists(select 1 from mission_assignments where id::text=recovery_event.data->>'sourceJobId'
    and mission_id=m.id and job_key='compose' and role='compose' and status='completed')
   or exists(select 1 from agent_missions where project_id=p.id and id<>m.id and
    (created_at>m.created_at or created_at>=recovery_event.created_at or status in ('draft','running','awaiting_approval')))
   or exists(select 1 from project_runs where project_id=p.id and created_at>=recovery_event.created_at) then return false;end if;
 else
  select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 end if;
 if not found or m.status<>'blocked' or m.project_kind<>'specification' or m.deadline<=now()
  or m.calls>=m.max_calls or m.routing_calls>=m.max_calls*3 or greatest(m.actual_tokens,m.reserved_tokens)>=m.token_allowance then return false;end if;
 select * into c from benchmark_full_continuations where project_id=p.id;
 if not found or not benchmark_continuation_live(c.id,c.account_id,p.id) or m.deadline>c.deadline or m.created_at<c.created_at
  or m.project_evidence->>'benchmarkContinuationId' is distinct from c.id::text
  or m.project_evidence->>'benchmarkContinuationPlanHash' is distinct from c.plan_hash
  or not exists(select 1 from benchmark_full_project_bindings where project_id=p.id and account_id=c.account_id)
  or exists(select 1 from benchmark_budget_calls where account_id=c.account_id and (state<>'settled' or actual_tokens is null)) then return false;end if;
 select * into j from mission_assignments where mission_id=m.id and job_key='review' and role='review' for update;
 if not found or j.status<>'failed' or j.attempts<>1 or j.dependencies<>array['compose']::text[]
  or j.detail<>'Full benchmark account denied atomic model-call admission'
  or (j.lease is not null and j.lease_until>now())
  or exists(select 1 from mission_calls where job_id=j.id)
  or exists(select 1 from mission_assignments where mission_id=m.id and status in ('running','waiting_external','awaiting_approval'))
  or not exists(select 1 from mission_assignments where mission_id=m.id and job_key='compose' and status='completed' and jsonb_typeof(result->'text')='string')
  or exists(select 1 from project_events where project_id=p.id and event='verified_price_review_recovered' and data->>'jobId'=j.id::text) then return false;end if;
 select * into price from model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 if not found or price.pricing_status<>'verified' or price.pricing_verified_at is null or price.pricing_verified_at<=j.updated_at
  or price.pricing_verified_at<now()-interval '24 hours' or price.pricing_verified_at>now()
  or price.pricing_input_per_1m is null or price.pricing_output_per_1m is null
  or price.pricing_input_per_1m<=0 or price.pricing_input_per_1m>28 or price.pricing_output_per_1m<=0 or price.pricing_output_per_1m>28
  or price.source_metadata->>'pricing_verification_source' is distinct from 'https://developers.openai.com/api/docs/models/gpt-5.3-codex' then return false;end if;
 if not exists(select 1 from project_events where project_id=p.id and event='model_price_reverified' and created_at>j.updated_at
  and data->>'model'='gpt-5.3-codex' and data->>'priorStatus' in ('estimated','missing','error')
  and data->>'source'='https://developers.openai.com/api/docs/models/gpt-5.3-codex'
  and (data->>'verifiedAt')::timestamptz=price.pricing_verified_at) then return false;end if;
 insert into project_events(project_id,event,data) values(p.id,'verified_price_review_recovered',jsonb_build_object(
  'jobId',j.id,'missionId',m.id,'originalResult',j.result,'attempts',j.attempts,'callRows',0,
  'restoredActiveMission',p.active_mission_id is null,'checkpointRecoveryEventId',recovery_event.id,
  'pricingVerifiedAt',price.pricing_verified_at,'pricingSource',price.source_metadata->>'pricing_verification_source'));
 update mission_assignments set status='queued',lease=null,lease_until=null,available_at=now(),
  detail='Independent review resumed after fresh price verification; original attempt and budgets preserved.',updated_at=now() where id=j.id;
 update agent_missions set status='running',updated_at=now() where id=m.id;
 update work_projects set status='running',active_mission_id=m.id,lease=null,lease_until=null,
  detail='Independent review resumed under existing authority after verified pricing was restored.',updated_at=now() where id=p.id;
 return true;
end $$;
revoke all on function public.recover_verified_price_review(uuid) from public,anon,authenticated;
grant execute on function public.recover_verified_price_review(uuid) to service_role;

-- A Full continuation owns its existing child and cumulative stage budgets.
-- Generic checkpoint recovery must not detach it or request a replacement child.
DO $patch$
declare body text; signature text;
begin
 foreach signature in array array['public.recover_game_specification_checkpoint(uuid)','public.resume_game_checkpoint_watchdog(uuid)'] loop
 select pg_get_functiondef(signature::regprocedure) into body;
 if position('BEGIN' in body)=0 then raise exception 'Expected checkpoint recovery body missing';end if;
 body:=replace(body,'BEGIN',E'BEGIN\n  IF EXISTS(SELECT 1 FROM benchmark_full_project_bindings WHERE project_id=p_id) THEN RETURN false; END IF;');
 execute body;
 end loop;
end $patch$;
