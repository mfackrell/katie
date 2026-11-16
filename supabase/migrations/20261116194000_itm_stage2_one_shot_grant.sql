-- Owner-authorized, single-use Stage 2 recovery dispatch for an already-paid Grok Stage 1.
-- This migration grants NO inference by itself. An operator must insert a batch-exact
-- approval row after the app and migration have independently qualified.
create table if not exists public.itm_stage2_one_shot_grants (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  chat_id uuid not null,
  batch_end_message_id text not null,
  expected_cursor text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  context_sha256 text not null check (context_sha256 ~ '^[0-9a-f]{64}$'),
  stage1_response_sha256 text not null check (stage1_response_sha256 ~ '^[0-9a-f]{64}$'),
  provider text not null default 'anthropic' check (provider = 'anthropic'),
  model text not null default 'claude-sonnet-5-5' check (model = 'claude-sonnet-5-5'),
  owner_approval_reference text not null,
  approved_at timestamptz not null default now(),
  dispatched_at timestamptz,
  unique (actor_id,chat_id,batch_end_message_id)
);
create index if not exists itm_stage2_one_shot_grants_dispatched_idx
 on public.itm_stage2_one_shot_grants(actor_id,chat_id,batch_end_message_id,dispatched_at);

alter table public.itm_stage2_one_shot_grants enable row level security;
revoke all on public.itm_stage2_one_shot_grants from public,anon,authenticated,service_role;
grant select on public.itm_stage2_one_shot_grants to service_role;

-- A claim is deliberately consumed BEFORE contacting the provider. Even an
-- unknown HTTP outcome cannot cause a second dispatch from another runtime.
-- There is no reset/renew/retry operation. Only the exact source, Stage 1
-- evidence, Stage 2 prior-summary context, and checkpoint can consume it.
create or replace function public.claim_itm_stage2_one_shot(
  p_actor_id uuid,
  p_chat_id uuid,
  p_batch_end_message_id text,
  p_expected_cursor text,
  p_source_sha256 text,
  p_context_sha256 text,
  p_stage1_response_sha256 text
) returns boolean
language plpgsql security definer
set search_path = public,pg_temp
as $$
declare v_grant_id uuid;
begin
  if not exists (
    select 1 from public.chats c where c.id = p_chat_id and c.actor_id = p_actor_id
  ) then raise exception 'ITM_STAGE2_ACTOR_CHAT_MISMATCH'; end if;

  update public.itm_stage2_one_shot_grants g
     set dispatched_at = clock_timestamp()
   where g.actor_id = p_actor_id
     and g.chat_id = p_chat_id
     and g.batch_end_message_id = p_batch_end_message_id
     and g.expected_cursor = p_expected_cursor
     and g.source_sha256 = p_source_sha256
     and g.context_sha256 = p_context_sha256
     and g.stage1_response_sha256 = p_stage1_response_sha256
     and g.provider = 'anthropic'
     and g.model = 'claude-sonnet-5-5'
     and g.dispatched_at is null
     and exists (
       select 1 from public.intermediate_memory m
        where m.actor_id = p_actor_id and m.chat_id = p_chat_id
          and m.content->>'summarizedThroughMessageId' = p_expected_cursor
     )
     and exists (
       select 1 from public.itm_stage_receipts r
        where r.actor_id = p_actor_id and r.chat_id = p_chat_id
          and r.batch_end_message_id = p_batch_end_message_id
          and r.expected_cursor = p_expected_cursor
          and r.provider = 'grok' and r.stage = 'episodes'
          and r.source_sha256 = p_source_sha256
          and r.response_sha256 = p_stage1_response_sha256
     )
   returning g.id into v_grant_id;
  return v_grant_id is not null;
end
$$;
revoke all on function public.claim_itm_stage2_one_shot(uuid,uuid,text,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.claim_itm_stage2_one_shot(uuid,uuid,text,text,text,text,text)
  to service_role;

-- Approvals cannot be silently rewritten or erased after an attempt;
-- the claim RPC is the only permitted state transition.
create or replace function public.reject_itm_stage2_grant_mutation()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'ITM_STAGE2_GRANT_IMMUTABLE'; end if;
  if old.dispatched_at is not null or new.dispatched_at is null
     or row(old.id,old.actor_id,old.chat_id,old.batch_end_message_id,old.expected_cursor,
            old.source_sha256,old.context_sha256,old.stage1_response_sha256,
            old.provider,old.model,old.owner_approval_reference,old.approved_at)
       is distinct from
       row(new.id,new.actor_id,new.chat_id,new.batch_end_message_id,new.expected_cursor,
           new.source_sha256,new.context_sha256,new.stage1_response_sha256,
           new.provider,new.model,new.owner_approval_reference,new.approved_at)
  then raise exception 'ITM_STAGE2_GRANT_IMMUTABLE'; end if;
  return new;
end
$$;
revoke all on function public.reject_itm_stage2_grant_mutation() from public,anon,authenticated;
drop trigger if exists itm_stage2_grant_immutable on public.itm_stage2_one_shot_grants;
create trigger itm_stage2_grant_immutable
before update or delete on public.itm_stage2_one_shot_grants
for each row execute function public.reject_itm_stage2_grant_mutation();
