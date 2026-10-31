-- An internal worker may use only the owner of an already-claimed reaction job.
create function public.standalone_reaction_reply_owner(p_job bigint,p_request uuid,p_actor uuid,p_chat uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid;
begin
 select b.owner_id into v_owner
 from reaction_reply_jobs j
 join actor_reaction_events e on e.id=j.event_id and e.actor_id=j.actor_id and e.chat_id=j.chat_id and e.message_id=j.message_id
 join messages m on m.id=j.message_id and m.chat_id=j.chat_id and m.actor_id=j.actor_id and m.role='assistant'
 join standalone_owner_bindings b on b.actor_id=j.actor_id and b.chat_id=j.chat_id
 where j.id=p_job and j.request_id=p_request and j.actor_id=p_actor and j.chat_id=p_chat
 and j.status='processing' and j.lease_until>now()
 and standalone_verify_scope(b.owner_id,j.actor_id,j.chat_id);
 if v_owner is null then raise exception 'Reaction owner not verified'; end if;
 return v_owner;
end $$;
revoke all on function public.standalone_reaction_reply_owner(bigint,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.standalone_reaction_reply_owner(bigint,uuid,uuid,uuid) to service_role;
