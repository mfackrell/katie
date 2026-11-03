-- Only present the saved same-model cache authorization when its original
-- request remains uncancelled. Owner cancellation is request-wide and must
-- suppress stale recovery banners without erasing historical accounting.
begin;
create or replace function public.standalone_owner_cache_authorization_recovery(
  p_owner uuid,p_actor uuid,p_chat uuid
) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare saved_request text;
begin
  if not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'STANDALONE_SCOPE_DENIED'; end if;
  select w.request_id into saved_request
  from standalone_workflows w
  where w.owner_id=p_owner and w.actor_id=p_actor and w.chat_id=p_chat
    and w.status='paused'
    and coalesce(w.result->>'body','') like '%"type":"accounting_pause"%'
    and coalesce(w.result->>'body','') like '%"code":"standalone_unsupported_billing"%'
    and coalesce(w.result->>'body','') like '%No reviewed no-fee cache metadata policy for this exact model%'
    and not exists (
      select 1 from standalone_provider_attempts a
      where a.owner_id=p_owner and a.request_id=w.request_id and a.state='paused'
    )
    and not exists (
      select 1 from standalone_provider_attempts a
      where a.owner_id=p_owner and a.request_id=w.request_id and a.cancelled_by_owner_at is not null
    )
  order by w.updated_at desc limit 1;
  if saved_request is null then return null; end if;
  return jsonb_build_object('requestId',saved_request);
end $$;
revoke all on function public.standalone_owner_cache_authorization_recovery(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.standalone_owner_cache_authorization_recovery(uuid,uuid,uuid) to service_role;
commit;
