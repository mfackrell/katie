-- Executive registry: contracts are explicitly capability-scoped and versioned.
-- Specialist execution internals remain outside this layer.
create table public.executive_orchestrators(
 id uuid primary key default gen_random_uuid(),
 actor_id uuid not null references public.actors(id),
 slug text not null check(slug ~ '^[a-z][a-z0-9_-]{1,49}$'),
 title text not null check(length(title) between 3 and 100),
 description text not null check(length(description) between 10 and 2000),
 capabilities text[] not null check(cardinality(capabilities) between 1 and 20),
 adapter text not null check(adapter in ('mission','external')),
 endpoint_key text,
 version integer not null default 1 check(version between 1 and 100000),
 status text not null default 'registered' check(status in ('registered','active','disabled','retired')),
 autonomy text not null default 'supervised' check(autonomy in ('supervised','delegated')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(actor_id,slug),
 check(adapter='mission' and endpoint_key is null or adapter='external' and endpoint_key is not null and endpoint_key ~ '^[a-z][a-z0-9_-]{2,70}$')
);
create table public.executive_delegations(
 id uuid primary key default gen_random_uuid(),
 orchestrator_id uuid not null references public.executive_orchestrators(id) on delete restrict,
 actor_id uuid not null references public.actors(id),
 chat_id uuid not null references public.chats(id),
 request_key text not null check(length(request_key) between 5 and 128),
 objective text not null check(length(objective) between 1 and 12000),
 success_criteria jsonb not null check(jsonb_typeof(success_criteria)='array' and jsonb_array_length(success_criteria) between 1 and 20),
 capability text not null,
 status text not null default 'proposed' check(status in ('proposed','accepted','running','submitted','verified','rejected','blocked','cancelled')),
 delegated_version integer not null,
 budget_tokens integer not null check(budget_tokens between 0 and 120000),
 deadline timestamptz not null,
 mission_id uuid references public.agent_missions(id),
 result jsonb,
 reviewed_by text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(actor_id,chat_id,request_key),
 check(result is null or jsonb_typeof(result)='object')
);
create table public.executive_delegation_events(
 id uuid primary key default gen_random_uuid(),
 delegation_id uuid not null references public.executive_delegations(id) on delete restrict,
 event text not null,
 evidence jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index executive_delegate_queue on public.executive_delegations(status,deadline);
create index executive_registry_capabilities on public.executive_orchestrators using gin(capabilities);
alter table public.executive_orchestrators enable row level security;
alter table public.executive_delegations enable row level security;
alter table public.executive_delegation_events enable row level security;
revoke all on public.executive_orchestrators,public.executive_delegations,public.executive_delegation_events from public,anon,authenticated,service_role;
grant select,insert,update on public.executive_orchestrators,public.executive_delegations to service_role;
grant select,insert on public.executive_delegation_events to service_role;

create function public.register_executive_orchestrator(p_actor uuid,p_slug text,p_title text,
 p_description text,p_capabilities text[],p_adapter text,p_endpoint text default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare o executive_orchestrators;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.executive.registry',0));
 if not exists(select 1 from actors where id=p_actor) then raise exception 'Actor unavailable';end if;
 if p_slug !~ '^[a-z][a-z0-9_-]{1,49}$' or length(p_title) not between 3 and 100 or
 length(p_description) not between 10 and 2000 or cardinality(p_capabilities) not between 1 and 20 or
 exists(select 1 from unnest(p_capabilities) a where a !~ '^[a-z][a-z0-9_-]{1,49}$') or
 (select count(distinct x) from unnest(p_capabilities) x)<>cardinality(p_capabilities) or
 p_adapter not in ('mission','external') or
 (p_adapter='mission' and p_endpoint is not null) or
 (p_adapter='external' and (p_endpoint is null or p_endpoint !~ '^[a-z][a-z0-9_-]{2,70}$'))
 then raise exception 'Invalid specialist capability declaration';end if;
 select * into o from executive_orchestrators where actor_id=p_actor and slug=p_slug for update;
 if found then
  if o.title<>p_title or o.description<>p_description or o.capabilities is distinct from p_capabilities or
     o.adapter<>p_adapter or o.endpoint_key is distinct from p_endpoint then raise exception 'Specialist identity conflict; explicit versioned update required';end if;
  return to_jsonb(o);
 end if;
 insert into executive_orchestrators(actor_id,slug,title,description,capabilities,adapter,endpoint_key)
 values(p_actor,p_slug,p_title,p_description,p_capabilities,p_adapter,p_endpoint) returning * into o;
 return to_jsonb(o);
end $$;

create function public.propose_executive_delegation(p_actor uuid,p_chat uuid,p_slug text,
 p_request text,p_objective text,p_capability text,p_success jsonb,p_budget integer,p_deadline timestamptz)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare o executive_orchestrators;d executive_delegations;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.executive.delegations',0));
 if not exists(select 1 from chats where id=p_chat and actor_id=p_actor) then raise exception 'Actor/chat mismatch';end if;
 select * into o from executive_orchestrators where actor_id=p_actor and slug=p_slug and status in ('registered','active') for update;
 if not found then raise exception 'Specialist unavailable';end if;
 if not p_capability=any(o.capabilities) or length(p_request) not between 5 and 128 or
 length(trim(p_objective)) not between 1 and 12000 or
 jsonb_typeof(p_success) is distinct from 'array' or jsonb_array_length(p_success) not between 1 and 20 or
 exists(select 1 from jsonb_array_elements(p_success) x where jsonb_typeof(x)<>'string' or length(trim(x#>>'{}')) not between 1 and 500) or
 p_budget not between 0 and 120000 or p_deadline<=now() or p_deadline>now()+interval '90 days'
 then raise exception 'Invalid delegated objective';end if;
 select * into d from executive_delegations where actor_id=p_actor and chat_id=p_chat and request_key=p_request for update;
 if found then
  if d.orchestrator_id<>o.id or d.objective<>p_objective or d.capability<>p_capability or
     d.success_criteria<>p_success or d.budget_tokens<>p_budget or d.deadline<>p_deadline
  then raise exception 'Delegation idempotency conflict';end if;
  return to_jsonb(d);
 end if;
 insert into executive_delegations(orchestrator_id,actor_id,chat_id,request_key,objective,success_criteria,capability,delegated_version,budget_tokens,deadline)
 values(o.id,p_actor,p_chat,p_request,p_objective,p_success,p_capability,o.version,p_budget,p_deadline) returning * into d;
 insert into executive_delegation_events(delegation_id,event,evidence) values(d.id,'proposed',jsonb_build_object('specialist',o.slug,'version',o.version));
 return to_jsonb(d);
end $$;

-- No specialist may self-report executive acceptance. The executive must
-- independently accept or reject a submitted evidence package.
create function public.transition_executive_delegation(p_id uuid,p_actor uuid,p_chat uuid,
 p_action text,p_evidence jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare d executive_delegations;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.executive.delegations',0));
 select * into d from executive_delegations where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or jsonb_typeof(p_evidence)<>'object' or length(p_evidence::text)>20000 then return null;end if;
 if p_action='accept' and d.status='proposed' then
  update executive_delegations set status='accepted',updated_at=now() where id=d.id returning * into d;
 elsif p_action='start' and d.status='accepted' then
  update executive_delegations set status='running',updated_at=now() where id=d.id returning * into d;
 elsif p_action='submit' and d.status='running' and p_evidence ? 'deliverable' then
  update executive_delegations set status='submitted',result=p_evidence,updated_at=now() where id=d.id returning * into d;
 elsif p_action='verify' and d.status='submitted' and p_evidence->>'independentReview'='pass' and length(coalesce(d.result->>'deliverable',''))>0 then
  update executive_delegations set status='verified',reviewed_by='executive',updated_at=now() where id=d.id returning * into d;
 elsif p_action='reject' and d.status='submitted' and length(coalesce(p_evidence->>'findings',''))>0 then
  update executive_delegations set status='rejected',result=coalesce(d.result,'{}'::jsonb)||jsonb_build_object('review',p_evidence),updated_at=now() where id=d.id returning * into d;
 elsif p_action='cancel' and d.status in ('proposed','accepted','running') then
  update executive_delegations set status='cancelled',updated_at=now() where id=d.id returning * into d;
 else return null;end if;
 insert into executive_delegation_events(delegation_id,event,evidence) values(d.id,p_action,p_evidence);
 return to_jsonb(d);
end $$;
revoke all on function public.register_executive_orchestrator(uuid,text,text,text,text[],text,text),
 public.propose_executive_delegation(uuid,uuid,text,text,text,text,jsonb,integer,timestamptz),
 public.transition_executive_delegation(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.register_executive_orchestrator(uuid,text,text,text,text[],text,text),
 public.propose_executive_delegation(uuid,uuid,text,text,text,text,jsonb,integer,timestamptz),
 public.transition_executive_delegation(uuid,uuid,uuid,text,jsonb) to service_role;