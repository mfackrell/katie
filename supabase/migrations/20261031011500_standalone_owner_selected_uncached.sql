-- A priceable same-model, no-cache-metadata proposal must be reviewed by
-- the owner once. No unknown cache-fee policy is silently accepted.
begin;
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
 -- Unreviewed cache pricing must remain a deliberate owner decision even
 -- when its normal-rate quote is below both automatic spending thresholds.
 if p_estimate ? 'ownerApprovalRequired' and p_estimate->>'ownerApprovalRequired' is distinct from 'selected_model_uncached' then
   raise exception 'STANDALONE_OWNER_APPROVAL_KIND_INVALID';
 end if;
 if p_estimate->>'ownerApprovalRequired' = 'selected_model_uncached' and (
   p_provider <> 'openai' or p_payload->>'provider' <> 'openai'
   or p_payload->'payload' ? 'prompt_cache_key'
   or p_payload->'payload' ? 'prompt_cache_retention'
 ) then raise exception 'STANDALONE_UNCACHED_APPROVAL_INVALID'; end if;
 if p_estimate->>'ownerApprovalRequired' = 'selected_model_uncached' then reason:='selected_model_uncached';
 elsif c.per_call_limit_microusd is null or c.request_limit_microusd is null then reason:='thresholds_unset';
 elsif p_reserved>c.per_call_limit_microusd then reason:='per_call_threshold';
 elsif standalone_request_committed(p_owner,p_request)+p_reserved>c.request_limit_microusd then reason:='request_threshold';end if;
 insert into standalone_provider_attempts(owner_id,actor_id,chat_id,request_id,attempt_key,prepared_hash,prepared_payload,
 pricing_version,provider,model,category,state,reserved_microusd,budget_revision,pause_reason,source_prepared_hash,base_attempt_key,preflight_estimate,estimator_version,reason)
 values(p_owner,p_actor,p_chat,p_request,p_key,p_hash,p_payload,p_pricing,p_provider,p_model,p_category,
 case when reason is null then 'reserved' else 'paused' end,p_reserved,c.budget_revision,reason,p_hash,p_key,p_estimate,p_estimator,p_reason) returning * into a;
 return standalone_attempt_json(a);
end $$;
revoke all on function public.standalone_admit(uuid,uuid,uuid,text,text,text,jsonb,text,text,text,numeric,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.standalone_admit(uuid,uuid,uuid,text,text,text,jsonb,text,text,text,numeric,text,jsonb,text,text) to service_role;
commit;
