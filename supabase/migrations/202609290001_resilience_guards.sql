create table if not exists chat_requests (
  request_id text primary key,
  actor_id text not null,
  chat_id text not null,
  request_fingerprint text not null,
  status text not null check (status in ('processing','completed','failed')),
  assistant_message_id text,
  assistant_model text,
  assistant_content text,
  assistant_assets jsonb not null default '[]'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_chat_requests_chat_created
  on chat_requests(chat_id, created_at desc);

create table if not exists provider_health (
  provider_name text primary key,
  status text not null check (status in ('blocked','healthy')),
  reason text,
  failure_count integer not null default 0,
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_provider_health_blocked_until
  on provider_health(blocked_until);
