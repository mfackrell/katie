-- Admit developer-owned projects from saved, explicitly approved Executive assignments.
-- Ordinary managed-agent project creation remains prohibited. Approval of an
-- Executive task never authorizes a Developer project's code changes.
create or replace function public.create_work_project(p_id uuid,p_request text,p_actor uuid,p_chat uuid,p_objective text,p_repository uuid default null) returns jsonb language plpgsql security invoker set search_path=public as $$ declare p work_projects;role_name text;config jsonb;a jsonb;ids uuid[]:='{}';aid uuid;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if not exists(select 1 from chats where id=p_chat and actor_id=p_actor) or (exists(select 1 from managed_agents where actor_id=p_actor) and not exists (select 1 from agent_missions m join mission_assignments j on j.mission_id=m.id join agent_tasks t on t.id=j.id where p_request='executive-delegated:'||m.id::text and j.role='development' and j.payload->>'approved'='true' and t.actor_id=p_actor and t.chat_id=p_chat and t.agent_id=j.agent_id and t.repository_id is not distinct from m.repository_id and t.kind='development' and t.initial_input=j.payload->>'development_input' and m.repository_id is not distinct from p_repository and m.project_id is null)) then raise exception 'Project chat association denied';end if;
 select * into p from work_projects where id=p_id or request_id=p_request;
 if found then if p.id<>p_id or p.actor_id<>p_actor or p.chat_id<>p_chat or p.objective<>p_objective or p.repository_id is distinct from p_repository then raise exception 'Project request identity conflict';end if;return to_jsonb(p);end if;
 if p_repository is not null and not exists(select 1 from repo_sync_runs where id=p_repository) then raise exception 'Connected repository unavailable';end if;
 foreach role_name in array array['lead','research','development'] loop
  select agent_id into aid from project_agents where actor_id=p_actor and role=role_name;
  if aid is null then
   config:=jsonb_build_object('name','Project '||initcap(role_name),'instructions',case role_name when 'research' then 'Research primary evidence, distinguish facts and gaps, independently challenge unsupported conclusions. Do not invent findings or actions.' when 'development' then 'Implement approved project increments on isolated branches through existing independent testing and review. Preserve prior verified work. Run focused tests and actual approved browser acceptance. Never merge, deploy to production, modify secrets or expand approved scope.' else 'Manage the original user outcome. Preserve acceptance requirements across milestones. Deliver only evidence-backed integrated results; a plan or partial milestone is not project completion.' end,'research',role_name='research','development',role_name='development','attachments',false,'reviewMode','always','maxActiveTasks',1,'maxInputChars',16000);
   a:=save_managed_agent(null,config,false);aid:=(a->>'id')::uuid;insert into project_agents values(p_actor,role_name,aid);
  end if;
  if not exists(select 1 from managed_agents where id=aid and not archived) then raise exception 'A saved project agent was disabled; restore or replace it explicitly';end if;ids:=array_append(ids,aid);
 end loop;
 insert into work_projects(id,request_id,actor_id,chat_id,objective,repository_id,team,detail) values(p_id,p_request,p_actor,p_chat,p_objective,p_repository,ids,'Researching the requested outcome. No coding or production changes authorized yet.') returning * into p;
 insert into project_events(project_id,event,data) values(p.id,'created',jsonb_build_object('objective',p.objective,'repository',p.repository_id));
 if p_request like 'executive-delegated:%' then
  -- A previous issue/PR is source evidence, not an approved game contract.
  -- Preserve linkage without allowing the saved artifact to bypass research,
  -- scope approval, independent checks or the original target repository.
  insert into project_events(project_id,event,data)
    select p.id,'executive_delegation_received',jsonb_build_object(
      'missionId',m.id,'assignmentId',j.id,'sourceTaskStatus',t.status,
      'sourceIssueUrl',t.external->>'issueUrl','sourcePrUrl',t.external->>'prUrl',
      'priorWorkVerified',false,'codingApprovalInherited',false)
    from agent_missions m join mission_assignments j on j.mission_id=m.id
    join agent_tasks t on t.id=j.id
    where p_request='executive-delegated:'||m.id::text and j.role='development'
      and t.actor_id=p_actor and t.chat_id=p_chat and t.agent_id=j.agent_id;
  update work_projects set clarifications=
    'DELEGATION PROVENANCE: The Executive Orchestrator delegated this project. Prior owner-authored GitHub issue: '||
      coalesce((select t.external->>'issueUrl' from mission_assignments j join agent_tasks t on t.id=j.id
        join agent_missions m on m.id=j.mission_id where p_request='executive-delegated:'||m.id::text
          and j.role='development' limit 1),'not yet recorded')||
      '. Locate any existing draft PR and immutable code SHA associated with that issue. Recover and independently verify saved source before new implementation. Historical work is NOT a validated project contract or coding approval; consult the stored executive_delegation_received event.'
  where id=p.id returning * into p;
 end if;
 return to_jsonb(p);
end $$;

-- Recover a previously blocked Executive mission only after a developer-owned
-- project has been established from that SAME task and original objective.
-- Preserve the original model costs, attempts, issue/PR references and result.
-- No scope approval, coding authorization or review evidence is synthesized.
create or replace function public.recover_delegated_development(p_mission uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare m agent_missions; j mission_assignments;t agent_tasks;p work_projects;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into m from agent_missions where id=p_mission for update;
 if not found or m.project_id is not null or m.repository_id is null then raise exception 'Standalone development mission unavailable'; end if;
 select * into j from mission_assignments where mission_id=m.id and role='development' for update;
 if not found or j.payload->>'approved' is distinct from 'true' then raise exception 'Saved development delegation authorization unavailable';end if;
 select * into t from agent_tasks where id=j.id for update;
 if not found or t.agent_id<>j.agent_id or t.repository_id is distinct from m.repository_id or t.initial_input is distinct from j.payload->>'development_input' then
  raise exception 'Immutable developer task binding invalid';
 end if;
 select * into p from work_projects where request_id='executive-delegated:'||m.id::text for update;
 if not found or p.actor_id<>t.actor_id or p.chat_id<>t.chat_id or p.objective<>m.objective
    or p.repository_id is distinct from m.repository_id then raise exception 'Developer project binding invalid';end if;
 if m.status='running' and j.status='waiting_external' then return to_jsonb(p);end if;
 if m.status<>'blocked' or j.status<>'failed' or j.attempts>2 or t.status not in ('submitted','dispatching','ready','blocked') then
  raise exception 'Historical delegation recovery state not eligible';
 end if;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),
   result=coalesce(j.result,'{}'::jsonb)||jsonb_build_object('delegatedProjectId',p.id,'historicalFailureRetained',true),
   detail='Supervising approved Developer Orchestrator project; saved GitHub work is retained.',updated_at=now() where id=j.id;
 update agent_missions set status='running',deadline=greatest(m.deadline,p.deadline),
   detail='Historical development handoff recovered into Developer Orchestrator project. Completion requires independently verified project acceptance.',updated_at=now()
   where id=m.id;
 insert into project_events(project_id,event,data) values(p.id,'executive_supervision_recovered',
   jsonb_build_object('missionId',m.id,'assignmentId',j.id,'originalDeadline',m.deadline,
     'originalAttempts',j.attempts,'originalFailure',j.result->>'detail','scopeApprovalInherited',false,'codingApprovalInherited',false));
 return to_jsonb(p);
end $$;
revoke all on function public.recover_delegated_development(uuid) from public,anon,authenticated;
grant execute on function public.recover_delegated_development(uuid) to service_role;
