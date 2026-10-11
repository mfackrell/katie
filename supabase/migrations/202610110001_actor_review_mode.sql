alter table public.actors
  add column if not exists review_mode text not null default 'adaptive'
  check (review_mode in ('adaptive', 'always', 'off'));

alter table public.chat_requests
  add column if not exists review_audit jsonb;
