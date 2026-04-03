create table if not exists public.model_registry (
  provider_name text not null,
  model_id text not null,
  normalized_model_id text not null,
  discovered_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  is_active boolean not null default true,
  discovery_status text not null default 'discovered',
  pricing_status text not null default 'missing',
  capability_status text not null default 'missing',
  routing_eligibility text not null default 'manual_override_only',
  confidence_score numeric not null default 0,
  confidence_tier text not null default 'low',
  source_metadata jsonb not null default '{}'::jsonb,
  pricing_input_per_1m numeric,
  pricing_output_per_1m numeric,
  supports_text boolean,
  supports_vision boolean,
  supports_web_search boolean,
  supports_image_generation boolean,
  supports_video boolean,
  reasoning_tier text,
  speed_tier text,
  cost_tier text,
  capability_verified_at timestamptz,
  pricing_verified_at timestamptz,
  verification_updated_at timestamptz,
  failure_reason text,
  exception_count integer not null default 0,
  last_exception_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider_name, normalized_model_id)
);

create index if not exists model_registry_provider_active_idx
  on public.model_registry(provider_name, is_active);

create index if not exists model_registry_routing_idx
  on public.model_registry(routing_eligibility, confidence_tier);

create or replace function public.set_model_registry_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if tg_op = 'INSERT' and new.first_seen_at is null then
    new.first_seen_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_model_registry_updated_at on public.model_registry;
create trigger trg_model_registry_updated_at
before insert or update on public.model_registry
for each row execute function public.set_model_registry_updated_at();
