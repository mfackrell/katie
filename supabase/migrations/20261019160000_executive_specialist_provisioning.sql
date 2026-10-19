-- Provisioning is an executive management decision, not a grant of new
-- tool permissions. Commissioning creates an auditable request only.
create table if not exists public.executive_provisioning_requests(
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references public.actors(id),
 chat_id uuid not null references public.chats(id),
 request_key text not null check(length(request_key) between 5 and 128),
 requirement jsonb not null check(jsonb_typeof(requirement)='object' and length(requirement::text)<=14000),
 capability text not null check(capability ~ '^[a-z][a-z0-9_-]{1,49}$'),
 specialist_slug text not null check(specialist_slug ~ '^[a-z][a-z0-9_-]{1,49}$'),
 route text not null check(route in ('reuse','configure','commission')),
 status text not null default 'proposed' check(status in ('proposed','configured','commission_pending','commissioned','validated','activated','blocked','cancelled')),
 specialist_id uuid references public.executive_orchestrators(id),
 commission_delegation_id uuid references public.executive_delegations(id),
 evidence jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(actor_id,chat_id,request_key),
 check (route='commission' or commission_delegation_id is null)
);
create table if not exists public.executive_provisioning_events(
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.executive_provisioning_requests(id),
 event text not null,
 evidence jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index if not exists executive_provision_queue on public.executive_provisioning_requests(status,updated_at);
alter table public.executive_provisioning_requests enable row level security;
alter table public.executive_provisioning_events enable row level security;
revoke all on public.executive_provisioning_requests,public.executive_provisioning_events from public,anon,authenticated,service_role;
grant select,insert,update on public.executive_provisioning_requests to service_role;
grant select,insert on public.executive_provisioning_events to service_role;

do $migration$
begin
create function public.propose_executive_provisioning(p_actor uuid,p_chat uuid,p_request text,
 p_requirement jsonb,p_route text,p_specialist uuid default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare r executive_provisioning_requests;o executive_orchestrators;cap text;slug text;caps text[];avail text[];
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.executive.provisioning',0));
 if not exists(select 1 from chats where id=p_chat and actor_id=p_actor) then raise exception 'Actor/chat association invalid';end if;
 if p_route not in ('reuse','configure','commission') or length(p_request) not between 5 and 128 or
 jsonb_typeof(p_requirement)<>'object' or length(p_requirement::text)>14000 then raise exception 'Invalid provisioning request';end if;
 cap:=p_requirement->>'capability';slug:=p_requirement->>'proposedSlug';
 if cap is null or cap !~ '^[a-z][a-z0-9_-]{1,49}$' or
    slug is null or slug !~ '^[a-z][a-z0-9_-]{1,49}$' or
    jsonb_typeof(p_requirement->'proposedCapabilities')<>'array' or
    jsonb_array_length(p_requirement->'proposedCapabilities') not between 1 and 20 or
    jsonb_typeof(p_requirement->'successCriteria')<>'array' or
    jsonb_array_length(p_requirement->'successCriteria') not between 1 and 20 or
    length(coalesce(p_requirement->>'objective','')) not between 1 and 5000
 then raise exception 'Invalid capability proposal';end if;
 select array_agg(x) into caps from jsonb_array_elements_text(p_requirement->'proposedCapabilities') x;
 if not cap=any(caps) or exists(select 1 from unnest(caps) x where x !~ '^[a-z][a-z0-9_-]{1,49}$')
  or (select count(distinct x) from unnest(caps) x)<>cardinality(caps) then raise exception 'Invalid required capabilities';end if;
 select * into r from executive_provisioning_requests where actor_id=p_actor and chat_id=p_chat and request_key=p_request for update;
 if found then
  if r.requirement is distinct from p_requirement or r.route<>p_route or r.specialist_id is distinct from p_specialist
   then raise exception 'Provisioning idempotency conflict';end if;
  return to_jsonb(r);
 end if;
 if p_route='reuse' then
   select * into o from executive_orchestrators where id=p_specialist and actor_id=p_actor and status='active' and cap=any(capabilities);
   if not found then raise exception 'No active specialist supports the requirement';end if;
 elsif p_specialist is not null then raise exception 'Unverified specialist binding';end if;
 insert into executive_provisioning_requests(actor_id,chat_id,request_key,requirement,capability,specialist_slug,route,
 specialist_id,status,evidence)
 values(p_actor,p_chat,p_request,p_requirement,cap,slug,p_route,p_specialist,
  case when p_route='reuse' then 'validated' when p_route='configure' then 'proposed' else 'commission_pending' end,
  jsonb_build_object('decision',p_route))
 returning * into r;
 insert into executive_provisioning_events(request_id,event,evidence) values(r.id,'proposed',jsonb_build_object('route',p_route));
 return to_jsonb(r);
end $$;
exception when duplicate_function then null;
end $migration$;

-- Provisioning never treats registration as activation. A specialist is
-- promoted only after the evidence of its declared capabilities has been
-- independently verified; external code is never generated by this RPC.
do $migration$
begin
create function public.transition_executive_provisioning(p_id uuid,p_actor uuid,p_chat uuid,p_action text,p_evidence jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare r executive_provisioning_requests;o executive_orchestrators;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.executive.provisioning',0));
 select * into r from executive_provisioning_requests where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or jsonb_typeof(p_evidence)<>'object' or length(p_evidence::text)>14000 then return null;end if;
 if p_action='configure' and r.status='proposed' and r.route='configure'
  and p_evidence->>'capabilityCatalogVerified'='true' then
  select * into o from executive_orchestrators where actor_id=p_actor and slug=r.specialist_slug for update;
  if found then return null;end if;
  insert into executive_orchestrators(actor_id,slug,title,description,capabilities,adapter,status)
  values(p_actor,r.specialist_slug,r.requirement->>'proposedTitle',r.requirement->>'proposedDescription',
   array(select jsonb_array_elements_text(r.requirement->'proposedCapabilities')),
   'mission','registered') returning * into o;
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
exception when duplicate_function then null;
end $migration$;
revoke all on function public.propose_executive_provisioning(uuid,uuid,text,jsonb,text,uuid),
 public.transition_executive_provisioning(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.propose_executive_provisioning(uuid,uuid,text,jsonb,text,uuid),
 public.transition_executive_provisioning(uuid,uuid,uuid,text,jsonb) to service_role;