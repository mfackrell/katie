-- Read-only, bounded evidence from existing private receipts; no new quality rankings.
create or replace function public.standalone_routing_observations(
 p_owner uuid,p_actor uuid,p_chat uuid,p_request text,p_intent text
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare observations jsonb; overhead text;
begin
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'STANDALONE_SCOPE_DENIED'; end if;
 select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) into observations from (
  select w.request_id,w.updated_at as observed_at,
   w.checkpoints->'routing-delivery-audit:v1'->>'provider' as provider,
   w.checkpoints->'routing-delivery-audit:v1'->>'model' as model,
   w.checkpoints->'routing-delivery-audit:v1'->>'status' as status,
   w.checkpoints->'routing-delivery-audit:v1'->>'reason' as reason,
   p_intent as intent, a.output_tokens,a.cache_hit_tokens,a.attempts,h.overhead_micro_usd
  from standalone_workflows w
  left join lateral (
   select case when bool_and(s.state='settled') then ceil(avg((s.usage->>'outputTokens')::bigint))::bigint end as output_tokens,
    case when bool_and(s.state='settled') then ceil(avg((s.usage->>'cachedInputTokens')::bigint))::bigint end as cache_hit_tokens,count(*)::int as attempts
   from standalone_provider_attempts s
   where s.owner_id=p_owner and s.actor_id=p_actor and s.chat_id=p_chat
    and s.request_id=w.request_id and s.category='chat'
    and s.provider=w.checkpoints->'routing-delivery-audit:v1'->>'provider'
    and s.model=w.checkpoints->'routing-delivery-audit:v1'->>'model'
  ) a on true
  left join lateral (
   select case when count(*)>0 and count(*) filter(where s.state<>'settled')=0 then coalesce(sum(s.actual_microusd),0)::text else null end as overhead_micro_usd
   from standalone_provider_attempts s where s.owner_id=p_owner and s.actor_id=p_actor
    and s.chat_id=p_chat and s.request_id=w.request_id and s.category<>'chat'
  ) h on true
  where w.owner_id=p_owner and w.actor_id=p_actor and w.chat_id=p_chat
   and w.request_id<>p_request and w.status='completed' and w.updated_at>=now()-interval '30 days'
   and w.checkpoints->'routing-delivery-audit:v1'->>'classifiedIntent'=p_intent
   and w.checkpoints->'routing-delivery-audit:v1'->>'status' in ('pass','fail')
  order by w.updated_at desc limit 100
 ) e;
 select case when count(*)>0 and count(*) filter(where state<>'settled')=0 then coalesce(sum(actual_microusd),0)::text else null end into overhead
 from standalone_provider_attempts where owner_id=p_owner and actor_id=p_actor and chat_id=p_chat and request_id=p_request;
 return jsonb_build_object('observations',observations,'overhead_micro_usd',overhead);
end $$;
revoke all on function public.standalone_routing_observations(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.standalone_routing_observations(uuid,uuid,uuid,text,text) to service_role;
