create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_trgm;

create table if not exists repositories (
  id uuid primary key,
  github_owner text not null,
  github_repo text not null,
  default_branch text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(github_owner, github_repo)
);

create table if not exists repo_sync_runs (
  id uuid primary key,
  repository_id uuid not null references repositories(id) on delete cascade,
  mode text not null check (mode in ('full','incremental')),
  status text not null check (status in ('running','success','failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  commit_from text,
  commit_to text,
  files_seen int not null default 0,
  files_indexed int not null default 0,
  chunks_indexed int not null default 0,
  error_message text
);

create table if not exists files (
  id uuid primary key,
  repository_id uuid not null references repositories(id) on delete cascade,
  path text not null,
  language text,
  sha text not null,
  size_bytes int not null,
  is_binary bool not null default false,
  last_indexed_at timestamptz,
  unique(repository_id, path)
);

create table if not exists file_chunks (
  id uuid primary key,
  file_id uuid not null references files(id) on delete cascade,
  chunk_index int not null,
  start_line int not null,
  end_line int not null,
  content text not null,
  content_hash text not null,
  embedding vector(1536),
  token_estimate int not null,
  unique(file_id, chunk_index)
);

create table if not exists symbols (
  id uuid primary key,
  file_id uuid not null references files(id) on delete cascade,
  name text not null,
  kind text not null,
  start_line int not null,
  end_line int not null,
  signature text,
  unique(file_id, name, start_line)
);

create table if not exists file_edges (
  id uuid primary key,
  repository_id uuid not null references repositories(id) on delete cascade,
  from_path text not null,
  to_path text not null,
  edge_type text not null,
  unique(repository_id, from_path, to_path, edge_type)
);

create index if not exists idx_repo_sync_runs_repo on repo_sync_runs(repository_id, started_at desc);
create index if not exists idx_files_repo_path on files(repository_id, path);
create index if not exists idx_file_chunks_file_chunk on file_chunks(file_id, chunk_index);
create index if not exists idx_file_chunks_embedding on file_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists idx_file_chunks_content_trgm on file_chunks using gin (content gin_trgm_ops);
create index if not exists idx_symbols_name on symbols(name);
create index if not exists idx_edges_repo_from on file_edges(repository_id, from_path);
