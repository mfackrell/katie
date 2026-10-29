-- Reviewed Qwen infrastructure policy only. Production writer: migrate.yml -> scripts/run-migrations.mjs.
begin;
alter table public.standalone_provider_attempts drop constraint standalone_provider_attempts_state_check;
alter table public.standalone_provider_attempts add constraint standalone_provider_attempts_state_check
 check(state in('paused','reserved','dispatched','settled','uncertain','cancelled','estimated'));

-- A completed job without an authoritative monetary receipt is estimated, never
-- settled for a fabricated amount. Its entire reviewed reservation stays committed.
create or replace function public.standalone_request_committed(p_owner uuid,p_request text) returns numeric
language sql stable set search_path=public,pg_temp as $$
 select coalesce(sum(case when state='settled' then actual_microusd when state in('reserved','dispatched','uncertain','estimated') then reserved_microusd else 0 end),0)
 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request
$$;

create function public.standalone_qwen_policy_attempt(a public.standalone_provider_attempts) returns boolean
language sql immutable set search_path=public,pg_temp as $$
 select coalesce(a.provider='runpod' and a.model='Qwen/Qwen3-VL-8B-Instruct'
 and a.pricing_version='standalone-runpod-qwen-still-v1' and a.estimator_version='standalone-runpod-qwen-still-v1'
 and a.reserved_microusd=20000 and a.prepared_payload->>'schemaVersion'='standalone-runpod-still-v1'
 and a.prepared_payload->>'provider'=a.provider and a.prepared_payload->>'model'=a.model
 and a.prepared_payload->>'endpoint'='/v2/yafwsm98e8m9lv/run'
 and a.prepared_payload->>'hash'=a.prepared_hash and a.prepared_payload->>'sourceHash' ~ '^[a-f0-9]{64}$'
 and length(a.prepared_payload->>'attachmentId') between 1 and 1000
 and length(a.prepared_payload->>'question') between 1 and 1800
 and a.prepared_payload#>>'{payload,policy,executionTimeout}'='60000'
 and a.prepared_payload#>>'{payload,policy,ttl}'='900000'
 and a.prepared_payload#>>'{payload,input,route}'='/v1/chat/completions'
 and a.prepared_payload#>>'{payload,input,method}'='POST'
 and a.prepared_payload#>>'{payload,input,body,model}'=a.model
 and a.prepared_payload#>>'{payload,input,body,max_tokens}'='1400'
 and a.prepared_payload#>>'{payload,input,body,temperature}'='0'
 and jsonb_typeof(a.prepared_payload#>'{payload,input,body,messages}')='array'
 and case when jsonb_typeof(a.prepared_payload#>'{payload,input,body,messages}')='array' then jsonb_array_length(a.prepared_payload#>'{payload,input,body,messages}') end=1
 and a.prepared_payload#>>'{payload,input,body,messages,0,role}'='user'
 and jsonb_typeof(a.prepared_payload#>'{payload,input,body,messages,0,content}')='array'
 and case when jsonb_typeof(a.prepared_payload#>'{payload,input,body,messages,0,content}')='array' then jsonb_array_length(a.prepared_payload#>'{payload,input,body,messages,0,content}') end=2
 and a.prepared_payload#>>'{payload,input,body,messages,0,content,0,type}'='image_url'
 and length(a.prepared_payload#>>'{payload,input,body,messages,0,content,0,image_url,url}')<=8000000
 and a.prepared_payload#>>'{payload,input,body,messages,0,content,0,image_url,url}' ~* '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
 and a.prepared_payload#>>'{payload,input,body,messages,0,content,1,type}'='text'
 and length(a.prepared_payload#>>'{payload,input,body,messages,0,content,1,text}') between 1 and 1800
 and a.prepared_payload#>>'{payload,input,body,messages,0,content,1,text}'=a.prepared_payload->>'question',false)
$$;

create function public.standalone_complete_qwen_estimate(p_owner uuid,p_attempt uuid,p_job text,p_checkpoint jsonb,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;job jsonb;completion_evidence jsonb;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or not standalone_qwen_policy_attempt(a) then raise exception 'STANDALONE_INFRASTRUCTURE_POLICY_DENIED';end if;
 if a.state not in('dispatched','uncertain','estimated','settled') or coalesce(p_job,'') !~ '^[A-Za-z0-9-]{8,150}$'
 or a.provider_request_id is distinct from p_job or jsonb_typeof(p_checkpoint) is distinct from 'object'
 or p_checkpoint->>'status' is distinct from '200' or coalesce(length(p_checkpoint->>'body'),0) not between 1 and 2000000
 or jsonb_typeof(p_evidence) is distinct from 'object' then raise exception 'STANDALONE_INFRASTRUCTURE_COMPLETION_INVALID';end if;
 begin job:=(p_checkpoint->>'body')::jsonb;exception when others then raise exception 'STANDALONE_INFRASTRUCTURE_COMPLETION_INVALID';end;
 if job->>'id' is distinct from p_job or coalesce(job->>'status','') not in('COMPLETED','FAILED','CANCELLED','TIMED_OUT') then raise exception 'STANDALONE_INFRASTRUCTURE_COMPLETION_INVALID';end if;
 if a.response_checkpoint is not null and a.response_checkpoint is distinct from p_checkpoint then raise exception 'STANDALONE_CHECKPOINT_CONFLICT';end if;
 completion_evidence:=(p_evidence-'actualMicrousd'-'actualCost'-'cost')||jsonb_build_object('kind','estimated_infrastructure','policyVersion','standalone-runpod-qwen-still-v1','jobId',p_job,'reservedMicrousd','20000','currency','USD','monetaryReceipt',false,'jobStatus',job->>'status');
 if a.state='settled' then return standalone_attempt_json(a);end if;
 if a.state='estimated' then
  if a.evidence is distinct from completion_evidence then raise exception 'STANDALONE_INFRASTRUCTURE_COMPLETION_CONFLICT';end if;
  return standalone_attempt_json(a);
 end if;
 update standalone_provider_attempts set state='estimated',response_checkpoint=p_checkpoint,evidence=completion_evidence,
 uncertainty_reason=null,settled_at=null where id=a.id returning * into a;
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
 if a.provider='runpod' and not standalone_qwen_policy_attempt(a) then raise exception 'STANDALONE_INFRASTRUCTURE_POLICY_DENIED';end if;
 if not standalone_qwen_policy_attempt(a) then
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
 if exists(select 1 from standalone_provider_attempts a where a.owner_id=p_owner and a.request_id=p_request
 and (a.state='dispatched' or (a.state='uncertain' and not standalone_uncertain_exposure_accepted(p_owner,a.id)))
 and not (standalone_qwen_policy_attempt(a) and coalesce(a.provider_request_id ~ '^[A-Za-z0-9-]{8,150}$',false))) then
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

create or replace function public.standalone_settle(p_owner uuid,p_attempt uuid,p_provider text,p_receipt text,p_actual numeric,p_usage jsonb,p_evidence jsonb) returns jsonb
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
 if a.state not in('dispatched','uncertain','estimated') then raise exception 'STANDALONE_RECEIPT_NOT_DISPATCHED';end if;
 if exists(select 1 from standalone_provider_attempts where owner_id=p_owner and provider=p_provider and provider_receipt_id=p_receipt and id<>a.id) then
 insert into standalone_attempt_events(attempt_id,owner_id,kind,details) values(a.id,p_owner,'receipt_conflict',jsonb_build_object('receipt',p_receipt,'actual_microusd',p_actual::text,'usage',p_usage,'evidence',p_evidence,'reason','receipt_already_bound_to_other_attempt'));
 update standalone_provider_attempts set state='uncertain',uncertainty_reason='Provider receipt conflicts with another attempt; manual reconciliation required' where id=a.id returning * into a;
 return jsonb_build_object('conflict',true,'code','standalone_receipt_conflict','attempt',standalone_attempt_json(a));end if;
 -- Overruns are recorded in full, including when actual exceeds the reservation.
 update standalone_provider_attempts set state='settled',actual_microusd=p_actual,provider_receipt_id=p_receipt,
 usage=p_usage,evidence=p_evidence,resolved_model=p_evidence->>'resolvedModel',settled_at=now() where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;

create or replace function public.standalone_record_provider_identifiers(p_owner uuid,p_attempt uuid,p_request_id text,p_response_id text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state not in('dispatched','uncertain','settled','estimated')
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

create or replace function public.standalone_checkpoint_response(p_owner uuid,p_attempt uuid,p_checkpoint jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or a.state not in('dispatched','uncertain','settled','estimated') or p_checkpoint is null or jsonb_typeof(p_checkpoint)<>'object' then raise exception 'STANDALONE_CHECKPOINT_INVALID';end if;
 if a.response_checkpoint is not null and a.response_checkpoint<>p_checkpoint then raise exception 'STANDALONE_CHECKPOINT_CONFLICT';end if;
 update standalone_provider_attempts set response_checkpoint=p_checkpoint where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;

-- An explicit client-side submission rejection has no accepted job identity.
-- Retain the reviewed estimate and its exact rejection checkpoint; never invent
-- a job ID to make a failed submission look like completed inference.
create function public.standalone_complete_qwen_rejection(p_owner uuid,p_attempt uuid,p_checkpoint jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or not standalone_qwen_policy_attempt(a) then raise exception 'STANDALONE_INFRASTRUCTURE_POLICY_DENIED';end if;
 if a.state not in('dispatched','estimated') or a.provider_request_id is not null
 or jsonb_typeof(p_checkpoint) is distinct from 'object'
 or coalesce(p_checkpoint->>'status','') not in('400','401','403','404','422','429')
 or jsonb_typeof(p_checkpoint->'body') is distinct from 'string'
 or coalesce(length(p_checkpoint->>'body'),0) not between 1 and 4096
 or p_checkpoint->'headers' is distinct from '[]'::jsonb then raise exception 'STANDALONE_INFRASTRUCTURE_REJECTION_INVALID';end if;
 if a.response_checkpoint is not null and a.response_checkpoint is distinct from p_checkpoint then raise exception 'STANDALONE_CHECKPOINT_CONFLICT';end if;
 if a.state='estimated' then return standalone_attempt_json(a);end if;
 update standalone_provider_attempts set state='estimated',response_checkpoint=p_checkpoint,
 evidence=jsonb_build_object('kind','estimated_infrastructure','policyVersion','standalone-runpod-qwen-still-v1','submissionStatus','rejected','httpStatus',p_checkpoint->>'status','reservedMicrousd','20000','currency','USD','monetaryReceipt',false),
 uncertainty_reason=null,settled_at=null where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;
revoke all on function public.standalone_complete_qwen_rejection(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.standalone_complete_qwen_rejection(uuid,uuid,jsonb) to service_role;
revoke all on function public.standalone_qwen_policy_attempt(public.standalone_provider_attempts) from public,anon,authenticated,service_role;
revoke all on function public.standalone_complete_qwen_estimate(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.standalone_complete_qwen_estimate(uuid,uuid,text,jsonb,jsonb) to service_role;
commit;
