-- Private, append-only evidence explaining automatic saved-file selection.
-- Captures a short model-stated relevance rationale, not hidden reasoning.
-- No raw prompts, original files, pixels or source observation summaries.
create table if not exists public.attachment_selection_diagnostics (
  actor_id uuid not null,
  chat_id uuid not null,
  request_id text not null,
  selection_method text not null,
  selector_rationale text check (selector_rationale is null or char_length(selector_rationale) <= 400),
  context_signals jsonb not null default '{}'::jsonb,
  selected_files jsonb not null default '[]'::jsonb check (jsonb_typeof(selected_files) = 'array'),
  created_at timestamptz not null default now(),
  primary key (actor_id, chat_id, request_id)
);
create index if not exists attachment_selection_diagnostics_chat_time
  on public.attachment_selection_diagnostics (actor_id, chat_id, created_at desc);
alter table public.attachment_selection_diagnostics enable row level security;
revoke all on public.attachment_selection_diagnostics from public, anon, authenticated, service_role;
grant select, insert on public.attachment_selection_diagnostics to service_role;
