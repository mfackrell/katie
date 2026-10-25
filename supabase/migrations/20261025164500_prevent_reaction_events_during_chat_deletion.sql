-- Avoid logging a removed reaction when its parent chat/message is being deleted.
-- Preserve audit events for ordinary reaction removals.
CREATE OR REPLACE FUNCTION public.record_actor_reaction_event()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.chats WHERE id = OLD.chat_id)
      OR NOT EXISTS (SELECT 1 FROM public.messages WHERE id = OLD.message_id) THEN
      RETURN OLD;
    END IF;
    INSERT INTO public.actor_reaction_events(actor_id,chat_id,message_id,reaction,event_type)
    VALUES (OLD.actor_id,OLD.chat_id,OLD.message_id,NULL,'removed');
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.actor_reaction_events(actor_id,chat_id,message_id,reaction,event_type)
    VALUES (NEW.actor_id,NEW.chat_id,NEW.message_id,NEW.reaction,'added');
    RETURN NEW;
  ELSIF OLD.reaction IS DISTINCT FROM NEW.reaction THEN
    INSERT INTO public.actor_reaction_events(actor_id,chat_id,message_id,reaction,event_type)
    VALUES (NEW.actor_id,NEW.chat_id,NEW.message_id,NEW.reaction,'changed');
  END IF;
  RETURN NEW;
END;
$function$;
