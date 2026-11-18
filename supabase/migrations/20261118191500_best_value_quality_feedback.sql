-- Best Value only: bounded, source-linked feedback across intent labels.
-- The existing standalone_routing_observations RPC and Best Answer payload remain unchanged.
-- Task comparability is assessed by the existing selection LLM, not by label equality.
create index if not exists chat_requests_best_value_completed
  on public.chat_requests(actor_id,chat_id,completed_at desc)
  where status='completed';

create or replace function public.standalone_best_value_quality_feedback(
 p_owner uuid, p_actor uuid, p_chat uuid, p_request text
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare feedback jsonb;
begin
  if not public.standalone_verify_scope(p_owner,p_actor,p_chat) then
    raise exception 'STANDALONE_SCOPE_DENIED';
  end if;

  with recent_users as (
    select u.id,u.chat_id,u.created_at,
      case when left(ltrim(u.content),8)='{"text":'
        then u.content::jsonb->>'text' else u.content end as feedback_text
    from public.messages u
    where u.actor_id=p_actor and u.chat_id=p_chat and u.role='user'
      and u.created_at >= now()-interval '30 days'
    order by u.created_at desc limit 80
  ), classified_users as (
    select u.*,
      u.feedback_text ~* $negative$((that|this|your)([[:space:]]+(answer|reply|response|turn))?[[:space:]]+(was|is|has[[:space:]]+been)[[:space:]]+((really|so|very|absolutely|completely)[[:space:]]+)?(terrible|awful|bad|wrong|poor|horrible|unhelpful|repetitive))|(you[[:space:]]+(aren't|aren’t|are[[:space:]]+not|don't|don’t|do[[:space:]]+not)[[:space:]]+(understanding|understand|listening|following))|((you('re|’re|[[:space:]]+are)?[[:space:]]+)(keep[[:space:]]+)?repeating[[:space:]]+yourself)|((that|this|your)([[:space:]]+(answer|reply|response))?[[:space:]]+(completely[[:space:]]+)?(missed|misses)[[:space:]]+the[[:space:]]+point)|(not[[:space:]]+what[[:space:]]+i[[:space:]]+(asked|wanted|requested))|(did[[:space:]]+not[[:space:]]+answer[[:space:]]+my[[:space:]]+question)$negative$ as is_negative,
      u.feedback_text ~* $positive$((that|this|your)([[:space:]]+(answer|reply|response|turn))?[[:space:]]+(was|is|has[[:space:]]+been)[[:space:]]+((so|much|really|way|absolutely|completely)[[:space:]]+)?(better|good|great|excellent|helpful|perfect|fantastic|spot[[:space:]]+on|exactly[[:space:]]+right))|(you[[:space:]]+nailed[[:space:]]+it)|((this|that)[[:space:]]+is[[:space:]]+exactly[[:space:]]+(the[[:space:]]+kind[[:space:]]+of[[:space:]]+response[[:space:]]+i[[:space:]]+wanted|what[[:space:]]+i[[:space:]]+wanted))|(exactly[[:space:]]+what[[:space:]]+i[[:space:]]+asked)$positive$ as is_positive
    from recent_users u
  ), direct_feedback as (
    select cr.request_id,u.created_at as observed_at,
      w.checkpoints->'routing-delivery-audit:v1'->>'provider' as provider,
      w.checkpoints->'routing-delivery-audit:v1'->>'model' as model,
      w.checkpoints->'routing-delivery-audit:v1'->>'classifiedIntent' as intent,
      'adjacent_user_feedback'::text as source,
      case when u.feedback_text ~* '(repeat|repetitive)' then 'continuity'
           when u.feedback_text ~* '(understand|listening|following|missed[[:space:]]+the[[:space:]]+point|not[[:space:]]+what[[:space:]]+i)' then 'objective_fidelity'
           when u.feedback_text ~* '(wrong|incorrect)' then 'accuracy'
           else 'user_satisfaction' end::text as dimension,
      case when u.is_negative and u.is_positive then 'ambiguous'
           when u.is_negative then 'negative'
           else 'positive' end::text as outcome,
      'explicit_next_turn_comment_context_attributed'::text as confidence,
      u.id::text as source_id,
      left(prior.content,160)::text as task_excerpt
    from classified_users u
    join lateral (
      select c.request_id,c.completed_at,c.updated_at,c.assistant_message_id
      from public.chat_requests c
      where c.actor_id=p_actor::text and c.chat_id=p_chat::text
        and c.status='completed' and c.assistant_content is not null
        and c.request_id<>p_request
        and coalesce(c.completed_at,c.updated_at) < u.created_at
        and coalesce(c.completed_at,c.updated_at) >= u.created_at-interval '90 minutes'
      order by coalesce(c.completed_at,c.updated_at) desc limit 1
    ) cr on true
    join public.standalone_workflows w
      on w.owner_id=p_owner and w.actor_id=p_actor and w.chat_id=p_chat
      and w.request_id=cr.request_id and w.status='completed'
    left join lateral (
      select m.content from public.messages m
      where m.actor_id=p_actor and m.chat_id=p_chat and m.role='user'
        and m.created_at < u.created_at
      order by m.created_at desc limit 1
    ) prior on true
    where (u.is_negative or u.is_positive)
      and not exists (
        select 1 from public.messages intervening
        where intervening.actor_id=p_actor and intervening.chat_id=p_chat
          and intervening.role='user'
          and intervening.created_at > coalesce(cr.completed_at,cr.updated_at)
          and intervening.created_at < u.created_at
      )
  ), reaction_feedback as (
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
    from (
      select * from public.message_reactions
      where actor_id=p_actor and chat_id=p_chat
        and updated_at>=now()-interval '30 days'
      order by updated_at desc limit 40
    ) r
    join public.messages a on a.id=r.message_id and a.actor_id=p_actor
      and a.chat_id=p_chat and a.role='assistant'
    join public.chat_requests cr
      on cr.assistant_message_id=a.id::text and cr.actor_id=p_actor::text
      and cr.chat_id=p_chat::text and cr.status='completed' and cr.request_id<>p_request
    join public.standalone_workflows w
      on w.owner_id=p_owner and w.actor_id=p_actor and w.chat_id=p_chat
      and w.request_id=cr.request_id and w.status='completed'
    left join lateral (
      select m.content from public.messages m
      where m.actor_id=p_actor and m.chat_id=p_chat and m.role='user'
        and m.created_at<a.created_at
      order by m.created_at desc limit 1
    ) prior on true
  )
  select coalesce(jsonb_agg(to_jsonb(e) order by e.observed_at desc),'[]'::jsonb)
  into feedback
  from (
    select * from (
      select * from direct_feedback
      union all select * from reaction_feedback
    ) events
    where provider is not null and model is not null and intent is not null
      and request_id<>p_request
    order by observed_at desc limit 40
  ) e;

  return feedback;
end $$;

revoke all on function public.standalone_best_value_quality_feedback(uuid,uuid,uuid,text)
 from public,anon,authenticated;
grant execute on function public.standalone_best_value_quality_feedback(uuid,uuid,uuid,text)
 to service_role;
