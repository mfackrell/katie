-- Phase-specific evidence admission: complete game brief plus reviewed research.
-- The model worker separately enforces a 128K character request envelope and
-- native token reservation within the unchanged mission/project spending caps.
create or replace function public.project_evidence_limit(p_profile text,p_phase text)
returns integer language sql immutable security invoker set search_path=public as $$
 select case when p_profile='game' and p_phase='specification' then 60000 else 30000 end;
$$;
revoke all on function public.project_evidence_limit(text,text) from public,anon,authenticated;
grant execute on function public.project_evidence_limit(text,text) to service_role;
do $$ declare definition text;begin
 select pg_get_functiondef('public.finish_work_project(uuid,uuid,text,jsonb)'::regprocedure) into definition;
 if position('length(coalesce((p_data->''evidence'')::text,''''))>30000' in definition)=0 then raise exception 'Expected phase evidence fence missing';end if;
 definition:=replace(definition,'length(coalesce((p_data->''evidence'')::text,''''))>30000',
 'length(coalesce((p_data->''evidence'')::text,''''))>public.project_evidence_limit(p.profile,kind)');
 execute definition;
end $$;

-- Resume only the specification stage from independently approved research.
-- Guard all project-level permissions, historical charges and attempt limits.
create or replace function public.resume_oversized_game_specification(p_id uuid,p_actor uuid,p_chat uuid,p_evidence jsonb default null)
returns boolean language plpgsql set search_path to 'public' as $$
declare p public.work_projects; charged bigint; runs_used int; latest_research text; research_id text; original_source text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status<>'blocked' or p.profile<>'game' or p.phase<>'specification'
   or p.active_mission_id is not null or p.spec is not null
   or p.approval_hash is not null or p.approved_hash is not null
   or p.deadline<=now()+interval '30 minutes'
   or (p.detail not like '%Project milestone context exceeds its bounded input%' and p.detail not like '%Project evidence exceeds bounded context%')
 then return false;end if;
 -- The exact most recent eligible research payload is the source the real worker
 -- consumes. Validate it before the one-shot record can be spent.
 select m.result,r.outcome->>'reviewedMissionId' into latest_research,research_id from public.project_runs r
 join public.agent_missions m on m.id=r.mission_id
 where r.project_id=p.id and r.kind='research' and m.status='completed'
   and r.outcome is not null
   and coalesce((r.outcome->>'superseded')::boolean,false)=false
 order by r.ordinal desc limit 1;
 if not found or coalesce(length(latest_research),0)=0 then return false;end if;
 original_source:='ORIGINAL USER OUTCOME (must remain authoritative):'||chr(10)||p.objective||chr(10)||p.clarifications;
 -- Exact complete evidence is built by the real worker, not a raw text-length
 -- estimate. Validate serialization and authoritative source identity before
 -- recording any wake-up or publishing an admission announcement.
 if p_evidence is null or jsonb_typeof(p_evidence)<>'object' or length(p_evidence::text)>public.project_evidence_limit(p.profile,p.phase)
  or p_evidence->>'projectProfile' is distinct from 'game'
  or p_evidence->'reviewedResearch'->>'text' is distinct from latest_research
  or p_evidence->'reviewedResearch'->>'reviewedMissionId' is distinct from research_id
  or (length(original_source)>6500 and p_evidence->>'originalUserOutcome' is distinct from original_source)
 then return false;end if;

 -- A retryable coordinator wake-up, not a spent child/recovery slot.
 -- The actual fully serialized evidence is checked at child admission.
 if (select count(*) from project_events where project_id=p.id and event='oversized_game_specification_resumed')>=2
    or (p.lease is not null and p.lease_until>now()) then return false;end if;
 select count(*) into runs_used from public.project_runs where project_id=p.id;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged from public.agent_missions where project_id=p.id;
 if runs_used>=p.max_missions or p.token_allowance-charged<10000 then return false;end if;
 update public.work_projects set status='running',lease=null,lease_until=null,
  detail='Resuming specification from saved independently reviewed research with original instructions stored losslessly as mission evidence. Previous attempts and charges retained.',
  updated_at=now() where id=p.id;
 insert into public.project_events(project_id,event,data) values(p.id,'oversized_game_specification_resumed',
  jsonb_build_object('reviewedResearchRetained',true,'chargedTokens',charged,'remainingTokens',p.token_allowance-charged,
   'priorRuns',runs_used,'previousFailures',p.failures,'evidenceHash',encode(sha256(convert_to(project_canonical(p_evidence),'UTF8')),'hex'),'codingApproved',false,'dispatchPending',true));
 perform public.project_publish(p.id,'Specification context admitted; resuming from the original reviewed research within the original budget.');
 return true;
end;$$;

-- These maintenance RPCs must not be callable from browser/data API roles.
revoke all on function public.resume_oversized_game_specification(uuid,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.resume_oversized_game_specification(uuid,uuid,uuid,jsonb) to service_role;
