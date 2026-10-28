-- An owner-authorized, service-role-only, non-retrying replay of a previously
-- persisted photograph. No image bytes or provider credentials in this table.
create table if not exists public.image_replay_trials (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  source_chat_id uuid not null,
  attachment_id uuid not null,
  replay_chat_id uuid,
  request_id text,
  status text not null default 'pending' check (status in ('pending','running','completed','failed')),
  expires_at timestamptz not null,
  model text,
  result_text text,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  unique (source_chat_id, attachment_id)
);
alter table public.image_replay_trials enable row level security;
revoke all on public.image_replay_trials from public, anon, authenticated;
grant select, insert, update on public.image_replay_trials to service_role;
