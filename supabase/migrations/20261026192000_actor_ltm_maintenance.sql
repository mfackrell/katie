-- Reversible actor-wide memory consolidation; service-role only.
create table if not exists public.actor_ltm_maintenance_history (
  id bigint generated always as identity primary key,
  actor_id uuid not null,
  previous_revision bigint not null,
  next_revision bigint not null,
  previous_content jsonb not null,
  new_content jsonb not null,
  archived_entries jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.actor_ltm_maintenance_history enable row level security;
revoke all on public.actor_ltm_maintenance_history from public, anon, authenticated;
grant select, insert on public.actor_ltm_maintenance_history to service_role;
grant usage, select on sequence public.actor_ltm_maintenance_history_id_seq to service_role;

create or replace function public.commit_actor_ltm_maintenance(
  p_actor_id uuid,
  p_expected_revision bigint,
  p_expected_content jsonb,
  p_updated_entries jsonb,
  p_archived_entries jsonb
) returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  original public.actor_long_term_memory%rowtype;
  updated jsonb;
begin
  if jsonb_typeof(p_updated_entries) <> 'array'
     or jsonb_typeof(p_archived_entries) <> 'array'
     or jsonb_array_length(p_updated_entries) = 0 then
    raise exception 'Invalid maintenance payload';
  end if;
  select * into original from public.actor_long_term_memory
  where actor_id = p_actor_id for update;
  if not found or original.revision is distinct from p_expected_revision
     or original.content is distinct from p_expected_content then
    return false;
  end if;
  updated := jsonb_set(original.content, '{entries}', p_updated_entries, true);
  insert into public.actor_ltm_maintenance_history (
    actor_id, previous_revision, next_revision, previous_content, new_content, archived_entries
  ) values (
    p_actor_id, original.revision, original.revision+1, original.content, updated, p_archived_entries
  );
  update public.actor_long_term_memory set content=updated,
    revision=original.revision+1, updated_at=now() where actor_id=p_actor_id;
  return true;
end;
$$;
revoke all on function public.commit_actor_ltm_maintenance(uuid,bigint,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.commit_actor_ltm_maintenance(uuid,bigint,jsonb,jsonb,jsonb) to service_role;
