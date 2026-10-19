-- Atomically clear only the target actor's long-term semantic memory and source documents.
-- Chat transcripts, short/intermediate memory and other actors remain untouched.
create or replace function public.clear_actor_long_term_memory(p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entries integer;
  v_documents integer;
  v_legacy integer;
  v_visual integer;
begin
  if not exists (select 1 from public.actors where id = p_actor_id) then
    raise exception 'actor not found';
  end if;
  perform 1 from public.actors where id = p_actor_id for update;
  select coalesce(jsonb_array_length(case when jsonb_typeof(content->'entries') = 'array'
    then content->'entries' else '[]'::jsonb end), 0)
    into v_entries from public.actor_long_term_memory where actor_id = p_actor_id;
  select count(*) into v_documents from public.actor_memory_documents where actor_id = p_actor_id;
  select count(*) into v_legacy from public.long_term_memory where actor_id = p_actor_id;
  select count(*) into v_visual from public.visual_references where actor_id = p_actor_id;
  delete from public.actor_memory_documents where actor_id = p_actor_id;
  delete from public.long_term_memory where actor_id = p_actor_id;
  delete from public.visual_references where actor_id = p_actor_id;
  insert into public.actor_long_term_memory(actor_id,content,updated_at)
    values (p_actor_id, '{"version":3,"purpose":"Actor-wide durable memory","entries":[]}'::jsonb, now())
    on conflict(actor_id) do update set content=excluded.content,updated_at=excluded.updated_at;
  if exists(select 1 from public.actor_memory_documents where actor_id=p_actor_id)
    or exists(select 1 from public.long_term_memory where actor_id=p_actor_id)
    or exists(select 1 from public.visual_references where actor_id=p_actor_id)
    or exists(select 1 from public.actor_long_term_memory where actor_id=p_actor_id
      and jsonb_array_length(content->'entries') <> 0) then
    raise exception 'memory clear verification failed';
  end if;
  return jsonb_build_object('entries_removed',coalesce(v_entries,0),'documents_removed',v_documents,'legacy_rows_removed',v_legacy,'visual_references_removed',v_visual);
end;
$$;
revoke all on function public.clear_actor_long_term_memory(uuid) from public, anon, authenticated;
grant execute on function public.clear_actor_long_term_memory(uuid) to service_role;
