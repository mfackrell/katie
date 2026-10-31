-- Qwen cron must not read protected accounting tables through PostgREST.
-- Preserve the RPC-only ledger boundary established by the original migration.
-- Both entry points are read-only, bounded, and callable solely with the
-- server-held service_role credential. Never grant direct table access.
create or replace function public.standalone_recoverable_qwen_jobs()
returns table (
  owner_id uuid, actor_id uuid, chat_id uuid, request_id text,
  provider_request_id text, state text
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select a.owner_id,a.actor_id,a.chat_id,a.request_id,a.provider_request_id,a.state
  from public.standalone_provider_attempts a
  join public.standalone_workflows w
    on w.owner_id=a.owner_id and w.actor_id=a.actor_id
   and w.chat_id=a.chat_id and w.request_id=a.request_id
  where a.provider='runpod'
    and a.model='Qwen/Qwen3-VL-8B-Instruct'
    and a.pricing_version='standalone-runpod-qwen-still-v2'
    and a.state='dispatched' and a.response_checkpoint is null
    and a.cancelled_by_owner_at is null
    and a.provider_request_id ~ '^[A-Za-z0-9-]{8,150}$'
    and w.status='paused'
    and w.error like '%standalone_runpod_in_progress%'
    and public.standalone_verify_scope(a.owner_id,a.actor_id,a.chat_id)
  order by a.created_at desc
  limit 12
$$;

create or replace function public.standalone_verified_cron_qwen_owner(
  p_actor uuid, p_chat uuid, p_request text
)
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select a.owner_id
  from public.standalone_provider_attempts a
  join public.standalone_workflows w
    on w.owner_id=a.owner_id and w.actor_id=a.actor_id
   and w.chat_id=a.chat_id and w.request_id=a.request_id
  where a.actor_id=p_actor and a.chat_id=p_chat and a.request_id=p_request
    and a.provider='runpod'
    and a.model='Qwen/Qwen3-VL-8B-Instruct'
    and a.pricing_version='standalone-runpod-qwen-still-v2'
    and a.state='dispatched' and a.response_checkpoint is null
    and a.cancelled_by_owner_at is null
    and a.provider_request_id ~ '^[A-Za-z0-9-]{8,150}$'
    and w.status='paused'
    and w.error like '%standalone_runpod_in_progress%'
    and public.standalone_verify_scope(a.owner_id,a.actor_id,a.chat_id)
  order by a.created_at desc
  limit 1
$$;

revoke all on function public.standalone_recoverable_qwen_jobs()
  from public, anon, authenticated, service_role;
revoke all on function public.standalone_verified_cron_qwen_owner(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.standalone_recoverable_qwen_jobs()
  to service_role;
grant execute on function public.standalone_verified_cron_qwen_owner(uuid,uuid,text)
  to service_role;
