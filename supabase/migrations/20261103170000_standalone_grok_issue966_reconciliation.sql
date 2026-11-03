-- One-time historical reconciliation: GitHub issue #966.
-- Runs under the sole GitHub Actions migration authority, not a public RPC.
-- xAI's usage.cost_in_usd_ticks is its actual billed cost, in 1e10 ticks/USD.
-- Katie stores integer microUSD, rounding each individual receipt upward.
-- Preserve original cost/output in an immutable audit event and evidence.
begin;
do $issue966$
declare
 v_owner constant uuid:='04ed6c05-a586-4a56-ba81-1b50e378746b';
 v_before constant timestamptz:='2026-11-03T00:00:00Z';
 v_batch constant text:='issue-966-grok-history-20261103';
 r record;
 n_all integer;n_done integer;n_under integer;n_exact integer;n_unique integer;
 n_updated integer:=0;n_row integer;
 old_total numeric:=0;new_total numeric:=0;
 new_micro numeric;old_visible numeric;reasoning numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended('standalone.issue966.grok-correction',0));
 select count(*),count(distinct provider_receipt_id)
 into n_all,n_unique from public.standalone_provider_attempts
 where owner_id=v_owner and provider='grok' and created_at<v_before;
 -- Fresh installations must not synthesize user data or charge history.
 if n_all=0 then return;end if;
 if n_all<>48 or n_unique<>48 then
   raise exception 'GROK_966_HISTORICAL_INVENTORY_CHANGED';end if;
 -- Fence the original receipts against concurrent ledger activity.
 perform id from public.standalone_provider_attempts
 where owner_id=v_owner and provider='grok' and created_at<v_before
 order by id for update;

 select count(*) into n_done from public.standalone_provider_attempts
 where owner_id=v_owner and provider='grok' and created_at<v_before
 and evidence#>>'{historicalCostCorrection,batch}'=v_batch;
 if n_done>0 then
   select count(*) into n_under from public.standalone_provider_attempts
   where owner_id=v_owner and provider='grok' and created_at<v_before
     and (usage->>'cost_in_usd_ticks')::numeric/10000>actual_microusd;
   if n_done=47 and n_under=0 then return;end if;
   raise exception 'GROK_966_PARTIAL_OR_CONFLICTING_RECONCILIATION';
 end if;

 select count(*) filter(where state='settled'
    and (usage->>'cost_in_usd_ticks')::numeric/10000>actual_microusd),
 count(*) filter(where state='settled'
    and (usage->>'cost_in_usd_ticks')::numeric/10000=actual_microusd)
 into n_under,n_exact
 from public.standalone_provider_attempts
 where owner_id=v_owner and provider='grok' and created_at<v_before;
 if n_under<>47 or n_exact<>1 then
   raise exception 'GROK_966_EXPECTED_47_UNDER_AND_ONE_EXACT';end if;

 for r in select * from public.standalone_provider_attempts
   where owner_id=v_owner and provider='grok' and created_at<v_before
   and (usage->>'cost_in_usd_ticks')::numeric/10000>actual_microusd
   order by id
 loop
   new_micro:=ceil((r.usage->>'cost_in_usd_ticks')::numeric/10000);
   old_visible:=(r.usage->>'outputTokens')::numeric;
   reasoning:=(r.usage#>>'{completion_tokens_details,reasoning_tokens}')::numeric;
   if r.state<>'settled' or r.actual_microusd is null
      or r.actual_microusd<0 or r.actual_microusd<>trunc(r.actual_microusd)
      or r.evidence->>'kind'<>'provider_receipt'
      or r.evidence->>'pricedModel' is distinct from r.model
      or r.evidence->>'pricingVersion' is distinct from r.pricing_version
      or r.evidence->>'requestHash' is distinct from r.prepared_hash
      or r.evidence ? 'historicalCostCorrection'
      or coalesce(length(r.provider_receipt_id),0)=0
      or r.response_checkpoint is null
      or (r.usage->>'cost_in_usd_ticks')::numeric<=0
      or (r.usage->>'cost_in_usd_ticks')::numeric<>trunc((r.usage->>'cost_in_usd_ticks')::numeric)
      or reasoning is null or reasoning<=0
      or old_visible is null or old_visible<>(r.usage->>'completion_tokens')::numeric
      or (r.usage->>'inputTokens')::numeric<>(r.usage->>'prompt_tokens')::numeric
      or (r.usage->>'total_tokens')::numeric is distinct from
        (r.usage->>'inputTokens')::numeric+old_visible+reasoning
   then raise exception 'GROK_966_INVALID_RECEIPT_OR_USAGE';end if;
   update public.standalone_provider_attempts a
     set actual_microusd=new_micro,
     usage=jsonb_set(a.usage,'{outputTokens}',to_jsonb(old_visible+reasoning),true),
     evidence=a.evidence||jsonb_build_object('historicalCostCorrection',
       jsonb_build_object('batch',v_batch,
        'source','original_xai_cost_in_usd_ticks',
        'originalMicrousd',r.actual_microusd::text,
        'correctedMicrousd',new_micro::text,
        'originalVisibleOutputTokens',old_visible,
        'reasoningTokens',reasoning,
        'rawCostTicks',r.usage->>'cost_in_usd_ticks'))
     where a.id=r.id and a.actual_microusd=r.actual_microusd;
   get diagnostics n_row=row_count;
   if n_row<>1 then raise exception 'GROK_966_CONCURRENT_CHANGE';end if;
   insert into public.standalone_attempt_events(attempt_id,owner_id,kind,details)
   values(r.id,r.owner_id,'historical_cost_correction',
     jsonb_build_object('batch',v_batch,'provider','grok','model',r.model,
      'receiptId',r.provider_receipt_id,'source','original_xai_cost_in_usd_ticks',
      'originalMicrousd',r.actual_microusd::text,
      'correctedMicrousd',new_micro::text,
      'originalVisibleOutputTokens',old_visible,'reasoningTokens',reasoning,
      'rawCostTicks',r.usage->>'cost_in_usd_ticks'));
   old_total:=old_total+r.actual_microusd;
   new_total:=new_total+new_micro;
   n_updated:=n_updated+1;
 end loop;
 if n_updated<>47 or old_total<>1885322 or new_total<>2202249
   or new_total-old_total<>316927 then
   raise exception 'GROK_966_AGGREGATE_CONFLICT';end if;
 select count(*) into n_under from public.standalone_provider_attempts
 where owner_id=v_owner and provider='grok' and created_at<v_before
   and (usage->>'cost_in_usd_ticks')::numeric/10000>actual_microusd;
 if n_under<>0 then raise exception 'GROK_966_POSTCHECK_UNDERCOUNT';end if;
end $issue966$;
commit;
