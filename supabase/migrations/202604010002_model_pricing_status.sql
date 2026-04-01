alter table public.model_pricing
  alter column cost_tier drop not null;

alter table public.model_pricing
  add column if not exists pricing_status text not null default 'metadata_only';

update public.model_pricing
set pricing_status = case
  when input_cost_per_1m is not null or output_cost_per_1m is not null then 'complete'
  else 'metadata_only'
end
where pricing_status is distinct from case
  when input_cost_per_1m is not null or output_cost_per_1m is not null then 'complete'
  else 'metadata_only'
end;

alter table public.model_pricing
  drop constraint if exists model_pricing_pricing_status_check;

alter table public.model_pricing
  add constraint model_pricing_pricing_status_check check (pricing_status in ('complete', 'metadata_only', 'failed'));
