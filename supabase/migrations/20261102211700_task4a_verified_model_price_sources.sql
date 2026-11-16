-- Task 4A: narrowly pin independently published Standard API token prices.
-- Observed 2026-11-02 from the model-specific public provider pages.
-- Never downgrade a newer independently verified record, alter unrelated
-- models, or replace prices that no longer match the published rates.
-- A stale verification (>24 hours) fails closed at financial admission.
update public.model_registry set
 pricing_status='verified',
 pricing_verified_at='2026-11-02T20:45:00Z'::timestamptz,
 verification_updated_at=now(),
 source_metadata=coalesce(source_metadata,'{}'::jsonb)||
  jsonb_build_object('pricing_verification_source',
   'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
   'pricing_verification_observed_at','2026-11-02T20:45:00Z',
   'pricing_service_tier','default','pricing_context','standard API')
where provider_name='openai' and model_id='gpt-5.6-sol'
 and is_active=true and pricing_input_per_1m=4 and pricing_output_per_1m=20
 and (pricing_status='estimated' or pricing_status='missing'
  or (pricing_status='verified' and pricing_verified_at<'2026-11-02T20:45:00Z'::timestamptz));

update public.model_registry set
 pricing_status='verified',
 pricing_verified_at='2026-11-02T20:45:00Z'::timestamptz,
 verification_updated_at=now(),
 source_metadata=coalesce(source_metadata,'{}'::jsonb)||
  jsonb_build_object('pricing_verification_source',
   'https://developers.openai.com/api/docs/models/gpt-5.3-codex',
   'pricing_verification_observed_at','2026-11-02T20:45:00Z',
   'pricing_service_tier','default','pricing_context','standard API')
where provider_name='openai' and model_id='gpt-5.3-codex'
 and is_active=true and pricing_input_per_1m=1.75 and pricing_output_per_1m=14
 and (pricing_status='estimated' or pricing_status='missing'
  or (pricing_status='verified' and pricing_verified_at<'2026-11-02T20:45:00Z'::timestamptz));
