-- Additive, service-only management. Apply through the existing migration runner.
create function public.valid_managed_agent_config(p_config jsonb) returns boolean
language plpgsql immutable strict security invoker set search_path=public as $$
begin
 if jsonb_typeof(p_config) <> 'object' or (select count(*) from jsonb_object_keys(p_config)) <> 8
 or not p_config ?& array['name','instructions','research','attachments','development','maxActiveTasks','maxInputChars','reviewMode']
 or jsonb_typeof(p_config->'name') <> 'string' or length(trim(p_config->>'name')) not between 1 and 80
 or jsonb_typeof(p_config->'instructions') <> 'string' or length(trim(p_config->>'instructions')) not between 1 and 12000
 or jsonb_typeof(p_config->'research') <> 'boolean' or p_config->'attachments' <> 'false'::jsonb
 or jsonb_typeof(p_config->'reviewMode') <> 'string' or p_config->>'reviewMode' not in ('always','adaptive')
 or jsonb_typeof(p_config->'development') <> 'boolean'
 or jsonb_typeof(p_config->'maxActiveTasks') <> 'number' or jsonb_typeof(p_config->'maxInputChars') <> 'number'
 or (p_config->>'maxActiveTasks') !~ '^[1-4]$' or (p_config->>'maxInputChars') !~ '^[0-9]+$'
 or (p_config->>'maxInputChars')::integer not between 100 and 16000 then return false; end if;
 return true;
end $$;
revoke all on function public.valid_managed_agent_config(jsonb) from public,anon,authenticated;
grant execute on function public.valid_managed_agent_config(jsonb) to service_role;

create table public.managed_agents (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null unique references public.actors(id) on delete restrict,
 config jsonb not null check(public.valid_managed_agent_config(config)),
 version integer not null default 1,
 archived boolean not null default false,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index managed_agents_identity on public.managed_agents(id,actor_id);
create unique index chats_managed_identity on public.chats(id,actor_id);
create table public.agent_tasks (
 id uuid primary key,
 agent_id uuid not null references public.managed_agents(id) on delete restrict,
 actor_id uuid not null references public.actors(id) on delete restrict,
 chat_id uuid not null unique references public.chats(id) on delete restrict,
 snapshot jsonb not null check(public.valid_managed_agent_config(snapshot)), definition_version integer not null,
 kind text not null check(kind in ('general','development')),
 initial_input text not null check(length(initial_input) between 1 and 16000),
 input text not null check(length(input) between 1 and 16000),
 repository_id uuid references public.repo_sync_runs(id) on delete restrict,
 repository_full_name text,
 request_id text not null unique,
 status text not null default 'draft' check(status in ('draft','running','pending','completed','failed','blocked','dispatching','submitted','ready')),
 details text, external jsonb not null default '{}',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(agent_id,actor_id) references public.managed_agents(id,actor_id) on delete restrict,
 foreign key(chat_id,actor_id) references public.chats(id,actor_id) on delete restrict
);
create index agent_tasks_agent_status on public.agent_tasks(agent_id,status);
create index agent_tasks_actor on public.agent_tasks(actor_id);
alter table public.managed_agents enable row level security;
alter table public.agent_tasks enable row level security;
revoke all on public.managed_agents,public.agent_tasks from public,anon,authenticated;
grant select,insert,update on public.managed_agents,public.agent_tasks to service_role;

create function public.save_managed_agent(p_id uuid,p_config jsonb,p_archive boolean default false)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare a public.managed_agents; aid uuid;
begin
 -- SQL validates the closed shape too; service-role callers cannot inject tools.
 if not public.valid_managed_agent_config(p_config) then raise exception 'Invalid agent configuration'; end if;
 if p_id is null then
  if p_archive then raise exception 'Cannot archive missing agent'; end if;
  aid:=gen_random_uuid();
  insert into public.actors(id,name,system_prompt,review_mode) values(aid,p_config->>'name',p_config->>'instructions',p_config->>'reviewMode');
  insert into managed_agents(actor_id,config) values(aid,p_config) returning * into a;
 else
  select * into a from managed_agents where id=p_id for update;
  if not found or a.archived then raise exception 'Agent missing or archived'; end if;
  -- Existing tasks retain the entire original config; actor purpose is not authority for tasks.
  update managed_agents set config=p_config,archived=p_archive,version=version+1,updated_at=now() where id=p_id returning * into a;
  update actors set name=p_config->>'name',system_prompt=p_config->>'instructions',review_mode=p_config->>'reviewMode' where id=a.actor_id;
  if not found then raise exception 'Actor missing'; end if;
 end if;
 return to_jsonb(a);
end $$;

create function public.create_agent_task(p_id uuid,p_agent uuid,p_input text,p_kind text,p_repository uuid default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare a managed_agents; t agent_tasks; cid uuid:=gen_random_uuid(); repo_name text;
begin
 select * into a from managed_agents where id=p_agent for update;
 if not found or a.archived then raise exception 'Agent missing or archived'; end if;
 perform 1 from actors where id=a.actor_id for key share;
 if not found then raise exception 'Actor missing'; end if;
 select * into t from agent_tasks where id=p_id;
 if found then
  if t.agent_id<>p_agent or t.initial_input<>p_input or t.kind<>p_kind or t.repository_id is distinct from p_repository then raise exception 'Task id conflict'; end if;
  return to_jsonb(t);
 end if;
 if length(trim(p_input))<1 or length(p_input)>(a.config->>'maxInputChars')::integer or p_kind not in ('general','development') then raise exception 'Invalid task'; end if;
 if p_kind='development' then
  if not (a.config->>'development')::boolean or p_repository is null then raise exception 'Development submission denied'; end if;
  select repository_full_name into repo_name from repo_sync_runs where id=p_repository;
  if not found or repo_name is null or length(repo_name)>200 or repo_name !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' then raise exception 'Connected repository required'; end if;
 elsif p_repository is not null then raise exception 'General repository access unavailable'; end if;
 insert into chats(id,actor_id,title,created_at,updated_at) values(cid,a.actor_id,left(p_input,100),now(),now());
 insert into agent_tasks(id,agent_id,actor_id,chat_id,snapshot,definition_version,kind,initial_input,input,repository_id,repository_full_name,request_id)
 values(p_id,a.id,a.actor_id,cid,a.config,a.version,p_kind,p_input,p_input,p_repository,repo_name,'agent:'||p_id::text) returning * into t;
 return to_jsonb(t);
end $$;

-- All start/continuation/dispatch transitions serialize on the definition row.
create function public.transition_agent_task(p_id uuid,p_action text,p_message text default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare a managed_agents; t agent_tasks; n integer;
begin
 select a0.* into a from managed_agents a0 join agent_tasks t0 on t0.agent_id=a0.id where t0.id=p_id for update of a0;
 if not found then raise exception 'Task missing'; end if;
 select * into t from agent_tasks where id=p_id for update;
 perform 1 from chats where id=t.chat_id and actor_id=t.actor_id for key share;
 if not found or a.actor_id<>t.actor_id then raise exception 'Task association invalid'; end if;
 if p_action='start' then
  if a.archived then raise exception 'Agent archived'; end if;
  if t.status<>'draft' then return to_jsonb(t); end if;
 elsif p_action='continue' then
  if a.archived or t.kind<>'general' or t.status not in ('completed','pending','failed') then raise exception 'Task cannot continue'; end if;
  if length(trim(p_message))<1 or length(p_message)>(t.snapshot->>'maxInputChars')::integer then raise exception 'Invalid continuation'; end if;
  t.input:=p_message; t.request_id:='agent:'||gen_random_uuid()::text;
 else raise exception 'Invalid transition'; end if;
 select count(*) into n from agent_tasks where agent_id=a.id and id<>t.id and status in ('running','pending','dispatching','submitted');
 if n>=least((a.config->>'maxActiveTasks')::integer,(t.snapshot->>'maxActiveTasks')::integer) then raise exception 'Active task limit reached'; end if;
 update agent_tasks set input=t.input,request_id=t.request_id,status=case when kind='development' then 'dispatching' else 'running' end,details=case when kind='development' then 'Approved; verifying owner credentials before submission.' else 'Execution admitted; waiting for durable runtime status.' end,updated_at=now() where id=t.id returning * into t;
 return to_jsonb(t);
end $$;

create function public.check_agent_chat(p_actor uuid,p_chat uuid,p_request text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare a managed_agents; t agent_tasks;
begin
 select * into a from managed_agents where actor_id=p_actor;
 if not found then return null; end if;
 select * into t from agent_tasks where actor_id=p_actor and chat_id=p_chat;
 if not found or t.agent_id<>a.id or t.kind<>'general' or t.request_id<>p_request or t.status not in ('running','pending','completed','failed') then raise exception 'Managed actor requires an admitted task request'; end if;
 perform 1 from chats where id=p_chat and actor_id=p_actor;
 if not found then raise exception 'Task association invalid'; end if;
 return to_jsonb(t);
end $$;

revoke all on function public.save_managed_agent(uuid,jsonb,boolean),public.create_agent_task(uuid,uuid,text,text,uuid),public.transition_agent_task(uuid,text,text),public.check_agent_chat(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.save_managed_agent(uuid,jsonb,boolean),public.create_agent_task(uuid,uuid,text,text,uuid),public.transition_agent_task(uuid,text,text),public.check_agent_chat(uuid,uuid,text) to service_role;

create function public.claim_agent_dispatch(p_id uuid) returns boolean
language plpgsql security invoker set search_path=public as $$
declare t agent_tasks;
begin
 select * into t from agent_tasks where id=p_id for update;
 if not found or t.kind<>'development' or t.status<>'dispatching' or t.external ? 'attempted' then return false; end if;
 perform 1 from chats c join managed_agents a on a.id=t.agent_id where c.id=t.chat_id and c.actor_id=t.actor_id and a.actor_id=t.actor_id;
 if not found then raise exception 'Task association invalid'; end if;
 update agent_tasks set external=jsonb_build_object('attempted',true),updated_at=now() where id=p_id;
 return true;
end $$;
revoke all on function public.claim_agent_dispatch(uuid) from public,anon,authenticated;
grant execute on function public.claim_agent_dispatch(uuid) to service_role;

alter table public.agent_tasks add column execution_request_id text;
create function public.claim_agent_execution(p_id uuid,p_request text) returns boolean
language plpgsql security invoker set search_path=public as $$
declare t agent_tasks;
begin
 select * into t from agent_tasks where id=p_id for update;
 if not found or t.kind<>'general' or t.status<>'running' or t.request_id<>p_request then return false; end if;
 perform 1 from chats c join managed_agents a on a.id=t.agent_id where c.id=t.chat_id and c.actor_id=t.actor_id and a.actor_id=t.actor_id;
 if not found then raise exception 'Task association invalid'; end if;
 if t.execution_request_id=p_request then return false; end if;
 update agent_tasks set execution_request_id=p_request,updated_at=now() where id=p_id;
 return true;
end $$;
revoke all on function public.claim_agent_execution(uuid,text) from public,anon,authenticated;
grant execute on function public.claim_agent_execution(uuid,text) to service_role;
