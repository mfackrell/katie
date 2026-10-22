-- Existing handoff RPC is retained from its canonical migration. Add only knowledge snapshot support.
-- Knowledge remains a separate, source-verifiable capsule, never active requirements.
alter table public.agent_task_context_handoffs add column if not exists knowledge jsonb not null default '[]'::jsonb;
-- Existing knowledge columns must still be array-shaped; avoid duplicate constraint names.
DO $c$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_task_context_handoffs'::regclass AND conname = 'agent_task_handoff_knowledge_array') THEN
 ALTER TABLE public.agent_task_context_handoffs ADD CONSTRAINT agent_task_handoff_knowledge_array CHECK (jsonb_typeof(knowledge)='array'); END IF; END $c$;
grant update(knowledge) on public.agent_task_context_handoffs to service_role;

create function public.create_agent_task_handoff_with_knowledge(p_id uuid,p_agent uuid,p_input text,p_source_actor uuid,p_source_chat uuid,p_project text,p_knowledge jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare task jsonb; existed boolean; capsule jsonb; memory jsonb; snapshot jsonb; inherited boolean;
begin
 -- Use the same lock as the original RPC, including retries. The original RPC
 -- validates task input and handoff identity even when the receipt already exists.
 perform 1 from managed_agents where id=p_agent for update;
 select exists(select 1 from agent_task_context_handoffs where task_id=p_id) into existed;
 task:=create_agent_task_handoff(p_id,p_agent,p_input,p_source_actor,p_source_chat,p_project);
 if existed then return task; end if;
 if jsonb_typeof(p_knowledge) is distinct from 'array' or jsonb_array_length(p_knowledge)>80 then raise exception 'Invalid handoff knowledge'; end if;
 select content into memory from actor_long_term_memory where actor_id=p_source_actor for share;
 for capsule in select value from jsonb_array_elements(p_knowledge) loop
  if jsonb_typeof(capsule->'entry') is distinct from 'object' or jsonb_typeof(capsule->'sourceMessages') is distinct from 'array' or jsonb_array_length(capsule->'sourceMessages')=0 then raise exception 'Invalid knowledge capsule'; end if;
  -- An inherited capsule is transferable only as an exact immutable unit from
  -- the explicitly bound source actor/chat/project. No foreign live lookup.
  select exists(select 1 from agent_task_context_handoffs h cross join lateral jsonb_array_elements(h.knowledge) k
   where h.target_actor_id=p_source_actor and h.target_chat_id=p_source_chat and h.project_id=p_project and k=capsule) into inherited;
  if inherited then continue; end if;
  if not exists(select 1 from jsonb_array_elements(coalesce(memory->'entries','[]'::jsonb)) e where e=capsule->'entry') then raise exception 'Knowledge entry is not owned or inherited'; end if;
  if jsonb_typeof(capsule->'entry'->'evidenceMessageIds') is distinct from 'array' or jsonb_array_length(capsule->'entry'->'evidenceMessageIds')=0 then raise exception 'Knowledge evidence required'; end if;
  for snapshot in select value from jsonb_array_elements(capsule->'sourceMessages') loop
   if snapshot->>'role' is distinct from 'user' or not exists(
    select 1 from messages m join chats c on c.id=m.chat_id and c.actor_id=m.actor_id
    where m.actor_id=p_source_actor and m.id::text=snapshot->>'id' and m.chat_id::text=snapshot->>'chatId'
     and m.role='user' and m.content=snapshot->>'content' and m.created_at=(snapshot->>'createdAt')::timestamptz
   ) then raise exception 'Knowledge source is not an exact owned user message'; end if;
   if not (capsule->'entry'->'evidenceMessageIds' ? (snapshot->>'id')) then raise exception 'Unreferenced knowledge source'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements_text(capsule->'entry'->'evidenceMessageIds') e where not exists(select 1 from jsonb_array_elements(capsule->'sourceMessages') s where s->>'id'=e)) then raise exception 'Knowledge source missing'; end if;
 end loop;
 update agent_task_context_handoffs set knowledge=p_knowledge where task_id=p_id;
 return task;
end $$;
revoke all on function public.create_agent_task_handoff_with_knowledge(uuid,uuid,text,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.create_agent_task_handoff_with_knowledge(uuid,uuid,text,uuid,uuid,text,jsonb) to service_role;
