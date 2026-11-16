-- Internal ITM response evidence for no-cost replay of an already-paid stage.
-- Never store provider API keys, prompts or complete conversation transcripts here.
-- Only source-bound structured output; no cross-user/Data API access.
create table if not exists public.itm_stage_receipts (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  chat_id uuid not null,
  batch_end_message_id text not null,
  expected_cursor text,
  provider text not null check (provider in ('grok','anthropic')),
  stage text not null check (stage in ('episodes','retention')),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  context_sha256 text not null check (context_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check (response_sha256 ~ '^[0-9a-f]{64}$'),
  response_text text not null check (length(response_text) between 1 and 16000),
  processor_version text not null,
  created_at timestamptz not null default now(),
  unique (actor_id,chat_id,batch_end_message_id,provider,stage,source_sha256,context_sha256)
);
create index if not exists itm_stage_receipts_batch_idx
  on public.itm_stage_receipts(actor_id,chat_id,batch_end_message_id,created_at desc);
alter table public.itm_stage_receipts enable row level security;
revoke all on public.itm_stage_receipts from public,anon,authenticated;
revoke update,delete,truncate on public.itm_stage_receipts from service_role;
grant select,insert on public.itm_stage_receipts to service_role;

-- Enforce the authenticated actor/chat identity already established by Katie.
-- Only the service-role backend may call this insert path; it must still match.
create or replace function public.assert_itm_stage_receipt_owner()
returns trigger language plpgsql set search_path=public,pg_temp as $
begin
  if not exists(select 1 from public.chats c where c.id=new.chat_id and c.actor_id=new.actor_id) then
    raise exception 'ITM_STAGE_RECEIPT_ACTOR_CHAT_MISMATCH';
  end if;
  return new;
end;
$;
revoke all on function public.assert_itm_stage_receipt_owner() from public,anon,authenticated;
drop trigger if exists itm_stage_receipt_owner_check on public.itm_stage_receipts;
create trigger itm_stage_receipt_owner_check
before insert on public.itm_stage_receipts
for each row execute function public.assert_itm_stage_receipt_owner();

-- Even administrative code cannot silently rewrite historical stage evidence.
create or replace function public.reject_itm_stage_receipt_mutation()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  raise exception 'ITM_STAGE_RECEIPT_IMMUTABLE';
end;
$$;
revoke all on function public.reject_itm_stage_receipt_mutation() from public,anon,authenticated;
drop trigger if exists itm_stage_receipt_immutable on public.itm_stage_receipts;
create trigger itm_stage_receipt_immutable
before update or delete on public.itm_stage_receipts
for each row execute function public.reject_itm_stage_receipt_mutation();

-- Read a previously settled, source-bound legacy response for offline
-- validation/import. This is a read-only service-role operation; no provider
-- transport, accounting admission, or history mutation occurs here.
create or replace function public.itm_read_legacy_episode_output(
  p_actor_id uuid,p_chat_id uuid,p_batch_end_message_id text,p_provider text
) returns jsonb
language sql stable security invoker set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'response_text',((a.response_checkpoint->>'body')::jsonb->'choices'->0->'message'->>'content'),
    'ledger_attempt_id',a.id::text
  )
  from public.standalone_provider_attempts a
  where a.actor_id=p_actor_id and a.chat_id=p_chat_id
    and exists(select 1 from public.chats c where c.id=p_chat_id and c.actor_id=p_actor_id)
    and p_provider in ('grok','anthropic') and a.provider=p_provider
    and a.category='memory-summary'
    and a.state='settled' and a.response_checkpoint->>'status'='200'
    and a.response_checkpoint->>'body' is not null
    and strpos(coalesce(a.prepared_payload->>'serializedBody',''),
      '['||p_batch_end_message_id||']')>0
  order by a.created_at desc
  limit 1
$$;
revoke all on function public.itm_read_legacy_episode_output(uuid,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.itm_read_legacy_episode_output(uuid,uuid,text,text)
  to service_role;
