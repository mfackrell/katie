-- Retry a previously blocked independent-acceptance mission without duplicating
-- its registered specialist, relaxing the capability boundary, or bypassing review.
create or replace function public.transition_executive_provisioning(p_id uuid,p_actor uuid,p_chat uuid,p_action text,p_evidence jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare r executive_provisioning_requests;o executive_orchestrators;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.executive.provisioning',0));
 select * into r from executive_provisioning_requests where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or jsonb_typeof(p_evidence)<>'object' or length(p_evidence::text)>14000 then return null;end if;
 if p_action='configure' and r.status='proposed' and r.route='configure'
  and p_evidence->>'capabilityCatalogVerified'='true' then
  select * into o from executive_orchestrators where actor_id=p_actor and slug=r.specialist_slug for update;
  if found then
   -- An earlier acceptance may have blocked before activation. Rebind only
   -- the SAME registered adapter and capabilities, with no active contender.
   if o.status<>'registered' or o.adapter<>'mission' or
    o.capabilities is distinct from array(select jsonb_array_elements_text(r.requirement->'proposedCapabilities')) or
    exists(select 1 from executive_provisioning_requests x
      where x.specialist_id=o.id and x.status in ('configured','commissioned','validated','activated'))
   then return null;end if;
  else
   insert into executive_orchestrators(actor_id,slug,title,description,capabilities,adapter,status)
   values(p_actor,r.specialist_slug,r.requirement->>'proposedTitle',r.requirement->>'proposedDescription',
    array(select jsonb_array_elements_text(r.requirement->'proposedCapabilities')),
    'mission','registered') returning * into o;
  end if;
  update executive_provisioning_requests set specialist_id=o.id,status='configured',evidence=p_evidence,updated_at=now() where id=r.id returning * into r;
 elsif p_action='bind_commission' and r.route='commission' and r.status='commission_pending'
  and p_evidence->>'commissionDelegationId' is not null then
  if not exists(select 1 from executive_delegations d join executive_orchestrators o on o.id=d.orchestrator_id
   where d.id=(p_evidence->>'commissionDelegationId')::uuid and d.actor_id=p_actor and d.chat_id=p_chat
   and d.status in ('proposed','accepted','running') and d.capability='specialist_build'
   and o.status='active') then return null;end if;
  update executive_provisioning_requests set status='commissioned',
   commission_delegation_id=(p_evidence->>'commissionDelegationId')::uuid,evidence=p_evidence,updated_at=now() where id=r.id returning * into r;
 elsif p_action='validate' and r.status in ('configured','commissioned')
   and p_evidence->>'independentReview'='pass' and
   jsonb_typeof(p_evidence->'acceptanceEvidence')='array' and jsonb_array_length(p_evidence->'acceptanceEvidence')>0 then
  if r.route='commission' and not exists(select 1 from executive_delegations where id=r.commission_delegation_id
    and actor_id=p_actor and chat_id=p_chat and status='verified') then return null;end if;
  update executive_provisioning_requests set status='validated',evidence=p_evidence,updated_at=now() where id=r.id returning * into r;
 elsif p_action='activate' and r.status='validated' and r.specialist_id is not null
  and p_evidence->>'independentReview'='pass' then
  update executive_orchestrators set status='active',updated_at=now()
   where id=r.specialist_id and actor_id=p_actor and status='registered';
  if not found then return null;end if;
  update executive_provisioning_requests set status='activated',updated_at=now() where id=r.id returning * into r;
 elsif p_action='cancel' and r.status in ('proposed','commission_pending','configured','commissioned') then
  update executive_provisioning_requests set status='cancelled',updated_at=now() where id=r.id returning * into r;
 else return null;end if;
 insert into executive_provisioning_events(request_id,event,evidence) values(r.id,p_action,p_evidence);
 return to_jsonb(r);
end $$;
