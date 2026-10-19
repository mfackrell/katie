begin;
insert into actors(id,name) values('a1111111-1111-4111-8111-111111111111','Game intake fixture');
insert into chats(id,actor_id,title) values('a2222222-2222-4222-8222-222222222222','a1111111-1111-4111-8111-111111111111','Game intake fixture');
do $$declare p jsonb;q jsonb;aid uuid;collision jsonb;begin
 collision:=save_managed_agent(null,jsonb_build_object('name','Game Development Specialist v1','instructions','Unrelated editable test agent','research',true,'development',true,'attachments',false,'reviewMode','always','maxActiveTasks',1,'maxInputChars',16000),false);
 p:=create_game_work_project('a3333333-3333-4333-8333-333333333333','game-request-fixture','a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222','Build a browser game with explicit original rules',null);
 if p->>'profile'<>'game' then raise exception 'Missing game profile';end if;
 select agent_id into aid from project_agents where actor_id='a1111111-1111-4111-8111-111111111111' and role='game-development';
 if aid=(collision->>'id')::uuid then raise exception 'Mutable display-name collision selected';end if;
 if p->'team'->>2<>aid::text then raise exception 'Game specialist was not delegated';end if;
 q:=create_game_work_project('a3333333-3333-4333-8333-333333333333','game-request-fixture','a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222','Build a browser game with explicit original rules',null);
 if q<>p or (select count(*) from project_events where project_id=(p->>'id')::uuid and event='game_registered')<>1 then raise exception 'Duplicate game registration';end if;
 begin
  perform create_game_work_project('a3333333-3333-4333-8333-333333333333','game-request-fixture','a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222','Changed objective',null);
  raise exception 'Changed identity accepted';
 exception when others then if sqlerrm='Changed identity accepted' then raise;end if;end;
 -- Editing a pinned agent must fail closed on a subsequent NEW project.
 if not game_project_specialist_valid((p->>'id')::uuid) then raise exception 'Pinned specialist not admitted';end if;
 update managed_agents set version=version+1 where id=aid;
 if game_project_specialist_valid((p->>'id')::uuid) then raise exception 'Edited specialist can admit missions';end if;
 insert into chats(id,actor_id,title) values('a4444444-4444-4444-8444-444444444444','a1111111-1111-4111-8111-111111111111','Second game');
 begin
  perform create_game_work_project('a5555555-5555-4555-8555-555555555555','second-game-fixture','a1111111-1111-4111-8111-111111111111','a4444444-4444-4444-8444-444444444444','Build another browser game',null);
  raise exception 'Edited specialist accepted';
 exception when others then if sqlerrm='Edited specialist accepted' then raise;end if;end;
 if has_table_privilege('anon','game_specialist_bindings','select') or has_table_privilege('authenticated','game_specialist_bindings','select') or has_table_privilege('service_role','game_specialist_bindings','update') then raise exception 'Pinned specialist registry is not private/immutable';end if;
 if has_function_privilege('anon','public.create_game_work_project(uuid,text,uuid,uuid,text,uuid)','execute') or has_function_privilege('authenticated','public.create_game_work_project(uuid,text,uuid,uuid,text,uuid)','execute') then raise exception 'Public game creation access';end if;
end $$;
rollback;
