-- Atomic intermediate-memory checkpoint, scoped to the authenticated server's service role.
create or replace function public.commit_intermediate_memory_checkpoint(
  p_actor_id uuid,
  p_chat_id uuid,
  p_expected_cursor text,
  p_content jsonb
) returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  v_cursor text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_chat_id::text, 0));
  insert into public.intermediate_memory (actor_id, chat_id, content)
    values (p_actor_id, p_chat_id, '{}'::jsonb)
    on conflict (actor_id, chat_id) do nothing;
  select content->>'summarizedThroughMessageId' into v_cursor
  from public.intermediate_memory
  where actor_id = p_actor_id and chat_id = p_chat_id
  for update;
  if v_cursor is distinct from p_expected_cursor then
    return false;
  end if;
  update public.intermediate_memory
  set content = p_content, updated_at = now()
  where actor_id = p_actor_id and chat_id = p_chat_id;
  return true;
end;
$$;
revoke all on function public.commit_intermediate_memory_checkpoint(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.commit_intermediate_memory_checkpoint(uuid, uuid, text, jsonb) to service_role;
