alter table if exists public.actors
  add column if not exists routing_profile jsonb;
