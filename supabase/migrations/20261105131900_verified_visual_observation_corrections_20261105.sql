-- Actor-owned, image-hash-bound manual corrections are authoritative over
-- superseded model descriptions. Raw provider reports remain immutable audit data.
create table if not exists public.visual_observation_corrections (
  actor_id uuid not null references public.actors(id) on delete cascade,
  source_chat_id uuid not null references public.chats(id) on delete cascade,
  attachment_id uuid not null,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  description text not null check (length(trim(description)) >= 30),
  correction_model text not null check (correction_model like 'manual:%'),
  corrected_at timestamptz not null,
  original_model text not null,
  source_message_id uuid not null,
  approved_by_user boolean not null default false check (approved_by_user),
  primary key (actor_id, source_chat_id, attachment_id)
);
create index if not exists visual_observation_corrections_actor
  on public.visual_observation_corrections(actor_id);
alter table public.visual_observation_corrections enable row level security;
revoke all on public.visual_observation_corrections from public, anon, authenticated;
grant select on public.visual_observation_corrections to service_role;
comment on table public.visual_observation_corrections is
 'Trusted, owner-approved replacements for erroneous image observations. Source hash must match the retained canonical image; original Qwen observations remain in observationReports.';
