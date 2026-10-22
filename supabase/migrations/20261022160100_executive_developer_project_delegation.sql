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
    'DELEGATION PROVENANCE: The Executive Orchestrator delegated this project. Prior GitHub issue or draft PR may exist from an earlier attempt; recover and independently verify saved source before any implementation. The historical work is NOT a validated project contract or coding approval. Consult the stored executive_delegation_received event for the original artifact references.'
  where id=p.id returning * into p;
 end if;
 return to_jsonb(p);
end $$;
