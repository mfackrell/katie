-- Actor-private visual identities refer to immutable, already-saved image messages.
-- Image bytes remain in message assets; no base64 is duplicated in this index.
CREATE TABLE IF NOT EXISTS public.visual_references (
  actor_id uuid NOT NULL REFERENCES public.actors(id) ON DELETE CASCADE,
  subject_key text NOT NULL CHECK (subject_key ~ '^[a-z0-9][a-z0-9 _-]{0,63}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  source_chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  source_message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  asset_index integer NOT NULL DEFAULT 0 CHECK (asset_index BETWEEN 0 AND 4),
  approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, subject_key)
);
CREATE INDEX IF NOT EXISTS visual_references_chat_recent_idx
  ON public.visual_references (actor_id, source_chat_id, updated_at DESC);
ALTER TABLE public.visual_references ENABLE ROW LEVEL SECURITY;
-- This is internal actor memory; the server verifies actor/chat ownership and uses service credentials.
REVOKE ALL ON public.visual_references FROM anon, authenticated;
