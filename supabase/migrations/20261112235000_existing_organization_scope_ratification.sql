begin;

-- A scope-ratification proposal is inert. It records the exact ordinary project
-- approval contract and the accepted organization state that the owner will
-- later approve. Authority is created only by project_org_ratify_scope.
create table public.project_scope_ratification_proposals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.work_projects(id),
  repository_id uuid not null references public.repo_sync_runs(id),
  repository_full_name text not null,
  baseline_sha text not null check (baseline_sha ~ '^[a-f0-9]{40}$'),
  objective_hash text not null check (objective_hash ~ '^[a-f0-9]{64}$'),
  organization_hash text not null check (organization_hash ~ '^[a-f0-9]{64}$'),
  spec jsonb not null,
  scope_hash text not null check (scope_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique(project_id,scope_hash,organization_hash)
);

create table public.project_scope_ratification_approvals (
  proposal_id uuid primary key references public.project_scope_ratification_proposals(id),
  project_id uuid not null unique references public.work_projects(id),
  owner_id uuid not null,
  scope_hash text not null check (scope_hash ~ '^[a-f0-9]{64}$'),
  transaction_id bigint not null,
  approved_at timestamptz not null default clock_timestamp()
);

alter table public.project_scope_ratification_proposals enable row level security;
alter table public.project_scope_ratification_approvals enable row level security;
revoke all on public.project_scope_ratification_proposals,public.project_scope_ratification_approvals
  from public,anon,authenticated,service_role;
grant select on public.project_scope_ratification_proposals,public.project_scope_ratification_approvals to service_role;

create function public.project_scope_ratification_immutable() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  raise exception 'Scope ratification history is append-only';
end $$;
create trigger project_scope_ratification_proposals_immutable
before update or delete on public.project_scope_ratification_proposals
for each row execute function public.project_scope_ratification_immutable();
create trigger project_scope_ratification_approvals_immutable
before update or delete on public.project_scope_ratification_approvals
for each row execute function public.project_scope_ratification_immutable();

-- Bind approval to the accepted organization itself. Status/evidence/pending
-- decisions are deliberately included so an owner cannot approve a proposal
-- prepared before a management-state change.
create function public.project_org_scope_ratification_state(p_project uuid) returns text
language sql stable security definer set search_path=public,pg_temp as $$
  select encode(sha256(convert_to(project_canonical(jsonb_build_object(
    'nodes',coalesce((select jsonb_agg(to_jsonb(n) order by n.id)
      from project_organization_nodes n where n.project_id=p_project),'[]'::jsonb),
    'plans',coalesce((select jsonb_agg(to_jsonb(pl) order by pl.node_id)
      from project_organization_plans pl join project_organization_nodes n on n.id=pl.node_id
      where n.project_id=p_project),'[]'::jsonb),
    'decisions',coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at,d.id)
      from project_organization_decisions d where d.project_id=p_project),'[]'::jsonb)
  )),'UTF8')),'hex')
$$;

-- Recovery may authorize only paths already stated literally in accepted
-- management evidence. This is intentionally conservative; absent evidence
-- requires normal research/specification rather than inferred scope.
create function public.project_org_scope_path_supported(p_project uuid,p_path text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(
    select 1 from (
      select coalesce(n.objective,'')||' '||coalesce(n.acceptance::text,'')||' '||
             coalesce(n.management_contract::text,'') body
      from project_organization_nodes n where n.project_id=p_project
      union all
      select coalesce(pl.purpose,'')||' '||coalesce(pl.direction,'')||' '||
             coalesce(pl.outcomes::text,'')||' '||coalesce(pl.milestones::text,'') body
      from project_organization_plans pl join project_organization_nodes n on n.id=pl.node_id
      where n.project_id=p_project
      union all
      select coalesce(d.decision::text,'') body
      from project_organization_decisions d where d.project_id=p_project
    ) evidence where strpos(evidence.body,p_path)>0
  )
$$;

-- Prepare an inert proposal. Service code must supply the trusted repository
-- baseline after reading the target repository. This function never grants
-- authority and never advances project status.
create function public.project_org_prepare_scope_ratification(
  p_project uuid,p_spec jsonb,p_baseline text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  p work_projects; a project_provider_execution; repo_name text;
  objective_hash text; organization_hash text; scope_data jsonb; scope_hash text;
  q project_scope_ratification_proposals;
begin
  perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
  select * into strict p from work_projects where id=p_project for update;
  if p.organization_version<>1 or p.status<>'blocked' or p.phase not in ('research','specification','approval')
     or p.spec is not null or p.approval_hash is not null or p.approved_hash is not null
     or p.repository_id is null or p.deadline<=clock_timestamp()
  then raise exception 'Scope ratification requires one blocked existing organization with missing approval state';end if;
  if p_baseline is null or p_baseline !~ '^[a-f0-9]{40}$' then raise exception 'Exact repository baseline required';end if;
  if (select count(*) from project_organization_nodes where project_id=p.id and kind='project_director' and parent_id is null)<>1
     or not exists(select 1 from project_organization_nodes n join project_organization_plans pl on pl.node_id=n.id
                   where n.project_id=p.id and n.kind='project_director' and n.parent_id is null)
  then raise exception 'Accepted Project Director organization required';end if;
  if exists(select 1 from project_work_packages where project_id=p.id)
     or exists(select 1 from project_organization_scope_grants g join project_organization_nodes n on n.id=g.node_id where n.project_id=p.id)
  then raise exception 'Scope ratification cannot overwrite existing package or scope authority';end if;

  if jsonb_typeof(p_spec) is distinct from 'object'
     or length(coalesce(p_spec->>'name','')) not between 1 and 120
     or length(coalesce(p_spec->>'summary','')) not between 1 and 1800
     or jsonb_typeof(p_spec->'requirements') is distinct from 'array'
     or jsonb_array_length(p_spec->'requirements') not between 1 and 30
     or jsonb_typeof(p_spec->'allowedPaths') is distinct from 'array'
     or jsonb_array_length(p_spec->'allowedPaths') not between 1 and 12
     or jsonb_typeof(p_spec->'milestones') is distinct from 'array'
     or jsonb_array_length(p_spec->'milestones') not between 1 and 6
     or jsonb_typeof(p_spec->'finalContract') is distinct from 'object'
     or project_canonical(p_spec->'milestones'->(jsonb_array_length(p_spec->'milestones')-1)->'contract')
        is distinct from project_canonical(p_spec->'finalContract')
  then raise exception 'Concrete bounded project specification required';end if;
  if (select count(distinct value) from jsonb_array_elements_text(p_spec->'allowedPaths'))
       <>jsonb_array_length(p_spec->'allowedPaths')
     or exists(select 1 from jsonb_array_elements_text(p_spec->'allowedPaths') path
       where path is null or path~'(^|/)\.\.?(/|$)' or path~'^/' or path~'\.env|\.github|node_modules'
          or path!~'^(app|apps|components|lib|public|tests|docs)/[A-Za-z0-9_.\[\]/-]+/?$'
          or not project_org_scope_path_supported(p.id,path))
  then raise exception 'Specification scope exceeds accepted organization evidence';end if;
  if exists(select 1 from jsonb_array_elements(p_spec->'milestones') m
       where jsonb_typeof(m->'contract') is distinct from 'object'
          or coalesce(m->'contract'->>'path','')!~'^/[^[:space:]]*$'
          or starts_with(coalesce(m->'contract'->>'path',''),'//')
          or jsonb_typeof(m->'contract'->'scenarios') is distinct from 'array'
          or jsonb_array_length(m->'contract'->'scenarios')<1)
     or coalesce(p_spec->'finalContract'->>'path','')!~'^/[^[:space:]]*$'
     or starts_with(coalesce(p_spec->'finalContract'->>'path',''),'//')
     or jsonb_typeof(p_spec->'finalContract'->'scenarios') is distinct from 'array'
     or jsonb_array_length(p_spec->'finalContract'->'scenarios')<1
  then raise exception 'Executable browser acceptance contract required';end if;

  select repository_full_name into repo_name from repo_sync_runs where id=p.repository_id;
  if repo_name is null or repo_name!~'^[-A-Za-z0-9_.]+/[-A-Za-z0-9_.]+$' then raise exception 'Connected repository unavailable';end if;
  objective_hash:=encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex');
  select * into a from project_provider_execution where project_id=p.id;
  if found then
    if a.objective_hash is distinct from objective_hash or a.approved_scope is not null
       or a.deadline is distinct from p.deadline or a.deadline<=clock_timestamp()
       or project_provider_request_pending(p.id)
    then raise exception 'Provider authority is not in a recoverable pre-scope state';end if;
  end if;

  organization_hash:=project_org_scope_ratification_state(p.id);
  scope_data:=jsonb_build_object(
    'objective',p.objective,'clarifications',p.clarifications,'spec',p_spec,
    'repository',p.repository_id,'repository_name',repo_name,'baseline',p_baseline,
    'max_cycles',p.max_cycles,'max_missions',p.max_missions,
    'token_allowance',p.token_allowance,'deadline',p.deadline
  );
  scope_hash:=encode(sha256(convert_to(project_canonical(scope_data),'UTF8')),'hex');

  insert into project_scope_ratification_proposals(
    project_id,repository_id,repository_full_name,baseline_sha,objective_hash,organization_hash,spec,scope_hash
  ) values(p.id,p.repository_id,repo_name,p_baseline,objective_hash,organization_hash,p_spec,scope_hash)
  on conflict(project_id,scope_hash,organization_hash) do nothing
  returning * into q;
  if q.id is null then
    select * into strict q from project_scope_ratification_proposals
      where project_id=p.id and scope_hash=scope_hash and organization_hash=organization_hash;
  end if;
  return jsonb_build_object(
    'proposalId',q.id,'projectId',q.project_id,'repository',q.repository_full_name,
    'baselineSha',q.baseline_sha,'organizationHash',q.organization_hash,
    'scopeHash',q.scope_hash,'specification',q.spec,'createdAt',q.created_at
  );
end $$;

-- Owner activation is one transaction. A transaction-bound approval receipt lets
-- the existing project_org_scope_approved trigger create the root grant while
-- preserving the already accepted organization instead of resetting it.
create function public.project_org_ratify_scope(
  p_owner uuid,p_proposal uuid,p_hash text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  q project_scope_ratification_proposals; p work_projects; a project_provider_execution;
  objective_hash text; current_hash text; scope_data jsonb; root_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
  select * into strict q from project_scope_ratification_proposals where id=p_proposal for update;
  select * into strict p from work_projects where id=q.project_id for update;
  if p_owner is null or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
     or p_hash is null or p_hash is distinct from q.scope_hash
  then raise exception 'Exact authenticated owner scope ratification required';end if;
  if p.organization_version<>1 or p.status<>'blocked' or p.phase not in ('research','specification','approval')
     or p.spec is not null or p.approval_hash is not null or p.approved_hash is not null
     or p.repository_id is distinct from q.repository_id or p.deadline<=clock_timestamp()
     or exists(select 1 from project_scope_ratification_approvals where project_id=p.id)
  then raise exception 'Scope ratification proposal is stale or already consumed';end if;
  if project_org_scope_ratification_state(p.id) is distinct from q.organization_hash
  then raise exception 'Accepted organization changed; prepare a new exact scope proposal';end if;

  objective_hash:=encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex');
  if objective_hash is distinct from q.objective_hash then raise exception 'Project objective changed; scope proposal is stale';end if;
  scope_data:=jsonb_build_object(
    'objective',p.objective,'clarifications',p.clarifications,'spec',q.spec,
    'repository',p.repository_id,'repository_name',q.repository_full_name,'baseline',q.baseline_sha,
    'max_cycles',p.max_cycles,'max_missions',p.max_missions,
    'token_allowance',p.token_allowance,'deadline',p.deadline
  );
  current_hash:=encode(sha256(convert_to(project_canonical(scope_data),'UTF8')),'hex');
  if current_hash is distinct from q.scope_hash then raise exception 'Project scope inputs changed; proposal is stale';end if;

  select * into a from project_provider_execution where project_id=p.id for update;
  if found then
    if a.owner_id is distinct from p_owner or a.objective_hash is distinct from objective_hash
       or a.approved_scope is not null or a.deadline is distinct from p.deadline
       or a.deadline<=clock_timestamp() or project_provider_request_pending(p.id)
    then raise exception 'Provider authority is not eligible for exact scope ratification';end if;
  end if;

  insert into project_scope_ratification_approvals(
    proposal_id,project_id,owner_id,scope_hash,transaction_id
  ) values(q.id,p.id,p_owner,q.scope_hash,txid_current());

  if a.project_id is not null then
    update project_provider_execution set approved_scope=q.scope_hash where project_id=p.id;
  end if;

  update work_projects set
    spec=q.spec,repository_full_name=q.repository_full_name,baseline_sha=q.baseline_sha,
    approval_hash=q.scope_hash,approved_hash=q.scope_hash,status='running',phase='development',
    milestone_index=0,active_mission_id=null,lease=null,lease_until=null,
    detail='Owner ratified the existing organization scope. Management must delegate current development capability and file scope before coding.',
    updated_at=clock_timestamp()
  where id=p.id
  returning * into p;

  select id into strict root_id from project_organization_nodes
    where project_id=p.id and kind='project_director' and parent_id is null;
  if not exists(select 1 from project_organization_scope_grants
      where node_id=root_id and scope_hash=q.scope_hash and parent_id is null
        and paths=array(select jsonb_array_elements_text(q.spec->'allowedPaths')))
     or exists(select 1 from project_organization_scope_grants g
        join project_organization_nodes n on n.id=g.node_id
        where n.project_id=p.id and g.scope_hash=q.scope_hash and g.node_id<>root_id)
  then raise exception 'Atomic root scope grant was not established exactly';end if;

  insert into project_events(project_id,event,data) values(
    p.id,'scope_ratified',
    jsonb_build_object('proposalId',q.id,'scopeHash',q.scope_hash,'organizationHash',q.organization_hash,'ownerId',p_owner)
  );
  return to_jsonb(p);
end $$;

-- Preserve the normal trigger behavior for ordinary approvals. Only the exact
-- ratification transaction above suppresses its destructive node reset.
create or replace function public.project_org_scope_approved() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare root_id uuid; preserve_state boolean;
begin
  if new.organization_version=1 and new.approved_hash is not null and new.approved_hash is distinct from old.approved_hash then
    select id into root_id from project_organization_nodes
      where project_id=new.id and kind='project_director' and parent_id is null;
    if root_id is null then raise exception 'Project Director root required for approved scope';end if;
    select exists(
      select 1 from project_scope_ratification_approvals a
      join project_scope_ratification_proposals q on q.id=a.proposal_id
      where a.project_id=new.id and a.scope_hash=new.approved_hash
        and q.project_id=new.id and q.scope_hash=new.approved_hash
        and a.transaction_id=txid_current()
    ) into preserve_state;
    insert into project_organization_scope_grants
      values(root_id,new.approved_hash,array(select jsonb_array_elements_text(new.spec->'allowedPaths')),null)
      on conflict do nothing;
    if not preserve_state then
      update project_organization_nodes
        set status='active',evidence=null,decision_needed=(id=root_id)
        where project_id=new.id;
    end if;
  end if;
  return new;
end $$;

revoke all on function public.project_scope_ratification_immutable(),
  public.project_org_scope_ratification_state(uuid),
  public.project_org_scope_path_supported(uuid,text),
  public.project_org_prepare_scope_ratification(uuid,jsonb,text),
  public.project_org_ratify_scope(uuid,uuid,text)
from public,anon,authenticated,service_role;
grant execute on function public.project_org_prepare_scope_ratification(uuid,jsonb,text),
  public.project_org_ratify_scope(uuid,uuid,text) to service_role;

commit;
