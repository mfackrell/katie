-- Routine reads are scoped to a day, active work, a request or a fixed page.
begin;
create index standalone_attempts_owner_day on public.standalone_provider_attempts(owner_id,(coalesce(dispatched_at,created_at)),actor_id);
create index standalone_attempts_active_scope on public.standalone_provider_attempts(owner_id,actor_id,chat_id,created_at desc,id desc) where state in('paused','reserved','dispatched','uncertain');
create index standalone_events_attempt_kind on public.standalone_attempt_events(attempt_id,kind,created_at desc);
create index standalone_attempts_overruns on public.standalone_provider_attempts(owner_id,created_at desc) where actual_microusd>reserved_microusd;
create index standalone_events_receipt_conflict_recent on public.standalone_attempt_events(owner_id,created_at desc,id desc) where kind='receipt_conflict';
create index standalone_attempts_recent_cursor on public.standalone_provider_attempts(owner_id,created_at desc,id desc);

create function public.standalone_read_configuration(p_owner uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select standalone_configuration_json(c) from standalone_owner_configuration c where owner_id=p_owner
$$;
-- Lightweight records only: never materialize prepared payloads or responses in daily aggregation.
create function public.standalone_usage_totals(p_rows jsonb) returns jsonb
language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('cachedInputTokens',coalesce(sum(case when dispatched and provider<>'runpod' then coalesce((usage->>'cachedInputTokens')::bigint,0) else 0 end),0),'inputTokens',coalesce(sum(case when dispatched and provider<>'runpod' then coalesce((usage->>'inputTokens')::bigint,0) else 0 end),0),'outputTokens',coalesce(sum(case when dispatched and provider<>'runpod' then coalesce((usage->>'outputTokens')::bigint,0) else 0 end),0),'missingInputCount',count(*) filter(where dispatched and provider<>'runpod' and usage->>'inputTokens' is null),'missingOutputCount',count(*) filter(where dispatched and provider<>'runpod' and usage->>'outputTokens' is null),'estimatedCostMicrousd',coalesce(sum(actual_microusd),0)::text,'estimatedInfrastructureMicrousd',coalesce(sum(reserved_microusd) filter(where actual_microusd is null and dispatched and provider='runpod' and state='estimated'),0)::text,'pendingExposureMicrousd',coalesce(sum(reserved_microusd) filter(where state in('paused','reserved') or (state='dispatched' and actual_microusd is not null)),0)::text,'uncertainExposureMicrousd',coalesce(sum(reserved_microusd) filter(where state='uncertain' or (state='dispatched' and actual_microusd is null)),0)::text,'unknownCostCount',count(*) filter(where dispatched and actual_microusd is null),'attemptCount',count(*))
 from jsonb_to_recordset(coalesce(p_rows,'[]'::jsonb)) as r(provider text,state text,dispatched boolean,usage jsonb,actual_microusd numeric,reserved_microusd numeric)
$$;
create function public.standalone_usage_record(a public.standalone_provider_attempts) returns jsonb
language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('provider',a.provider,'state',a.state,'dispatched',a.dispatched_at is not null or a.state in('dispatched','settled','uncertain','estimated'),'usage',a.usage,'actual_microusd',a.actual_microusd,'reserved_microusd',a.reserved_microusd)
$$;
create function public.standalone_payload_preview(p_value jsonb) returns jsonb
language plpgsql immutable set search_path=public,pg_temp as $$
declare text_bytes bigint:=0;image_count bigint:=0;image_bytes bigint:=0;child jsonb;part jsonb;inline_value jsonb;image_url text;data text;
begin
 if jsonb_typeof(p_value)='string' then text_bytes:=octet_length(p_value#>>'{}');
 elsif jsonb_typeof(p_value) in('array','object') then
 if jsonb_typeof(p_value)='object' then
 inline_value:=coalesce(p_value->'inlineData',p_value->'inline_data',p_value->'source');
 image_url:=case when jsonb_typeof(p_value->'image_url')='string' then p_value->>'image_url' else p_value#>>'{image_url,url}' end;
 if p_value->>'type' in('input_image','image_url','image') or p_value ? 'inlineData' or p_value ? 'inline_data' then
 data:=coalesce(inline_value->>'data',case when image_url like 'data:%' then split_part(image_url,',',2) end);
 return jsonb_build_object('textBytes',0,'imageCount',1,'imageBytes',case when data is null then 0 else greatest(0,length(regexp_replace(data,'[[:space:]]','','g'))*3/4-case when data like '%==' then 2 when data like '%=' then 1 else 0 end) end);
 end if;
 end if;
 for child in select value from jsonb_array_elements(case when jsonb_typeof(p_value)='array' then p_value else (select coalesce(jsonb_agg(value),'[]') from jsonb_each(p_value)) end) loop
 part:=standalone_payload_preview(child);text_bytes:=text_bytes+(part->>'textBytes')::bigint;image_count:=image_count+(part->>'imageCount')::bigint;image_bytes:=image_bytes+(part->>'imageBytes')::bigint;
 end loop;
 end if;
 return jsonb_build_object('textBytes',text_bytes,'imageCount',image_count,'imageBytes',image_bytes);
end $$;
create function public.standalone_attempt_status(a public.standalone_provider_attempts) returns jsonb
language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('id',a.id,'owner_id',a.owner_id,'actor_id',a.actor_id,'chat_id',a.chat_id,'request_id',a.request_id,
 'provider',a.provider,'model',a.model,'category',a.category,'resolved_model',a.resolved_model,'state',a.state,
 'prepared_hash',a.prepared_hash,'pricing_version',a.pricing_version,'budget_revision',a.budget_revision,
 'reserved_microusd',a.reserved_microusd::text,'actual_microusd',a.actual_microusd::text,'usage',a.usage,
 'created_at',a.created_at,'dispatched_at',a.dispatched_at,'settled_at',a.settled_at,'cancelled_by_owner_at',a.cancelled_by_owner_at,
 'provider_request_id',a.provider_request_id,'response_checkpoint',case when a.response_checkpoint is not null then jsonb_build_object('status',a.response_checkpoint->'status') else null end,
 'uncertainty_reason',a.uncertainty_reason,'reason',a.reason,'pause_reason',a.pause_reason,'tradeoffs',a.tradeoffs,'estimator_version',a.estimator_version,
 'preflight_estimate',a.preflight_estimate,'prepared_payload','{}'::jsonb,'preview',case when a.state='paused' then standalone_payload_preview(a.prepared_payload->'payload') else '{}'::jsonb end)
$$;
create function public.standalone_history_status(a public.standalone_provider_attempts) returns jsonb
language sql immutable set search_path=public,pg_temp as $$
 select (standalone_usage_record(a)-'dispatched')||jsonb_build_object('id',a.id,'actor_id',a.actor_id,'chat_id',a.chat_id,'model',a.model,'category',a.category,'created_at',a.created_at,'dispatched_at',a.dispatched_at,'settled_at',a.settled_at,'reserved_microusd',a.reserved_microusd::text,'actual_microusd',a.actual_microusd::text)
$$;
create function public.standalone_daily_usage(p_owner uuid,p_actor uuid default null,p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare tz text;d date;lo timestamptz;hi timestamptz;answer jsonb;
begin
 select timezone into tz from standalone_owner_configuration where owner_id=p_owner;
 if tz is null then return null;end if;
 d:=(p_now at time zone tz)::date;lo:=d::timestamp at time zone tz;hi:=(d+1)::timestamp at time zone tz;
 with today as materialized (
 select a.provider,a.model,a.category,standalone_usage_record(a) as value from standalone_provider_attempts a
 where a.owner_id=p_owner and coalesce(a.dispatched_at,a.created_at)>=lo and coalesce(a.dispatched_at,a.created_at)<hi and (p_actor is null or a.actor_id=p_actor)
 ),providers as (select provider,standalone_usage_totals(jsonb_agg(value))||jsonb_build_object('provider',provider) as value from today group by provider),
 models as (select provider,model,category,standalone_usage_totals(jsonb_agg(value))||jsonb_build_object('provider',provider,'model',model,'category',category) as value from today group by provider,model,category)
 select jsonb_build_object('timezone',tz,'date',d::text,'start',lo,'end',hi,
 'totals',(select standalone_usage_totals(jsonb_agg(value)) from today),
 'providers',coalesce((select jsonb_agg(value order by provider) from providers),'[]'::jsonb),
 'models',coalesce((select jsonb_agg(value order by provider,model,category) from models),'[]'::jsonb),
 'unresolvedEarlier',(select standalone_usage_totals(jsonb_agg(standalone_usage_record(a))) from standalone_provider_attempts a where a.owner_id=p_owner and (p_actor is null or a.actor_id=p_actor) and a.state in('paused','reserved','dispatched','uncertain') and coalesce(a.dispatched_at,a.created_at)<lo),
 'attempts',coalesce((select jsonb_agg(standalone_history_status(a)) from (select * from standalone_provider_attempts where owner_id=p_owner and coalesce(dispatched_at,created_at)>=lo and coalesce(dispatched_at,created_at)<hi and (p_actor is null or actor_id=p_actor) order by created_at desc,id desc limit 25) a),'[]'::jsonb)) into answer;
 return answer;
end $$;
create function public.standalone_recent_activity(p_owner uuid,p_actor uuid default null,p_before timestamptz default null,p_before_id uuid default null) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(standalone_history_status(a) order by a.created_at desc,a.id desc),'[]'::jsonb) from
 (select * from standalone_provider_attempts where owner_id=p_owner and (p_actor is null or actor_id=p_actor)
 and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit 25) a
$$;
create function public.standalone_attempt_details(p_owner uuid,p_attempt uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('configuration',standalone_read_configuration(p_owner),'attempts',coalesce((select jsonb_agg(standalone_attempt_json(a)) from standalone_provider_attempts a where owner_id=p_owner and id=p_attempt),'[]'::jsonb),'events','[]'::jsonb)
$$;
create function public.standalone_request_uncertainties(p_owner uuid,p_request text) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'request_id',request_id,'provider',provider,'model',model,'state',state)),'[]'::jsonb)
 from standalone_provider_attempts where owner_id=p_owner and request_id=p_request and provider='runpod' and state='uncertain'
$$;
create function public.standalone_conflict_alerts(p_owner uuid,p_actor uuid default null) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('attemptId',id,'provider',provider,'model',model,'kind','receipt_conflict','message','Conflicting provider receipt evidence requires reconciliation. Saved costs were not silently overwritten.','actualMicrousd',actual_microusd::text,'reservedMicrousd',reserved_microusd::text)),'[]'::jsonb)
 from (select a.id,a.provider,a.model,a.actual_microusd,a.reserved_microusd from standalone_attempt_events e join standalone_provider_attempts a on a.id=e.attempt_id and a.owner_id=e.owner_id
 where e.owner_id=p_owner and e.kind='receipt_conflict' and (p_actor is null or a.actor_id=p_actor) order by e.created_at desc,e.id desc limit 25) alerts
$$;
create function public.standalone_usage_snapshot(p_owner uuid,p_actor uuid,p_chat uuid,p_all boolean default false,p_before timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare answer jsonb;
begin
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'STANDALONE_SCOPE_DENIED';end if;
 with active as materialized (select * from standalone_provider_attempts where owner_id=p_owner and actor_id=p_actor and chat_id=p_chat and state in('paused','reserved','dispatched','uncertain') and cancelled_by_owner_at is null and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit 100),
 requests as (select distinct request_id from active),
 flags as (select a.id,a.request_id,w.status,w.error,case when a.state='uncertain' then standalone_uncertain_exposure_accepted(p_owner,a.id) else false end as accepted,
 exists(select 1 from standalone_attempt_events e where e.attempt_id=a.id and e.kind='uncertain_exposure_auto_authorized') as automatic,
 exists(select 1 from standalone_attempt_events e where e.attempt_id=a.id and e.kind in('receipt_conflict','identifier_conflict','usage_conflict')) as conflict from active a left join standalone_workflows w on w.owner_id=p_owner and w.request_id=a.request_id)
 select jsonb_build_object('configuration',standalone_read_configuration(p_owner),'daily',standalone_daily_usage(p_owner,case when p_all then null else p_actor end),
 'attempts',coalesce((select jsonb_agg(standalone_attempt_status(a)) from active a),'[]'::jsonb),
 'alerts',coalesce((select jsonb_agg(jsonb_build_object('attemptId',a.id,'provider',a.provider,'model',a.model,'kind','overrun','message','Settled cost exceeds the preflight reservation. Further automatic attempts on this request are blocked.','actualMicrousd',a.actual_microusd::text,'reservedMicrousd',a.reserved_microusd::text)) from (select * from standalone_provider_attempts where owner_id=p_owner and actual_microusd>reserved_microusd and (p_all or actor_id=p_actor) order by created_at desc limit 25) a),'[]'::jsonb)||standalone_conflict_alerts(p_owner,case when p_all then null else p_actor end),
 'flags',coalesce((select jsonb_object_agg(id,jsonb_build_object('status',status,'error',error,'accepted',accepted,'automatic',automatic,'conflict',conflict)) from flags),'{}'::jsonb),
 'requestTotals',coalesce((select jsonb_object_agg(r.request_id,(select standalone_usage_totals(jsonb_agg(standalone_usage_record(a))) from standalone_provider_attempts a where a.owner_id=p_owner and a.request_id=r.request_id)) from requests r),'{}'::jsonb)) into answer;
 return answer;
end $$;
-- Compatibility maintenance read is hard-bounded; no production poller calls it.
create or replace function public.standalone_snapshot(p_owner uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('configuration',standalone_read_configuration(p_owner),'attempts',standalone_recent_activity(p_owner),'events','[]'::jsonb)
$$;
-- Retained only for owner-admin maintenance, never service-role application reads.
revoke execute on function public.standalone_snapshot(uuid) from service_role;
do $$ declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('standalone_read_configuration','standalone_usage_totals','standalone_usage_record','standalone_attempt_status','standalone_daily_usage','standalone_recent_activity','standalone_attempt_details','standalone_request_uncertainties','standalone_usage_snapshot','standalone_payload_preview','standalone_history_status','standalone_conflict_alerts') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
