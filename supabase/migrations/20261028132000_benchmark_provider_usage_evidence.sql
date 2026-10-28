-- Keep the actual provider receipt and its cost inputs with the canonical call.
-- No accounts, authority, spending limits, or historical charges are changed.
alter table public.benchmark_budget_calls add column if not exists provider_usage jsonb;
alter table public.benchmark_budget_calls add column if not exists pricing_snapshot jsonb;
alter table public.benchmark_budget_calls add column if not exists provider_receipt_at timestamptz;
create or replace function public.benchmark_reconcile_provider_usage(
 p_call uuid,p_provider_request text,p_usage jsonb,p_linked boolean default false)
returns text language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_budget_calls; total bigint; incoming bigint; outgoing bigint; cached bigint; price jsonb; result text;
begin
 if p_call is null or p_linked is null or nullif(btrim(p_provider_request),'') is null or
  jsonb_typeof(p_usage) is distinct from 'object' or
  coalesce(p_usage->>'total_tokens','') !~ '^[0-9]+$' or
  coalesce(p_usage->>'input_tokens','') !~ '^[0-9]+$' or
  coalesce(p_usage->>'output_tokens','') !~ '^[0-9]+$' or
  coalesce(p_usage->'input_tokens_details'->>'cached_tokens','0') !~ '^[0-9]+$' then
  raise exception 'complete authoritative provider usage required';end if;
 total:=(p_usage->>'total_tokens')::bigint;incoming:=(p_usage->>'input_tokens')::bigint;outgoing:=(p_usage->>'output_tokens')::bigint;
 cached:=coalesce(p_usage->'input_tokens_details'->>'cached_tokens','0')::bigint;
 if total<>incoming+outgoing or cached>incoming or total>2147483647 then raise exception 'provider usage totals inconsistent';end if;
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into c from public.benchmark_budget_calls where
  (p_linked and legacy_mission_call_id=p_call) or (not p_linked and id=p_call) for update;
 if not found or c.model not in ('gpt-5.3-codex','openai:gpt-5.3-codex') then raise exception 'provider usage call unavailable';end if;
 if c.provider_usage is not null and c.provider_usage<>p_usage then raise exception 'immutable provider usage conflict';end if;
 if p_linked then
  perform public.benchmark_reconcile_linked_receipt(p_call,'openai-responses',p_provider_request,total::integer);
  select state into result from public.benchmark_budget_calls where id=c.id;
 else
  result:=public.benchmark_reconcile_receipt(c.id,'openai-responses',p_provider_request,total);
 end if;
 select jsonb_build_object('provider','openai','model','gpt-5.3-codex',
  'inputPerMillion',r.pricing_input_per_1m,'outputPerMillion',r.pricing_output_per_1m,
  'cachedInputPerMillion',to_jsonb(r)->'pricing_cached_input_per_1m','status',r.pricing_status)
 into price from public.model_registry r where r.provider_name='openai' and r.model_id='gpt-5.3-codex';
 update public.benchmark_budget_calls set provider_usage=coalesce(provider_usage,p_usage),
  pricing_snapshot=coalesce(pricing_snapshot,price),provider_receipt_at=coalesce(provider_receipt_at,now()) where id=c.id;
 return result;
end $$;
revoke all on function public.benchmark_reconcile_provider_usage(uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.benchmark_reconcile_provider_usage(uuid,text,jsonb,boolean) to service_role;
