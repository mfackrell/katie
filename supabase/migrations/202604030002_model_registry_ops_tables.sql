create table if not exists public.model_registry_refresh_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('running', 'completed', 'failed')),
  providers jsonb not null default '[]'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists model_registry_refresh_runs_status_idx
  on public.model_registry_refresh_runs(status, started_at desc);

create table if not exists public.model_registry_exceptions (
  id bigserial primary key,
  provider_name text not null,
  model_id text,
  normalized_model_id text not null,
  exception_type text not null,
  exception_reason text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists model_registry_exceptions_provider_model_idx
  on public.model_registry_exceptions(provider_name, normalized_model_id, occurred_at desc);

create table if not exists public.model_registry_manual_overrides (
  provider_name text not null,
  normalized_model_id text not null,
  routing_eligibility_override text not null check (routing_eligibility_override in ('verified', 'restricted', 'manual_override_only', 'disabled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider_name, normalized_model_id)
);

create or replace function public.set_model_registry_override_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_model_registry_override_updated_at on public.model_registry_manual_overrides;
create trigger trg_model_registry_override_updated_at
before update on public.model_registry_manual_overrides
for each row execute function public.set_model_registry_override_updated_at();
