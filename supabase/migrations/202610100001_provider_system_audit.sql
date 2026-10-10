-- Capture the exact system-role strings prepared for a provider request so the
-- chat owner can inspect what Katie actually sent without calling another LLM.
-- The snapshot deliberately omits credentials, file bytes and multimodal data.
alter table public.chat_requests
  add column if not exists provider_system_audit jsonb;

comment on column public.chat_requests.provider_system_audit is
  'Last outbound generation provider system-message snapshot; scoped to actor and chat and read only by service role.';
