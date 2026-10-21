-- A review continuation is a new bounded child, never a reset of an expired
-- mission's charges, attempts or deadline. Its completed candidate and any
-- source-matching draft-blind checkpoint are copied exactly with provenance.
create or replace function public.resume_incomplete_game_review(p_id uuid,p_actor uuid,p_chat uuid,p_preflight jsonb default null)
returns boolean language plpgsql security invoker set search_path=public as $$
declare p work_projects;m agent_missions;j mission_assignments;c mission_assignments;
 spent bigint;seq integer;mid uuid;candidate_hash text;refresh boolean;technical boolean;recovery_event text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status<>'blocked' or p.phase<>'specification' or p.profile<>'game'
  or p.spec is not null or p.approved_hash is not null or p.approval_hash is not null
  or p.active_mission_id is null or p.deadline<=now()+interval '10 minutes'
  or (p.lease is not null and p.lease_until>now()) then return false;end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.project_kind<>'specification'
  or m.project_evidence->>'projectProfile' is distinct from 'game'
 then return false;end if;
 select * into j from mission_assignments where mission_id=m.id and role='review' and status='failed'
  and (result->>'responseStatus'='incomplete' and coalesce(result->>'incompleteReason','max_output_tokens')='max_output_tokens'
    or result->>'admissionDenied'='true' or result->>'reviewContextOverflow'='true'
    or detail='Model output incomplete: incomplete'
    or (payload ? 'reviewModelCheckpoint' and (result->>'reviewStageDeferred'='true'
      or detail='Worker lease expired; prior model-call reservation remains charged.'))) order by updated_at desc limit 1 for update;
 if not found then return false;end if;
 select * into c from mission_assignments where mission_id=m.id
  and job_key=case when j.job_key='review_again' then 'revision' else 'compose' end and status='completed'
  and length(coalesce(result->>'text',''))>0 for update;
 if not found then return false;end if;
 if exists(select 1 from mission_assignments a join agent_missions x on x.id=a.mission_id
   where x.project_id=p.id and a.status='running' and a.lease_until>now()) then return false;end if;
 -- A continuation cannot resurrect archived/modified agents or a dependency
 -- whose original evidence is unfinished or excluded from read-only recovery.
 if exists(select 1 from jsonb_array_elements(m.team) t where not exists(
  select 1 from managed_agents a where a.id=(t->>'id')::uuid and a.actor_id=(t->>'actor_id')::uuid
   and not a.archived and a.config=t->'config' and a.version=(t->>'version')::integer)) then return false;end if;
 if exists(select 1 from mission_assignments a,unnest(a.dependencies) dep
   where a.mission_id=m.id and (a.status='completed' and a.role<>'development' or a.id=j.id)
    and not exists(select 1 from mission_assignments d where d.mission_id=m.id and d.job_key=dep
      and d.status='completed' and d.role<>'development')) then return false;end if;
 candidate_hash:=encode(sha256(convert_to(c.result->>'text','UTF8')),'hex');
 refresh:=coalesce(j.result->>'reviewContextOverflow'='true' and p_preflight->>'refreshAssessment'='true',false);
 -- A previously measured overflow is never retried by copying the unchanged
 -- request blindly. The real worker must capture the complete current request
 -- from its source-matching saved assessment and prove it now fits.
 if j.result->>'reviewContextOverflow'='true' and not refresh and (
  p_preflight is null or p_preflight->>'reviewJobId' is distinct from j.id::text
  or p_preflight->>'candidateHash' is distinct from candidate_hash
  or p_preflight->>'checkpointHash' is distinct from j.payload->'reviewModelCheckpoint'->>'hash'
  or p_preflight->>'checkpointHash' is null
  or p_preflight->>'assessmentHash' is distinct from encode(sha256(convert_to(j.payload->'reviewModelCheckpoint'->'response'->>'text','UTF8')),'hex')
  or p_preflight->>'assessmentHash' is null
  or jsonb_typeof(p_preflight->'instruction') is distinct from 'string'
  or jsonb_typeof(p_preflight->'input') is distinct from 'string'
  or length(p_preflight->>'instruction') not between 1 and 48000
  or length(p_preflight->>'input') not between 1 and 128000
 ) then return false;end if;

 -- One additional technical continuation per exact candidate covers expired
 -- admission holds and exhausted worker leases. Never reset the old child or
 -- turn unchanged budget denial into a recurring stream of fresh missions.
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into spent from agent_missions where project_id=p.id;
 technical:=coalesce(j.payload ? 'reviewModelCheckpoint' and (j.result->>'reviewStageDeferred'='true'
   or j.detail='Worker lease expired; prior model-call reservation remains charged.'),false)
   or coalesce(j.result->>'admissionDenied'='true' and m.deadline<=now()+interval '5 minutes'
     and (j.result->>'remainingTokens')~'^[0-9]+$'
     and p.token_allowance-spent>greatest(10000,(j.result->>'remainingTokens')::bigint),false);
 if j.result->>'admissionDenied'='true' and m.project_evidence ? 'reviewContinuation' and not technical then return false;end if;
 recovery_event:=case when refresh then 'independent_assessment_refresh_started'
   when technical then 'technical_review_continuation_started' else 'incomplete_game_review_resumed' end;
 if exists(select 1 from project_events where project_id=p.id and event=recovery_event
   and data->>'candidateHash'=candidate_hash) then return false;end if;
 select count(*)+1 into seq from project_runs where project_id=p.id;
 -- Dispatch admission uses the real stage payload/native count, not a guessed
 -- minimum. No reservation or generation charge is made by this transaction.
 if seq>p.max_missions or p.token_allowance-spent<10000 then return false;end if;
 mid:=gen_random_uuid();
 insert into agent_missions(id,objective,team,status,max_calls,token_allowance,max_minutes,deadline,project_id,project_kind,project_evidence,detail)
 values(mid,m.objective,m.team,'running',m.max_calls,least(120000,p.token_allowance-spent),120,
  least(p.deadline,now()+interval '120 minutes'),p.id,'specification',m.project_evidence||
  jsonb_build_object('reviewContinuation',jsonb_build_object('missionId',m.id,'candidateJobId',c.id,'candidateHash',candidate_hash)),
  'Continue independent review of the exact saved candidate. Original mission remains immutable.');
 -- Copy completed dependencies and review receipts, including the preceding
 -- rejected review when continuing review_again. No implementation is copied.
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
 select mid,a.job_key,a.role,a.agent_id,a.instruction,a.dependencies,a.payload,'completed',0,a.result,
  'Reused completed evidence from source assignment '||a.id::text
 from mission_assignments a where a.mission_id=m.id and a.status='completed' and a.role<>'development';
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status)
 values(mid,j.job_key,j.role,j.agent_id,j.instruction,j.dependencies,(case when refresh then (j.payload-'reviewModelCheckpoint')||jsonb_build_object('assessmentRefresh',true) else j.payload end)||
  jsonb_build_object('continuationSource',jsonb_build_object('missionId',m.id,'jobId',j.id,'attempts',j.attempts)),'queued');
 insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index)
 values(p.id,mid,'specification',seq,p.milestone_index);
 insert into project_events(project_id,event,data) values(p.id,recovery_event,jsonb_build_object(
  'sourceMissionId',m.id,'missionId',mid,'reviewJobId',j.id,'candidateHash',candidate_hash,
  'chargedTokens',spent,'remainingTokens',p.token_allowance-spent,'previousAttempts',j.attempts,
  'savedCandidateUnchanged',true,'codingApproved',false,'dispatchPending',true,'priorAssessment',case when refresh then j.payload->'reviewModelCheckpoint' else null end));
 update work_projects set status='running',active_mission_id=mid,lease=null,lease_until=null,failures=0,
  detail='Saved specification independent review continued. Original charges and project deadline retained; coding remains unapproved.',updated_at=now() where id=p.id;
 perform project_publish(p.id,case when refresh then 'Refreshing the oversized independent assessment against the complete original sources. The saved specification and earlier receipt remain intact.' else 'Continuing the saved specification independent review. No redrafting or coding approval.' end);
 return true;
end $$;
revoke all on function public.resume_incomplete_game_review(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.resume_incomplete_game_review(uuid,uuid,uuid,jsonb) to service_role;

-- A continuation denied by actual admission remains pending, including one
-- whose successful draft-blind assessment is already saved and charged.
-- Retry the SAME child only when its remaining authorized capacity has
-- increased. Never duplicate a completed review stage,
-- widen the project ceiling, reset attempts, or repeatedly wake an unchanged
-- capacity denial. Original source missions remain untouched.
create or replace function public.resume_pending_game_review(p_id uuid,p_actor uuid,p_chat uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
declare p work_projects;m agent_missions;j mission_assignments;spent bigint;capacity bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status<>'blocked' or p.phase<>'specification' or p.profile<>'game'
  or p.spec is not null or p.approval_hash is not null or p.approved_hash is not null
  or p.deadline<=now()+interval '10 minutes' or p.lease_until>now() then return false;end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or not(m.project_evidence ? 'reviewContinuation')
  or m.deadline<=now()+interval '5 minutes' or m.calls>=m.max_calls or m.routing_calls>=m.max_calls*3 then return false;end if;
 select * into j from mission_assignments where mission_id=m.id and role='review' and status='failed'
  and result->>'admissionDenied'='true' and (result->>'remainingTokens')~'^[0-9]+$' for update;
 if not found or exists(select 1 from mission_assignments a join agent_missions x on x.id=a.mission_id
   where x.project_id=p.id and a.status='running' and a.lease_until>now()) then return false;end if;
 if exists(select 1 from jsonb_array_elements(m.team) t where not exists(
  select 1 from managed_agents a where a.id=(t->>'id')::uuid and a.actor_id=(t->>'actor_id')::uuid
   and not a.archived and a.config=t->'config' and a.version=(t->>'version')::integer)) then return false;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into spent from agent_missions where project_id=p.id;
 capacity:=least(120000-greatest(m.actual_tokens,m.reserved_tokens),p.token_allowance-spent);
 if capacity<=greatest(10000,(j.result->>'remainingTokens')::bigint) then return false;end if;
 insert into project_events(project_id,event,data) values(p.id,'pending_game_review_capacity_changed',jsonb_build_object(
  'missionId',m.id,'previousDeadline',m.deadline,'previousAttempts',j.attempts,'chargedTokens',spent,'remainingTokens',capacity));
 update agent_missions set status='running',token_allowance=least(120000,p.token_allowance-spent+greatest(m.actual_tokens,m.reserved_tokens)),
  updated_at=now() where id=m.id;
 update mission_assignments set status='queued',lease=null,lease_until=null,available_at=now(),updated_at=now() where id=j.id;
 update work_projects set status='running',lease=null,lease_until=null,failures=0,updated_at=now() where id=p.id;
 return true;
end $$;
revoke all on function public.resume_pending_game_review(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.resume_pending_game_review(uuid,uuid,uuid) to service_role;

-- Finalize dispatch provenance only when a real execution reservation succeeds.
-- Rejected calls do not spend this marker or any inference-call slot.
create or replace function public.reserve_mission_call(p_id uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer)
returns boolean language plpgsql security invoker set search_path=public as $$
declare accepted boolean;m agent_missions;
begin
 accepted:=public.try_reserve_mission_capacity(p_id,p_lease,p_call,p_model,p_tokens,false);
 if accepted then
  select x.* into m from agent_missions x join mission_assignments a on a.mission_id=x.id where a.id=p_id;
  if m.project_evidence ? 'reviewContinuation' and not exists(select 1 from project_events
    where project_id=m.project_id and event='review_continuation_dispatched' and data->>'missionId'=m.id::text) then
   insert into project_events(project_id,event,data) values(m.project_id,'review_continuation_dispatched',
    jsonb_build_object('missionId',m.id,'candidateHash',m.project_evidence->'reviewContinuation'->>'candidateHash','callId',p_call));
  end if;
 end if;
 return accepted;
end $$;
