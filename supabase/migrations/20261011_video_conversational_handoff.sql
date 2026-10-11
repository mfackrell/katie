alter table public.chat_requests add column if not exists video_reply_provider text;
alter table public.chat_requests add column if not exists video_reply_model text;
alter table public.chat_requests add column if not exists video_synthesis_state text;
alter table public.chat_requests add column if not exists video_synthesis_started_at timestamptz;
alter table public.chat_requests add column if not exists video_synthesis_text text;
alter table public.chat_requests add column if not exists video_synthesis_model text;
alter table public.chat_requests add column if not exists video_synthesis_error text;
