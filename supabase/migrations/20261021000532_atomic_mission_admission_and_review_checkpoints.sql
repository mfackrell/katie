-- Reservation rejection is an admission decision, not a terminal mission mutation.
create or replace function public.try_reserve_mission_capacity(p_id uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer,p_routing boolean)
returns boolean language plpgsql set search_path=public as $$
declare j mission_assignments;m agent_missions;project_limit bigint;project_used bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id;if not found then return false;end if;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into j from mission_assignments where id=p_id for update;
 if m.project_id is not null then
  select token_allowance into project_limit from work_projects where id=m.project_id and status='running' and active_mission_id=m.id and deadline>now();
  if not found then return false;end if;
 end if;
 if m.status not in ('running','awaiting_approval') or m.deadline<=now() or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then return false;end if;
 if p_tokens is null or p_tokens not between 1 and 120000 or p_call is null or p_routing is null or coalesce(length(p_model),0) not between 1 and 300 or exists(select 1 from mission_calls where id=p_call) then return false;end if;
 if (p_routing and m.routing_calls>=m.max_calls*3) or (not p_routing and m.calls>=m.max_calls) or greatest(m.reserved_tokens,m.actual_tokens)+p_tokens>m.token_allowance then return false;end if;
 if m.project_id is not null then
  select coalesce(sum(greatest(reserved_tokens,actual_tokens)),0) into project_used from agent_missions where project_id=m.project_id;
  if project_used+p_tokens>project_limit then return false;end if;
 end if;
 insert into mission_calls(id,job_id,lease,model,reserved_tokens) values(p_call,j.id,p_lease,p_model,p_tokens);
 update agent_missions set calls=calls+case when p_routing then 0 else 1 end,routing_calls=routing_calls+case when p_routing then 1 else 0 end,reserved_tokens=reserved_tokens+p_tokens,updated_at=now() where id=m.id;
 update mission_assignments set heartbeat_at=now(),lease_until=now()+interval '6 minutes' where id=j.id;
 return true;
end $$;
create or replace function public.reserve_mission_call(p_id uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer)
returns boolean language sql set search_path=public as $$ select public.try_reserve_mission_capacity(p_id,p_lease,p_call,p_model,p_tokens,false); $$;
create or replace function public.reserve_mission_routing_call(p_id uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer)
returns boolean language sql set search_path=public as $$ select public.try_reserve_mission_capacity(p_id,p_lease,p_call,p_model,p_tokens,true); $$;

create or replace function public.mission_call_capacity(p_id uuid,p_lease uuid)
returns jsonb language plpgsql set search_path=public as $$
declare j mission_assignments;m agent_missions;remaining bigint;parent_remaining bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id;
 if not found then return jsonb_build_object('authorized',false,'remainingTokens',0,'callsRemaining',0,'routingCallsRemaining',0);end if;
 select * into m from agent_missions where id=j.mission_id;
 if m.status not in ('running','awaiting_approval') or m.deadline<=now() or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then return jsonb_build_object('authorized',false,'remainingTokens',0,'callsRemaining',0,'routingCallsRemaining',0);end if;
 remaining:=m.token_allowance-greatest(m.reserved_tokens,m.actual_tokens);
 if m.project_id is not null then
  select p.token_allowance-(select coalesce(sum(greatest(a.reserved_tokens,a.actual_tokens)),0) from agent_missions a where a.project_id=p.id) into parent_remaining from work_projects p where p.id=m.project_id and p.status='running' and p.active_mission_id=m.id and p.deadline>now();
  if not found then return jsonb_build_object('authorized',false,'remainingTokens',0,'callsRemaining',0,'routingCallsRemaining',0);end if;
  remaining:=least(remaining,parent_remaining);
 end if;
 return jsonb_build_object('authorized',true,'remainingTokens',greatest(0,remaining),'callsRemaining',greatest(0,m.max_calls-m.calls),'routingCallsRemaining',greatest(0,m.max_calls*3-m.routing_calls));
end $$;

create or replace function public.checkpoint_mission_review_model(p_id uuid,p_lease uuid,p_hash text,p_response jsonb)
returns boolean language plpgsql set search_path=public as $$
declare j mission_assignments;m agent_missions;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id;if not found then return false;end if;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into j from mission_assignments where id=p_id for update;
 if j.role<>'review' or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() or m.status<>'running' or m.deadline<=now() then return false;end if;
 if m.project_id is not null and not exists(select 1 from work_projects where id=m.project_id and status='running' and active_mission_id=m.id and deadline>now()) then return false;end if;
 if p_hash is null or p_hash!~'^[a-f0-9]{64}$' or jsonb_typeof(p_response) is distinct from 'object' or jsonb_typeof(p_response->'text') is distinct from 'string' or length(p_response->>'text') not between 1 and 50000 or length(p_response::text)>64000 or jsonb_typeof(p_response->'sources') is distinct from 'array' or jsonb_typeof(p_response->'calculations') is distinct from 'array' or jsonb_typeof(p_response->'model') is distinct from 'string' then return false;end if;
 update mission_assignments set payload=jsonb_set(coalesce(payload,'{}'::jsonb),'{reviewModelCheckpoint}',jsonb_build_object('hash',p_hash,'response',p_response,'savedAt',now()),true),updated_at=now() where id=j.id;
 return true;
end $$;

-- Explicit owner-scoped recovery: reuse an identical saved candidate, not a new draft.
create or replace function public.resume_budget_blocked_review(p_id uuid,p_actor uuid,p_chat uuid)
returns jsonb language plpgsql set search_path=public as $$
declare p work_projects;failed agent_missions;source agent_missions;candidate mission_assignments;review_job mission_assignments;spent bigint;prior_outcome jsonb;candidate_hash text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status<>'blocked' or p.phase<>'specification' or p.profile<>'game' or p.approved_hash is not null or p.approval_hash is not null or p.spec is not null or p.active_mission_id is null or p.deadline<=now()+interval '20 minutes' then return null;end if;
 select * into failed from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or failed.status<>'blocked' or failed.detail not like '%allowance exhausted%' then return null;end if;
 if exists(select 1 from mission_assignments a join agent_missions m on m.id=a.mission_id where m.project_id=p.id and a.status='running' and a.lease_until>now()) then return null;end if;
 select a.* into candidate from mission_assignments a join agent_missions m on m.id=a.mission_id where m.project_id=p.id and m.project_kind='specification' and m.objective=failed.objective and m.status='blocked' and a.job_key='compose' and a.status='completed' and length(coalesce(a.result->>'text',''))>0 and not exists(select 1 from mission_assignments x where x.mission_id=m.id and x.role='revise') and exists(select 1 from mission_assignments r where r.mission_id=m.id and r.role='review' and r.status='failed' and (r.result->>'reviewContextOverflow'='true' or r.detail like 'Mission evidence exceeds bounded context.%')) order by m.created_at desc limit 1;
 if not found then return null;end if;
 select * into source from agent_missions where id=candidate.mission_id for update;
 select * into review_job from mission_assignments where mission_id=source.id and job_key='review' and role='review' and status='failed' for update;
 if not found or source.calls>=source.max_calls or source.routing_calls>=source.max_calls*3 or source.token_allowance-greatest(source.actual_tokens,source.reserved_tokens)<10000 then return null;end if;
 if exists(select 1 from project_events where project_id=p.id and event='budget_review_checkpoint_resumed' and data->>'blockedMissionId'=failed.id::text) then return null;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into spent from agent_missions where project_id=p.id;
 if p.token_allowance-spent<10000 then return null;end if;
 select outcome into prior_outcome from project_runs where project_id=p.id and mission_id=source.id;
 candidate_hash:=encode(sha256(convert_to(candidate.result->>'text','UTF8')),'hex');
 insert into project_events(project_id,event,data) values(p.id,'budget_review_checkpoint_resumed',jsonb_build_object('blockedMissionId',failed.id,'sourceMissionId',source.id,'candidateJobId',candidate.id,'candidateHash',candidate_hash,'reviewJobId',review_job.id,'previousReviewResult',review_job.result,'previousRunOutcome',prior_outcome,'previousDeadline',source.deadline,'previousAttempts',review_job.attempts,'chargedTokens',spent,'remainingTokens',p.token_allowance-spent));
 update project_runs set outcome=null where project_id=p.id and mission_id=source.id;
 update mission_assignments set status='queued',lease=null,lease_until=null,available_at=now(),detail='Resume unchanged saved candidate after token-admission architecture repair; original attempts and charges retained.',updated_at=now() where id=review_job.id;
 update agent_missions set status='running',deadline=least(p.deadline,now()+make_interval(mins=>least(max_minutes,120))),detail='Resuming exact saved specification review; token and call allowances unchanged.',updated_at=now() where id=source.id;
 update work_projects set status='running',active_mission_id=source.id,lease=null,lease_until=null,failures=0,detail='Independent review resumed from the last completed specification. No redrafting, budget reset or coding approval.',updated_at=now() where id=p.id;
 perform project_publish(p.id,'Saved specification restored for independent review. The original game rules, completed research, usage history and budget remain unchanged.');
 return jsonb_build_object('resumed',true,'missionId',source.id,'reviewJobId',review_job.id,'candidateHash',candidate_hash,'chargedTokens',spent,'remainingTokens',p.token_allowance-spent);
end $$;

revoke all on function public.try_reserve_mission_capacity(uuid,uuid,uuid,text,integer,boolean) from public,anon,authenticated;
revoke all on function public.mission_call_capacity(uuid,uuid) from public,anon,authenticated;
revoke all on function public.checkpoint_mission_review_model(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.resume_budget_blocked_review(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.try_reserve_mission_capacity(uuid,uuid,uuid,text,integer,boolean),public.mission_call_capacity(uuid,uuid),public.checkpoint_mission_review_model(uuid,uuid,text,jsonb),public.resume_budget_blocked_review(uuid,uuid,uuid) to service_role;
