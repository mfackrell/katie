-- Additive owner-controlled uncertain exposure continuation.
-- Production writer remains migrate.yml -> scripts/run-migrations.mjs.
begin;
create table public.standalone_uncertain_exposure_authorizations (
 id uuid primary key default gen_random_uuid(),
 attempt_id uuid not null references public.standalone_provider_attempts(id),
 owner_id uuid not null,request_id text not null,actor_id uuid not null,chat_id uuid not null,
 reserved_microusd numeric(30,0) not null check(reserved_microusd>=0),
 budget_revision bigint not null,prepared_hash text not null,pricing_version text not null,
 provider text not null,model text not null,binding_created_at timestamptz not null,
 grant_chat_id uuid not null,grant_created_at timestamptz not null,
 accepted_at timestamptz not null default now(),
 unique(attempt_id,budget_revision,reserved_microusd,prepared_hash,pricing_version,binding_created_at,grant_chat_id,grant_created_at),
 foreign key(owner_id,request_id) references public.standalone_workflows(owner_id,request_id),
 foreign key(owner_id,actor_id,chat_id) references public.standalone_owner_bindings(owner_id,actor_id,chat_id)
);
alter table public.standalone_uncertain_exposure_authorizations enable row level security;
revoke all on public.standalone_uncertain_exposure_authorizations from public,anon,authenticated,service_role;

-- An acknowledgement is valid only for the same exposure and current ownership
-- and budget revision. It never changes attempt state, receipts or commitment.
create function public.standalone_uncertain_exposure_accepted(p_owner uuid,p_attempt uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(
  select 1 from standalone_uncertain_exposure_authorizations u
  join standalone_provider_attempts a on a.id=u.attempt_id and a.owner_id=u.owner_id
  join standalone_owner_configuration c on c.owner_id=u.owner_id and c.budget_revision=u.budget_revision
  join standalone_owner_bindings b on b.owner_id=u.owner_id and b.actor_id=u.actor_id and b.chat_id=u.chat_id
   and b.created_at=u.binding_created_at and b.revoked_at is null
  join self_tool_owner_grants g on g.owner_id=u.owner_id and g.actor_id=u.actor_id
   and g.chat_id=u.grant_chat_id and g.created_at=u.grant_created_at
  join chats access_chat on access_chat.id=g.chat_id and access_chat.actor_id=g.actor_id
  where u.owner_id=p_owner and u.attempt_id=p_attempt and a.state='uncertain'
   and a.request_id=u.request_id and a.actor_id=u.actor_id and a.chat_id=u.chat_id
   and a.reserved_microusd=u.reserved_microusd and a.prepared_hash=u.prepared_hash
   and a.pricing_version=u.pricing_version and a.provider=u.provider and a.model=u.model
   and a.cancelled_by_owner_at is null and standalone_verify_scope(p_owner,a.actor_id,a.chat_id)
 )
$$;
create function public.standalone_accept_uncertain_exposure(p_owner uuid,p_attempt uuid,p_revision bigint,p_reserved numeric) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;b standalone_owner_bindings;g self_tool_owner_grants;u standalone_uncertain_exposure_authorizations;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state<>'uncertain' or not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then raise exception 'STANDALONE_EXPOSURE_ACCEPTANCE_DENIED';end if;
 if c.budget_revision is distinct from p_revision or a.reserved_microusd is distinct from p_reserved
 or c.per_call_limit_microusd is null or c.request_limit_microusd is null then raise exception 'STANDALONE_EXPOSURE_ACCEPTANCE_STALE';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (actual_microusd>reserved_microusd or cancelled_by_owner_at is not null)) then raise exception 'STANDALONE_REQUEST_STOPPED';end if;
 perform 1 from standalone_workflows where owner_id=p_owner and request_id=a.request_id and actor_id=a.actor_id and chat_id=a.chat_id;
 if not found then raise exception 'STANDALONE_EXPOSURE_WORKFLOW_UNAVAILABLE';end if;
 select * into b from standalone_owner_bindings where owner_id=p_owner and actor_id=a.actor_id and chat_id=a.chat_id and revoked_at is null for key share;
 if not found then raise exception 'STANDALONE_EXPOSURE_ACCEPTANCE_DENIED';end if;
 select grant_row.* into g from self_tool_owner_grants grant_row join chats access_chat
 on access_chat.id=grant_row.chat_id and access_chat.actor_id=grant_row.actor_id
 where grant_row.owner_id=p_owner and grant_row.actor_id=a.actor_id
 order by grant_row.created_at,grant_row.chat_id limit 1 for key share of grant_row,access_chat;
 if not found then raise exception 'STANDALONE_EXPOSURE_ACCEPTANCE_DENIED';end if;
 select * into u from standalone_uncertain_exposure_authorizations where owner_id=p_owner and attempt_id=a.id
 and request_id=a.request_id and budget_revision=c.budget_revision and reserved_microusd=a.reserved_microusd
 and prepared_hash=a.prepared_hash and pricing_version=a.pricing_version and provider=a.provider and model=a.model
 and binding_created_at=b.created_at and grant_chat_id=g.chat_id and grant_created_at=g.created_at;
 if found then return to_jsonb(u)||jsonb_build_object('reserved_microusd',u.reserved_microusd::text);end if;
 -- No UPDATE privilege or upsert: prior authorizations remain immutable history.
 -- A replaced grant may be explicitly reaccepted as a distinct authorization.
 insert into standalone_uncertain_exposure_authorizations(attempt_id,owner_id,request_id,actor_id,chat_id,reserved_microusd,budget_revision,prepared_hash,pricing_version,provider,model,binding_created_at,grant_chat_id,grant_created_at)
 values(a.id,p_owner,a.request_id,a.actor_id,a.chat_id,a.reserved_microusd,c.budget_revision,a.prepared_hash,a.pricing_version,a.provider,a.model,b.created_at,g.chat_id,g.created_at) returning * into u;
 insert into standalone_attempt_events(attempt_id,owner_id,kind,details)
 values(a.id,p_owner,'uncertain_exposure_accepted',jsonb_build_object('request_id',a.request_id,'reserved_microusd',a.reserved_microusd::text,'budget_revision',c.budget_revision,'accepted_at',u.accepted_at));
 return to_jsonb(u)||jsonb_build_object('reserved_microusd',u.reserved_microusd::text);
end $$;

create or replace function public.standalone_admit(p_owner uuid,p_actor uuid,p_chat uuid,p_request text,p_key text,
 p_hash text,p_payload jsonb,p_pricing text,p_provider text,p_model text,p_reserved numeric,p_category text,p_estimate jsonb,p_estimator text,p_reason text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts; reason text;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 if not found then raise exception 'STANDALONE_CONFIGURATION_REQUIRED';end if;
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
 if exists(select 1 from standalone_workflows where owner_id=p_owner and request_id=p_request and status in('completed','failed')) then raise exception 'STANDALONE_WORKFLOW_FINISHED';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and cancelled_by_owner_at is not null) then raise exception 'STANDALONE_REQUEST_CANCELLED';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and (state='uncertain' and not standalone_uncertain_exposure_accepted(p_owner,id))) then raise exception 'STANDALONE_REQUEST_UNCERTAIN';end if;
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

create or replace function public.standalone_approve(p_owner uuid,p_attempt uuid,p_hash text,p_pricing text,p_revision bigint,p_reserved numeric) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then raise exception 'STANDALONE_APPROVAL_DENIED';end if;
 if a.prepared_hash is distinct from p_hash or a.pricing_version is distinct from p_pricing
 or a.budget_revision is distinct from p_revision or a.reserved_microusd is distinct from p_reserved
 or c.budget_revision is distinct from p_revision or c.per_call_limit_microusd is null or c.request_limit_microusd is null then raise exception 'STANDALONE_APPROVAL_STALE';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (actual_microusd>reserved_microusd or cancelled_by_owner_at is not null or (state='uncertain' and not standalone_uncertain_exposure_accepted(p_owner,id)))) then raise exception 'STANDALONE_REQUEST_STOPPED';end if;
 if a.approved_at is not null then return standalone_attempt_json(a);end if;
 if a.state<>'paused' then raise exception 'STANDALONE_APPROVAL_NOT_PAUSED';end if;
 update standalone_provider_attempts set state='reserved',pause_reason=null,approved_at=now(),approved_hash=p_hash,
 approved_pricing_version=p_pricing,approved_revision=p_revision,approved_microusd=p_reserved,
 approved_request_microusd=standalone_request_committed(p_owner,a.request_id)+p_reserved where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;

create or replace function public.standalone_claim_dispatch(p_owner uuid,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;v_pause_reason text;exposure numeric;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state<>'reserved' then return null;end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (cancelled_by_owner_at is not null or (state='uncertain' and not standalone_uncertain_exposure_accepted(p_owner,id)))) then return null;end if;
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

create or replace function public.standalone_revise(p_owner uuid,p_attempt uuid,p_hash text,p_payload jsonb,p_pricing text,p_reserved numeric,p_tradeoffs text,p_estimate jsonb,p_estimator text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;r standalone_provider_attempts;reason text;k text;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state<>'paused' or not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then raise exception 'STANDALONE_REVISION_DENIED';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (actual_microusd>reserved_microusd or cancelled_by_owner_at is not null or (state='uncertain' and not standalone_uncertain_exposure_accepted(p_owner,id)))) then raise exception 'STANDALONE_REQUEST_STOPPED';end if;
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

create or replace function public.standalone_reprice_attempt(p_owner uuid,p_attempt uuid,p_pricing text,p_estimate jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;r standalone_provider_attempts;k text;amount numeric;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state not in('paused','reserved') or not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then raise exception 'STANDALONE_REVISION_DENIED';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (actual_microusd>reserved_microusd or cancelled_by_owner_at is not null or (state='uncertain' and not standalone_uncertain_exposure_accepted(p_owner,id)))) then raise exception 'STANDALONE_REQUEST_STOPPED';end if;
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

create or replace function public.standalone_claim_workflow(p_owner uuid,p_actor uuid,p_chat uuid,p_request text,p_hash text,p_body jsonb,p_resume boolean default false) returns jsonb
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
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and (state='dispatched' or (state='uncertain' and not standalone_uncertain_exposure_accepted(p_owner,id)))) then
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

create or replace function public.standalone_finish_workflow(p_owner uuid,p_request text,p_lease uuid,p_status text,p_result jsonb default null,p_error text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare w standalone_workflows;
begin
 -- Serialize completion with admission, claims and receipts for this owner.
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into w from standalone_workflows where owner_id=p_owner and request_id=p_request for update;
 if not found or w.status<>'running' or w.lease_token is distinct from p_lease then raise exception 'STANDALONE_WORKFLOW_LEASE_LOST';end if;
 if p_status not in('paused','completed','failed') then raise exception 'STANDALONE_WORKFLOW_STATUS_INVALID';end if;
 if p_status in('completed','failed') and exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and (state in('paused','reserved','dispatched') or (state='uncertain' and not standalone_uncertain_exposure_accepted(p_owner,id)))) then
 p_status:='paused';
 p_error:=coalesce(p_error,'Unresolved provider attempts require workflow pause.');end if;
 update standalone_workflows set status=p_status,result=p_result,error=p_error,lease_token=null,lease_expires_at=null,updated_at=now()
 where owner_id=p_owner and request_id=p_request returning * into w;return to_jsonb(w);
end $$;

revoke all on function public.standalone_uncertain_exposure_accepted(uuid,uuid),public.standalone_accept_uncertain_exposure(uuid,uuid,bigint,numeric) from public,anon,authenticated;
grant execute on function public.standalone_uncertain_exposure_accepted(uuid,uuid),public.standalone_accept_uncertain_exposure(uuid,uuid,bigint,numeric) to service_role;
commit;
