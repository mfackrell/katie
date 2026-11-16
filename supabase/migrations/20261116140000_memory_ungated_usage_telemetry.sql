-- Memory maintenance usage is operational telemetry, NOT a spending gate.
-- No reservation/approval/lease dependency; no prompts or model outputs stored.
create table if not exists public.memory_provider_usage (
  request_id uuid primary key,
  created_at timestamptz not null default now(),
  owner_id uuid,
  actor_id uuid,
  chat_id uuid,
  activity text not null check (activity in ('memory-summary','memory-relevance','memory-edit','memory-maintenance','memory-extraction')),
  provider text not null check (provider in ('openai','anthropic','grok','google')),
  model text not null,
  endpoint text not null,
  status text not null check (status in ('completed','http_error','transport_error')),
  http_status integer,
  input_tokens bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  cache_write_input_tokens bigint,
  cost_microusd numeric(30,0),
  pricing_version text not null,
  elapsed_ms bigint not null
);
create index if not exists memory_provider_usage_created_idx on public.memory_provider_usage(created_at desc);
create index if not exists memory_provider_usage_owner_idx on public.memory_provider_usage(owner_id,created_at desc);
alter table public.memory_provider_usage enable row level security;
revoke all on public.memory_provider_usage from public, anon, authenticated;
grant select, insert on public.memory_provider_usage to service_role;
