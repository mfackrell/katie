-- Developer-only specialization. Existing software and Executive entry points retain their behavior.
alter table public.work_projects add column if not exists profile text not null default 'software' check(profile in ('software','game'));
create table if not exists public.game_specialist_bindings (
 actor_id uuid primary key references public.actors(id),
 agent_id uuid not null unique references public.managed_agents(id),
 definition_version integer not null,
 config_hash text not null check(config_hash ~ '^[a-f0-9]{64}$')
);
alter table public.game_specialist_bindings enable row level security;
revoke all on public.game_specialist_bindings from public,anon,authenticated,service_role;
grant select,insert on public.game_specialist_bindings to service_role;
create or replace function public.create_game_work_project(p_id uuid,p_request text,p_actor uuid,p_chat uuid,p_objective text,p_repository uuid default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare p work_projects;aid uuid;a jsonb;was_existing boolean;b game_specialist_bindings;definition managed_agents;expected jsonb;expected_hash text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select exists(select 1 from work_projects where id=p_id or request_id=p_request) into was_existing;
 perform create_work_project(p_id,p_request,p_actor,p_chat,p_objective,p_repository);
 select * into strict p from work_projects where id=p_id for update;
 if was_existing then
  if p.profile<>'game' then raise exception 'Project profile identity conflict';end if;
  return to_jsonb(p);
 end if;
 -- Versioned server-owned charter, never selected by mutable display fields.
 expected:=jsonb_build_object('name','Game Development Specialist v1','instructions','Implement only approved game requirements. Read lib/game-development/GAME_CONTRACT.md. Separate a self-contained pure transition(state,action) engine from UI, persistence, bot and network behavior. Preserve source-grounded edition/rules, approved interpretations and unresolved decisions. Execute registered model and real-browser scenarios through the existing independent workflow. Repair proven gameplay defects only; preserve verified source on infrastructure failures. Return exact commit, receipts and usable Preview. Do not merge, publish production, expand scope or change orchestration, secrets, dependencies or services.','research',true,'development',true,'attachments',false,'reviewMode','always','maxActiveTasks',1,'maxInputChars',16000);
 expected_hash:=encode(sha256(convert_to(project_canonical(expected),'UTF8')),'hex');
 select * into b from game_specialist_bindings where actor_id=p_actor;
 if not found then
  a:=save_managed_agent(null,expected,false);
  aid:=(a->>'id')::uuid;
  insert into game_specialist_bindings(actor_id,agent_id,definition_version,config_hash) values(p_actor,aid,(a->>'version')::integer,expected_hash) returning * into b;
 end if;
 select * into strict definition from managed_agents where id=b.agent_id for share;
 if definition.archived or definition.version<>b.definition_version or b.config_hash<>expected_hash or encode(sha256(convert_to(project_canonical(definition.config),'UTF8')),'hex')<>b.config_hash then
  raise exception 'Pinned game specialist definition changed; restore or explicitly version its registration before new work';
 end if;
 aid:=b.agent_id;
 insert into project_agents(actor_id,role,agent_id) values(p_actor,'game-development',aid) on conflict(actor_id,role) do nothing;
 if not exists(select 1 from project_agents where actor_id=p_actor and role='game-development' and agent_id=aid) then raise exception 'Game specialist mapping identity conflict';end if;
 update work_projects set profile='game',team[3]=aid where id=p_id returning * into p;
 insert into project_events(project_id,event,data) values(p_id,'game_registered',jsonb_build_object('specialist',aid,'definitionVersion',b.definition_version,'configHash',b.config_hash,'acceptance','scope-bound model and browser contracts','repair','existing bounded project/native repair pipeline'));
 return to_jsonb(p);
end $$;
revoke all on function public.create_game_work_project(uuid,text,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.create_game_work_project(uuid,text,uuid,uuid,text,uuid) to service_role;

-- Every phase snapshots the same pinned specialist. A later ordinary agent edit
-- cannot silently change an already registered project's next mission.
create or replace function public.game_project_specialist_valid(p_id uuid) returns boolean
language plpgsql security invoker set search_path=public as $$
declare p work_projects;b game_specialist_bindings;a managed_agents;
begin
 select * into p from work_projects where id=p_id;
 if not found then return false;end if;
 if p.profile<>'game' then return true;end if;
 select * into b from game_specialist_bindings where actor_id=p.actor_id;
 if not found or p.team[3]<>b.agent_id then return false;end if;
 select * into a from managed_agents where id=b.agent_id for share;
 return found and not a.archived and a.version=b.definition_version and encode(sha256(convert_to(project_canonical(a.config),'UTF8')),'hex')=b.config_hash;
end $$;
revoke all on function public.game_project_specialist_valid(uuid) from public,anon,authenticated;
grant execute on function public.game_project_specialist_valid(uuid) to service_role;
create or replace function public.guard_game_project_mission() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 if new.project_id is not null and not game_project_specialist_valid(new.project_id) then raise exception 'Pinned game specialist changed before mission admission';end if;
 return new;
end $$;
revoke all on function public.guard_game_project_mission() from public,anon,authenticated;
grant execute on function public.guard_game_project_mission() to service_role;
drop trigger if exists game_project_mission_guard on public.agent_missions;
create trigger game_project_mission_guard before update of project_id on public.agent_missions for each row execute function public.guard_game_project_mission();

-- Registered workers cannot be edited through ordinary agent management.
-- New charters require a reviewed versioned registration, never a silent edit.
create or replace function public.guard_registered_game_specialist() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 if exists(select 1 from game_specialist_bindings where agent_id=old.id) and (new.config is distinct from old.config or new.version<>old.version or new.archived is distinct from old.archived) then
  raise exception 'Registered game specialist is immutable; create a reviewed new charter version instead of editing or archiving this worker';
 end if;
 return new;
end $$;
revoke all on function public.guard_registered_game_specialist() from public,anon,authenticated;
grant execute on function public.guard_registered_game_specialist() to service_role;
drop trigger if exists registered_game_specialist_guard on public.managed_agents;
create trigger registered_game_specialist_guard before update on public.managed_agents for each row execute function public.guard_registered_game_specialist();
