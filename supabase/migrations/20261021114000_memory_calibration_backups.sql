-- Calibration backups are restoration artifacts, not searchable memory evidence.
-- Retain full snapshots separately so cleaning memories never destroys history.
create table if not exists public.actor_memory_calibration_backups (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.actors(id) on delete cascade,
  memory_revision bigint not null,
  memory_content jsonb not null,
  approved_changes jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists actor_memory_calibration_backups_actor_created
  on public.actor_memory_calibration_backups(actor_id, created_at desc);
alter table public.actor_memory_calibration_backups enable row level security;
revoke all on public.actor_memory_calibration_backups from anon, authenticated;
grant select, insert on public.actor_memory_calibration_backups to service_role;
