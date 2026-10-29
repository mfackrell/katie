-- Additive only; production writer: scripts/run-migrations.mjs.
begin;
create table public.standalone_pricing_current(
 singleton boolean primary key default true check(singleton),
 version text not null references standalone_pricing_versions(version),retrieved_at timestamptz not null default now()
);
create table public.standalone_pricing_intake_events(
 id uuid primary key default gen_random_uuid(),version text not null references standalone_pricing_versions(version),
 retrieved_at timestamptz not null default now(),source_hash text not null,rejected jsonb not null
);
alter table standalone_pricing_current enable row level security;
alter table standalone_pricing_intake_events enable row level security;
revoke all on standalone_pricing_current,standalone_pricing_intake_events from public,anon,authenticated,service_role;
create function public.standalone_publish_pricing(p_version text,p_metadata jsonb,p_source_hash text,p_rejected jsonb) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_version not like 'standalone-catalog-v1-%' or p_metadata->>'version' is distinct from p_version
 or p_metadata->>'currency' is distinct from 'USD' or p_metadata->>'rateUnit' is distinct from 'nanoUSD/token'
 or jsonb_typeof(p_metadata->'models') is distinct from 'array' or jsonb_array_length(p_metadata->'models')=0
 or p_source_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_rejected) is distinct from 'object'
 then raise exception 'STANDALONE_PRICING_INVALID';end if;
 perform standalone_register_pricing(p_version,p_metadata);
 insert into standalone_pricing_intake_events(version,source_hash,rejected) values(p_version,p_source_hash,p_rejected);
 insert into standalone_pricing_current(singleton,version) values(true,p_version)
 on conflict(singleton) do update set version=excluded.version,retrieved_at=now();
 return true;
end $$;
create function public.standalone_load_pricing(p_version text default null) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('snapshot',v.metadata,'retrievedAt',coalesce(c.retrieved_at,v.created_at))
 from standalone_pricing_versions v left join standalone_pricing_current c on c.version=v.version
 where v.version=coalesce(p_version,(select version from standalone_pricing_current where singleton))
$$;
create function public.standalone_create_conversation(p_owner uuid,p_actor uuid,p_chat uuid,p_title text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c chats;
begin
 if p_owner is null or p_chat is null or length(trim(p_title)) not between 1 and 1000 then raise exception 'STANDALONE_SCOPE_INVALID';end if;
 -- Creation IDs are idempotent, but can never claim or overwrite an existing
 -- unbound/foreign conversation, even under concurrent requests.
 perform pg_advisory_xact_lock(hashtextextended(p_chat::text,0));
 perform 1 from actors a where a.id=p_actor and coalesce(a.actor_kind,'standard')='standard'
 and not exists(select 1 from managed_agents m where m.actor_id=a.id) for key share of a;
 if not found then raise exception 'STANDALONE_SCOPE_INVALID';end if;
 select * into c from chats where id=p_chat;
 if found then
  if c.actor_id is distinct from p_actor or not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
  return to_jsonb(c);
 end if;
 if exists(select 1 from standalone_owner_bindings where chat_id=p_chat) then raise exception 'STANDALONE_SCOPE_REVOKED';end if;
 insert into chats(id,actor_id,title) values(p_chat,p_actor,trim(p_title)) returning * into c;
 perform standalone_bind_scope(p_owner,p_actor,p_chat);
 insert into short_term_memory(actor_id,chat_id,content) values(p_actor,p_chat,'{}'::jsonb) on conflict(actor_id,chat_id) do nothing;
 insert into intermediate_memory(actor_id,chat_id,content) values(p_actor,p_chat,'{}'::jsonb) on conflict(actor_id,chat_id) do nothing;
 return to_jsonb(c);
end $$;
create function public.standalone_reprice_attempt(p_owner uuid,p_attempt uuid,p_pricing text,p_estimate jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;r standalone_provider_attempts;k text;amount numeric;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state not in('paused','reserved') or not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then raise exception 'STANDALONE_REVISION_DENIED';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (actual_microusd>reserved_microusd or cancelled_by_owner_at is not null or state='uncertain')) then raise exception 'STANDALONE_REQUEST_STOPPED';end if;
 if p_pricing is distinct from (select version from standalone_pricing_current where singleton) then raise exception 'STANDALONE_PRICING_CHANGED';end if;
 if p_estimate->>'status' is distinct from 'estimated' or p_estimate->>'requestHash' is distinct from a.prepared_hash
 or p_estimate->>'pricingVersion' is distinct from p_pricing or coalesce(p_estimate->>'estimatorVersion','')=''
 or coalesce(p_estimate->>'reservationMicrousd','') !~ '^[0-9]+$' then raise exception 'STANDALONE_ESTIMATE_BINDING_INVALID';end if;
 amount:=(p_estimate->>'reservationMicrousd')::numeric;
 k:=a.base_attempt_key||':repricing:'||(select count(*) from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and base_attempt_key=a.base_attempt_key)::text;
 insert into standalone_provider_attempts(owner_id,actor_id,chat_id,request_id,attempt_key,prepared_hash,prepared_payload,
 source_prepared_hash,base_attempt_key,supersedes_attempt_id,tradeoffs,pricing_version,provider,model,category,state,reserved_microusd,budget_revision,pause_reason,preflight_estimate,estimator_version,reason)
 values(p_owner,a.actor_id,a.chat_id,a.request_id,k,a.prepared_hash,a.prepared_payload,a.source_prepared_hash,a.base_attempt_key,a.id,
 'Catalog pricing changed before dispatch. Review the new quote; the request content is unchanged.',p_pricing,a.provider,a.model,a.category,
 'paused',amount,c.budget_revision,'pricing_updated',p_estimate,p_estimate->>'estimatorVersion',a.reason) returning * into r;
 update standalone_provider_attempts set state='cancelled',pause_reason='superseded_by_repricing' where id=a.id;
 return standalone_attempt_json(r);
end $$;
revoke all on function standalone_reprice_attempt(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function standalone_reprice_attempt(uuid,uuid,text,jsonb) to service_role;
create or replace function public.standalone_claim_dispatch(p_owner uuid,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;v_pause_reason text;exposure numeric;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state<>'reserved' then return null;end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (cancelled_by_owner_at is not null or state='uncertain')) then return null;end if;
 if not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
 -- Serialize activation with dispatch and compare the exact applicable model row.
 perform 1 from standalone_pricing_current where singleton for share;
 if exists(select 1 from standalone_pricing_current where singleton and retrieved_at<now()-interval '24 hours') then raise exception 'STANDALONE_PRICING_UNAVAILABLE';end if;
 if exists(select 1 from standalone_pricing_current where singleton) and
 (select m from standalone_pricing_versions v,jsonb_array_elements(v.metadata->'models') m where v.version=a.pricing_version and m->>'provider'=a.provider and m->>'model'=a.model)
 is distinct from
 (select m from standalone_pricing_current pc join standalone_pricing_versions v on v.version=pc.version,jsonb_array_elements(v.metadata->'models') m where pc.singleton and m->>'provider'=a.provider and m->>'model'=a.model)
 then raise exception 'STANDALONE_PRICING_CHANGED';end if;
 exposure:=standalone_request_committed(p_owner,a.request_id);
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and actual_microusd>reserved_microusd) then v_pause_reason:='request_overrun';
 elsif c.budget_revision is distinct from a.budget_revision or c.per_call_limit_microusd is null or c.request_limit_microusd is null then v_pause_reason:='configuration_changed';
 elsif a.approved_at is null and a.reserved_microusd>c.per_call_limit_microusd then v_pause_reason:='per_call_threshold';
 elsif a.approved_at is null and exposure>c.request_limit_microusd then v_pause_reason:='request_threshold';
 elsif a.approved_at is not null and exposure>a.approved_request_microusd then v_pause_reason:='request_exposure_changed';end if;
 if v_pause_reason is not null then
 update standalone_provider_attempts set state='paused',pause_reason=v_pause_reason,budget_revision=c.budget_revision,
 approved_at=null,approved_hash=null,approved_pricing_version=null,approved_revision=null,approved_microusd=null,approved_request_microusd=null where id=a.id;
 return null;end if;
 if a.approved_at is not null and (a.approved_hash<>a.prepared_hash or a.approved_pricing_version<>a.pricing_version
 or a.approved_revision<>a.budget_revision or a.approved_microusd<>a.reserved_microusd) then raise exception 'STANDALONE_APPROVAL_STALE';end if;
 update standalone_provider_attempts set state='dispatched',dispatched_at=now() where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;
revoke all on function standalone_publish_pricing(text,jsonb,text,jsonb),standalone_load_pricing(text),standalone_create_conversation(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function standalone_publish_pricing(text,jsonb,text,jsonb),standalone_load_pricing(text),standalone_create_conversation(uuid,uuid,uuid,text) to service_role;
commit;
