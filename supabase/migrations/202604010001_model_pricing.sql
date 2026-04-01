create table if not exists public.model_pricing (
  provider_name text not null,
  model_id text not null,
  input_cost_per_1m numeric null,
  output_cost_per_1m numeric null,
  cached_input_cost_per_1m numeric null,
  cached_output_cost_per_1m numeric null,
  supports_web_search boolean null,
  supports_vision boolean null,
  supports_video boolean null,
  supports_image_generation boolean null,
  reasoning_depth_tier text null,
  speed_tier text null,
  cost_tier text not null,
  source text not null,
  source_url text null,
  source_updated_at timestamptz null,
  refreshed_at timestamptz not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint model_pricing_provider_model_key unique (provider_name, model_id),
  constraint model_pricing_cost_tier_check check (cost_tier in ('low', 'medium', 'high')),
  constraint model_pricing_reasoning_depth_check check (reasoning_depth_tier is null or reasoning_depth_tier in ('low', 'medium', 'high')),
  constraint model_pricing_speed_tier_check check (speed_tier is null or speed_tier in ('slow', 'medium', 'fast'))
);

create index if not exists model_pricing_provider_idx on public.model_pricing(provider_name);
create index if not exists model_pricing_active_idx on public.model_pricing(provider_name, is_active);

create or replace function public.touch_model_pricing_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists model_pricing_touch_updated_at on public.model_pricing;
create trigger model_pricing_touch_updated_at
before update on public.model_pricing
for each row
execute function public.touch_model_pricing_updated_at();
