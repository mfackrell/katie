-- Expand only Qwen still-image prompt/output bounds. Preserve the v1 immutable
-- receipt contract and all existing accounting, ownership, replay and dispatch gates.
-- v1: 1,800 prompt chars / 1,400 output tokens
-- v2: 8,192 prompt chars / 4,096 output tokens
-- Both: same approved endpoint/model, $0.02 retained infrastructure exposure,
-- 60s execution timeout, 15m job TTL, and exact prepared-payload verification.
begin;

create or replace function public.standalone_qwen_policy_attempt(a public.standalone_provider_attempts) returns boolean
language sql immutable set search_path=public,pg_temp as $$
 select coalesce(a.provider='runpod' and a.model='Qwen/Qwen3-VL-8B-Instruct'
 and a.pricing_version in ('standalone-runpod-qwen-still-v1','standalone-runpod-qwen-still-v2') and a.estimator_version=a.pricing_version
 and a.reserved_microusd=20000 and a.prepared_payload->>'schemaVersion'='standalone-runpod-still-v1'
 and a.prepared_payload->>'provider'=a.provider and a.prepared_payload->>'model'=a.model
 and a.prepared_payload->>'endpoint'='/v2/yafwsm98e8m9lv/run'
 and a.prepared_payload->>'hash'=a.prepared_hash and a.prepared_payload->>'sourceHash' ~ '^[a-f0-9]{64}$'
 and length(a.prepared_payload->>'attachmentId') between 1 and 1000
 and length(a.prepared_payload->>'question') between 1 and (case when a.pricing_version='standalone-runpod-qwen-still-v2' then 8192 else 1800 end)
 and a.prepared_payload#>>'{payload,policy,executionTimeout}'='60000'
 and a.prepared_payload#>>'{payload,policy,ttl}'='900000'
 and a.prepared_payload#>>'{payload,input,route}'='/v1/chat/completions'
 and a.prepared_payload#>>'{payload,input,method}'='POST'
 and a.prepared_payload#>>'{payload,input,body,model}'=a.model
 and a.prepared_payload#>>'{payload,input,body,max_tokens}'=(case when a.pricing_version='standalone-runpod-qwen-still-v2' then '4096' else '1400' end)
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
 and length(a.prepared_payload#>>'{payload,input,body,messages,0,content,1,text}') between 1 and (case when a.pricing_version='standalone-runpod-qwen-still-v2' then 8192 else 1800 end)
 and a.prepared_payload#>>'{payload,input,body,messages,0,content,1,text}'=a.prepared_payload->>'question',false)
$$;


create or replace function public.standalone_complete_qwen_estimate(p_owner uuid,p_attempt uuid,p_job text,p_checkpoint jsonb,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;job jsonb;completion_evidence jsonb;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or not standalone_qwen_policy_attempt(a) then raise exception 'STANDALONE_INFRASTRUCTURE_POLICY_DENIED';end if;
 if standalone_qwen_unresolved_conflict(a) then raise exception 'STANDALONE_INFRASTRUCTURE_CONFLICT';end if;
 if a.state not in('dispatched','uncertain','estimated','settled') or coalesce(p_job,'') !~ '^[A-Za-z0-9-]{8,150}$'
 or a.provider_request_id is distinct from p_job or jsonb_typeof(p_checkpoint) is distinct from 'object'
 or p_checkpoint->>'status' is distinct from '200' or coalesce(length(p_checkpoint->>'body'),0) not between 1 and 2000000
 or jsonb_typeof(p_evidence) is distinct from 'object' then raise exception 'STANDALONE_INFRASTRUCTURE_COMPLETION_INVALID';end if;
 begin job:=(p_checkpoint->>'body')::jsonb;exception when others then raise exception 'STANDALONE_INFRASTRUCTURE_COMPLETION_INVALID';end;
 if job->>'id' is distinct from p_job or coalesce(job->>'status','') not in('COMPLETED','FAILED','CANCELLED','TIMED_OUT') then raise exception 'STANDALONE_INFRASTRUCTURE_COMPLETION_INVALID';end if;
 if a.response_checkpoint is not null and a.response_checkpoint is distinct from p_checkpoint then raise exception 'STANDALONE_CHECKPOINT_CONFLICT';end if;
 completion_evidence:=(p_evidence-'actualMicrousd'-'actualCost'-'cost')||jsonb_build_object('kind','estimated_infrastructure','policyVersion',a.pricing_version,'jobId',p_job,'reservedMicrousd','20000','currency','USD','monetaryReceipt',false,'jobStatus',job->>'status');
 if a.state='settled' then return standalone_attempt_json(a);end if;
 if a.state='estimated' then
  if a.evidence is distinct from completion_evidence then raise exception 'STANDALONE_INFRASTRUCTURE_COMPLETION_CONFLICT';end if;
  return standalone_attempt_json(a);
 end if;
 update standalone_provider_attempts set state='estimated',response_checkpoint=p_checkpoint,evidence=completion_evidence,
 uncertainty_reason=null,settled_at=null where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;

create or replace function public.standalone_complete_qwen_rejection(p_owner uuid,p_attempt uuid,p_checkpoint jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a standalone_provider_attempts;
begin
 perform 1 from standalone_owner_configuration where owner_id=p_owner for update;
 select * into a from standalone_provider_attempts where id=p_attempt and owner_id=p_owner for update;
 if not found or not standalone_qwen_policy_attempt(a) then raise exception 'STANDALONE_INFRASTRUCTURE_POLICY_DENIED';end if;
 if standalone_qwen_unresolved_conflict(a) then raise exception 'STANDALONE_INFRASTRUCTURE_CONFLICT';end if;
 if a.state not in('dispatched','estimated') or a.provider_request_id is not null
 or jsonb_typeof(p_checkpoint) is distinct from 'object'
 or coalesce(p_checkpoint->>'status','') not in('400','401','403','404','422','429')
 or jsonb_typeof(p_checkpoint->'body') is distinct from 'string'
 or coalesce(length(p_checkpoint->>'body'),0) not between 1 and 4096
 or p_checkpoint->'headers' is distinct from '[]'::jsonb then raise exception 'STANDALONE_INFRASTRUCTURE_REJECTION_INVALID';end if;
 if a.response_checkpoint is not null and a.response_checkpoint is distinct from p_checkpoint then raise exception 'STANDALONE_CHECKPOINT_CONFLICT';end if;
 if a.state='estimated' then return standalone_attempt_json(a);end if;
 update standalone_provider_attempts set state='estimated',response_checkpoint=p_checkpoint,
 evidence=jsonb_build_object('kind','estimated_infrastructure','policyVersion',a.pricing_version,'submissionStatus','rejected','httpStatus',p_checkpoint->>'status','reservedMicrousd','20000','currency','USD','monetaryReceipt',false),
 uncertainty_reason=null,settled_at=null where id=a.id returning * into a;
 return standalone_attempt_json(a);
end $$;

commit;
