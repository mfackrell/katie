-- Read-only private audit projection. No text, reviewer identity, or free-form assessment leaves SQL.
create or replace function public.standalone_routing_reviewer_evidence(
 p_owner uuid,p_actor uuid,p_chat uuid,p_request text,p_intent text
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare observations jsonb;
begin
 if not standalone_verify_scope(p_owner,p_actor,p_chat) then raise exception 'STANDALONE_SCOPE_DENIED'; end if;
 with qualified as (
  select w.updated_at as observed_at,
   w.checkpoints->'routing-delivery-audit:v1'->>'provider' as provider,
   w.checkpoints->'routing-delivery-audit:v1'->>'model' as model,
   r.review_audit->>'verdict' as verdict
  from standalone_workflows w
  join chat_requests r on r.request_id=w.request_id
   and r.actor_id=p_actor::text and r.chat_id=p_chat::text
  where w.owner_id=p_owner and w.actor_id=p_actor and w.chat_id=p_chat
   and w.request_id<>p_request and w.status='completed'
   and w.updated_at between now()-interval '30 days' and now()
   and nullif(p_intent,'') is not null and p_intent<>'unknown'
   and w.checkpoints->'routing-delivery-audit:v1'->>'classifiedIntent'=p_intent
   and r.review_audit->>'mode'='always'
   and r.review_audit->>'verdict' in ('approve','revise')
   and jsonb_typeof(r.review_audit->'independentAssessment')='object'
   and r.review_audit->'independentAssessment'<>'{}'::jsonb
   and nullif(r.review_audit->'reviewer'->>'provider','') is not null
   and nullif(r.review_audit->'reviewer'->>'modelId','') is not null
   and nullif(w.checkpoints->'routing-delivery-audit:v1'->>'provider','') is not null
   and nullif(w.checkpoints->'routing-delivery-audit:v1'->>'model','') is not null
   -- Same provider is allowed, but self-review by the generating model is not.
   and r.review_audit->'reviewer'->>'modelId'<>w.checkpoints->'routing-delivery-audit:v1'->>'model'
   -- A verdict on a replaced draft must never qualify the delivered answer.
   and r.review_audit->>'finalHash' ~ '^[a-f0-9]{64}$'
   and r.review_audit->'reviews'->-1->>'answerHash'=r.review_audit->>'finalHash'
   and r.review_audit->'reviews'->-1->'review'->>'verdict'=r.review_audit->>'verdict'
  order by w.updated_at desc,w.request_id limit 100
 ), grouped as (
  select provider,model,count(*) as sample_count,
   count(*) filter(where verdict='approve') as approvals,
   count(*) filter(where verdict='revise') as revisions,
   min(observed_at) as first_observation,max(observed_at) as latest_observation
  from qualified group by provider,model
 ) select coalesce(jsonb_agg(to_jsonb(g) order by provider,model),'[]'::jsonb) into observations from grouped g;
 return jsonb_build_object('observations',observations);
end $$;
revoke all on function public.standalone_routing_reviewer_evidence(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.standalone_routing_reviewer_evidence(uuid,uuid,uuid,text,text) to service_role;
