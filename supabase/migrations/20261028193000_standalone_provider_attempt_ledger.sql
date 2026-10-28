-- Proposed only. Production execution belongs exclusively to the repository migration runner.
-- This standalone ledger never reads/writes benchmark or project accounting.
create table public.standalone_owner_configuration (
 owner_id uuid primary key, timezone text not null,
 per_call_limit_microusd numeric(30,0), request_limit_microusd numeric(30,0),
 budget_revision bigint not null default 1,
 check(per_call_limit_microusd is null or per_call_limit_microusd>=0),
 check(request_limit_microusd is null or request_limit_microusd>=0)
);
create table public.standalone_owner_bindings (
 owner_id uuid not null, actor_id uuid not null references public.actors(id),
 chat_id uuid not null references public.chats(id), created_at timestamptz not null default now(),
 primary key(owner_id,actor_id,chat_id), unique(chat_id)
);
create table public.standalone_pricing_versions (
 version text primary key, metadata jsonb not null, created_at timestamptz not null default now()
);
create table public.standalone_provider_attempts (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null,
 actor_id uuid not null, chat_id uuid not null, request_id text not null, attempt_key text not null,
 prepared_hash text not null check(prepared_hash ~ '^[0-9a-f]{64}$'), prepared_payload jsonb not null,
 source_prepared_hash text not null,base_attempt_key text not null,supersedes_attempt_id uuid unique references public.standalone_provider_attempts(id),tradeoffs text,
 pricing_version text not null references public.standalone_pricing_versions(version),
 provider text not null, model text not null, category text not null,
 preflight_estimate jsonb not null,estimator_version text not null,reason text not null,resolved_model text,
 state text not null check(state in('paused','reserved','dispatched','settled','uncertain','cancelled')),
 reserved_microusd numeric(30,0) not null check(reserved_microusd>=0),
 actual_microusd numeric(30,0) check(actual_microusd>=0), budget_revision bigint not null,
 usage jsonb, evidence jsonb, provider_receipt_id text,provider_request_id text,provider_response_id text, response_checkpoint jsonb,
 pause_reason text, uncertainty_reason text,cancelled_by_owner_at timestamptz, approved_at timestamptz,
 approved_hash text, approved_pricing_version text, approved_revision bigint, approved_microusd numeric(30,0),approved_request_microusd numeric(30,0),
 created_at timestamptz not null default now(), dispatched_at timestamptz, settled_at timestamptz,
 foreign key(owner_id,actor_id,chat_id) references public.standalone_owner_bindings(owner_id,actor_id,chat_id),
 unique(owner_id,request_id,attempt_key), unique(owner_id,provider,provider_receipt_id),
 check((state='settled')=(actual_microusd is not null)),
 check((provider_receipt_id is null)=(actual_microusd is null))
);
create table public.standalone_attempt_events (
 id uuid primary key default gen_random_uuid(),attempt_id uuid not null references public.standalone_provider_attempts(id),
 owner_id uuid not null,kind text not null,details jsonb not null,created_at timestamptz not null default now()
);
create index standalone_events_owner_created on public.standalone_attempt_events(owner_id,created_at desc);
create index standalone_attempts_owner_created on public.standalone_provider_attempts(owner_id,created_at desc);
create index standalone_attempts_request on public.standalone_provider_attempts(owner_id,request_id);
create table public.standalone_workflows (
 owner_id uuid not null,request_id text not null,actor_id uuid not null,chat_id uuid not null,
 request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),request_body jsonb not null,
 status text not null check(status in('pending','running','paused','completed','failed')),
 lease_token uuid,lease_expires_at timestamptz,result jsonb,error text,checkpoints jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(owner_id,request_id),
 foreign key(owner_id,actor_id,chat_id) references public.standalone_owner_bindings(owner_id,actor_id,chat_id)
);
-- RLS and no mutation privileges: all state transitions below are atomic service RPCs.
alter table public.standalone_owner_configuration enable row level security;
alter table public.standalone_owner_bindings enable row level security;
alter table public.standalone_pricing_versions enable row level security;
alter table public.standalone_provider_attempts enable row level security;
alter table public.standalone_workflows enable row level security;
alter table public.standalone_attempt_events enable row level security;
revoke all on public.standalone_owner_configuration, public.standalone_owner_bindings,
 public.standalone_pricing_versions,public.standalone_provider_attempts,public.standalone_workflows,public.standalone_attempt_events from public,anon,authenticated,service_role;

create function public.standalone_attempt_json(a public.standalone_provider_attempts) returns jsonb
language sql immutable set search_path=public,pg_temp as $$
 select to_jsonb(a)||jsonb_build_object('reserved_microusd',a.reserved_microusd::text,
 'actual_microusd',a.actual_microusd::text,'approved_microusd',a.approved_microusd::text,'approved_request_microusd',a.approved_request_microusd::text)
$$;
create function public.standalone_configuration_json(c public.standalone_owner_configuration) returns jsonb
language sql immutable set search_path=public,pg_temp as $$
 select to_jsonb(c)||jsonb_build_object('per_call_limit_microusd',c.per_call_limit_microusd::text,
 'request_limit_microusd',c.request_limit_microusd::text)
$$;
create function public.standalone_verify_scope(p_owner uuid,p_actor uuid,p_chat uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from standalone_owner_bindings b join actors a on a.id=b.actor_id
 join chats c on c.id=b.chat_id and c.actor_id=a.id
 where b.owner_id=p_owner and b.actor_id=p_actor and b.chat_id=p_chat
 and coalesce(a.actor_kind,'standard')='standard'
 and not exists(select 1 from managed_agents m where m.actor_id=a.id))
$$;
create function public.standalone_authorize_scope(p_owner uuid,p_actor uuid,p_chat uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select standalone_verify_scope(p_owner,p_actor,p_chat)
$$;
create function public.standalone_bind_scope(p_owner uuid,p_actor uuid,p_chat uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from actors a join chats c on c.actor_id=a.id
 where a.id=p_actor and c.id=p_chat and coalesce(a.actor_kind,'standard')='standard'
 and not exists(select 1 from managed_agents m where m.actor_id=a.id)) then
 raise exception 'STANDALONE_SCOPE_INVALID';end if;
 insert into standalone_owner_bindings(owner_id,actor_id,chat_id) values(p_owner,p_actor,p_chat)
 on conflict(owner_id,actor_id,chat_id) do nothing;return true;
end $$;
create function public.standalone_register_pricing(p_version text,p_metadata jsonb) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_version is null or length(p_version)=0 or jsonb_typeof(p_metadata)<>'object' then raise exception 'INVALID_PRICING';end if;
 insert into standalone_pricing_versions(version,metadata) values(p_version,p_metadata) on conflict do nothing;
 if not exists(select 1 from standalone_pricing_versions where version=p_version and metadata=p_metadata) then raise exception 'PRICING_VERSION_CONFLICT';end if;
 return true;
end $$;
create function public.standalone_configure(p_owner uuid,p_timezone text,p_call numeric,p_request numeric) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;
begin
 if p_owner is null or not exists(select 1 from pg_timezone_names where name=p_timezone)
 or (p_call is not null and (p_call<0 or p_call<>trunc(p_call) or p_call::text in('NaN','Infinity','-Infinity')))
 or (p_request is not null and (p_request<0 or p_request<>trunc(p_request) or p_request::text in('NaN','Infinity','-Infinity'))) then raise exception 'INVALID_STANDALONE_CONFIGURATION';end if;
 insert into standalone_owner_configuration(owner_id,timezone,per_call_limit_microusd,request_limit_microusd)
 values(p_owner,p_timezone,p_call,p_request)
 on conflict(owner_id) do update set timezone=excluded.timezone,
 per_call_limit_microusd=excluded.per_call_limit_microusd,request_limit_microusd=excluded.request_limit_microusd,
 budget_revision=standalone_owner_configuration.budget_revision+1 returning * into c;
 update standalone_provider_attempts set budget_revision=c.budget_revision where owner_id=p_owner and state='paused';
 return standalone_configuration_json(c);
end $$;
create function public.standalone_snapshot(p_owner uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('configuration',(select standalone_configuration_json(c) from standalone_owner_configuration c where owner_id=p_owner),
 'attempts',coalesce((select jsonb_agg(standalone_attempt_json(a) order by created_at desc,id) from standalone_provider_attempts a where owner_id=p_owner),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(to_jsonb(e) order by created_at,id) from standalone_attempt_events e where owner_id=p_owner),'[]'::jsonb))
$$;
create function public.standalone_lookup_attempt(p_owner uuid,p_request text,p_key text) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select standalone_attempt_json(a) from standalone_provider_attempts a where owner_id=p_owner and request_id=p_request and base_attempt_key=p_key and not exists(select 1 from standalone_provider_attempts child where child.supersedes_attempt_id=a.id)
$$;
create function public.standalone_request_committed(p_owner uuid,p_request text) returns numeric
language sql stable set search_path=public,pg_temp as $$
 select coalesce(sum(case when state='settled' then actual_microusd when state in('reserved','dispatched','uncertain') then reserved_microusd else 0 end),0)
 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request
$$;
create function public.standalone_admit(p_owner uuid,p_actor uuid,p_chat uuid,p_request text,p_key text,
 p_hash text,p_payload jsonb,p_pricing text,p_provider text,p_model text,p_reserved numeric,p_category text,p_estimate jsonb,p_estimator text,p_reason text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts; reason text;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 if not found then raise exception 'STANDALONE_CONFIGURATION_REQUIRED';end if;
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
 if exists(select 1 from standalone_workflows where owner_id=p_owner and request_id=p_request and status in('completed','failed')) then raise exception 'STANDALONE_WORKFLOW_FINISHED';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and cancelled_by_owner_at is not null) then raise exception 'STANDALONE_REQUEST_CANCELLED';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and state='uncertain') then raise exception 'STANDALONE_REQUEST_UNCERTAIN';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and actual_microusd>reserved_microusd) then raise exception 'STANDALONE_REQUEST_OVERRUN';end if;
 if p_reserved is null or p_reserved::text in('NaN','Infinity','-Infinity') or p_reserved<0 or p_reserved<>trunc(p_reserved) or p_request is null or length(p_request)=0
 or p_key is null or length(p_key)=0 or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
 or p_payload is null or jsonb_typeof(p_payload)<>'object' or coalesce(length(p_provider),0)=0 or coalesce(length(p_model),0)=0
 or coalesce(length(p_category),0)=0 or coalesce(length(p_pricing),0)=0
 or p_estimate is null or jsonb_typeof(p_estimate)<>'object' or coalesce(length(p_estimator),0)=0 or coalesce(length(p_reason),0)=0 then raise exception 'INVALID_STANDALONE_ATTEMPT';end if;
 if p_estimate->>'status' is distinct from 'estimated' or p_estimate->>'requestHash' is distinct from p_hash
 or p_estimate->>'pricingVersion' is distinct from p_pricing or p_estimate->>'estimatorVersion' is distinct from p_estimator
 or coalesce(p_estimate->>'reservationMicrousd','') !~ '^[0-9]+$' then raise exception 'STANDALONE_ESTIMATE_BINDING_INVALID';end if;
 if (p_estimate->>'reservationMicrousd')::numeric<>p_reserved then raise exception 'STANDALONE_ESTIMATE_BINDING_INVALID';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and (actor_id<>p_actor or chat_id<>p_chat)) then raise exception 'STANDALONE_REQUEST_SCOPE_CONFLICT';end if;
 select * into a from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and attempt_key=p_key for update;
 if found then
 if a.prepared_hash is distinct from p_hash or a.prepared_payload is distinct from p_payload or a.pricing_version is distinct from p_pricing
 or a.provider is distinct from p_provider or a.model is distinct from p_model or a.reserved_microusd is distinct from p_reserved or a.category is distinct from p_category
 or a.preflight_estimate is distinct from p_estimate or a.estimator_version is distinct from p_estimator or a.reason is distinct from p_reason then raise exception 'STANDALONE_ATTEMPT_CONFLICT';end if;
 return (select standalone_attempt_json(x) from standalone_provider_attempts x where x.owner_id=p_owner and x.request_id=p_request and x.base_attempt_key=p_key and not exists(select 1 from standalone_provider_attempts child where child.supersedes_attempt_id=x.id));end if;
 if c.per_call_limit_microusd is null or c.request_limit_microusd is null then reason:='thresholds_unset';
 elsif p_reserved>c.per_call_limit_microusd then reason:='per_call_threshold';
 elsif standalone_request_committed(p_owner,p_request)+p_reserved>c.request_limit_microusd then reason:='request_threshold';end if;
 insert into standalone_provider_attempts(owner_id,actor_id,chat_id,request_id,attempt_key,prepared_hash,prepared_payload,
 pricing_version,provider,model,category,state,reserved_microusd,budget_revision,pause_reason,source_prepared_hash,base_attempt_key,preflight_estimate,estimator_version,reason)
 values(p_owner,p_actor,p_chat,p_request,p_key,p_hash,p_payload,p_pricing,p_provider,p_model,p_category,
 case when reason is null then 'reserved' else 'paused' end,p_reserved,c.budget_revision,reason,p_hash,p_key,p_estimate,p_estimator,p_reason) returning * into a;
 return standalone_attempt_json(a);
end $$;
create function public.standalone_approve(p_owner uuid,p_attempt uuid,p_hash text,p_pricing text,p_revision bigint,p_reserved numeric) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then raise exception 'STANDALONE_APPROVAL_DENIED';end if;
 if a.prepared_hash is distinct from p_hash or a.pricing_version is distinct from p_pricing
 or a.budget_revision is distinct from p_revision or a.reserved_microusd is distinct from p_reserved
 or c.budget_revision is distinct from p_revision or c.per_call_limit_microusd is null or c.request_limit_microusd is null then raise exception 'STANDALONE_APPROVAL_STALE';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (actual_microusd>reserved_microusd or cancelled_by_owner_at is not null or state='uncertain')) then raise exception 'STANDALONE_REQUEST_STOPPED';end if;
 if a.approved_at is not null then return standalone_attempt_json(a);end if;
 if a.state<>'paused' then raise exception 'STANDALONE_APPROVAL_NOT_PAUSED';end if;
 update standalone_provider_attempts set state='reserved',pause_reason=null,approved_at=now(),approved_hash=p_hash,
 approved_pricing_version=p_pricing,approved_revision=p_revision,approved_microusd=p_reserved,
 approved_request_microusd=standalone_request_committed(p_owner,a.request_id)+p_reserved where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;
create function public.standalone_claim_dispatch(p_owner uuid,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;v_pause_reason text;exposure numeric;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state<>'reserved' then return null;end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (cancelled_by_owner_at is not null or state='uncertain')) then return null;end if;
 if not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
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
create function public.standalone_settle(p_owner uuid,p_attempt uuid,p_provider text,p_receipt text,p_actual numeric,p_usage jsonb,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.provider is distinct from p_provider or coalesce(length(p_receipt),0)=0
 or p_actual is null or p_actual::text in('NaN','Infinity','-Infinity') or p_actual<0 or p_actual<>trunc(p_actual) or p_usage is null or p_evidence is null or jsonb_typeof(p_usage)<>'object' or jsonb_typeof(p_evidence)<>'object' then raise exception 'STANDALONE_RECEIPT_INVALID';end if;
 if a.state='settled' then
 if a.provider_receipt_id is distinct from p_receipt or a.actual_microusd is distinct from p_actual or a.usage is distinct from p_usage or a.evidence is distinct from p_evidence then
 insert into standalone_attempt_events(attempt_id,owner_id,kind,details) values(a.id,p_owner,'receipt_conflict',jsonb_build_object('receipt',p_receipt,'actual_microusd',p_actual::text,'usage',p_usage,'evidence',p_evidence,'saved_receipt',a.provider_receipt_id,'saved_actual_microusd',a.actual_microusd::text));
 return jsonb_build_object('conflict',true,'code','standalone_receipt_conflict','attempt',standalone_attempt_json(a));end if;
 return standalone_attempt_json(a);end if;
 if a.state not in('dispatched','uncertain') then raise exception 'STANDALONE_RECEIPT_NOT_DISPATCHED';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and provider=p_provider and provider_receipt_id=p_receipt and id<>a.id) then
 insert into standalone_attempt_events(attempt_id,owner_id,kind,details) values(a.id,p_owner,'receipt_conflict',jsonb_build_object('receipt',p_receipt,'actual_microusd',p_actual::text,'usage',p_usage,'evidence',p_evidence,'reason','receipt_already_bound_to_other_attempt'));
 update standalone_provider_attempts set state='uncertain',uncertainty_reason='Provider receipt conflicts with another attempt; manual reconciliation required' where id=a.id returning * into a;
 return jsonb_build_object('conflict',true,'code','standalone_receipt_conflict','attempt',standalone_attempt_json(a));end if;
 -- Overruns are recorded in full, including when actual exceeds the reservation.
 update standalone_provider_attempts set state='settled',actual_microusd=p_actual,provider_receipt_id=p_receipt,
 usage=p_usage,evidence=p_evidence,resolved_model=p_evidence->>'resolvedModel',settled_at=now() where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;
create function public.standalone_mark_uncertain(p_owner uuid,p_attempt uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found then raise exception 'STANDALONE_ATTEMPT_NOT_FOUND';end if;
 if a.state in('dispatched','uncertain') then
 update standalone_provider_attempts set state='uncertain',uncertainty_reason=p_reason where id=a.id returning * into a;
 elsif a.state<>'settled' then raise exception 'STANDALONE_NOT_DISPATCHED';end if;
 return standalone_attempt_json(a);
end $$;
create function public.standalone_cancel(p_owner uuid,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found then raise exception 'STANDALONE_ATTEMPT_NOT_FOUND';end if;
 -- Cancellation is a request-wide fence, including concurrently prepared helpers.
 update standalone_provider_attempts set cancelled_by_owner_at=coalesce(cancelled_by_owner_at,now()),
 state=case when state in('paused','reserved') then 'cancelled' when state='dispatched' then 'uncertain' else state end,
 uncertainty_reason=case when state='dispatched' then 'Cancelled after dispatch; settlement pending' else uncertainty_reason end
 where owner_id=p_owner and request_id=a.request_id;
 select * into a from standalone_provider_attempts where id=p_attempt;
 return standalone_attempt_json(a);
end $$;
create function public.standalone_checkpoint_response(p_owner uuid,p_attempt uuid,p_checkpoint jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state not in('dispatched','uncertain','settled') or p_checkpoint is null or jsonb_typeof(p_checkpoint)<>'object' then raise exception 'STANDALONE_CHECKPOINT_INVALID';end if;
 if a.response_checkpoint is not null and a.response_checkpoint<>p_checkpoint then raise exception 'STANDALONE_CHECKPOINT_CONFLICT';end if;
 update standalone_provider_attempts set response_checkpoint=p_checkpoint where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;
-- A request lease fences orchestration; provider claims are separately one-shot.
create function public.standalone_claim_workflow(p_owner uuid,p_actor uuid,p_chat uuid,p_request text,p_hash text,p_body jsonb,p_resume boolean default false) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare w standalone_workflows;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
 insert into standalone_workflows(owner_id,request_id,actor_id,chat_id,request_hash,request_body,status)
 values(p_owner,p_request,p_actor,p_chat,p_hash,p_body,'pending') on conflict do nothing;
 select * into w from standalone_workflows where owner_id=p_owner and request_id=p_request for update;
 if w.actor_id<>p_actor or w.chat_id<>p_chat or w.request_hash<>p_hash or w.request_body<>p_body then raise exception 'STANDALONE_WORKFLOW_CONFLICT';end if;
 if w.status='completed' then return to_jsonb(w)||jsonb_build_object('claimed',false);end if;
 if w.status='running' and w.lease_expires_at>now() then return to_jsonb(w)||jsonb_build_object('claimed',false);end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and actual_microusd>reserved_microusd) then
 return to_jsonb(w)||jsonb_build_object('claimed',false,'blocked','request_overrun');end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and state in('dispatched','uncertain')) then
 return to_jsonb(w)||jsonb_build_object('claimed',false,'blocked','unresolved_provider_attempt');end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and cancelled_by_owner_at is not null) then
 return to_jsonb(w)||jsonb_build_object('claimed',false,'blocked','cancelled');end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and state='cancelled' and not exists(select 1 from standalone_provider_attempts replacement where replacement.supersedes_attempt_id=standalone_provider_attempts.id)) then
 return to_jsonb(w)||jsonb_build_object('claimed',false,'blocked','cancelled');end if;
 if w.status='paused' and (p_resume is distinct from true or exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and state='paused')) then
 return to_jsonb(w)||jsonb_build_object('claimed',false,'blocked','approval_required');end if;
 if w.status='failed' then return to_jsonb(w)||jsonb_build_object('claimed',false,'blocked','failed');end if;
 update standalone_workflows set status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '20 minutes',updated_at=now()
 where owner_id=p_owner and request_id=p_request returning * into w;
 return to_jsonb(w)||jsonb_build_object('claimed',true);
end $$;
create function public.standalone_finish_workflow(p_owner uuid,p_request text,p_lease uuid,p_status text,p_result jsonb default null,p_error text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare w standalone_workflows;
begin
 -- Serialize completion with admission, claims and receipts for this owner.
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into w from standalone_workflows where owner_id=p_owner and request_id=p_request for update;
 if not found or w.status<>'running' or w.lease_token is distinct from p_lease then raise exception 'STANDALONE_WORKFLOW_LEASE_LOST';end if;
 if p_status not in('paused','completed','failed') then raise exception 'STANDALONE_WORKFLOW_STATUS_INVALID';end if;
 if p_status in('completed','failed') and exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and state in('paused','reserved','dispatched','uncertain')) then
 p_status:='paused';
 p_error:=coalesce(p_error,'Unresolved provider attempts require workflow pause.');end if;
 update standalone_workflows set status=p_status,result=p_result,error=p_error,lease_token=null,lease_expires_at=null,updated_at=now()
 where owner_id=p_owner and request_id=p_request returning * into w;return to_jsonb(w);
end $$;
create function public.standalone_load_workflow(p_owner uuid,p_request text) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select to_jsonb(w) from standalone_workflows w where owner_id=p_owner and request_id=p_request
$$;
create function public.standalone_revise(p_owner uuid,p_attempt uuid,p_hash text,p_payload jsonb,p_pricing text,p_reserved numeric,p_tradeoffs text,p_estimate jsonb,p_estimator text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;r standalone_provider_attempts;reason text;k text;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state<>'paused' or not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then raise exception 'STANDALONE_REVISION_DENIED';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (actual_microusd>reserved_microusd or cancelled_by_owner_at is not null or state='uncertain')) then raise exception 'STANDALONE_REQUEST_STOPPED';end if;
 if p_reserved is null or p_reserved::text in('NaN','Infinity','-Infinity') or p_reserved<0 or p_reserved>=a.reserved_microusd or p_reserved<>trunc(p_reserved)
 or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or p_payload is null or jsonb_typeof(p_payload)<>'object'
 or p_payload->>'provider' is distinct from a.provider or p_payload->>'endpoint' is distinct from a.prepared_payload->>'endpoint'
 or coalesce(length(p_payload->>'model'),0)=0
 or coalesce(length(p_tradeoffs),0)=0 or p_estimate is null or jsonb_typeof(p_estimate)<>'object' or coalesce(length(p_estimator),0)=0 then raise exception 'STANDALONE_REVISION_INVALID';end if;
 if p_estimate->>'status' is distinct from 'estimated' or p_estimate->>'requestHash' is distinct from p_hash
 or p_estimate->>'pricingVersion' is distinct from p_pricing or p_estimate->>'estimatorVersion' is distinct from p_estimator
 or coalesce(p_estimate->>'reservationMicrousd','') !~ '^[0-9]+$' then raise exception 'STANDALONE_ESTIMATE_BINDING_INVALID';end if;
 if (p_estimate->>'reservationMicrousd')::numeric<>p_reserved then raise exception 'STANDALONE_ESTIMATE_BINDING_INVALID';end if;
 if c.per_call_limit_microusd is null or c.request_limit_microusd is null then reason:='thresholds_unset';
 elsif p_reserved>c.per_call_limit_microusd then reason:='per_call_threshold';
 elsif standalone_request_committed(p_owner,a.request_id)+p_reserved>c.request_limit_microusd then reason:='request_threshold';end if;
 k:=a.base_attempt_key||':revision:'||(select count(*) from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and base_attempt_key=a.base_attempt_key)::text;
 insert into standalone_provider_attempts(owner_id,actor_id,chat_id,request_id,attempt_key,prepared_hash,prepared_payload,
 source_prepared_hash,base_attempt_key,supersedes_attempt_id,tradeoffs,pricing_version,provider,model,category,state,reserved_microusd,budget_revision,pause_reason,preflight_estimate,estimator_version,reason)
 values(p_owner,a.actor_id,a.chat_id,a.request_id,k,p_hash,p_payload,a.source_prepared_hash,a.base_attempt_key,a.id,p_tradeoffs,
 p_pricing,a.provider,p_payload->>'model',a.category,'paused',p_reserved,c.budget_revision,coalesce(reason,'cost_reduction_review'),p_estimate,p_estimator,a.reason) returning * into r;
 update standalone_provider_attempts set state='cancelled',pause_reason='superseded_by_cost_reduction' where id=a.id;
 return standalone_attempt_json(r);
end $$;
create function public.standalone_checkpoint_workflow(p_owner uuid,p_request text,p_lease uuid,p_key text,p_value jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare w standalone_workflows;
begin
 select * into w from standalone_workflows where owner_id=p_owner and request_id=p_request for update;
 if not found or w.status<>'running' or w.lease_token is distinct from p_lease or w.lease_expires_at<=now() then raise exception 'STANDALONE_WORKFLOW_LEASE_LOST';end if;
 if p_key is null or length(p_key)=0 then raise exception 'STANDALONE_WORKFLOW_CHECKPOINT_INVALID';end if;
 p_value:=coalesce(p_value,'null'::jsonb);
 if w.checkpoints ? p_key then
 if w.checkpoints->p_key is distinct from p_value then raise exception 'STANDALONE_WORKFLOW_CHECKPOINT_CONFLICT';end if;
 return w.checkpoints->p_key;end if;
 update standalone_workflows set checkpoints=jsonb_set(checkpoints,array[p_key],p_value,true),updated_at=now()
 where owner_id=p_owner and request_id=p_request;
 return p_value;
end $$;
-- Preserve observed tokens even when a receipt cannot yet be priced. No zero-cost settlement.
create function public.standalone_record_partial_usage(p_owner uuid,p_attempt uuid,p_usage jsonb,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;k text;v numeric;merged_usage jsonb;merged_evidence jsonb;conflict boolean:=false;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state not in('dispatched','uncertain','settled') or p_usage is null or p_evidence is null
 or jsonb_typeof(p_usage)<>'object' or jsonb_typeof(p_evidence)<>'object' then raise exception 'STANDALONE_PARTIAL_USAGE_INVALID';end if;
 foreach k in array array['inputTokens','outputTokens','cachedInputTokens'] loop
 if p_usage ? k and p_usage->k <> 'null'::jsonb then
 if jsonb_typeof(p_usage->k)<>'number' then raise exception 'STANDALONE_PARTIAL_USAGE_INVALID';end if;
 v:=(p_usage->>k)::numeric;
 if v<0 or v<>trunc(v) or v>9007199254740991 then raise exception 'STANDALONE_PARTIAL_USAGE_INVALID';end if;
 if a.usage ? k and a.usage->k <> 'null'::jsonb and a.usage->k is distinct from p_usage->k then conflict:=true;end if;
 end if;end loop;
 if a.resolved_model is not null and p_evidence->>'resolvedModel' is not null and a.resolved_model<>p_evidence->>'resolvedModel' then conflict:=true;end if;
 if conflict then
 insert into standalone_attempt_events(attempt_id,owner_id,kind,details) values(a.id,p_owner,'usage_conflict',jsonb_build_object('usage',p_usage,'evidence',p_evidence,'saved_usage',a.usage,'saved_evidence',a.evidence));
 return jsonb_build_object('conflict',true,'code','standalone_usage_conflict','attempt',standalone_attempt_json(a));end if;
 -- A late partial report never erases a complete, priced receipt.
 if a.state='settled' then return standalone_attempt_json(a);end if;
 merged_usage:=coalesce(a.usage,'{}'::jsonb)||jsonb_strip_nulls(p_usage);
 merged_evidence:=coalesce(a.evidence,'{}'::jsonb)||jsonb_strip_nulls(p_evidence)||jsonb_build_object('pricingUnknown',true);
 if a.state='uncertain' and a.usage=merged_usage and a.evidence=merged_evidence then return standalone_attempt_json(a);end if;
 update standalone_provider_attempts set state='uncertain',usage=merged_usage,evidence=merged_evidence,
 resolved_model=coalesce(resolved_model,p_evidence->>'resolvedModel'),uncertainty_reason='Partial usage or unknown resolved-model pricing; reservation remains held'
 where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;
create function public.standalone_record_provider_identifiers(p_owner uuid,p_attempt uuid,p_request_id text,p_response_id text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state not in('dispatched','uncertain','settled')
 or p_request_id='' or p_response_id='' then raise exception 'STANDALONE_PROVIDER_IDENTIFIERS_INVALID';end if;
 if (a.provider_request_id is not null and p_request_id is not null and a.provider_request_id<>p_request_id)
 or (a.provider_response_id is not null and p_response_id is not null and a.provider_response_id<>p_response_id) then
 insert into standalone_attempt_events(attempt_id,owner_id,kind,details) values(a.id,p_owner,'identifier_conflict',jsonb_build_object(
 'request_id',p_request_id,'response_id',p_response_id,'saved_request_id',a.provider_request_id,'saved_response_id',a.provider_response_id));
 return jsonb_build_object('conflict',true,'code','standalone_identifier_conflict','attempt',standalone_attempt_json(a));end if;
 if p_request_id is not null or p_response_id is not null then
 update standalone_provider_attempts set provider_request_id=coalesce(provider_request_id,p_request_id),provider_response_id=coalesce(provider_response_id,p_response_id)
 where id=a.id returning * into a;end if;
 return standalone_attempt_json(a);
end $$;
-- Append-only events are evidence; accounting totals are still derived only from attempts.
create function public.standalone_record_attempt_event() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into standalone_attempt_events(attempt_id,owner_id,kind,details)
 values(new.id,new.owner_id,case when tg_op='INSERT' then 'admitted' when old.state is distinct from new.state then 'state_changed' when old.response_checkpoint is distinct from new.response_checkpoint then 'response_checkpoint' when old.provider_request_id is distinct from new.provider_request_id or old.provider_response_id is distinct from new.provider_response_id then 'provider_identifiers' else 'updated' end,
 jsonb_build_object('request_id',new.request_id,'attempt_key',new.attempt_key,'previous_state',case when tg_op='UPDATE' then old.state end,
 'state',new.state,'reserved_microusd',new.reserved_microusd::text,'actual_microusd',new.actual_microusd::text,
 'provider_receipt_id',new.provider_receipt_id,'provider_request_id',new.provider_request_id,'provider_response_id',new.provider_response_id,'previous_usage',case when tg_op='UPDATE' then old.usage end,'usage',new.usage,'evidence',new.evidence,'resolved_model',new.resolved_model,'prepared_hash',new.prepared_hash,'pricing_version',new.pricing_version,
 'estimator_version',new.estimator_version,'budget_revision',new.budget_revision,'approved_at',new.approved_at,
 'approved_hash',new.approved_hash,'approved_pricing_version',new.approved_pricing_version,'approved_revision',new.approved_revision,
 'approved_microusd',new.approved_microusd::text,'approved_request_microusd',new.approved_request_microusd::text,
 'cancelled_by_owner_at',new.cancelled_by_owner_at,'pause_reason',new.pause_reason,'uncertainty_reason',new.uncertainty_reason));
 if new.actual_microusd>new.reserved_microusd and (tg_op='INSERT' or old.actual_microusd is distinct from new.actual_microusd) then
 insert into standalone_attempt_events(attempt_id,owner_id,kind,details) values(new.id,new.owner_id,'overrun',jsonb_build_object(
 'request_id',new.request_id,'reserved_microusd',new.reserved_microusd::text,'actual_microusd',new.actual_microusd::text,
 'excess_microusd',(new.actual_microusd-new.reserved_microusd)::text,'provider_receipt_id',new.provider_receipt_id,'evidence',new.evidence));end if;
 return new;
end $$;
create trigger standalone_attempt_event after insert or update on public.standalone_provider_attempts
 for each row execute function public.standalone_record_attempt_event();
-- Public execute is PostgreSQL's default: revoke on every helper and entry point.
do $$ declare f record;begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'standalone\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 if f.proname not in('standalone_attempt_json','standalone_configuration_json','standalone_verify_scope','standalone_request_committed','standalone_record_attempt_event') then
 execute format('grant execute on function %s to service_role',f.signature);end if;
 end loop;
end $$;
