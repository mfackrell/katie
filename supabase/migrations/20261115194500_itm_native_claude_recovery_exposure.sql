-- ITM v12 recovery inspection. Read-only, actor-scoped and restricted to the
-- server's service role. Prior failed/uncertain provider attempts are NOT reset.
-- This function returns only flags; source transcripts remain in PostgreSQL.
create or replace function public.inspect_itm_batch_provider_exposure(
  p_actor_id uuid, p_chat_id uuid, p_batch_end_message_id text
) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_grok_sent boolean := false;
  v_anthropic_sent boolean := false;
  v_paused boolean := false;
  v_in_flight boolean := false;
  v_terminal boolean := false;
begin
  if not exists (
    select 1 from public.chats c
    where c.id = p_chat_id and c.actor_id = p_actor_id
  ) then
    raise exception 'Unrecognized actor/chat for ITM recovery inspection';
  end if;
  if p_batch_end_message_id is null or length(p_batch_end_message_id) < 2
     or length(p_batch_end_message_id) > 128 then
    raise exception 'Invalid ITM batch source identifier';
  end if;

  -- The exact source-end message appears in the frozen paid request payload
  -- as [message-id]. This safely ties old provider receipts to the batch,
  -- including older processor versions which used a different claim identity.
  select
    coalesce(bool_or(a.provider = 'grok'
      and a.state in ('dispatched','uncertain','settled')), false),
    coalesce(bool_or(a.provider = 'anthropic'
      and a.state in ('dispatched','uncertain','settled')), false),
    coalesce(bool_or(a.state in ('paused','reserved')), false)
  into v_grok_sent,v_anthropic_sent,v_paused
  from public.standalone_provider_attempts a
  where a.actor_id = p_actor_id and a.chat_id = p_chat_id
    and a.category = 'memory-summary'
    and strpos(coalesce(a.prepared_payload->>'serializedBody',''),
      '[' || p_batch_end_message_id || ']') > 0;

  -- Refuse to re-admit a batch while a recent request may still be executing,
  -- including under a previous processor version. 90s is the provider budget;
  -- ten minutes gives settlement and transient host shutdown ample headroom.
  select exists(
    select 1 from public.intermediate_memory_batch_attempts b
    where b.actor_id = p_actor_id and b.chat_id = p_chat_id
      and b.batch_end_message_id = p_batch_end_message_id
      and b.state = 'processing'
      and b.claimed_at > now() - interval '10 minutes'
  ) into v_in_flight;

  -- Only the current v12 processor's explicit terminal classifications
  -- fence cross-provider fallback. Older v11 endpoint defects are not
  -- mistaken for permanent v12 policy denials.
  select exists(
    select 1 from public.intermediate_memory_batch_attempts b
    where b.actor_id=p_actor_id and b.chat_id=p_chat_id
      and b.batch_end_message_id=p_batch_end_message_id
      and b.state='blocked'
      and b.processor_version like 'two-stage-30-messages-v12-claude-native-failclosed-recovery:%'
      and b.error_code like 'ITM_TERMINAL:%'
  ) into v_terminal;

  return jsonb_build_object(
    'grok_sent',v_grok_sent, 'anthropic_sent',v_anthropic_sent,
    'paused',v_paused, 'in_flight',v_in_flight, 'terminal',v_terminal
  );
end;
$$;
revoke all on function public.inspect_itm_batch_provider_exposure(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.inspect_itm_batch_provider_exposure(uuid,uuid,text)
  to service_role;
