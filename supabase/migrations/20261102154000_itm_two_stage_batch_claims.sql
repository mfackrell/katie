-- A durable actor/chat-scoped, fail-closed circuit breaker for two-stage ITM.
-- All operations use the existing service role and the same advisory-lock key
-- as commit_intermediate_memory_checkpoint. No source messages are changed.
create table if not exists public.intermediate_memory_batch_attempts (
  actor_id uuid not null,
  chat_id uuid not null,
  batch_end_message_id text not null,
  processor_version text not null,
  expected_cursor text,
  state text not null check (state in ('processing', 'blocked', 'completed')),
  error_code text,
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (actor_id, chat_id, batch_end_message_id, processor_version)
);
alter table public.intermediate_memory_batch_attempts enable row level security;
revoke all on public.intermediate_memory_batch_attempts from public, anon, authenticated;
grant select, insert, update on public.intermediate_memory_batch_attempts to service_role;

-- A claim is recorded BEFORE any paid provider call. Two concurrent requests
-- may not pay for the same batch. A previously failed/in-flight batch cannot
-- automatically retry; an explicit, reviewed recovery changes the processor
-- version or restores the saved claim after resolving the cause.
create or replace function public.claim_intermediate_memory_batch(
  p_actor_id uuid,
  p_chat_id uuid,
  p_expected_cursor text,
  p_batch_end_message_id text,
  p_processor_version text
) returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_cursor text;
  v_state text;
begin
  if not exists (
    select 1 from public.chats
    where id = p_chat_id and actor_id = p_actor_id
  ) then
    raise exception 'Unrecognized actor/chat for intermediate memory batch';
  end if;
  if length(p_batch_end_message_id) < 2 or length(p_processor_version) < 5 then
    raise exception 'Invalid intermediate memory batch identity';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_chat_id::text, 0));
  select content->>'summarizedThroughMessageId'
    into v_cursor from public.intermediate_memory
   where actor_id = p_actor_id and chat_id = p_chat_id
   for update;

  if v_cursor is distinct from p_expected_cursor then return 'stale'; end if;

  insert into public.intermediate_memory_batch_attempts
    (actor_id,chat_id,batch_end_message_id,processor_version,expected_cursor,state)
  values (p_actor_id,p_chat_id,p_batch_end_message_id,p_processor_version,p_expected_cursor,'processing')
  on conflict do nothing;
  if found then return 'claimed'; end if;

  select state into v_state from public.intermediate_memory_batch_attempts
   where actor_id = p_actor_id and chat_id = p_chat_id
     and batch_end_message_id = p_batch_end_message_id
     and processor_version = p_processor_version;

  return case when v_state = 'processing' then 'processing' else 'blocked' end;
end;
$$;
revoke all on function public.claim_intermediate_memory_batch(uuid,uuid,text,text,text)
  from public, anon, authenticated;
grant execute on function public.claim_intermediate_memory_batch(uuid,uuid,text,text,text)
  to service_role;

-- Record outcome without changing the durable ITM cursor or its timestamp.
-- A failure cannot be re-admitted under the same batch identity/version.
create or replace function public.finish_intermediate_memory_batch(
  p_actor_id uuid,
  p_chat_id uuid,
  p_batch_end_message_id text,
  p_processor_version text,
  p_state text,
  p_reason text
) returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if p_state not in ('blocked','completed') then
    raise exception 'Invalid ITM batch state';
  end if;
  update public.intermediate_memory_batch_attempts
     set state = p_state,
         error_code = case when p_state = 'blocked' then left(coalesce(p_reason,'unknown'),160) else null end,
         finished_at = now()
   where actor_id = p_actor_id
     and chat_id = p_chat_id
     and batch_end_message_id = p_batch_end_message_id
     and processor_version = p_processor_version
     and state = 'processing';
  return found;
end;
$$;
revoke all on function public.finish_intermediate_memory_batch(uuid,uuid,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.finish_intermediate_memory_batch(uuid,uuid,text,text,text,text)
  to service_role;
