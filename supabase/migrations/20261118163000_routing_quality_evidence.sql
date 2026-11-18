-- Extend the existing private routing evidence RPC. Source records remain in
-- existing messages, reactions, chat requests, and standalone ledger tables.
-- No inference calls or new feedback scoring/persistence service are introduced.
create index if not exists standalone_workflows_routing_quality_recent
 on public.standalone_workflows
 (owner_id, actor_id, chat_id, ((checkpoints->'routing-delivery-audit:v1'->>'classifiedIntent')), updated_at desc)
 where status='completed';

create index if not exists chat_requests_routing_quality_assistant
 on public.chat_requests (assistant_message_id)
 where assistant_message_id is not null;

create index if not exists messages_routing_quality_actor_recent
 on public.messages (actor_id, created_at desc) where role='user';

create index if not exists messages_routing_quality_chat_recent
 on public.messages (actor_id, chat_id, created_at desc);

create or replace function public.standalone_routing_observations(
 p_owner uuid,p_actor uuid,p_chat uuid,p_request text,p_intent text
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare observations jsonb; overhead text; feedback jsonb;
begin
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then
   raise exception 'STANDALONE_SCOPE_DENIED';
 end if;

 -- Limit the indexed, task-scoped receipt set BEFORE per-request aggregates.
 -- Previously aggregates were executed against a large unordered workflow scan.
 select coalesce(jsonb_agg(to_jsonb(e) order by e.observed_at desc),'[]'::jsonb)
 into observations from (
  select w.request_id,w.observed_at,
   w.audit->>'provider' as provider,
   w.audit->>'model' as model,
   w.audit->>'status' as status,
   w.audit->>'reason' as reason,
   p_intent as intent,a.output_tokens,a.cache_hit_tokens,a.attempts,h.overhead_micro_usd
  from (
   select request_id,updated_at as observed_at,
    checkpoints->'routing-delivery-audit:v1' as audit
   from standalone_workflows
   where owner_id=p_owner and actor_id=p_actor and chat_id=p_chat
    and request_id<>p_request and status='completed'
    and updated_at>=now()-interval '30 days'
    and checkpoints->'routing-delivery-audit:v1'->>'classifiedIntent'=p_intent
   order by updated_at desc limit 100
  ) w
  left join lateral (
   select case when bool_and(s.state='settled') then ceil(avg((s.usage->>'outputTokens')::bigint))::bigint end as output_tokens,
    case when bool_and(s.state='settled') then ceil(avg((s.usage->>'cachedInputTokens')::bigint))::bigint end as cache_hit_tokens,
    count(*)::int as attempts
   from standalone_provider_attempts s
   where s.owner_id=p_owner and s.actor_id=p_actor and s.chat_id=p_chat
    and s.request_id=w.request_id and s.category='chat'
    and s.provider=w.audit->>'provider' and s.model=w.audit->>'model'
  ) a on true
  left join lateral (
   select case when count(*)>0 and count(*) filter(where s.state<>'settled')=0
    then coalesce(sum(s.actual_microusd),0)::text else null end as overhead_micro_usd
   from standalone_provider_attempts s
   where s.owner_id=p_owner and s.actor_id=p_actor and s.chat_id=p_chat
    and s.request_id=w.request_id and s.category<>'chat'
  ) h on true
 ) e;

 select case when count(*)>0 and count(*) filter(where state<>'settled')=0
   then coalesce(sum(actual_microusd),0)::text else null end into overhead
 from standalone_provider_attempts
 where owner_id=p_owner and actor_id=p_actor and chat_id=p_chat and request_id=p_request;

 -- Feedback remains sourced and attributable. Reaction does not necessarily
 -- establish response quality; ambiguous emotions are never marked positive.
 -- Explicit adjacent-turn comments are labeled as contextual attribution,
 -- not a verified assessment of model skill. Internal reviews are not user votes.
 with
 reaction_events as (
  select cr.request_id,r.updated_at as observed_at,
   w.checkpoints->'routing-delivery-audit:v1'->>'provider' as provider,
   w.checkpoints->'routing-delivery-audit:v1'->>'model' as model,
   w.checkpoints->'routing-delivery-audit:v1'->>'classifiedIntent' as intent,
   'message_reaction'::text as source,'user_satisfaction'::text as dimension,
   case when r.reaction in ('like','love') then 'positive'
        when r.reaction='dislike' then 'negative'
        else 'ambiguous' end::text as outcome,
   'direct_response_reaction'::text as confidence,
   r.message_id::text as source_id,
   left(prior.content,160)::text as task_excerpt
  from (select * from message_reactions
        where actor_id=p_actor and updated_at>=now()-interval '30 days'
        order by updated_at desc limit 40) r
  join messages am on am.id=r.message_id and am.actor_id=p_actor and am.role='assistant'
  join chat_requests cr on cr.assistant_message_id=am.id::text
    and cr.actor_id=p_actor::text and cr.chat_id=am.chat_id::text and cr.status='completed'
  join standalone_workflows w on w.owner_id=p_owner and w.actor_id=p_actor
    and w.chat_id=am.chat_id and w.request_id=cr.request_id
  left join lateral (
   select m.content from messages m
   where m.actor_id=p_actor and m.chat_id=am.chat_id and m.role='user'
     and m.created_at<am.created_at
   order by m.created_at desc limit 1
  ) prior on true
  where w.checkpoints->'routing-delivery-audit:v1'->>'classifiedIntent'=p_intent
 ),
 explicit_user_feedback as (
  select cr.request_id,um.created_at as observed_at,
   w.checkpoints->'routing-delivery-audit:v1'->>'provider' as provider,
   w.checkpoints->'routing-delivery-audit:v1'->>'model' as model,
   w.checkpoints->'routing-delivery-audit:v1'->>'classifiedIntent' as intent,
   'adjacent_user_feedback'::text as source,
   case when um.content ~* '(repeat|same thing|again and again)' then 'continuity'
        when um.content ~* '(refus|wont|cannot|cant|will not)' then 'answerability'
        when um.content ~* '(wrong|incorrect|not true)' then 'accuracy'
        when um.content ~* '(not what i (asked|wanted|requested)|did not answer|didnt answer|ignored my)' then 'objective_fidelity'
        else 'user_satisfaction' end::text as dimension,
   case when um.content ~* '((your|that|this) (answer|reply|response) (is|was) (great|good|excellent|helpful)|you nailed it|exactly what i asked)' then 'positive'
        else 'negative' end::text as outcome,
   'context_attributed_not_verified'::text as confidence,
   um.id::text as source_id,left(prior.content,160)::text as task_excerpt
  from (
   select id,chat_id,content,created_at from messages
   where actor_id=p_actor and role='user' and created_at>=now()-interval '30 days'
    and (
     content ~* '(you.{0,45}(repeat|same thing|refus|did not answer|didnt answer|ignored my|wrong answer))'
     or content ~* '((that|your|this) (answer|reply|response) (is|was) (wrong|bad|great|good|excellent|helpful))'
     or content ~* '(not what i (asked|wanted|requested)|exactly what i asked|you nailed it)'
    )
   order by created_at desc limit 40
  ) um
  join lateral (
   select a.id,a.created_at from messages a
   where a.actor_id=p_actor and a.chat_id=um.chat_id and a.role='assistant'
     and a.created_at<um.created_at
   order by a.created_at desc limit 1
  ) am on true
  join chat_requests cr on cr.assistant_message_id=am.id::text
    and cr.actor_id=p_actor::text and cr.chat_id=um.chat_id::text and cr.status='completed'
  join standalone_workflows w on w.owner_id=p_owner and w.actor_id=p_actor
    and w.chat_id=um.chat_id and w.request_id=cr.request_id
  left join lateral (
   select m.content from messages m
   where m.actor_id=p_actor and m.chat_id=um.chat_id and m.role='user'
     and m.created_at<am.created_at
   order by m.created_at desc limit 1
  ) prior on true
  where w.checkpoints->'routing-delivery-audit:v1'->>'classifiedIntent'=p_intent
 ),
 review_events as (
  select cr.request_id,cr.updated_at as observed_at,
   w.checkpoints->'routing-delivery-audit:v1'->>'provider' as provider,
   w.checkpoints->'routing-delivery-audit:v1'->>'model' as model,
   w.checkpoints->'routing-delivery-audit:v1'->>'classifiedIntent' as intent,
   'internal_review'::text as source,
   case when cr.review_audit->>'status'='approved' then 'review_approved'
        else 'review_revised' end::text as dimension,
   'ambiguous'::text as outcome,
   'internal_review_selection_biased'::text as confidence,
   cr.request_id::text as source_id,null::text as task_excerpt
  from (select * from chat_requests
        where actor_id=p_actor::text and created_at>=now()-interval '30 days'
          and review_audit is not null and status='completed'
        order by created_at desc limit 40) cr
  join standalone_workflows w on w.owner_id=p_owner and w.actor_id=p_actor
    and w.chat_id=cr.chat_id::uuid and w.request_id=cr.request_id
  where w.checkpoints->'routing-delivery-audit:v1'->>'classifiedIntent'=p_intent
 )
 select coalesce(jsonb_agg(to_jsonb(f) order by f.observed_at desc),'[]'::jsonb)
 into feedback
 from (
  select * from (
   select * from reaction_events
   union all select * from explicit_user_feedback
   union all select * from review_events
  ) src
  where provider is not null and model is not null and request_id<>p_request
  order by observed_at desc limit 40
 ) f;

 return jsonb_build_object('observations',observations,
   'overhead_micro_usd',overhead,'quality_feedback',feedback);
end $$;

revoke all on function public.standalone_routing_observations(uuid,uuid,uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.standalone_routing_observations(uuid,uuid,uuid,text,text)
 to service_role;
