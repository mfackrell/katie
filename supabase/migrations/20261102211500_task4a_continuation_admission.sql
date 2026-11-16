-- Task 4A: one owner-scoped continuation ceiling on the EXISTING mission-call ledger.
-- No existing project becomes authorized by installing this migration.
-- The original project's owner pause remains effective until a later authenticated
-- single owner decision creates the continuation and a recovery mission atomically.
create table public.project_continuation_authorizations (
 id uuid primary key default gen_random_uuid(),
 project_id uuid not null unique references public.work_projects(id) on delete restrict,
 actor_id uuid not null,
 chat_id uuid not null,
 source_mission_id uuid not null references public.agent_missions(id) on delete restrict,
 approval_digest text not null check(approval_digest ~ '^[a-f0-9]{64}$'),
 authorized_at timestamptz not null default now(),
 revoked_at timestamptz,
 deadline timestamptz not null,
 incremental_tokens bigint not null check(incremental_tokens between 10000 and 10000000),
 incremental_calls integer not null check(incremental_calls between 1 and 200),
 incremental_microusd numeric(20,0) not null check(incremental_microusd between 1 and 1000000000),
 assessment_reserve_tokens bigint not null check(assessment_reserve_tokens>=10000),
 completion_reserve_tokens bigint not null check(completion_reserve_tokens>=10000),
 assessment_reserve_calls integer not null check(assessment_reserve_calls>=1),
 completion_reserve_calls integer not null check(completion_reserve_calls>=1),
 allowed_models text[] not null check(cardinality(allowed_models) between 1 and 4),
 historical_tokens bigint not null check(historical_tokens>=0),
 historical_calls integer not null check(historical_calls>=0),
 historical_mission_deadline timestamptz not null,
 pricing_evidence jsonb not null check(jsonb_typeof(pricing_evidence)='array'),
 check (assessment_reserve_tokens+completion_reserve_tokens<incremental_tokens),
 check (assessment_reserve_calls+completion_reserve_calls<incremental_calls),
 check (deadline>authorized_at)
);
create index project_continuation_authorizations_deadline on public.project_continuation_authorizations(deadline);
alter table public.project_continuation_authorizations enable row level security;
revoke all on public.project_continuation_authorizations from public,anon,authenticated,service_role;
grant select,insert on public.project_continuation_authorizations to service_role;

-- Do not duplicate provider-call rows or maintain a parallel charge counter.
-- Historical pre-authorization calls stay unchanged; only new admitted calls
-- carry the immutable continuation ID and worst-case monetary hold.
alter table public.mission_calls
 add column project_continuation_id uuid references public.project_continuation_authorizations(id) on delete restrict,
 add column project_reserved_microusd numeric(20,0),
 add column project_pricing_evidence jsonb;
alter table public.mission_calls
 add constraint project_mission_cost_binding check(
   (project_continuation_id is null and project_reserved_microusd is null and project_pricing_evidence is null)
   or (project_continuation_id is not null and project_reserved_microusd>0
       and jsonb_typeof(project_pricing_evidence)='object'));
create index mission_calls_project_continuation on public.mission_calls(project_continuation_id);

-- Preserve the existing canonical token, lease, status and concurrency admission,
-- then add the scoped model/dollar/call/time check within its SAME transaction.
-- Prices are conservative upper bounds, including 1.5x long-context output
-- and a further 1.1x possible regional uplift. Only default service tier may
-- be used by the bounded provider for a continuation.
create or replace function public.try_reserve_mission_capacity(
 p_id uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer,p_routing boolean
) returns boolean language plpgsql security invoker set search_path=public as $$
declare
 j mission_assignments; m agent_missions; project_limit bigint; project_used bigint;
 authority project_continuation_authorizations; price model_registry;
 existing_tokens bigint; existing_calls integer; existing_dollars numeric;
 upper_dollars numeric; evidence jsonb; model_provider text; chosen_model text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id;if not found then return false;end if;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into j from mission_assignments where id=p_id for update;
 if m.project_id is not null then
  select benchmark_effective_project_cap(id) into project_limit from work_projects
   where id=m.project_id and status='running' and active_mission_id=m.id and deadline>now();
  if not found then return false;end if;
 end if;
 if m.status not in ('running','awaiting_approval')
  or benchmark_effective_mission_deadline(m.id)<=now()
  or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now()
 then return false;end if;
 if p_tokens is null or p_tokens not between 1 and 120000 or p_call is null or p_routing is null
  or coalesce(length(p_model),0) not between 1 and 300
  or exists(select 1 from mission_calls where id=p_call) then return false;end if;
 if (p_routing and m.routing_calls>=benchmark_effective_mission_call_limit(m.id,benchmark_effective_mission_continuation(m.id))*3)
  or (not p_routing and m.calls>=benchmark_effective_mission_call_limit(m.id,benchmark_effective_mission_continuation(m.id)))
  or greatest(m.reserved_tokens,m.actual_tokens)+p_tokens>benchmark_effective_mission_allowance(m.id,benchmark_effective_mission_continuation(m.id))
 then return false;end if;
 if m.project_id is not null then
  select coalesce(sum(greatest(reserved_tokens,actual_tokens)),0) into project_used
   from agent_missions where project_id=m.project_id;
  if project_used+p_tokens>project_limit then return false;end if;
  select * into authority from project_continuation_authorizations
   where project_id=m.project_id;
  if found then
   if authority.deadline<=clock_timestamp() or authority.revoked_at is not null or authority.authorized_at>clock_timestamp()
    or p_model<>all(authority.allowed_models) then return false;end if;
   model_provider:=split_part(p_model,':',1);
   chosen_model:=substring(p_model from length(model_provider)+2);
   select * into price from model_registry where provider_name=model_provider and model_id=chosen_model;
   if not found or price.is_active is distinct from true
    or price.pricing_status is distinct from 'verified'
    or price.pricing_verified_at is null or price.pricing_verified_at<now()-interval '24 hours'
    or price.pricing_verified_at>now()
    or coalesce(price.pricing_input_per_1m,0)<=0 or coalesce(price.pricing_output_per_1m,0)<=0
    or price.source_metadata->>'pricing_verification_source'
       is distinct from 'https://developers.openai.com/api/docs/models/'||chosen_model
    or model_provider<>'openai' then return false;end if;
   select coalesce(sum(greatest(c.reserved_tokens,coalesce(c.actual_tokens,0))),0),
          count(*),coalesce(sum(c.project_reserved_microusd),0)
     into existing_tokens,existing_calls,existing_dollars
    from mission_calls c where c.project_continuation_id=authority.id;
   if exists(select 1 from mission_calls c where c.project_continuation_id=authority.id
     and (c.status='uncertain' or c.actual_tokens>c.reserved_tokens)) then return false;end if;
   upper_dollars:=ceil(p_tokens*greatest(price.pricing_input_per_1m,price.pricing_output_per_1m)*1.65);
   if existing_tokens+p_tokens>authority.incremental_tokens
    or existing_calls+1>authority.incremental_calls
    or existing_dollars+upper_dollars>authority.incremental_microusd then return false;end if;
   -- Protect final assessment and completion capacity until the assigned stage.
   if m.project_kind<>'assessment' and
      (existing_tokens+p_tokens+authority.assessment_reserve_tokens+authority.completion_reserve_tokens>authority.incremental_tokens
       or existing_calls+1+authority.assessment_reserve_calls+authority.completion_reserve_calls>authority.incremental_calls)
    then return false;end if;
   if m.project_kind='assessment' and j.role<>'review' and
      (existing_tokens+p_tokens+authority.completion_reserve_tokens>authority.incremental_tokens
       or existing_calls+1+authority.completion_reserve_calls>authority.incremental_calls)
    then return false;end if;
   evidence:=jsonb_build_object('source',price.source_metadata->>'pricing_verification_source',
    'verifiedAt',price.pricing_verified_at,'model',p_model,
    'inputPerMillionUsd',price.pricing_input_per_1m,
    'outputPerMillionUsd',price.pricing_output_per_1m,
    'upperBoundMultiplier',1.65,'priceBasis','conservative_reserved_tokens',
    'phase',m.project_kind,'role',j.role);
  end if;
 end if;
 insert into mission_calls(id,job_id,lease,model,reserved_tokens,
  project_continuation_id,project_reserved_microusd,project_pricing_evidence)
 values(p_call,j.id,p_lease,p_model,p_tokens,
  authority.id,case when authority.id is null then null else upper_dollars end,evidence);
 update agent_missions set calls=calls+case when p_routing then 0 else 1 end,
   routing_calls=routing_calls+case when p_routing then 1 else 0 end,
   reserved_tokens=reserved_tokens+p_tokens,updated_at=now() where id=m.id;
 update mission_assignments set heartbeat_at=now(),lease_until=now()+interval '6 minutes' where id=j.id;
 return true;
end $$;
-- Invalidate/rebind the SQL-language routing wrapper to the new canonical
-- admission function. It must never continue referencing an older function OID.
create or replace function public.reserve_mission_routing_call(
 p_id uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer
) returns boolean language sql security invoker set search_path=public as $$
 select public.try_reserve_mission_capacity(p_id,p_lease,p_call,p_model,p_tokens,true);
$$;
revoke all on function public.try_reserve_mission_capacity(uuid,uuid,uuid,text,integer,boolean),
 public.reserve_mission_routing_call(uuid,uuid,uuid,text,integer)
 from public,anon,authenticated;
grant execute on function public.try_reserve_mission_capacity(uuid,uuid,uuid,text,integer,boolean),
 public.reserve_mission_routing_call(uuid,uuid,uuid,text,integer) to service_role;
