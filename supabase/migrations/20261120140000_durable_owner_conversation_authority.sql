-- Keep an owner's ability to open new conversations independent of deletable chats.
-- Self-tool execution grants remain per-chat; this does NOT create those grants.
-- Applied exclusively by the protected production migration workflow.
BEGIN;

CREATE TABLE IF NOT EXISTS public.standalone_owner_conversation_authority (
  owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
ALTER TABLE public.standalone_owner_conversation_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.standalone_owner_conversation_authority
  FROM PUBLIC, anon, authenticated, service_role;

-- One-time, independently verified bootstrap: the sole non-guest owner must
-- already possess a live, appropriately bound self-tool grant. A mere chat,
-- actor name, browser-supplied UUID, or unverified binding cannot seed access.
INSERT INTO public.standalone_owner_conversation_authority(owner_id)
SELECT u.id
FROM auth.users u
WHERE u.is_anonymous IS FALSE
  AND (SELECT count(*) FROM auth.users WHERE is_anonymous IS FALSE) = 1
  AND EXISTS (
    SELECT 1
    FROM public.self_tool_owner_grants g
    JOIN public.chats c
      ON c.id = g.chat_id AND c.actor_id = g.actor_id
    JOIN public.actors a ON a.id = g.actor_id
    JOIN public.standalone_owner_bindings b
      ON b.owner_id = g.owner_id
      AND b.actor_id = g.actor_id
      AND b.chat_id = g.chat_id
      AND b.revoked_at IS NULL
    WHERE g.owner_id = u.id
      AND coalesce(a.actor_kind, 'standard') = 'standard'
      AND NOT EXISTS (SELECT 1 FROM public.managed_agents m WHERE m.actor_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM public.standalone_guest_workspaces w WHERE w.actor_id = a.id)
  )
ON CONFLICT (owner_id) DO NOTHING;

-- Same-actor self-tool access remains a valid enrollment proof. For the sole
-- permanent owner, the explicitly provisioned durable authority replaces the
-- old cross-actor proof tied to a chat that could be deleted at any time.
CREATE OR REPLACE FUNCTION public.standalone_create_conversation(
  p_owner uuid, p_actor uuid, p_chat uuid, p_title text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c chats;
BEGIN
  IF p_owner IS NULL OR p_actor IS NULL OR p_chat IS NULL
     OR length(trim(p_title)) NOT BETWEEN 1 AND 1000
  THEN RAISE EXCEPTION 'STANDALONE_SCOPE_INVALID'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_chat::text, 0));
  PERFORM 1 FROM actors a
  WHERE a.id = p_actor
    AND coalesce(a.actor_kind, 'standard') = 'standard'
    AND NOT EXISTS (SELECT 1 FROM managed_agents m WHERE m.actor_id = a.id)
  FOR KEY SHARE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'STANDALONE_SCOPE_INVALID'; END IF;

  PERFORM 1 FROM self_tool_owner_grants g
  JOIN chats access_chat
    ON access_chat.id = g.chat_id AND access_chat.actor_id = g.actor_id
  WHERE g.owner_id = p_owner AND g.actor_id = p_actor
  FOR KEY SHARE OF g, access_chat;

  IF NOT FOUND THEN
    -- An owner authority grant is an account-level capability, NOT a
    -- conversation-level tool permission. Ordinary users cannot create it.
    -- Lock against concurrent revocation until this creation commits.
    PERFORM 1 FROM standalone_owner_conversation_authority authority
    JOIN auth.users u ON u.id = authority.owner_id
    WHERE authority.owner_id = p_owner
      AND authority.revoked_at IS NULL
      AND u.is_anonymous IS FALSE
      AND (SELECT count(*) FROM auth.users WHERE is_anonymous IS FALSE) = 1
      AND NOT EXISTS (SELECT 1 FROM standalone_guest_workspaces w WHERE w.actor_id = p_actor)
    FOR SHARE OF authority, u;
    IF NOT FOUND THEN RAISE EXCEPTION 'STANDALONE_ACTOR_ACCESS_DENIED'; END IF;
  END IF;

  SELECT * INTO c FROM chats WHERE id = p_chat;
  IF FOUND THEN
    IF c.actor_id IS DISTINCT FROM p_actor
       OR NOT standalone_verify_scope(p_owner, p_actor, p_chat)
    THEN RAISE EXCEPTION 'STANDALONE_SCOPE_DENIED'; END IF;
    RETURN to_jsonb(c);
  END IF;
  IF EXISTS (SELECT 1 FROM standalone_owner_bindings WHERE chat_id = p_chat)
  THEN RAISE EXCEPTION 'STANDALONE_SCOPE_REVOKED'; END IF;

  INSERT INTO chats(id, actor_id, title)
  VALUES(p_chat, p_actor, trim(p_title)) RETURNING * INTO c;
  PERFORM standalone_bind_scope(p_owner, p_actor, p_chat);
  INSERT INTO short_term_memory(actor_id, chat_id, content)
    VALUES(p_actor, p_chat, '{}'::jsonb)
    ON CONFLICT(actor_id, chat_id) DO NOTHING;
  INSERT INTO intermediate_memory(actor_id, chat_id, content)
    VALUES(p_actor, p_chat, '{}'::jsonb)
    ON CONFLICT(actor_id, chat_id) DO NOTHING;
  RETURN to_jsonb(c);
END
$function$;

REVOKE ALL ON FUNCTION public.standalone_create_conversation(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.standalone_create_conversation(uuid, uuid, uuid, text)
  TO service_role;

COMMIT;
