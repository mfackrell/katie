-- One-time, evidence-gated repair of historical xAI billed usage.
-- Original receipts, amounts, tokens, and approvals remain in the append-only audit.
-- Production execution is owned by the repository migration runner only.
begin;
do $grok_repair$
declare
  receipt_count integer;
  previously_reconciled integer;
  candidate_count integer;
  unique_receipts integer;
  delta_micro numeric;
  audit_count integer;
  updated_count integer;
  verified_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('standalone-grok-cost-ticks-20261103',0));

  select count(*) into receipt_count
  from public.standalone_provider_attempts a
  where a.provider='grok' and a.state='settled'
    and a.created_at < '2026-11-03 00:00:00+00'::timestamptz
    and a.usage ? 'cost_in_usd_ticks';

  -- A fresh installation has no historical calls to repair.
  if receipt_count=0 then return; end if;
  if receipt_count<>48 then
    raise exception 'GROK_HISTORICAL_RECEIPT_INVENTORY_CHANGED: %',receipt_count;
  end if;

  -- Serialize against other ledger changes on the affected owner.
  perform 1 from public.standalone_owner_configuration c
  where c.owner_id in (
    select distinct a.owner_id from public.standalone_provider_attempts a
    where a.provider='grok' and a.state='settled'
      and a.created_at < '2026-11-03 00:00:00+00'::timestamptz
      and a.usage ? 'cost_in_usd_ticks'
  ) for update;

  select count(*) into previously_reconciled
  from public.standalone_provider_attempts a
  where a.provider='grok'
    and a.evidence#>>'{historicalCostCorrection,version}'='xai-reported-ticks-20261103-v1';

  if previously_reconciled=47 then
    select count(*) into verified_count
    from public.standalone_provider_attempts a
    where a.provider='grok' and a.state='settled'
      and a.evidence#>>'{historicalCostCorrection,version}'='xai-reported-ticks-20261103-v1'
      and a.actual_microusd=ceil((a.usage->>'cost_in_usd_ticks')::numeric/10000)
      and (a.usage->>'outputTokens')::numeric =
          (a.usage->>'completion_tokens')::numeric +
          (a.usage#>>'{completion_tokens_details,reasoning_tokens}')::numeric;
    if verified_count<>47 then raise exception 'GROK_PRIOR_CORRECTION_INCOMPLETE';end if;
    return;
  elsif previously_reconciled<>0 then
    raise exception 'GROK_PARTIAL_PRIOR_CORRECTION: %',previously_reconciled;
  end if;

  create temp table katie_grok_cost_correction_targets on commit drop as
  select a.id,a.owner_id,a.model,a.provider_receipt_id,a.actual_microusd old_micro,
    ceil((a.usage->>'cost_in_usd_ticks')::numeric/10000) corrected_micro,
    a.usage original_usage,a.evidence original_evidence,
    (a.usage->>'outputTokens')::numeric visible_output,
    (a.usage#>>'{completion_tokens_details,reasoning_tokens}')::numeric reasoning_output
  from public.standalone_provider_attempts a
  where a.provider='grok' and a.state='settled'
    and a.created_at < '2026-11-03 00:00:00+00'::timestamptz
    and a.response_checkpoint->>'status'='200'
    and (a.response_checkpoint->>'body')::jsonb->>'id'=a.provider_receipt_id
    and (a.response_checkpoint->>'body')::jsonb->>'model'=a.model
    and a.evidence->>'kind'='provider_receipt'
    and a.evidence->>'pricedModel'=a.model
    and a.evidence->>'pricingVersion'=a.pricing_version
    and not (a.evidence ? 'historicalCostCorrection')
    and jsonb_typeof(a.usage->'cost_in_usd_ticks')='number'
    and (a.usage->>'cost_in_usd_ticks')::numeric/10000>a.actual_microusd
    and (a.usage#>>'{completion_tokens_details,reasoning_tokens}')::numeric>0
    and (a.usage->>'outputTokens')::numeric=(a.usage->>'completion_tokens')::numeric
    and (a.usage->>'inputTokens')::numeric=(a.usage->>'prompt_tokens')::numeric
    and (a.usage->>'total_tokens')::numeric=
        (a.usage->>'inputTokens')::numeric +
        (a.usage->>'completion_tokens')::numeric +
        (a.usage#>>'{completion_tokens_details,reasoning_tokens}')::numeric;

  select count(*),count(distinct provider_receipt_id),
    coalesce(sum(corrected_micro-old_micro),0)
  into candidate_count,unique_receipts,delta_micro
  from katie_grok_cost_correction_targets;

  if candidate_count<>47 or unique_receipts<>47 or delta_micro<>316927 then
    raise exception 'GROK_HISTORICAL_CORRECTION_EVIDENCE_MISMATCH: %, %, %',
      candidate_count,unique_receipts,delta_micro;
  end if;

  -- Record the *entire* prior accounting evidence before changing the read model.
  insert into public.standalone_attempt_events(attempt_id,owner_id,kind,details)
  select t.id,t.owner_id,'historical_cost_correction',
    jsonb_build_object(
      'version','xai-reported-ticks-20261103-v1',
      'provider','grok',
      'providerReceiptId',t.provider_receipt_id,
      'model',t.model,
      'previousMicrousd',t.old_micro::text,
      'correctedMicrousd',t.corrected_micro::text,
      'previousUsage',t.original_usage,
      'previousEvidence',t.original_evidence,
      'visibleOutputTokens',t.visible_output,
      'reasoningTokens',t.reasoning_output,
      'basis','provider_reported_cost_in_usd_ticks')
  from katie_grok_cost_correction_targets t;
  get diagnostics audit_count=row_count;
  if audit_count<>47 then raise exception 'GROK_AUDIT_INSERT_MISMATCH';end if;

  update public.standalone_provider_attempts a
  set actual_microusd=t.corrected_micro,
      usage=jsonb_set(a.usage,'{outputTokens}',to_jsonb(t.visible_output+t.reasoning_output),true),
      evidence=a.evidence || jsonb_build_object('historicalCostCorrection',
        jsonb_build_object('version','xai-reported-ticks-20261103-v1',
          'previousMicrousd',t.old_micro::text,
          'correctedMicrousd',t.corrected_micro::text,
          'providerCostTicks',t.original_usage->>'cost_in_usd_ticks',
          'originalVisibleOutputTokens',t.visible_output,
          'reasoningTokens',t.reasoning_output))
  from katie_grok_cost_correction_targets t
  where a.id=t.id and a.actual_microusd=t.old_micro and a.state='settled';
  get diagnostics updated_count=row_count;
  if updated_count<>47 then raise exception 'GROK_UPDATE_COUNT_MISMATCH: %',updated_count;end if;

  select count(*) into verified_count
  from public.standalone_provider_attempts a
  where a.provider='grok' and a.state='settled'
    and a.evidence#>>'{historicalCostCorrection,version}'='xai-reported-ticks-20261103-v1'
    and a.actual_microusd=ceil((a.usage->>'cost_in_usd_ticks')::numeric/10000)
    and (a.usage->>'outputTokens')::numeric=
      (a.usage->>'completion_tokens')::numeric+
      (a.usage#>>'{completion_tokens_details,reasoning_tokens}')::numeric;
  if verified_count<>47 then raise exception 'GROK_POST_CORRECTION_VERIFICATION_FAILED';end if;
end
$grok_repair$;
commit;
