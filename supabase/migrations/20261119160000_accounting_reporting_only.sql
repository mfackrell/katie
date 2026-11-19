-- The 2026-11-19 owner's directive: accounting reports after execution.
-- Preserve every historical attempt, cost, estimate and receipt.
-- Only security-validated, owner-cancellable, one-shot operations are dispatched.
begin;

create or replace function public.standalone_admit(p_owner uuid,p_actor uuid,p_chat uuid,p_request text,p_key text,
 p_hash text,p_payload jsonb,p_pricing text,p_provider text,p_model text,p_reserved numeric,p_category text,p_estimate jsonb,p_estimator text,p_reason text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts; revision bigint;
begin
 select coalesce((select budget_revision from standalone_owner_configuration where owner_id=p_owner),0) into revision;
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
 if exists(select 1 from standalone_workflows where owner_id=p_owner and request_id=p_request and status in('completed','failed')) then raise exception 'STANDALONE_WORKFLOW_FINISHED';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and cancelled_by_owner_at is not null) then raise exception 'STANDALONE_REQUEST_CANCELLED';end if;
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
 -- Stored quotes are informational; no cost or approval check is performed here.
 insert into standalone_provider_attempts(owner_id,actor_id,chat_id,request_id,attempt_key,prepared_hash,prepared_payload,
 pricing_version,provider,model,category,state,reserved_microusd,budget_revision,pause_reason,source_prepared_hash,base_attempt_key,preflight_estimate,estimator_version,reason)
 values(p_owner,p_actor,p_chat,p_request,p_key,p_hash,p_payload,p_pricing,p_provider,p_model,p_category,
 'reserved',p_reserved,revision,null,p_hash,p_key,p_estimate,p_estimator,p_reason) returning * into a;
 return standalone_attempt_json(a);
end $$;

create or replace function public.standalone_claim_dispatch(p_owner uuid,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state<>'reserved' then return null;end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and cancelled_by_owner_at is not null) then return null;end if;
 if not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
 if a.provider='runpod' and not standalone_qwen_policy_attempt(a) then raise exception 'STANDALONE_INFRASTRUCTURE_POLICY_DENIED';end if;
 if a.provider='venice' and not standalone_venice_policy_attempt(a) then raise exception 'STANDALONE_VENICE_POLICY_DENIED';end if;
 -- Price freshness, budget limits and unknown charges cannot gate dispatch.
 -- The row lock, identity check, cancellation and one-shot state transition remain.
 update standalone_provider_attempts set state='dispatched',dispatched_at=now() where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;

create or replace function public.standalone_claim_workflow(p_owner uuid,p_actor uuid,p_chat uuid,p_request text,p_hash text,p_body jsonb,p_resume boolean default false) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare w standalone_workflows;
begin
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
 insert into standalone_workflows(owner_id,request_id,actor_id,chat_id,request_hash,request_body,status)
 values(p_owner,p_request,p_actor,p_chat,p_hash,p_body,'pending') on conflict do nothing;
 select * into w from standalone_workflows where owner_id=p_owner and request_id=p_request for update;
 if w.actor_id<>p_actor or w.chat_id<>p_chat or w.request_hash<>p_hash or w.request_body<>p_body then raise exception 'STANDALONE_WORKFLOW_CONFLICT';end if;
 if w.status='completed' then return to_jsonb(w)||jsonb_build_object('claimed',false);end if;
 if w.status='running' and w.lease_expires_at>now() then return to_jsonb(w)||jsonb_build_object('claimed',false);end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and cancelled_by_owner_at is not null) then
 return to_jsonb(w)||jsonb_build_object('claimed',false,'blocked','cancelled');end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and state='cancelled' and not exists(select 1 from standalone_provider_attempts replacement where replacement.supersedes_attempt_id=standalone_provider_attempts.id)) then
 return to_jsonb(w)||jsonb_build_object('claimed',false,'blocked','cancelled');end if;
 if w.status='paused' and p_resume is distinct from true then
 return to_jsonb(w)||jsonb_build_object('claimed',false,'blocked','resume_required');end if;
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
 select * into w from standalone_workflows where owner_id=p_owner and request_id=p_request for update;
 if not found or w.status<>'running' or w.lease_token is distinct from p_lease then raise exception 'STANDALONE_WORKFLOW_LEASE_LOST';end if;
 if p_status not in('paused','completed','failed') then raise exception 'STANDALONE_WORKFLOW_STATUS_INVALID';end if;
 update standalone_workflows set status=p_status,result=p_result,error=p_error,lease_token=null,lease_expires_at=null,updated_at=now()
 where owner_id=p_owner and request_id=p_request returning * into w;return to_jsonb(w);
end $$;

-- Release existing finance-only paused attempts. Old pause reasons remain in
-- append-only standalone_attempt_events through the state-change trigger.
update public.standalone_provider_attempts a
set state='reserved', pause_reason=null
where a.state='paused'
  and a.pause_reason in ('thresholds_unset','per_call_threshold','request_threshold',
    'selected_model_uncached','request_overrun','configuration_changed','request_exposure_changed')
  and a.cancelled_by_owner_at is null
  and not exists (select 1 from public.standalone_provider_attempts x
    where x.owner_id=a.owner_id and x.request_id=a.request_id and x.cancelled_by_owner_at is not null)
  and exists (select 1 from public.standalone_workflows w
    where w.owner_id=a.owner_id and w.request_id=a.request_id
      and w.status in ('pending','paused','running'));

-- Mark uncertainty as durable evidence only. The previous implementation
-- performed an owner-spending authorization inside this error-recording RPC;
-- that caused financial approval decisions to interrupt technical recovery.
create or replace function public.standalone_mark_uncertain(
  p_owner uuid,p_attempt uuid,p_reason text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 select * into a from standalone_provider_attempts
   where id=p_attempt and owner_id=p_owner for update;
 if not found then raise exception 'STANDALONE_ATTEMPT_NOT_FOUND';end if;
 if not standalone_verify_scope(p_owner,a.actor_id,a.chat_id)
 then raise exception 'STANDALONE_SCOPE_DENIED';end if;
 if a.state in('dispatched','uncertain') then
   update standalone_provider_attempts
   set state='uncertain',uncertainty_reason=p_reason
   where id=a.id returning * into a;
 elsif a.state<>'settled' then
   raise exception 'STANDALONE_NOT_DISPATCHED';
 end if;
 return standalone_attempt_json(a);
end $$;

-- Historical acknowledgement rows remain intact, but no new cost-based
-- authorization transition fires when the provider outcome is uncertain.
drop trigger if exists standalone_uncertainty_owner_limits on public.standalone_provider_attempts;

revoke all on function public.standalone_admit(uuid,uuid,uuid,text,text,text,jsonb,text,text,text,numeric,text,jsonb,text,text),
  public.standalone_claim_dispatch(uuid,uuid),
  public.standalone_claim_workflow(uuid,uuid,uuid,text,text,jsonb,boolean),
  public.standalone_finish_workflow(uuid,text,uuid,text,jsonb,text),
  public.standalone_mark_uncertain(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.standalone_admit(uuid,uuid,uuid,text,text,text,jsonb,text,text,text,numeric,text,jsonb,text,text),
  public.standalone_claim_dispatch(uuid,uuid),
  public.standalone_claim_workflow(uuid,uuid,uuid,text,text,jsonb,boolean),
  public.standalone_finish_workflow(uuid,text,uuid,text,jsonb,text),
  public.standalone_mark_uncertain(uuid,uuid,text)
  to service_role;
commit;
