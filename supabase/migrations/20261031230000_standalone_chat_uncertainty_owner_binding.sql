-- Ordinary chat exposure acknowledgement is authorized by its exact, active
-- standalone owner binding. Self-tool execution grants are unrelated privileges.
-- Preserve grant-bound historical acknowledgements without rewriting them.
begin;

alter table public.standalone_uncertain_exposure_authorizations
  alter column grant_chat_id drop not null,
  alter column grant_created_at drop not null;

alter table public.standalone_uncertain_exposure_authorizations
  add constraint standalone_exposure_grant_pair_check
  check ((grant_chat_id is null) = (grant_created_at is null));

-- NULL grant fields identify owner-binding acknowledgements. The old unique
-- constraint still protects historical grant-bound records; this partial index
-- protects idempotency for new records despite PostgreSQL NULL semantics.
create unique index standalone_exposure_owner_binding_unique
on public.standalone_uncertain_exposure_authorizations(
  attempt_id,budget_revision,reserved_microusd,prepared_hash,
  pricing_version,binding_created_at
)
where grant_chat_id is null;

create or replace function public.standalone_uncertain_exposure_accepted(
  p_owner uuid,p_attempt uuid
) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(
    select 1
    from standalone_uncertain_exposure_authorizations u
    join standalone_provider_attempts a
      on a.id=u.attempt_id and a.owner_id=u.owner_id
    join standalone_owner_configuration c
      on c.owner_id=u.owner_id and c.budget_revision=u.budget_revision
    join standalone_owner_bindings b
      on b.owner_id=u.owner_id and b.actor_id=u.actor_id
      and b.chat_id=u.chat_id and b.created_at=u.binding_created_at
      and b.revoked_at is null
    left join self_tool_owner_grants g
      on g.owner_id=u.owner_id and g.actor_id=u.actor_id
      and g.chat_id=u.grant_chat_id and g.created_at=u.grant_created_at
    left join chats access_chat
      on access_chat.id=g.chat_id and access_chat.actor_id=g.actor_id
    where u.owner_id=p_owner and u.attempt_id=p_attempt
      and a.state='uncertain' and a.request_id=u.request_id
      and a.actor_id=u.actor_id and a.chat_id=u.chat_id
      and a.reserved_microusd=u.reserved_microusd
      and a.prepared_hash=u.prepared_hash
      and a.pricing_version=u.pricing_version
      and a.provider=u.provider and a.model=u.model
      and a.cancelled_by_owner_at is null
      and standalone_verify_scope(p_owner,a.actor_id,a.chat_id)
      -- Legacy grant-bound authorizations must retain their original grant.
      -- New normal-chat authorizations require no privileged self-tool grant.
      and (u.grant_chat_id is null or access_chat.id is not null)
  )
$$;

create or replace function public.standalone_accept_uncertain_exposure(
  p_owner uuid,p_attempt uuid,p_revision bigint,p_reserved numeric
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  c standalone_owner_configuration;
  a standalone_provider_attempts;
  b standalone_owner_bindings;
  u standalone_uncertain_exposure_authorizations;
begin
  select * into c from standalone_owner_configuration
    where owner_id=p_owner for update;
  select * into a from standalone_provider_attempts
    where id=p_attempt and owner_id=p_owner for update;
  if not found or a.state<>'uncertain'
    or not standalone_verify_scope(p_owner,a.actor_id,a.chat_id)
  then raise exception 'STANDALONE_EXPOSURE_ACCEPTANCE_DENIED'; end if;
  if c.budget_revision is distinct from p_revision
    or a.reserved_microusd is distinct from p_reserved
    or c.per_call_limit_microusd is null
    or c.request_limit_microusd is null
  then raise exception 'STANDALONE_EXPOSURE_ACCEPTANCE_STALE'; end if;
  if exists(
    select 1 from standalone_provider_attempts
    where owner_id=p_owner and request_id=a.request_id
      and (actual_microusd>reserved_microusd
        or cancelled_by_owner_at is not null)
  ) then raise exception 'STANDALONE_REQUEST_STOPPED'; end if;
  perform 1 from standalone_workflows
    where owner_id=p_owner and request_id=a.request_id
      and actor_id=a.actor_id and chat_id=a.chat_id;
  if not found
  then raise exception 'STANDALONE_EXPOSURE_WORKFLOW_UNAVAILABLE'; end if;
  select * into b from standalone_owner_bindings
    where owner_id=p_owner and actor_id=a.actor_id
      and chat_id=a.chat_id and revoked_at is null
    for key share;
  if not found
  then raise exception 'STANDALONE_EXPOSURE_ACCEPTANCE_DENIED'; end if;

  select * into u from standalone_uncertain_exposure_authorizations
    where owner_id=p_owner and attempt_id=a.id
      and request_id=a.request_id and budget_revision=c.budget_revision
      and reserved_microusd=a.reserved_microusd
      and prepared_hash=a.prepared_hash
      and pricing_version=a.pricing_version and provider=a.provider
      and model=a.model and binding_created_at=b.created_at
      and grant_chat_id is null and grant_created_at is null;
  if found
  then return to_jsonb(u) ||
    jsonb_build_object('reserved_microusd',u.reserved_microusd::text);
  end if;
  -- New rows are bound to the exact verified owner/chat/attempt and current
  -- budget revision. Neither retries nor exposure/accounting rows are changed.
  insert into standalone_uncertain_exposure_authorizations(
    attempt_id,owner_id,request_id,actor_id,chat_id,
    reserved_microusd,budget_revision,prepared_hash,
    pricing_version,provider,model,binding_created_at
  ) values(
    a.id,p_owner,a.request_id,a.actor_id,a.chat_id,
    a.reserved_microusd,c.budget_revision,a.prepared_hash,
    a.pricing_version,a.provider,a.model,b.created_at
  ) returning * into u;
  insert into standalone_attempt_events(attempt_id,owner_id,kind,details)
  values(a.id,p_owner,'uncertain_exposure_accepted',
    jsonb_build_object('authorization','verified_owner_binding',
      'request_id',a.request_id,
      'reserved_microusd',a.reserved_microusd::text,
      'budget_revision',c.budget_revision,
      'accepted_at',u.accepted_at));
  return to_jsonb(u) ||
    jsonb_build_object('reserved_microusd',u.reserved_microusd::text);
end $$;

-- Both functions retain existing service_role-only EXECUTE permissions.
-- No changes to self-tool grants, scope binding, dispatch, budgets or RLS.
commit;
