begin;
insert into actors(id,name) values('a1111111-1111-4111-8111-111111111111','Game intake fixture');
insert into chats(id,actor_id,title) values('a2222222-2222-4222-8222-222222222222','a1111111-1111-4111-8111-111111111111','Game intake fixture');
do $$declare p jsonb;q jsonb;aid uuid;begin
 p:=create_game_work_project('a3333333-3333-4333-8333-333333333333','game-request-fixture','a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222','Build a browser game with explicit original rules',null);
 if p->>'profile'<>'game' then raise exception 'Missing game profile';end if;
 select agent_id into aid from project_agents where actor_id='a1111111-1111-4111-8111-111111111111' and role='game-development';
 if p->'team'->>2<>aid::text then raise exception 'Game specialist was not delegated';end if;
 q:=create_game_work_project('a3333333-3333-4333-8333-333333333333','game-request-fixture','a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222','Build a browser game with explicit original rules',null);
 if q<>p or (select count(*) from project_events where project_id=(p->>'id')::uuid and event='game_registered')<>1 then raise exception 'Duplicate game registration';end if;
 begin
  perform create_game_work_project('a3333333-3333-4333-8333-333333333333','game-request-fixture','a1111111-1111-4111-8111-111111111111','a2222222-2222-4222-8222-222222222222','Changed objective',null);
  raise exception 'Changed identity accepted';
 exception when others then if sqlerrm='Changed identity accepted' then raise;end if;end;
 if has_function_privilege('anon','public.create_game_work_project(uuid,text,uuid,uuid,text,uuid)','execute') or has_function_privilege('authenticated','public.create_game_work_project(uuid,text,uuid,uuid,text,uuid)','execute') then raise exception 'Public game creation access';end if;
end $$;
rollback;
