-- Developer-only specialization. Existing software and Executive entry points retain their behavior.
alter table public.work_projects add column if not exists profile text not null default 'software' check(profile in ('software','game'));
create or replace function public.create_game_work_project(p_id uuid,p_request text,p_actor uuid,p_chat uuid,p_objective text,p_repository uuid default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare p work_projects;aid uuid;a jsonb;was_existing boolean;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select exists(select 1 from work_projects where id=p_id or request_id=p_request) into was_existing;
 -- Preserve the existing identity, actor/chat, repository and objective checks atomically.
 perform create_work_project(p_id,p_request,p_actor,p_chat,p_objective,p_repository);
 select * into strict p from work_projects where id=p_id for update;
 if was_existing then
  if p.profile<>'game' then raise exception 'Project profile identity conflict';end if;
  return to_jsonb(p);
 end if;
 select agent_id into aid from project_agents where actor_id=p_actor and role='game-development';
 if aid is null then
  -- Reuse the existing reviewed game specialist; never edit its charter or Executive registry.
  select id into aid from managed_agents where not archived and config->>'name'='Game Development Agent' and config->>'development'='true' order by created_at limit 1;
  if aid is null then
   a:=save_managed_agent(null,jsonb_build_object('name','Game Development Agent','instructions','Implement only approved game requirements. Read lib/game-development/GAME_CONTRACT.md. Separate a self-contained pure transition(state,action) engine from UI, persistence, bot and network behavior. Preserve source-grounded edition/rules, approved interpretations and unresolved decisions. Execute registered model and real-browser scenarios through the existing independent workflow. Repair proven gameplay defects only; preserve verified source on infrastructure failures. Return exact commit, receipts and usable Preview. Do not merge, publish production, expand scope or change orchestration, secrets, dependencies or services.','research',true,'development',true,'attachments',false,'reviewMode','always','maxActiveTasks',1,'maxInputChars',16000),false);
   aid:=(a->>'id')::uuid;
  end if;
  insert into project_agents(actor_id,role,agent_id) values(p_actor,'game-development',aid);
 end if;
 if not exists(select 1 from managed_agents where id=aid and not archived and config->>'development'='true') then raise exception 'Saved game specialist unavailable';end if;
 update work_projects set profile='game',team[3]=aid where id=p_id returning * into p;
 insert into project_events(project_id,event,data) values(p_id,'game_registered',jsonb_build_object('specialist',aid,'acceptance','scope-bound model and browser contracts','repair','existing bounded project/native repair pipeline'));
 return to_jsonb(p);
end $$;
revoke all on function public.create_game_work_project(uuid,text,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.create_game_work_project(uuid,text,uuid,uuid,text,uuid) to service_role;
