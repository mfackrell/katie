create table if not exists public.repo_sync_runs (
  id uuid primary key default gen_random_uuid(),
  repository_full_name text not null,
  before_sha text not null,
  after_sha text not null,
  commit_sha text not null,
  commit_index integer not null,
  status text not null default 'queued',
  changed_files_count integer not null default 0,
  deleted_files_count integer not null default 0,
  processed_changed_files_count integer not null default 0,
  processed_deleted_files_count integer not null default 0,
  failed_files_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists repo_sync_runs_repository_created_idx
  on public.repo_sync_runs(repository_full_name, created_at desc);

create table if not exists public.repo_sync_run_files (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.repo_sync_runs(id) on delete cascade,
  file_path text not null,
  change_type text not null check (change_type in ('changed', 'deleted')),
  status text not null default 'pending',
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists repo_sync_run_files_run_status_idx
  on public.repo_sync_run_files(run_id, status, created_at);

create table if not exists public.repo_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.repo_sync_runs(id) on delete cascade,
  status text not null default 'queued',
  attempts integer not null default 0,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists repo_sync_jobs_status_created_idx
  on public.repo_sync_jobs(status, created_at);

create or replace function public.set_repo_sync_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_repo_sync_runs_updated_at on public.repo_sync_runs;
create trigger trg_repo_sync_runs_updated_at
before insert or update on public.repo_sync_runs
for each row execute function public.set_repo_sync_updated_at();

drop trigger if exists trg_repo_sync_run_files_updated_at on public.repo_sync_run_files;
create trigger trg_repo_sync_run_files_updated_at
before insert or update on public.repo_sync_run_files
for each row execute function public.set_repo_sync_updated_at();

drop trigger if exists trg_repo_sync_jobs_updated_at on public.repo_sync_jobs;
create trigger trg_repo_sync_jobs_updated_at
before insert or update on public.repo_sync_jobs
for each row execute function public.set_repo_sync_updated_at();
