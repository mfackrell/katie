-- Carry complete source and approved requirements alongside immutable receipts.
-- These are character limits only; native reservation and all spending caps remain unchanged.
create or replace function public.project_evidence_limit(p_profile text,p_phase text)
returns integer language sql immutable security invoker set search_path=public as $$
 select case when p_profile='game' and p_phase='specification' then 60000
  when p_profile='game' and p_phase in ('development','assessment') then 96000 else 30000 end;
$$;
revoke all on function public.project_evidence_limit(text,text) from public,anon,authenticated;
grant execute on function public.project_evidence_limit(text,text) to service_role;

-- An incomplete response on the last call retains its technical provenance.
-- One bounded checkpointed continuation can finish it without resetting counters.
do $migration$ declare definition text;needle text:= $needle$j.result->>'reviewStageDeferred'='true'$needle$;begin
 select pg_get_functiondef('public.resume_incomplete_game_review(uuid,uuid,uuid,jsonb)'::regprocedure) into definition;
 if position(needle in definition)=0 then raise exception 'Expected technical recovery fence missing';end if;
 definition:=replace(definition,needle,needle||$extension$ or (j.result->>'admissionDenied'='true' and (j.result->>'callsRemaining'='0' and m.calls>=m.max_calls or j.result->>'routingCallsRemaining'='0' and m.routing_calls>=m.max_calls*3 or j.result->>'remainingTokens'='0' and greatest(m.actual_tokens,m.reserved_tokens)>=120000))$extension$);
 execute definition;
end $migration$;
