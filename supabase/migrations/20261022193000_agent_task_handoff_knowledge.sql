-- Preserve current handoff's identity checks, locks and immutable receipt; extend only scoped work-product snapshot and evidence IDs.
create or replace function public.create_agent_task_handoff(p_id uuid,p_agent uuid,p_input text,p_source_actor uuid,p_source_chat uuid,p_project text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare task jsonb; source jsonb; frozen jsonb; receipt agent_task_context_handoffs; project jsonb; existed boolean; evidence jsonb; original_chat uuid; original_owned boolean; inherited jsonb;
begin
 -- Creation and context seeding share a transaction and the existing agent lock.
 if nullif(trim(p_project),'') is null then raise exception 'Source project required'; end if;
 perform 1 from managed_agents where id=p_agent for update;
 select exists(select 1 from agent_tasks where id=p_id) into existed;
 task:=create_agent_task(p_id,p_agent,p_input,'general',null);
 select * into receipt from agent_task_context_handoffs where task_id=p_id;
 if found then
  if receipt.source_actor_id is distinct from p_source_actor or receipt.source_chat_id is distinct from p_source_chat or receipt.project_id is distinct from p_project then raise exception 'Handoff identity conflict'; end if;
  return task;
 end if;
 if existed then raise exception 'Existing task was not created with this handoff'; end if;
 if (task->>'status')<>'draft' or exists(select 1 from chat_task_progress where chat_id=(task->>'chat_id')::uuid) then raise exception 'Task already has context'; end if;
 select progress.state into source from chat_task_progress progress join chats c on c.id=progress.chat_id and c.actor_id=progress.actor_id
 where progress.actor_id=p_source_actor and progress.chat_id=p_source_chat for share of progress,c;
 if source is null or source->>'version' is distinct from '1' or nullif(source->>'projectClarification','') is not null or source->'projectContext'->>'userMessageId' is distinct from p_project then raise exception 'Explicit source project is unavailable or ambiguous'; end if;
 if jsonb_typeof(source->'answered') is distinct from 'array' or jsonb_typeof(source->'pending') is distinct from 'array' then raise exception 'Invalid source progress'; end if;
 select nullif(item->>'sourceChatId','')::uuid into original_chat from jsonb_array_elements(coalesce(source->'projects','[]'::jsonb)) item where item->'projectContext'->>'userMessageId'=p_project limit 1;
 original_chat:=coalesce(original_chat,p_source_chat);
 select exists(select 1 from chats where id=original_chat and actor_id=p_source_actor) into original_owned;
 inherited:='[]'::jsonb;
 if not original_owned then
  select source_messages into inherited from agent_task_context_handoffs where target_actor_id=p_source_actor and target_chat_id=p_source_chat and project_id=p_project and source_chat_id=original_chat;
  if inherited is null then raise exception 'Original project source does not belong to the source actor or an explicit handoff'; end if;
 end if;
 project:=jsonb_build_object('sourceChatId',p_source_chat,'updatedAt',now(),'projectContext',source->'projectContext','objective',source->'objective','pending',source->'pending','answered',source->'answered','workProduct',source->'workProduct');
 frozen:=(source-'projectClarification'-'projects')||jsonb_build_object('projects',jsonb_build_array(project));
 -- Only active-ledger source IDs are transferable; never copy an entire foreign chat.
 with required_ids(id) as (
  select source->'projectContext'->>'userMessageId' union select source->'objective'->>'userMessageId' union select source->>'lastAssistantMessageId'
  union select source->'workProduct'->>'assistantMessageId' where source->'workProduct'->>'projectId'=p_project
  union select source->'workProduct'->'request'->>'userMessageId' where source->'workProduct'->>'projectId'=p_project
  union select q->>'userMessageId' from jsonb_array_elements(coalesce(source->'workProduct'->'requestSources','[]'::jsonb)) q where source->'workProduct'->>'projectId'=p_project
  union select q->>'assistantMessageId' from jsonb_array_elements(source->'pending') q
  union select q->>'assistantMessageId' from jsonb_array_elements(source->'answered') q
  union select q->>'userMessageId' from jsonb_array_elements(source->'answered') q
 ), candidates(item,priority) as (
  select jsonb_build_object('id',m.id,'role',m.role,'content',m.content,'createdAt',m.created_at,'chatId',m.chat_id),0
  from messages m where (m.chat_id=p_source_chat or (original_owned and m.chat_id=original_chat)) and m.actor_id=p_source_actor and m.id::text in (select id from required_ids)
  union all
  select item,1 from jsonb_array_elements(inherited) item where item->>'id' in (select id from required_ids)
 ), selected as (select distinct on (item->>'id') item from candidates order by item->>'id',priority)
 select coalesce(jsonb_agg(item order by item->>'createdAt',item->>'id'),'[]'::jsonb) into evidence from selected;
 insert into agent_task_context_handoffs(task_id,target_actor_id,target_chat_id,source_actor_id,source_chat_id,project_id,state,source_messages) values(p_id,(task->>'actor_id')::uuid,(task->>'chat_id')::uuid,p_source_actor,p_source_chat,p_project,frozen,evidence);
 insert into chat_task_progress(actor_id,chat_id,state) values((task->>'actor_id')::uuid,(task->>'chat_id')::uuid,frozen);
 return task;
end $$;

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
