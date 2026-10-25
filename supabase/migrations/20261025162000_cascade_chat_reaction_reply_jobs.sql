-- Reconcile the production hotfix into the GitHub-authoritative migration ledger.
-- This is intentionally idempotent: Supabase native history already records
-- cascade_delete_chat_reaction_reply_jobs applied directly on 2026-10-25.
-- GitHub Actions remains the sole automated production migration writer.
DO $$
DECLARE existing_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO existing_definition
  FROM pg_constraint
  WHERE conrelid = 'public.reaction_reply_jobs'::regclass
    AND conname = 'reaction_reply_jobs_chat_id_fkey'
    AND contype = 'f';

  IF existing_definition IS NULL THEN
    ALTER TABLE public.reaction_reply_jobs
      ADD CONSTRAINT reaction_reply_jobs_chat_id_fkey
      FOREIGN KEY (chat_id) REFERENCES public.chats(id) ON DELETE CASCADE;
  ELSIF existing_definition NOT LIKE '%ON DELETE CASCADE%' THEN
    ALTER TABLE public.reaction_reply_jobs
      DROP CONSTRAINT reaction_reply_jobs_chat_id_fkey;
    ALTER TABLE public.reaction_reply_jobs
      ADD CONSTRAINT reaction_reply_jobs_chat_id_fkey
      FOREIGN KEY (chat_id) REFERENCES public.chats(id) ON DELETE CASCADE;
  END IF;
END $$;
