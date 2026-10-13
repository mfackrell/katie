-- Atomic, additive actor-scoped writes for automatic long-term learning.
-- No existing entry is removed merely because an LLM omits it from a response.
create or replace function public.merge_actor_long_term_memory_entries(
  p_actor_id uuid,
  p_entries jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  saved jsonb;
  merged jsonb;
  item jsonb;
  entry_key text;
begin
  if jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'Memory patch must be a JSON array';
  end if;

  insert into public.actor_long_term_memory (actor_id, content)
  values (p_actor_id, '{"version":3,"purpose":"Actor-wide durable memory","entries":[]}'::jsonb)
  on conflict (actor_id) do nothing;

  select content into saved
    from public.actor_long_term_memory
    where actor_id = p_actor_id
    for update;

  merged := case when jsonb_typeof(saved->'entries') = 'array'
    then saved->'entries' else '[]'::jsonb end;

  for item in select value from jsonb_array_elements(p_entries) as patch(value) loop
    entry_key := nullif(btrim(item->>'key'), '');
    if jsonb_typeof(item) is distinct from 'object' or entry_key is null then
      raise exception 'Invalid actor memory patch entry';
    end if;

    select coalesce(jsonb_agg(value), '[]'::jsonb)
      into merged
      from jsonb_array_elements(merged) as current_entry(value)
      where current_entry.value->>'key' is distinct from entry_key;
    merged := merged || jsonb_build_array(item);
  end loop;

  update public.actor_long_term_memory
    set content = (coalesce(saved, '{}'::jsonb)
      || jsonb_build_object('version', 3, 'purpose',
         coalesce(saved->>'purpose', 'Actor-wide durable memory')))
      || jsonb_build_object('entries', merged),
      revision = revision + 1,
      updated_at = now()
    where actor_id = p_actor_id
    returning content into saved;

  return saved;
end;
$$;

revoke all on function public.merge_actor_long_term_memory_entries(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.merge_actor_long_term_memory_entries(uuid, jsonb)
  to service_role;
