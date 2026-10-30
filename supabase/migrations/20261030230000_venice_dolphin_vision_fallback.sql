-- Independent Venice Dolphin fallback, versioned and bounded.
-- Preserve all existing Qwen, original-request and owner approval protections.
-- Provider URL and pricing are pinned in the server-side implementation.
begin;

create function public.standalone_venice_policy_attempt(a public.standalone_provider_attempts) returns boolean
language sql immutable set search_path=public,pg_temp as $$
 select coalesce(
 a.provider='venice' and a.model='venice-uncensored-1-2'
 and a.pricing_version='standalone-venice-dolphin-vision-v1'
 and a.estimator_version=a.pricing_version and a.reserved_microusd=100000
 and a.prepared_payload->>'schemaVersion'='standalone-venice-still-v1'
 and a.prepared_payload->>'provider'=a.provider
 and a.prepared_payload->>'model'=a.model
 and a.prepared_payload->>'endpoint'='/api/v1/chat/completions'
 and a.prepared_payload->>'hash'=a.prepared_hash
 and a.prepared_payload->>'sourceHash' ~ '^[a-f0-9]{64}$'
 and length(a.prepared_payload->>'attachmentId') between 1 and 1000
 and length(a.prepared_payload->>'question') between 1 and 8192
 and jsonb_typeof(a.prepared_payload->'payload')='object'
 and ((a.prepared_payload->'payload')-'messages')=jsonb_build_object(
   'model','venice-uncensored-1-2','temperature',0,'max_tokens',4096,
   'stream',false,'store',false,'venice_parameters',
   jsonb_build_object('enable_web_search','off','enable_web_scraping',false,
                      'include_venice_system_prompt',false))
 and jsonb_typeof(a.prepared_payload#>'{payload,messages}')='array'
 and jsonb_array_length(a.prepared_payload#>'{payload,messages}')=1
 and a.prepared_payload#>>'{payload,messages,0,role}'='user'
 and jsonb_typeof(a.prepared_payload#>'{payload,messages,0,content}')='array'
 and jsonb_array_length(a.prepared_payload#>'{payload,messages,0,content}')=2
 and a.prepared_payload#>>'{payload,messages,0,content,0,type}'='text'
 and a.prepared_payload#>>'{payload,messages,0,content,0,text}'=a.prepared_payload->>'question'
 and jsonb_typeof(a.prepared_payload#>'{payload,messages,0,content,0}')='object'
 and (a.prepared_payload#>'{payload,messages,0,content,0}')
     = jsonb_build_object('type','text','text',a.prepared_payload->>'question')
 and a.prepared_payload#>>'{payload,messages,0,content,1,type}'='image_url'
 and jsonb_typeof(a.prepared_payload#>'{payload,messages,0,content,1,image_url}')='object'
 and (a.prepared_payload#>'{payload,messages,0,content,1}')
     = jsonb_build_object('type','image_url','image_url',
           jsonb_build_object('url',a.prepared_payload#>>'{payload,messages,0,content,1,image_url,url}'))
 and length(a.prepared_payload#>>'{payload,messages,0,content,1,image_url,url}') between 1 and 8000000
 and a.prepared_payload#>>'{payload,messages,0,content,1,image_url,url}'
      ~* '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
 ,false)
$$;

-- The original Qwen dispatch mechanism is reused, never replaced with a new
-- funding/authorization mechanism. Only the separately reviewed Venice provider
-- is admitted without first-party catalog lookup, after its exact SQL gate.
create or replace function public.standalone_claim_dispatch(p_owner uuid,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c standalone_owner_configuration;a standalone_provider_attempts;v_pause_reason text;exposure numeric;
begin
 select * into c from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state<>'reserved' then return null;end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and request_id=a.request_id and (cancelled_by_owner_at is not null or (state='uncertain' and not standalone_uncertain_exposure_accepted(p_owner,id)))) then return null;end if;
 if not standalone_verify_scope(p_owner,a.actor_id,a.chat_id) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
 if a.provider='runpod' and not standalone_qwen_policy_attempt(a) then raise exception 'STANDALONE_INFRASTRUCTURE_POLICY_DENIED';end if;
 if a.provider='venice' and not standalone_venice_policy_attempt(a) then raise exception 'STANDALONE_VENICE_POLICY_DENIED';end if;
 if not standalone_qwen_policy_attempt(a) and not standalone_venice_policy_attempt(a) then
 -- Serialize activation with dispatch and compare the exact applicable model row.
 perform 1 from standalone_pricing_current where singleton for share;
 if exists(select 1 from standalone_pricing_current where singleton and retrieved_at<now()-interval '24 hours') then raise exception 'STANDALONE_PRICING_UNAVAILABLE';end if;
 if exists(select 1 from standalone_pricing_current where singleton) and
 (select m from standalone_pricing_versions v,jsonb_array_elements(v.metadata->'models') m where v.version=a.pricing_version and m->>'provider'=a.provider and m->>'model'=a.model)
 is distinct from
 (select m from standalone_pricing_current pc join standalone_pricing_versions v on v.version=pc.version,jsonb_array_elements(v.metadata->'models') m where pc.singleton and m->>'provider'=a.provider and m->>'model'=a.model)
 then raise exception 'STANDALONE_PRICING_CHANGED';end if;
 end if;
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

create function public.standalone_complete_venice_estimate(
 p_owner uuid,p_attempt uuid,p_checkpoint jsonb,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.standalone_provider_attempts; body jsonb; evidence jsonb; status integer;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or not standalone_venice_policy_attempt(a) then
   raise exception 'STANDALONE_VENICE_POLICY_DENIED';end if;
 if a.state not in ('dispatched','estimated') or p_checkpoint is null
   or jsonb_typeof(p_checkpoint)<>'object'
   or jsonb_typeof(p_checkpoint->'body')<>'string'
   or coalesce(length(p_checkpoint->>'body'),0) not between 1 and 300000
   or p_checkpoint->'headers' is distinct from '[["content-type","application/json"]]'::jsonb
   or p_checkpoint->>'status' !~ '^[0-9]{3}$'
   or jsonb_typeof(p_evidence)<>'object' then
   raise exception 'STANDALONE_VENICE_COMPLETION_INVALID';end if;
 status:=(p_checkpoint->>'status')::integer;
 if status not in (200,400,401,402,403,404,422,429) then
   raise exception 'STANDALONE_VENICE_COMPLETION_INVALID';end if;
 begin body:=(p_checkpoint->>'body')::jsonb;
 exception when others then raise exception 'STANDALONE_VENICE_COMPLETION_INVALID';end;
 if status=200 then
  if body->>'model' is distinct from a.model
   or jsonb_typeof(body->'choices')<>'array'
   or jsonb_array_length(body->'choices')<>1
   or body#>>'{choices,0,finish_reason}' not in ('stop','length')
   or jsonb_typeof(body#>'{choices,0,message,content}')<>'string'
   or coalesce(length(body#>>'{choices,0,message,content}'),0)>20000
   then raise exception 'STANDALONE_VENICE_COMPLETION_INVALID';end if;
 else
  if body->>'status' is distinct from status::text then
   raise exception 'STANDALONE_VENICE_COMPLETION_INVALID';end if;
 end if;
 if a.response_checkpoint is not null and a.response_checkpoint is distinct from p_checkpoint
   then raise exception 'STANDALONE_CHECKPOINT_CONFLICT';end if;
 evidence:=jsonb_build_object('kind','estimated_vision_inference',
  'policyVersion',a.pricing_version,'model',a.model,'status',status,
  'sourceHash',a.prepared_payload->>'sourceHash',
  'reservedMicrousd','100000','currency','USD','monetaryReceipt',false);
 if a.state='estimated' then
   if a.evidence is distinct from evidence then
     raise exception 'STANDALONE_VENICE_COMPLETION_CONFLICT';end if;
   return standalone_attempt_json(a);
 end if;
 update standalone_provider_attempts set state='estimated',
   response_checkpoint=p_checkpoint,evidence=evidence,
   uncertainty_reason=null,settled_at=null
   where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;

revoke all on function public.standalone_venice_policy_attempt(public.standalone_provider_attempts)
  from public,anon,authenticated,service_role;
revoke all on function public.standalone_complete_venice_estimate(uuid,uuid,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.standalone_complete_venice_estimate(uuid,uuid,jsonb,jsonb) to service_role;
commit;
