CREATE TABLE IF NOT EXISTS public.video_upload_handoffs (
  request_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES public.actors(id) ON DELETE CASCADE,
  chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  request_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready','dispatching','dispatched','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.video_upload_handoff_files (
  request_id uuid NOT NULL REFERENCES public.video_upload_handoffs(request_id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes BETWEEN 1 AND 209715200),
  upload_id uuid UNIQUE,
  upload_token text,
  file_reference jsonb,
  PRIMARY KEY (request_id, ordinal),
  CHECK ((upload_id IS NULL) = (upload_token IS NULL))
);
CREATE INDEX IF NOT EXISTS video_upload_handoffs_pending_idx
ON public.video_upload_handoffs (status, updated_at)
WHERE status IN ('uploading','ready','dispatching');
CREATE INDEX IF NOT EXISTS video_upload_handoff_files_upload_idx ON public.video_upload_handoff_files(upload_id);
ALTER TABLE public.video_upload_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_upload_handoff_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.video_upload_handoffs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.video_upload_handoff_files FROM PUBLIC, anon, authenticated;
