begin;

-- Original DO only. The privileged release operator MUST close this fence
-- before ANY canonical alias promotion; SQL claim/owner writers acquire the
-- identical mission.state/mission.claim locks before consulting it.
-- A missing or closed fence fails closed, and runtime service_role cannot
-- set or reopen the fence.
create table public.project_retest_production_release_gate (
 project_id uuid primary key references public.work_projects(id)
  check(project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid),
 release_sha text not null check(release_sha ~ '^[0-9a-f]{40}$'),
 deployment_id text not null check(deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 alias_name text not null default 'katie-mu.vercel.app'
  check(alias_name='katie-mu.vercel.app'),
 state text not null check(state in ('closed','active')),
 generation bigint not null default 1 check(generation>0),
 updated_at timestamptz not null default clock_timestamp()
);
alter table public.project_retest_production_release_gate enable row level security;
revoke all on public.project_retest_production_release_gate
 from public,anon,authenticated,service_role;
grant select on public.project_retest_production_release_gate to service_role;

create function public.project_org_retest_active_release(
 p_project uuid,p_release text
) returns boolean language sql stable security definer set search_path=public,pg_temp as $fn$
 select exists(select 1 from project_retest_production_release_gate g
  where g.project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  and g.project_id=p_project and g.release_sha=p_release
  and g.state='active' and g.alias_name='katie-mu.vercel.app');
$fn$;

-- POSTGRES-only operator release control; not owner approval. The operator
-- must independently verify exact READY deployment/alias before 'active'.
-- Vercel automatic alias assignment must be disabled for the trial and all
-- production promotions must follow CLOSE -> PROMOTE -> OPEN. Never register
-- a SHA based only on VERCEL_GIT_COMMIT_SHA reported by a stale runtime.
create function public.project_org_retest_set_release_gate(
 p_project uuid,p_release text,p_deployment text,p_action text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
declare g project_retest_production_release_gate;p work_projects;stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 select * into p from work_projects where id=p_project for update;
 select * into g from project_retest_production_release_gate where project_id=p_project for update;
 if p.id is null or p.id is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  or p_release is null or p_release !~ '^[0-9a-f]{40}$'
  or p_deployment is null or p_deployment !~ '^dpl_[A-Za-z0-9]+$'
  or p_action is null or p_action not in ('active','closed')
  or p.max_missions<>96 or p.token_allowance<>600000
  or p.approved_hash is distinct from '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  or not exists(select 1 from project_blocked_management_retest_receipts r
    where r.project_id=p_project and r.historical_missions=78)
 then raise exception 'Exact original project release authority required';end if;
 if p_action='closed' and (g.project_id is null or g.state<>'active'
   or g.release_sha is distinct from p_release or g.deployment_id is distinct from p_deployment)
 then raise exception 'Only active exact deployment can be sealed before promotion';end if;
 if p_action='active' and g.project_id is not null and g.state<>'closed'
 then raise exception 'Prior release must be closed before a new SHA is activated';end if;
 -- Closing a generation must NEVER race a paid worker that already holds a
 -- source-bound lease. An expired lease can be cleared/requeued by the worker
 -- scheduler while the original worker is still in-flight, so reject every
 -- non-completed attempted assignment in the renewed mission lineage, even
 -- when lease is null. Terminal completed jobs cannot start new inference.
 -- The global state/claim advisory locks serialize this check with leasing.
 if exists(
  select 1 from agent_missions m
  join mission_assignments j on j.mission_id=m.id
  left join project_retest_future_window_receipts w on w.project_id=m.project_id
  where m.project_id=p_project
   and (m.id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
     or (w.project_id is not null and m.created_at>=w.authorized_at))
   and j.attempts>0
   and (j.lease is not null or j.lease_until is not null
    or j.status not in ('completed','failed')
    or (j.status='failed' and exists(
      select 1 from project_provider_requests request
      where request.assignment_id=j.id and request.resolved_at is null)))
 ) then raise exception 'Undrained owner-renewed worker attempt; release gate transition denied';end if;
 stamp:=clock_timestamp();
 if g.project_id is null then
  if p_action<>'active' then raise exception 'Initial release requires verified READY alias';end if;
  insert into project_retest_production_release_gate
   (project_id,release_sha,deployment_id,state,generation,updated_at)
   values(p_project,p_release,p_deployment,'active',1,stamp);
 else
  update project_retest_production_release_gate
   set release_sha=p_release,deployment_id=p_deployment,state=p_action,
       generation=g.generation+1,updated_at=stamp where project_id=p_project;
 end if;
 insert into project_events(project_id,event,data)
 values(p_project,'mission79_release_gate_transition',
  jsonb_build_object('action',p_action,'releaseSha',p_release,
    'deploymentId',p_deployment,'alias','katie-mu.vercel.app',
    'priorGeneration',g.generation,'recordedAt',stamp));
 return jsonb_build_object('projectId',p_project,'state',p_action,
  'releaseSha',p_release,'deploymentId',p_deployment,'recordedAt',stamp);
end
$fn$;
revoke all on function
 public.project_org_retest_active_release(uuid,text),
 public.project_org_retest_set_release_gate(uuid,text,text,text)
 from public,anon,authenticated,service_role;
grant execute on function public.project_org_retest_active_release(uuid,text)
 to service_role;
-- project_org_retest_set_release_gate is executable ONLY by its owning postgres role.


-- Issue #1061, mission 79: the owner has already admitted one retest. The
-- original continuation is deliberately immutable here. A release operator
-- must verify the actual READY production SHA before explicitly binding it.
-- No mission, assignment, deadline, budget or approval row is rewritten.
create table public.project_retest_claim_release_receipts (
 project_id uuid primary key references public.work_projects(id),
 owner_id uuid not null,
 window_id uuid not null references public.project_execution_windows(id),
 source_mission_id uuid not null references public.agent_missions(id),
 mission_id uuid not null references public.agent_missions(id),
 assignment_id uuid not null unique references public.mission_assignments(id),
 prior_release_sha text not null check(prior_release_sha ~ '^[a-f0-9]{40}$'),
 retest_release_sha text not null check(retest_release_sha ~ '^[a-f0-9]{40}$'),
 bound_release_sha text not null check(bound_release_sha ~ '^[a-f0-9]{40}$' and bound_release_sha<>prior_release_sha),
 scope_hash text not null check(scope_hash ~ '^[a-f0-9]{64}$'),
 cutoff timestamptz not null,
 historical_missions integer not null check(historical_missions=79),
 bound_at timestamptz not null default clock_timestamp()
);
alter table public.project_retest_claim_release_receipts enable row level security;
revoke all on public.project_retest_claim_release_receipts from public,anon,authenticated,service_role;
grant select on public.project_retest_claim_release_receipts to service_role;
create trigger project_retest_claim_release_immutable before update or delete
 on public.project_retest_claim_release_receipts for each row
 execute function public.project_org_change_immutable();

-- Preserve the old continuation AND mission evidence predicates. Only an
-- additional release exactly recorded against the original owner-approved
-- retest is accepted, and only under the unchanged original project envelope.
create function public.project_org_retest_claim_release_authorized(
 p_project uuid,p_release text
) returns boolean language sql stable security definer set search_path=public,pg_temp as $fn$
 select exists(
  select 1 from project_retest_claim_release_receipts b
  join project_blocked_management_retest_receipts r on r.project_id=b.project_id
   and r.owner_id=b.owner_id and r.window_id=b.window_id
   and r.source_mission_id=b.source_mission_id
   and r.release_sha=b.retest_release_sha and r.prior_release_sha=b.prior_release_sha
   and r.scope_hash=b.scope_hash and r.cutoff=b.cutoff and r.historical_missions=78
  join project_provider_execution a on a.project_id=b.project_id
   and a.owner_id=b.owner_id and a.window_id=b.window_id
   and a.continuation_release_sha=b.prior_release_sha
   and a.approved_scope=b.scope_hash and a.deadline=b.cutoff
  join work_projects p on p.id=b.project_id
   and p.deadline=b.cutoff and p.approved_hash=b.scope_hash
   and p.approval_hash=b.scope_hash
  where b.project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
   and b.project_id=p_project and b.bound_release_sha=p_release
   and p.status='running' and p.phase='development' and p.organization_version=1
   and p.active_mission_id is not null and p.deadline>clock_timestamp()
   and p.max_missions=96 and p.token_allowance=600000
   and (select count(*) from agent_missions m where m.project_id=p.id) between 79 and 96
   and project_provider_continued(p.id)
   and project_org_blocked_owner_release(b.window_id,b.prior_release_sha)
 );
$fn$;

-- Read-only fail-closed release binding offer for the exact queued 79th
-- management assignment, not a general continuation or new execution window.
create function public.project_org_retest_claim_release_offer(
 p_owner uuid,p_project uuid,p_release text
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $fn$
declare
 p work_projects;a project_provider_execution;r project_blocked_management_retest_receipts;
 b project_retest_claim_release_receipts;m agent_missions;j mission_assignments;
 n project_organization_nodes;used integer;
begin
 select * into p from work_projects where id=p_project;
 select * into a from project_provider_execution where project_id=p_project;
 select * into r from project_blocked_management_retest_receipts where project_id=p_project;
 if p_project is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  or p.id is null or p_owner is null or a.owner_id is distinct from p_owner
  or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  or p_release is null or p_release !~ '^[a-f0-9]{40}$'
 then raise exception 'Original authenticated owner and verified production release required';end if;
 select * into b from project_retest_claim_release_receipts where project_id=p.id;
 if b.project_id is not null then
  if b.owner_id is distinct from p_owner or b.bound_release_sha is distinct from p_release
    or not project_org_retest_claim_release_authorized(p.id,p_release)
  then raise exception 'Recorded execution-release binding changed or production release advanced';end if;
  return jsonb_build_object('projectId',p.id,'stage','bound','releaseSha',p_release,
   'sourceMissionId',b.source_mission_id,'missionId',b.mission_id,
   'assignmentId',b.assignment_id,'windowId',b.window_id,'scopeHash',b.scope_hash,
   'cutoff',b.cutoff,'historicalMissions',b.historical_missions,'maxMissions',96,
   'tokenAllowance',600000,'boundAt',b.bound_at,
   'stateHash',project_org_hierarchy_recovery_state(p.id));
 end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id;
 select * into j from mission_assignments where mission_id=m.id and role='work';
 select * into n from project_organization_nodes where id=(m.project_evidence->>'organizationNodeId')::uuid and project_id=p.id;
 select count(*) into used from agent_missions where project_id=p.id;
 if p.organization_version<>1 or not project_provider_mode(p.id)
  or p.status not in ('running','blocked') or p.phase<>'development'
  or (p.status='blocked' and p.detail is distinct from
   'No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.')
  or p.lease is not null or p.lease_until is not null
  or p.deadline is distinct from r.cutoff
  or p.deadline<=clock_timestamp()+interval '5 minutes'
  or p.approved_hash is distinct from '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  or p.approval_hash is distinct from p.approved_hash
  or p.max_missions<>96 or p.token_allowance<>600000 or used<>79
  or (select count(*) from project_organization_nodes x where x.project_id=p.id and x.status='active' and x.deadline=p.deadline)<>13
  or a.objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
  or a.deadline is distinct from p.deadline or a.approved_scope is distinct from p.approved_hash
  or a.window_id is distinct from r.window_id or a.continuation_release_sha is distinct from r.prior_release_sha
  or a.continued_at is null or not project_provider_continued(p.id)
  or r.owner_id is distinct from p_owner or r.source_mission_id is distinct from '911d15bd-be5f-416e-bbac-fbe86ca6fa90'::uuid
  or r.historical_missions<>78 or r.cutoff is distinct from p.deadline
  or r.scope_hash is distinct from p.approved_hash or r.release_sha is null
  or r.release_sha !~ '^[a-f0-9]{40}$' or r.release_sha=r.prior_release_sha
  or p_release is not distinct from a.continuation_release_sha
  or not project_org_blocked_owner_release(r.window_id,r.prior_release_sha)
  or m.id is null or m.status<>'running' or m.project_kind<>'management'
  or m.calls<>0 or m.routing_calls<>0 or m.deadline is distinct from p.deadline
  or m.created_at<r.authorized_at or m.project_evidence->>'previousMissionId' is not null
  or m.project_evidence->>'providerContinuationWindow' is distinct from r.window_id::text
  or m.project_evidence->>'providerContinuationRelease' is distinct from r.prior_release_sha
  or m.project_evidence->>'providerContinuationDecision' is distinct from a.continuation_decision_id::text
  or n.id is null or n.kind<>'project_director' or n.parent_id is not null or n.status<>'active'
  or n.id::text is distinct from m.project_evidence->>'organizationNodeId'
  or j.id is null or j.agent_id is distinct from n.agent_id
  or j.payload->>'organizationNodeId' is distinct from n.id::text
  or j.status<>'queued' or j.attempts<>0 or j.lease is not null or j.lease_until is not null
  or j.available_at>clock_timestamp()
  or (select count(*) from mission_assignments jj where jj.mission_id=m.id)<>1
  or not project_provider_continued_assignment(j.id)
  or exists(select 1 from mission_assignments jj join agent_missions mm on mm.id=jj.mission_id
    where mm.project_id=p.id and jj.id<>j.id and jj.status in ('queued','running','waiting_external'))
  or exists(select 1 from project_work_packages w where w.project_id=p.id)
  or project_provider_request_pending(p.id)
  or exists(with recursive qa as
    (select id from project_organization_nodes where project_id=p.id and area in ('quality_assurance','independent_qa')
     union all select x.id from project_organization_nodes x join qa on x.parent_id=qa.id)
     select 1 from qa join project_organization_nodes x on x.id=qa.id where 'development'=any(x.tools))
 then raise exception 'Original owner retest, active management assignment or release authority changed';end if;
 return jsonb_build_object('projectId',p.id,'stage','bind','releaseSha',p_release,
  'sourceMissionId',r.source_mission_id,'missionId',m.id,'assignmentId',j.id,
  'windowId',r.window_id,'scopeHash',r.scope_hash,'cutoff',r.cutoff,
  'historicalMissions',used,'maxMissions',p.max_missions,
  'tokenAllowance',p.token_allowance,'stateHash',project_org_hierarchy_recovery_state(p.id));
end
$fn$;

-- EPD-controlled first-party release action: bind the exact READY production
-- SHA confirmed outside PostgreSQL against the ALREADY approved owner retest.
-- This is not another owner window, new approval, model call or mission replay.
create function public.project_org_bind_retest_claim_release(
 p_owner uuid,p_project uuid,p_release text,p_mission uuid,p_assignment uuid,p_state_hash text,
 p_epoch bigint,p_deployment text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
declare p work_projects;offer jsonb;stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 select * into p from work_projects where id=p_project for update;
 perform 1 from project_provider_execution where project_id=p_project for update;
 perform 1 from agent_missions where id=p_mission and project_id=p_project for update;
 perform 1 from mission_assignments where id=p_assignment and mission_id=p_mission for update;
 offer:=project_org_retest_claim_release_offer(p_owner,p_project,p_release);
 if offer->>'stage' is distinct from 'bind'
  or p_mission is distinct from (offer->>'missionId')::uuid
  or p_assignment is distinct from (offer->>'assignmentId')::uuid
  or p_mission is distinct from 'b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  or p_assignment is distinct from '85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
  or p_state_hash is null or p_state_hash is distinct from offer->>'stateHash'
  or (offer->>'cutoff')::timestamptz<=clock_timestamp()+interval '5 minutes'
 then raise exception 'Exact existing owner retest and production release required';end if;
 stamp:=clock_timestamp();
 -- The original scheduler's 45-minute wait watchdog has since blocked
 -- this still-queued mission. Re-admit ONLY that exact no-progress state,
 -- after the immutable retest and current source-bound release pass above.
 -- The inactivity clock begins again at this genuine recovery transition;
 -- no technical artifact, mission attempt, token or spend is fabricated.
 if p.status='blocked' then
  update work_projects set status='running',
   progress_since=stamp,updated_at=stamp,
   detail='Original owner-approved mission 79 re-admitted after exact release binding; queued work unchanged.'
  where id=p.id and status='blocked';
 end if;
 insert into project_retest_claim_release_receipts(
  project_id,owner_id,window_id,source_mission_id,mission_id,assignment_id,
  prior_release_sha,retest_release_sha,bound_release_sha,scope_hash,cutoff,historical_missions,bound_at
 ) select p.id,p_owner,r.window_id,r.source_mission_id,p_mission,p_assignment,
   r.prior_release_sha,r.release_sha,p_release,r.scope_hash,r.cutoff,79,stamp
   from project_blocked_management_retest_receipts r where r.project_id=p.id;
 if not project_org_retest_claim_release_authorized(p.id,p_release)
 then raise exception 'Release binding does not preserve original owner scope and window';end if;
 insert into project_events(project_id,event,data) values(p.id,'owner_retest_claim_release_bound',
  jsonb_build_object('ownerId',p_owner,'sourceMissionId',offer->>'sourceMissionId',
    'missionId',p_mission,'assignmentId',p_assignment,'windowId',offer->>'windowId',
    'retestReleaseSha',(select retest_release_sha from project_retest_claim_release_receipts where project_id=p.id),
    'priorProjectStatus',p.status,'watchdogReadmission',p.status='blocked',
    'releaseSha',p_release,'scopeHash',p.approved_hash,'cutoff',p.deadline,
    'historicalMissions',79,'maxMissions',96,'tokenAllowance',600000,'boundAt',stamp));
 return jsonb_build_object('projectId',p.id,'stage','bound','releaseSha',p_release,
   'missionId',p_mission,'assignmentId',p_assignment,'windowId',offer->>'windowId',
   'sourceMissionId',offer->>'sourceMissionId','cutoff',p.deadline,
   'scopeHash',p.approved_hash,'historicalMissions',79,'maxMissions',96,
   'tokenAllowance',600000,'boundAt',stamp,'existing',false);
end
$fn$;

-- Modify only the two original exact-release admission conjuncts. Never
-- replace project_provider_continued_assignment, its window/source checks,
-- or the legacy director recovery guards; every other project is unchanged.
do $patch$
declare
 body text;
 anchor text:='(project_provider_continued_assignment(a.id) and p_release=(select continuation_release_sha from project_provider_execution where project_id=b.project_id))';
 replacement text:='(project_provider_continued_assignment(a.id) and (p_release=(select continuation_release_sha from project_provider_execution where project_id=b.project_id) or project_org_retest_claim_release_authorized(b.project_id,p_release)))';
begin
 body:=pg_get_functiondef('public.claim_mission_work_release(text)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>2
 then raise exception 'Unexpected installed exact-release worker claim contract';end if;
 execute replace(body,anchor,replacement);
end $patch$;

-- Expired original window: do not rewrite either consumed owner receipt.
-- A SECOND owner click is required for a new deadline, with no implied value.
create table public.project_retest_future_window_receipts (
 project_id uuid primary key references public.work_projects(id)
   check(project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid),
 authorization_id uuid not null unique references public.project_execution_windows(id),
 owner_id uuid not null,
 prior_window_id uuid not null references public.project_execution_windows(id),
 source_mission_id uuid not null references public.agent_missions(id),
 mission_id uuid not null unique references public.agent_missions(id),
 assignment_id uuid not null unique references public.mission_assignments(id),
 release_sha text not null check(release_sha ~ '^[a-f0-9]{40}$'),
 original_retest_release_sha text not null check(original_retest_release_sha ~ '^[a-f0-9]{40}$'),
 original_continuation_release_sha text not null check(original_continuation_release_sha ~ '^[a-f0-9]{40}$'),
 scope_hash text not null check(scope_hash ~ '^[a-f0-9]{64}$'),
 prior_cutoff timestamptz not null,
 cutoff timestamptz not null,
 state_hash text not null check(state_hash ~ '^[a-f0-9]{64}$'),
 organization_hash text not null check(organization_hash ~ '^[a-f0-9]{64}$'),
 historical_missions integer not null check(historical_missions=79),
 authorized_at timestamptz not null default clock_timestamp(),
 check(isfinite(prior_cutoff) and isfinite(cutoff) and cutoff>prior_cutoff)
);
alter table public.project_retest_future_window_receipts enable row level security;
revoke all on public.project_retest_future_window_receipts from public,anon,authenticated,service_role;
grant select on public.project_retest_future_window_receipts to service_role;
create trigger project_retest_future_window_immutable before update or delete
 on public.project_retest_future_window_receipts for each row
 execute function public.project_org_change_immutable();

-- The three original grants are a CLOSED historical set. Each live node
-- must be the SAME identity carried by its append-only 13-node window
-- contract; the paths come from the immutable owner-ratified proposal.
-- A missing/extra grant, changed path, parent, permission or scope fails closed.
create function public.project_org_retest_exact_scope_grants(p_project uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $fn$
 select exists(
  select 1 from work_projects p
  join project_blocked_management_retest_receipts r on r.project_id=p.id
  join project_scope_ratification_approvals approval on approval.project_id=p.id
   and approval.owner_id=r.owner_id and approval.scope_hash=r.scope_hash
  join project_scope_ratification_proposals proposal on proposal.id=approval.proposal_id
   and proposal.project_id=p.id and proposal.scope_hash=r.scope_hash
  join project_blocked_owner_windows original_window
   on original_window.project_id=p.id and original_window.authorization_id=r.window_id
  where p.id=p_project
   and p.id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
   and p.approved_hash=r.scope_hash and p.approval_hash=r.scope_hash
   and p.spec->'allowedPaths'=proposal.spec->'allowedPaths'
   and proposal.spec->'allowedPaths'=to_jsonb(array[
    'app/milestone-3-tic-tac-toe/',
    'lib/milestone-3-tic-tac-toe/',
    'tests/milestone-3-tic-tac-toe/']::text[])
   and exists(select 1 from project_events ratified
    where ratified.project_id=p.id and ratified.event='scope_ratified'
     and ratified.data->>'proposalId'=proposal.id::text
     and ratified.data->>'scopeHash'=r.scope_hash
     and ratified.data->>'ownerId'=r.owner_id::text
     and ratified.data->>'organizationHash'=proposal.organization_hash)
   and (select count(*) from project_organization_scope_grants g
    join project_organization_nodes n on n.id=g.node_id
    where n.project_id=p.id)=3
   and (select count(*) from (
    values
     ('general'::text,'project_director'::text,'project_director'::text,
      0,null::text,null::text,
      array['manage','analysis','research','development','repository_review']::text[]),
     ('game_delivery','manager','functional_director',
      1,'general','project_director',
      array['analysis','development','manage','repository_review']::text[]),
     ('delivery_management','manager','manager',
      2,'game_delivery','functional_director',
      array['analysis','development','manage','repository_review']::text[])
    ) expected(area,kind,management_level,depth,parent_area,parent_level,tools)
    join project_organization_nodes n on n.project_id=p.id
     and n.area=expected.area and n.kind=expected.kind
     and n.management_level=expected.management_level and n.depth=expected.depth
     and n.status='active' and n.tools=expected.tools
    left join project_organization_nodes parent on parent.id=n.parent_id
     and parent.project_id=p.id
    join project_organization_scope_grants g on g.node_id=n.id
     and g.scope_hash=r.scope_hash
     and g.parent_id is not distinct from n.parent_id
     and g.paths=array(select jsonb_array_elements_text(proposal.spec->'allowedPaths'))
    join project_organization_contract_changes history on history.node_id=n.id
     and history.project_id=p.id and history.window_id=r.window_id
     and history.prior_deadline=original_window.prior_cutoff
     and history.deadline=original_window.cutoff
     and history.tools=history.prior_tools and history.tools=n.tools
    where (expected.parent_area is null and n.parent_id is null
      or parent.area=expected.parent_area
       and parent.management_level=expected.parent_level)
   )=3
 );
$fn$;

-- Verify immutable original owner/resume and 13 unchanged original
-- contracts even after the live project moves to a newly approved window.
create function public.project_org_retest_original_owner_lineage(
 p_project uuid
) returns boolean language sql stable security definer set search_path=public,pg_temp as $fn$
 select exists(
  select 1 from project_blocked_management_retest_receipts r
  join project_blocked_owner_windows w on w.project_id=r.project_id
   and w.authorization_id=r.window_id and w.owner_id=r.owner_id
   and w.cutoff=r.cutoff and w.scope_hash=r.scope_hash
   and w.resume_release_sha=r.prior_release_sha
  join project_blocked_owner_resumes s on s.project_id=w.project_id
   and s.owner_id=w.owner_id and s.authorization_id=w.authorization_id
   and s.release_sha=w.resume_release_sha
  join project_execution_windows oldw on oldw.id=w.authorization_id
   and oldw.project_id=w.project_id and oldw.owner_id=w.owner_id
   and oldw.decision_id=w.decision_id and oldw.release_sha=w.prior_release_sha
  join project_provider_execution original_a on original_a.project_id=r.project_id
   and original_a.owner_id=r.owner_id and original_a.continuation_decision_id=oldw.decision_id
   and oldw.prior_cutoff=w.prior_cutoff and oldw.cutoff=w.cutoff
  where r.project_id=p_project
   and r.project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
   and r.source_mission_id='911d15bd-be5f-416e-bbac-fbe86ca6fa90'::uuid
   and r.window_id='7d216bbe-596e-457e-b84d-e07ad1e80365'::uuid
   and r.cutoff='2026-11-18T14:00:00Z'::timestamptz
   and r.historical_missions=78
   and (select count(*) from project_organization_nodes n
      join project_organization_contract_changes c on c.node_id=n.id
       and c.project_id=n.project_id and c.window_id=w.authorization_id
      where n.project_id=r.project_id and n.status='active'
       and c.prior_deadline=w.prior_cutoff and c.deadline=w.cutoff
       and c.tools=c.prior_tools and n.tools=c.tools)=13
   and (select count(*) from project_organization_nodes n
      where n.project_id=r.project_id and n.status='active')=13
   and (select count(distinct c.node_id) from project_organization_contract_changes c
      join project_organization_nodes n on n.id=c.node_id
       and n.project_id=c.project_id and n.status='active'
      where c.project_id=r.project_id and c.window_id=w.authorization_id
       and c.prior_deadline=w.prior_cutoff and c.deadline=w.cutoff
       and c.tools=c.prior_tools and n.tools=c.tools)=13
   and (select count(*) from project_organization_contract_changes c
      where c.project_id=r.project_id and c.window_id=w.authorization_id)=13
   -- The historical source itself must still be the same blocked director
   -- mission. Receipt references alone are not proof that it is unchanged.
   and exists(select 1 from agent_missions src
     join project_organization_nodes director on director.project_id=src.project_id
      and director.id::text=src.project_evidence->>'organizationNodeId'
     where src.id=r.source_mission_id and src.project_id=r.project_id
       and src.project_kind='management' and src.status='blocked'
       and src.created_at<=r.authorized_at
       and src.project_evidence->>'providerContinuationWindow'=r.window_id::text
       and src.project_evidence->>'providerContinuationRelease'=r.prior_release_sha
       and src.project_evidence->>'previousMissionId' is null
       and src.project_evidence->>'providerContinuationDecision'=original_a.continuation_decision_id::text
       and director.kind='project_director' and director.parent_id is null
       and director.management_level='project_director'
       -- Immutable normalized full JSON evidence from the saved original
       -- mission. Root identity and continuation release are separately
       -- verified above against the actual director and owner receipt.
       and md5((src.project_evidence||jsonb_build_object(
        'organizationNodeId','PROJECT_DIRECTOR_ROOT',
        'providerContinuationRelease','ORIGINAL_CONTINUATION_RELEASE',
        'providerContinuationDecision','ORIGINAL_OWNER_DECISION'))::text)
        ='4394ff6c15ac6d3bdc9e12daf6629d8d'
       and md5(src.detail)='8ddada511e8f2bf0651bac4cab805156')
   and (select count(*) from mission_assignments historical_job
      where historical_job.mission_id=r.source_mission_id)=1
   and exists(select 1 from mission_assignments historical_job
      join project_organization_nodes director
       on director.project_id=r.project_id and director.agent_id=historical_job.agent_id
       and director.kind='project_director'
       and director.parent_id is null
      where historical_job.id='cd81b57d-0812-485c-b8f6-d658aa80186f'::uuid
       and historical_job.mission_id=r.source_mission_id
       and historical_job.job_key='plan' and historical_job.role='work'
       and historical_job.status='failed' and historical_job.attempts=1
       and historical_job.lease is null
       and historical_job.payload->>'organizationNodeId'=director.id::text
       and historical_job.result->>'detail' like '%No delegation change requested%'
       and md5(historical_job.result::text)='6fb74874bbd75251de00eae1d12ea736'
       and md5((historical_job.payload||jsonb_build_object(
        'organizationNodeId','PROJECT_DIRECTOR_ROOT'))::text)
        ='767e9764ef2b102f90a05e5b823a7db8'
       and md5(historical_job.instruction)='a11af3226e8a475603769242c6133e4b')
   -- Freeze the actual original 13-node reporting/QA structure, sourced from
   -- the preserved project rather than re-hashing a potentially drifted
   -- hierarchy after renewal. Node IDs are already bound to 13 immutable
   -- historical contract-change rows above.
   and (select jsonb_object_agg(role_signature,qty) from (
     select n.area||'|'||n.kind||'|'||n.management_level||'|'||n.depth::text
       ||'|'||coalesce(parent.area,'ROOT')
       ||'|'||coalesce(parent.management_level,'ROOT') role_signature,
       count(*) qty
     from project_organization_nodes n
     left join project_organization_nodes parent on parent.id=n.parent_id
       and parent.project_id=n.project_id
     where n.project_id=r.project_id and n.status='active'
     group by 1
   ) saved_topology)=jsonb_build_object(
     'general|project_director|project_director|0|ROOT|ROOT',1,
     'game_delivery|manager|functional_director|1|general|project_director',1,
     'independent_qa|manager|functional_director|1|general|project_director',1,
     'delivery_management|manager|manager|2|game_delivery|functional_director',1,
     'independent_qa_execution|manager|manager|2|independent_qa|functional_director',1,
     'independent_qa_planning|manager|manager|2|independent_qa|functional_director',1,
     'delivery_planning|manager|supervisor|3|delivery_management|manager',1,
     'delivery_repository_assessment|worker|worker|3|delivery_management|manager',1,
     'independent_qa_execution_coordination|manager|supervisor|3|independent_qa_execution|manager',2,
     'qa_planning|manager|supervisor|3|independent_qa_planning|manager',3)
   and project_org_retest_exact_scope_grants(r.project_id)
 );
$fn$;

-- New-window membership is ONLY for the saved mission 79/queued job, and
-- requires both immutable owner receipts and the new owner-selected window.
-- Historical mission providerContinuationWindow/Release/Decision stay intact.
create function public.project_org_retest_renewed_assignment(
 p_mission uuid,p_job uuid
) returns boolean language sql stable security definer set search_path=public,pg_temp as $fn$
 select exists(select 1 from project_retest_future_window_receipts q
 join project_blocked_management_retest_receipts r on r.project_id=q.project_id
   and r.owner_id=q.owner_id and r.window_id=q.prior_window_id
   and r.source_mission_id=q.source_mission_id
   and r.release_sha=q.original_retest_release_sha
   and r.prior_release_sha=q.original_continuation_release_sha
   and r.scope_hash=q.scope_hash and r.cutoff=q.prior_cutoff
   and r.historical_missions=78
 join project_execution_windows w on w.id=q.authorization_id
   and w.project_id=q.project_id and w.owner_id=q.owner_id
   and w.release_sha=q.original_continuation_release_sha
   and w.prior_cutoff=q.prior_cutoff and w.cutoff=q.cutoff
 join work_projects p on p.id=q.project_id
   and p.deadline=q.cutoff and p.approved_hash=q.scope_hash
   and p.approval_hash=q.scope_hash and p.max_missions=96
   and p.token_allowance=600000 and p.organization_version=1
 join project_provider_execution a on a.project_id=p.id
   and a.owner_id=q.owner_id and a.window_id=q.authorization_id
   and a.deadline=q.cutoff and a.approved_scope=q.scope_hash
   and a.continuation_release_sha=q.original_continuation_release_sha
   and a.continuation_decision_id=w.decision_id
 join agent_missions m on m.id=q.mission_id and m.project_id=p.id
   and m.deadline=q.cutoff and m.project_kind='management'
 join mission_assignments j on j.id=q.assignment_id and j.mission_id=m.id
 where q.project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  and m.id=p_mission and j.id=p_job
  and m.id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  and j.id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
  and q.historical_missions=79
  and (select count(*) from agent_missions mm where mm.project_id=p.id)=79
  and p.active_mission_id=m.id and p.phase='development'
  and p.status in ('blocked','running') and m.status in ('blocked','running')
  and m.project_evidence->>'providerContinuationWindow'=r.window_id::text
  and m.project_evidence->>'providerContinuationRelease'=r.prior_release_sha
  and m.project_evidence->>'providerContinuationDecision'=a.continuation_decision_id::text
  and m.project_evidence->>'previousMissionId' is null
  -- The scheduler-created original mission 79 must retain the COMPLETE
  -- historical management source JSON. Its predecessor is independently
  -- attested against an immutable original-production evidence digest.
  and m.project_evidence=(select source.project_evidence from agent_missions source
    where source.id=r.source_mission_id and source.project_id=p.id)
  and j.payload=(select old_assignment.payload from mission_assignments old_assignment
    where old_assignment.id='cd81b57d-0812-485c-b8f6-d658aa80186f'::uuid
      and old_assignment.mission_id=r.source_mission_id)
  and project_org_retest_original_owner_lineage(p.id)
 and project_org_scope_ratification_state(p.id)=q.organization_hash
  and (select count(*) from project_organization_contract_changes c
    join project_organization_nodes n on n.id=c.node_id and n.project_id=p.id
    where c.project_id=p.id and c.window_id=q.authorization_id
      and c.deadline=q.cutoff and c.prior_deadline=q.prior_cutoff
      and c.tools=c.prior_tools and n.tools=c.tools
      and n.status='active' and n.deadline=q.cutoff)=13
  and (select count(*) from project_organization_nodes n
    where n.project_id=p.id and n.status='active' and n.deadline=q.cutoff)=13
  and not exists(with recursive qa as
    (select id from project_organization_nodes where project_id=p.id
     and area in ('independent_qa','quality_assurance')
     union all select child.id from project_organization_nodes child join qa on child.parent_id=qa.id)
    select 1 from qa join project_organization_nodes n on n.id=qa.id
     where 'development'=any(n.tools))
 );
$fn$;

-- Retain original authorization checks; only exact owner-renewed mission 79
-- may inherit its existing source when the current window ID has advanced.
do $source_patch$
declare body text;
 anchor text:='(m.project_evidence->>''providerContinuationWindow'') is not distinct from a.window_id::text and public.project_provider_continued(a.project_id)';
 replacement text:='((m.project_evidence->>''providerContinuationWindow'') is not distinct from a.window_id::text or public.project_org_retest_renewed_assignment(m.id,j.id)) and public.project_provider_continued(a.project_id)';
begin
 body:=pg_get_functiondef('public.project_provider_continued_assignment(uuid)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
 then raise exception 'Original provider assignment source membership contract changed';end if;
 execute replace(body,anchor,replacement);
end $source_patch$;

-- After new owner renewal, the historical provider SHA is no longer eligible
-- for the same saved assignment, even though its original evidence is retained.
do $renewed_exact_release_fence$
declare body text;
 anchor text:='(project_provider_continued_assignment(a.id) and (p_release=(select continuation_release_sha from project_provider_execution where project_id=b.project_id) or project_org_retest_claim_release_authorized(b.project_id,p_release)))';
 replacement text:='(project_provider_continued_assignment(a.id) and ((p_release=(select continuation_release_sha from project_provider_execution where project_id=b.project_id) and not exists(select 1 from project_retest_future_window_receipts q where q.project_id=b.project_id)) or project_org_retest_claim_release_authorized(b.project_id,p_release)))';
begin
 body:=pg_get_functiondef('public.claim_mission_work_release(text)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>2
 then raise exception 'Installed exact-release worker claim contract changed';end if;
 execute replace(body,anchor,replacement);
end $renewed_exact_release_fence$;


-- One locked read-only offer. Never synthesizes an approval or deadline.
create function public.project_org_retest_future_window_offer(
 p_owner uuid,p_project uuid,p_release text
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $fn$
declare p work_projects;a project_provider_execution;r project_blocked_management_retest_receipts;
 q project_retest_future_window_receipts;b project_retest_claim_release_receipts;
 m agent_missions;j mission_assignments;used integer;st text;release_gate project_retest_production_release_gate;
begin
 select * into p from work_projects where id=p_project;
 select * into a from project_provider_execution where project_id=p_project;
 select * into r from project_blocked_management_retest_receipts where project_id=p_project;
 if p_project is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  or p.id is null or a.owner_id is distinct from p_owner
  or p_owner is null or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  or p_release is null or p_release !~ '^[a-f0-9]{40}$'
  or not project_org_retest_active_release(p_project,p_release)
  or r.project_id is null or r.owner_id is distinct from p_owner
  or r.source_mission_id is distinct from '911d15bd-be5f-416e-bbac-fbe86ca6fa90'::uuid
  or r.window_id is distinct from '7d216bbe-596e-457e-b84d-e07ad1e80365'::uuid
  or r.cutoff is distinct from '2026-11-18T14:00:00Z'::timestamptz
  or not exists(select 1 from project_blocked_owner_windows bw where bw.project_id=p.id
    and bw.authorization_id=r.window_id and bw.cutoff=r.cutoff)
  or not project_org_retest_original_owner_lineage(p.id)
  or r.historical_missions<>78
  or r.scope_hash is distinct from '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
  or r.prior_release_sha is null or r.prior_release_sha !~ '^[a-f0-9]{40}$'
  or r.release_sha is null or r.release_sha !~ '^[a-f0-9]{40}$'
  or r.release_sha is not distinct from r.prior_release_sha
  -- This recovery is exclusively after the actual original owner cutoff.
  -- No unexpired owner window may be silently superseded.
  or clock_timestamp()<='2026-11-18T14:00:00Z'::timestamptz
 then raise exception 'Original owner retest and project identity not eligible for window renewal';end if;
 select * into release_gate from project_retest_production_release_gate where project_id=p_project;
 if release_gate.state is distinct from 'active'
  or release_gate.release_sha is distinct from p_release
  or release_gate.generation is null or release_gate.generation<=0
  or release_gate.deployment_id is null
 then raise exception 'Exact original release generation and deployment required';end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id;
 select * into j from mission_assignments where mission_id=m.id and role='work';
 select count(*) into used from agent_missions where project_id=p.id;
 select * into q from project_retest_future_window_receipts where project_id=p.id;
 select * into b from project_retest_claim_release_receipts where project_id=p.id;
 if p.organization_version<>1 or not project_provider_mode(p.id) or p.phase<>'development'
  or p.status not in ('blocked','running') or p.lease is not null or p.lease_until is not null
  or p.approved_hash is distinct from r.scope_hash or p.approval_hash is distinct from p.approved_hash
  or p.max_missions<>96 or p.token_allowance<>600000 or used<>79
  or (select count(*) from project_work_packages w where w.project_id=p.id)<>0
  or (select count(*) from project_organization_nodes n where n.project_id=p.id and n.status='active')<>13
  or a.objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
  or a.continuation_release_sha is distinct from r.prior_release_sha
  or a.approved_scope is distinct from p.approved_hash
  or m.id is distinct from 'b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  or j.id is distinct from '85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
  or m.id is null or m.project_kind<>'management' or m.calls<>0 or m.routing_calls<>0
  or m.created_at<r.authorized_at
  or m.id is distinct from (select mm.id from agent_missions mm where mm.project_id=p.id
    order by mm.created_at desc,mm.id desc limit 1)
  or not exists(select 1 from project_organization_nodes root
    where root.project_id=p.id and root.id::text=m.project_evidence->>'organizationNodeId'
    and root.kind='project_director' and root.parent_id is null
    and root.status='active' and root.agent_id=j.agent_id
    and j.payload->>'organizationNodeId'=root.id::text)
  or exists(with recursive qa as
    (select id from project_organization_nodes where project_id=p.id
     and area in ('quality_assurance','independent_qa')
     union all select child.id from project_organization_nodes child join qa on child.parent_id=qa.id)
    select 1 from qa join project_organization_nodes n on n.id=qa.id
     where 'development'=any(n.tools))
  or m.project_evidence->>'organizationNodeId' is distinct from
     (select id::text from project_organization_nodes n where n.project_id=p.id and n.kind='project_director' and n.parent_id is null)
  or m.project_evidence->>'providerContinuationRelease' is distinct from r.prior_release_sha
  or m.project_evidence->>'providerContinuationWindow' is distinct from r.window_id::text
  or m.project_evidence->>'providerContinuationDecision' is distinct from a.continuation_decision_id::text
  or m.project_evidence->>'previousMissionId' is not null
  or j.id is null or j.status<>'queued' or j.attempts<>0
  or j.lease is not null or j.lease_until is not null
  or (select count(*) from mission_assignments jj where jj.mission_id=m.id)<>1
  or project_provider_request_pending(p.id)
 then raise exception 'Original 79th management mission or immutable authority changed';end if;
 if q.project_id is not null then
  if q.owner_id is distinct from p_owner
   or q.mission_id is distinct from m.id or q.assignment_id is distinct from j.id
   or q.prior_window_id is distinct from r.window_id
   or q.scope_hash is distinct from p.approved_hash
   or q.prior_cutoff is distinct from r.cutoff
   or q.original_continuation_release_sha is distinct from r.prior_release_sha
   or q.original_retest_release_sha is distinct from r.release_sha
   or a.window_id is distinct from q.authorization_id
   or a.deadline is distinct from q.cutoff or p.deadline is distinct from q.cutoff
   or m.deadline is distinct from q.cutoff
   or not project_org_retest_renewed_assignment(m.id,j.id)
  then raise exception 'Recorded future window state or production SHA changed';end if;
  st:=case when b.project_id is not null then 'bound' else 'authorized' end;
  if st='bound' and (b.bound_release_sha is distinct from p_release or p.status<>'running' or m.status<>'running')
   then raise exception 'Already-bound exact release changed';end if;
  if st='authorized' and (p.status<>'blocked' or m.status<>'blocked')
   then raise exception 'Recorded window may not auto-restart management';end if;
  return jsonb_build_object('projectId',p.id,'stage',st,'releaseSha',p_release,
   'releaseGeneration',release_gate.generation,'deploymentId',release_gate.deployment_id,
   'authorizationReleaseSha',q.release_sha,
   'status',p.status,'missionStatus',m.status,'sourceMissionId',r.source_mission_id,
   'missionId',m.id,'assignmentId',j.id,'priorWindowId',r.window_id,
   'authorizationId',q.authorization_id,'scopeHash',p.approved_hash,
   'priorCutoff',q.prior_cutoff,'cutoff',q.cutoff,
   'historicalMissions',used,'maxMissions',96,'tokenAllowance',600000,
   'nodeCount',13,'authorizedAt',q.authorized_at,
   'stateHash',project_org_hierarchy_recovery_state(p.id));
 end if;
 if b.project_id is not null or p.status<>'blocked' or m.status<>'blocked'
  or p.detail is distinct from
   'No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.'
  or p.deadline is distinct from r.cutoff or a.deadline is distinct from r.cutoff
  or a.window_id is distinct from r.window_id or m.deadline is distinct from r.cutoff
  or (select count(*) from project_organization_nodes n where n.project_id=p.id and n.deadline=p.deadline and n.status='active')<>13
  or not project_provider_continued(p.id)
  or not project_provider_continued_assignment(j.id)
 then raise exception 'Expired source-bound owner project is not eligible for another window';end if;
 return jsonb_build_object('projectId',p.id,'stage','authorize',
  'releaseSha',p_release,'releaseGeneration',release_gate.generation,
  'deploymentId',release_gate.deployment_id,'status',p.status,'missionStatus',m.status,
  'sourceMissionId',r.source_mission_id,'missionId',m.id,'assignmentId',j.id,
  'priorWindowId',r.window_id,'authorizationId',null,
  'scopeHash',p.approved_hash,'priorCutoff',r.cutoff,'cutoff',null,
  'historicalMissions',used,'maxMissions',96,'tokenAllowance',600000,
  'nodeCount',13,'stateHash',project_org_hierarchy_recovery_state(p.id));
end
$fn$;

-- Exactly one owner-confirmed, future cutoff; no work begins at this stage.
create function public.project_org_authorize_retest_future_window(
 p_owner uuid,p_project uuid,p_release text,p_mission uuid,p_assignment uuid,p_authorization uuid,
 p_cutoff timestamptz,p_state_hash text,p_epoch bigint,p_deployment text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
declare p work_projects;a project_provider_execution;m agent_missions;j mission_assignments;
 r project_blocked_management_retest_receipts;offer jsonb;n project_organization_nodes;stamp timestamptz;
 g project_retest_production_release_gate;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 select * into j from mission_assignments where mission_id=m.id and role='work' for update;
 select * into g from project_retest_production_release_gate where project_id=p_project for update;
 if g.project_id is null or g.state is distinct from 'active'
  or g.release_sha is distinct from p_release
  or g.deployment_id is distinct from p_deployment
  or g.generation is distinct from p_epoch
  or g.alias_name is distinct from 'katie-mu.vercel.app'
 then raise exception 'Observed canonical release epoch or deployment changed under owner write lock';end if;
 offer:=project_org_retest_future_window_offer(p_owner,p_project,p_release);
 if offer->>'stage' is distinct from 'authorize'
  or p_mission is distinct from 'b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  or p_assignment is distinct from '85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
  or p_mission is distinct from m.id or p_assignment is distinct from j.id
  or p_authorization is null or p_state_hash is null or p_state_hash is distinct from offer->>'stateHash'
  or p_cutoff is null or not isfinite(p_cutoff) or p_cutoff<=clock_timestamp()+interval '5 minutes'
  or p_cutoff>clock_timestamp()+interval '24 hours' or p_cutoff<=p.deadline
  or clock_timestamp()<='2026-11-18T14:00:00Z'::timestamptz
  or exists(select 1 from project_execution_windows where id=p_authorization)
 then raise exception 'Fresh authenticated owner future-window selection and unchanged state required';end if;
 perform 1 from project_organization_nodes where project_id=p.id order by depth,id for update;
 perform 1 from project_organization_scope_grants scope_grant
  join project_organization_nodes grant_node on grant_node.id=scope_grant.node_id
  where grant_node.project_id=p.id order by scope_grant.node_id for update of scope_grant;
 if not project_org_retest_exact_scope_grants(p.id)
 then raise exception 'Original three-grant authority changed under owner lock';end if;
 if project_org_hierarchy_recovery_state(p.id) is distinct from p_state_hash
 then raise exception 'Original owner approval state changed while acquiring organization locks';end if;
 -- The original offer cutoff check precedes these organization row locks.
 -- A contender may wait across its five-minute safety margin without any
 -- state-hash change. Do not save an expired owner window after that wait.
 if p_cutoff<=clock_timestamp()+interval '5 minutes'
  or p_cutoff>clock_timestamp()+interval '24 hours'
 then raise exception 'Owner future cutoff expired while acquiring organization locks';end if;
 select * into r from project_blocked_management_retest_receipts where project_id=p.id;
 if r.window_id is distinct from '7d216bbe-596e-457e-b84d-e07ad1e80365'::uuid
  or r.cutoff is distinct from '2026-11-18T14:00:00Z'::timestamptz
 then raise exception 'Original immutable owner retest window or cutoff changed';end if;
 stamp:=clock_timestamp();
 insert into project_execution_windows(id,project_id,owner_id,release_sha,
   decision_id,prior_cutoff,cutoff,prior_release_sha)
 values(p_authorization,p.id,p_owner,a.continuation_release_sha,
   a.continuation_decision_id,p.deadline,p_cutoff,a.continuation_release_sha);
 update project_provider_execution set window_id=p_authorization,deadline=p_cutoff where project_id=p.id;
 update work_projects set deadline=p_cutoff,updated_at=stamp where id=p.id;
 update agent_missions set deadline=p_cutoff,updated_at=stamp where id=m.id;
 for n in select * from project_organization_nodes where project_id=p.id order by depth,id for update loop
  insert into project_organization_contract_changes(project_id,node_id,window_id,
   prior_deadline,deadline,prior_tools,tools,prior_submission)
  values(p.id,n.id,p_authorization,n.deadline,p_cutoff,n.tools,n.tools,n.completion_submission);
  update project_organization_nodes set deadline=p_cutoff where id=n.id;
 end loop;
 insert into project_retest_future_window_receipts(
   project_id,authorization_id,owner_id,prior_window_id,source_mission_id,
   mission_id,assignment_id,release_sha,original_retest_release_sha,
   original_continuation_release_sha,scope_hash,prior_cutoff,cutoff,
   state_hash,organization_hash,historical_missions,authorized_at)
 values(p.id,p_authorization,p_owner,r.window_id,r.source_mission_id,m.id,j.id,
   p_release,r.release_sha,r.prior_release_sha,p.approved_hash,p.deadline,p_cutoff,
   p_state_hash,project_org_scope_ratification_state(p.id),79,stamp);
 if not project_provider_continued(p.id)
  or not project_provider_continued_assignment(j.id)
  or not project_org_retest_renewed_assignment(m.id,j.id)
 then raise exception 'Owner-renewed source remains unauthorized; full transaction rolled back';end if;
 insert into project_events(project_id,event,data) values(p.id,'mission79_future_window_owner_authorized',
  jsonb_build_object('ownerId',p_owner,'authorizationId',p_authorization,
   'originalRetestSourceId',r.source_mission_id,'missionId',m.id,'assignmentId',j.id,
   'oldWindowId',r.window_id,'priorCutoff',p.deadline,'cutoff',p_cutoff,
   'releaseSha',p_release,'scopeHash',p.approved_hash,'historicalMissions',79,
   'maxMissions',96,'tokenAllowance',600000,'authorizedAt',stamp));
 return jsonb_build_object('projectId',p.id,'stage','authorized','authorizationId',p_authorization,
  'sourceMissionId',r.source_mission_id,'missionId',m.id,'assignmentId',j.id,
  'releaseSha',p_release,'scopeHash',p.approved_hash,'priorCutoff',p.deadline,
  'cutoff',p_cutoff,'status','blocked','missionStatus','blocked',
  'historicalMissions',79,'maxMissions',96,'tokenAllowance',600000,
  'authorizedAt',stamp,'existing',false);
end
$fn$;

-- The earlier binder remains installed only as a no-op fail-closed contract
-- until an authentic NEW owner window exists; then new source rules apply.
create or replace function public.project_org_retest_claim_release_authorized(
 p_project uuid,p_release text
) returns boolean language sql stable security definer set search_path=public,pg_temp as $fn$
 select exists(select 1 from project_retest_claim_release_receipts b
 join project_retest_future_window_receipts q on q.project_id=b.project_id
  and q.authorization_id=b.window_id and q.owner_id=b.owner_id
  and q.mission_id=b.mission_id and q.assignment_id=b.assignment_id
  and q.cutoff=b.cutoff
  and q.scope_hash=b.scope_hash
 join project_blocked_management_retest_receipts r on r.project_id=b.project_id
  and r.owner_id=b.owner_id and r.source_mission_id=b.source_mission_id
  and r.window_id=q.prior_window_id and r.cutoff=q.prior_cutoff
  and r.release_sha=b.retest_release_sha and r.prior_release_sha=b.prior_release_sha
  and r.scope_hash=b.scope_hash
 join work_projects p on p.id=b.project_id and p.deadline=q.cutoff
  and p.status='running' and p.active_mission_id=b.mission_id
  and p.max_missions=96 and p.token_allowance=600000
  and p.approved_hash=b.scope_hash and p.approval_hash=b.scope_hash
 join project_provider_execution a on a.project_id=p.id
  and a.owner_id=b.owner_id and a.window_id=q.authorization_id
  and a.continuation_release_sha=b.prior_release_sha and a.deadline=q.cutoff
 join agent_missions m on m.id=b.mission_id and m.project_id=p.id
  and m.status='running' and m.deadline=q.cutoff and m.calls=0
 join mission_assignments j on j.id=b.assignment_id and j.mission_id=m.id
  and j.status='queued' and j.attempts=0 and j.lease is null
 where b.project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  and p_project=b.project_id and p_release=b.bound_release_sha
  and project_org_retest_active_release(p_project,p_release)
  and m.id=q.mission_id and j.id=q.assignment_id
  and p.deadline>clock_timestamp() and project_provider_continued(p.id)
  and project_provider_continued_assignment(j.id)
  and project_org_retest_original_owner_lineage(p.id)
  and project_org_retest_renewed_assignment(m.id,j.id)
  and b.historical_missions=79
 );
$fn$;

create or replace function public.project_org_retest_claim_release_offer(
 p_owner uuid,p_project uuid,p_release text
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $fn$
declare p work_projects;a project_provider_execution;q project_retest_future_window_receipts;
 b project_retest_claim_release_receipts;m agent_missions;j mission_assignments;used integer;
begin
 select * into p from work_projects where id=p_project;
 select * into a from project_provider_execution where project_id=p_project;
 select * into q from project_retest_future_window_receipts where project_id=p_project;
 select * into b from project_retest_claim_release_receipts where project_id=p_project;
 if p_project is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
  or q.project_id is null or p.id is null or a.owner_id is distinct from p_owner
  or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  or not project_org_retest_active_release(p_project,p_release) or q.owner_id is distinct from p_owner
  or p.deadline is distinct from q.cutoff or a.deadline is distinct from q.cutoff
  or a.window_id is distinct from q.authorization_id
  or p.max_missions<>96 or p.token_allowance<>600000
  or p.approved_hash is distinct from q.scope_hash or p.approval_hash is distinct from q.scope_hash
  or p.deadline<=clock_timestamp()+interval '5 minutes'
 then raise exception 'Fresh owner-selected future window and exact production release required';end if;
 select * into m from agent_missions where id=q.mission_id and project_id=p.id;
 select * into j from mission_assignments where id=q.assignment_id and mission_id=m.id;
 select count(*) into used from agent_missions where project_id=p.id;
 if used<>79 or m.id is distinct from q.mission_id
  or j.id is distinct from q.assignment_id
  or m.id is distinct from 'b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  or j.id is distinct from '85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
  or m.calls<>0 or m.routing_calls<>0 or m.deadline is distinct from q.cutoff
  or p.active_mission_id is distinct from m.id
  or j.status<>'queued' or j.attempts<>0 or j.lease is not null or j.lease_until is not null
  or not project_provider_continued(p.id)
  or not project_provider_continued_assignment(j.id)
  or not project_org_retest_renewed_assignment(m.id,j.id)
  or exists(select 1 from project_work_packages pkg where pkg.project_id=p.id)
 then raise exception 'Historical mission 79 or approved renewed source changed';end if;
 if b.project_id is not null then
  if b.bound_release_sha is distinct from p_release or m.status<>'running' or p.status<>'running'
  then raise exception 'Already bound mission release state changed';end if;
  return jsonb_build_object('projectId',p.id,'stage','bound','releaseSha',p_release,
    'missionId',m.id,'assignmentId',j.id,'authorizationId',q.authorization_id,
    'cutoff',q.cutoff,'scopeHash',p.approved_hash,'historicalMissions',79,
    'maxMissions',96,'tokenAllowance',600000,'boundAt',b.bound_at,
    'stateHash',project_org_hierarchy_recovery_state(p.id));
 end if;
 if p.status<>'blocked' or m.status<>'blocked'
  or p.detail is distinct from 'No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.'
  or p.lease is not null or p.lease_until is not null
 then raise exception 'Only original unclaimed, watchdog-blocked mission may be re-admitted';end if;
 return jsonb_build_object('projectId',p.id,'stage','bind','releaseSha',p_release,
   'missionId',m.id,'assignmentId',j.id,'authorizationId',q.authorization_id,
   'sourceMissionId',q.source_mission_id,'windowId',q.authorization_id,
   'scopeHash',p.approved_hash,'cutoff',q.cutoff,'historicalMissions',used,
   'maxMissions',96,'tokenAllowance',600000,
   'stateHash',project_org_hierarchy_recovery_state(p.id));
end
$fn$;

create or replace function public.project_org_bind_retest_claim_release(
 p_owner uuid,p_project uuid,p_release text,p_mission uuid,p_assignment uuid,p_state_hash text,
 p_epoch bigint,p_deployment text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
declare p work_projects;offer jsonb;q project_retest_future_window_receipts;
 r project_blocked_management_retest_receipts;stamp timestamptz;
 g project_retest_production_release_gate;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 select * into p from work_projects where id=p_project for update;
 perform 1 from project_provider_execution where project_id=p_project for update;
 perform 1 from agent_missions where id=p_mission and project_id=p_project for update;
 perform 1 from mission_assignments where id=p_assignment and mission_id=p_mission for update;
 select * into g from project_retest_production_release_gate where project_id=p_project for update;
 if g.project_id is null or g.state is distinct from 'active'
  or g.release_sha is distinct from p_release
  or g.deployment_id is distinct from p_deployment
  or g.generation is distinct from p_epoch
  or g.alias_name is distinct from 'katie-mu.vercel.app'
 then raise exception 'Observed canonical release epoch or deployment changed under binding lock';end if;
 perform 1 from project_organization_nodes where project_id=p.id order by depth,id for update;
 perform 1 from project_organization_scope_grants scope_grant
  join project_organization_nodes grant_node on grant_node.id=scope_grant.node_id
  where grant_node.project_id=p.id order by scope_grant.node_id for update of scope_grant;
 if not project_org_retest_exact_scope_grants(p.id)
 then raise exception 'Original three-grant authority changed under binding lock';end if;
 offer:=project_org_retest_claim_release_offer(p_owner,p_project,p_release);
 if offer->>'stage' is distinct from 'bind'
  or p_mission is distinct from (offer->>'missionId')::uuid
  or p_assignment is distinct from (offer->>'assignmentId')::uuid
  or p_mission is distinct from 'b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  or p_assignment is distinct from '85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
  or p_state_hash is null or p_state_hash is distinct from offer->>'stateHash'
  or (offer->>'cutoff')::timestamptz<=clock_timestamp()+interval '5 minutes'
 then raise exception 'Owner-authorized new window, exact deployment and current mission required';end if;
 select * into q from project_retest_future_window_receipts where project_id=p.id;
 select * into r from project_blocked_management_retest_receipts where project_id=p.id;
 stamp:=clock_timestamp();
 update work_projects set status='running',progress_since=stamp,updated_at=stamp,
  detail='Original mission79 admitted under independently owner-approved new window and exact release'
 where id=p.id and status='blocked';
 update agent_missions set status='running',updated_at=stamp
 where id=p_mission and project_id=p.id and status='blocked';
 insert into project_retest_claim_release_receipts(
  project_id,owner_id,window_id,source_mission_id,mission_id,assignment_id,
  prior_release_sha,retest_release_sha,bound_release_sha,scope_hash,
  cutoff,historical_missions,bound_at)
 values(p.id,p_owner,q.authorization_id,r.source_mission_id,p_mission,p_assignment,
  r.prior_release_sha,r.release_sha,p_release,p.approved_hash,q.cutoff,79,stamp);
 if not project_org_retest_claim_release_authorized(p.id,p_release)
 then raise exception 'Recorded source-bound release failed original protection gates';end if;
 insert into project_events(project_id,event,data) values(p.id,'mission79_new_window_release_bound',
  jsonb_build_object('ownerId',p_owner,'newOwnerWindowId',q.authorization_id,
   'sourceMissionId',r.source_mission_id,'missionId',p_mission,
   'assignmentId',p_assignment,'releaseSha',p_release,'newCutoff',q.cutoff,
   'originalCutoff',r.cutoff,'scopeHash',p.approved_hash,
   'historicalMissions',79,'maxMissions',96,'tokenAllowance',600000,
   'boundAt',stamp));
 return jsonb_build_object('projectId',p.id,'stage','bound','releaseSha',p_release,
   'missionId',p_mission,'assignmentId',p_assignment,
   'authorizationId',q.authorization_id,'cutoff',q.cutoff,
   'scopeHash',p.approved_hash,'historicalMissions',79,'maxMissions',96,
   'tokenAllowance',600000,'boundAt',stamp,'existing',false);
end
$fn$;

-- The production worker must present the EXACT SQL-gate generation that
-- it observed before verifying the canonical Vercel alias. A release gate
-- closed/reopened between HTTP verification and claim has a new generation
-- and therefore cannot claim the saved management job using stale proof.
-- Ordinary projects never require this special epoch.
create function public.project_org_retest_release_epoch(
 p_project uuid,p_release text
) returns jsonb language sql stable security definer set search_path=public,pg_temp as $fn$
 select coalesce((select jsonb_build_object('generation',g.generation,
  'deploymentId',g.deployment_id,
  'active',g.state='active' and g.release_sha=p_release and
   g.alias_name='katie-mu.vercel.app')
  from project_retest_production_release_gate g
  where g.project_id=p_project),
  jsonb_build_object('generation',0,'active',false,'deploymentId',null));
$fn$;

create function public.project_org_retest_claim_release_authorized_epoch(
 p_project uuid,p_release text,p_generation bigint,p_deployment text
) returns boolean language sql stable security definer set search_path=public,pg_temp as $fn$
 select coalesce(p_generation>0,false)
  and public.project_org_retest_claim_release_authorized(p_project,p_release)
  and exists(select 1 from public.project_retest_production_release_gate g
   where g.project_id=p_project and g.release_sha=p_release
    and g.state='active' and g.alias_name='katie-mu.vercel.app'
    and g.generation=p_generation and g.deployment_id=p_deployment);
$fn$;

-- Clone the installed, source-qualified production claim implementation,
-- including its global three-worker cap and all existing leasing predicates,
-- but require p_epoch for the original renewed mission79 branch. Preserve the
-- legacy function for unrelated work; it can no longer claim mission79 after
-- its owner-approved future window exists (even on a stale deployment).
do $epoch_claim_patch$
declare
 legacy text;epoch_body text;
 header text:='FUNCTION public.claim_mission_work_release(p_release text)';
 claim_lock text:=$claimlock$perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));$claimlock$;
 housekeeping_mission text:=$hm$where status in ('running','awaiting_approval') and benchmark_effective_mission_deadline(id)<=now();$hm$;
 housekeeping_lease text:=$hl$where j0.status='running' and lease_until<=now();$hl$;
 housekeeping_failed text:=$hf$where m0.status='running' and exists(select 1 from mission_assignments a where a.mission_id=m0.id and a.status='failed');$hf$;
 proof text:='project_org_retest_claim_release_authorized(b.project_id,p_release)';
begin
 legacy:=pg_get_functiondef('public.claim_mission_work_release(text)'::regprocedure);
 if (length(legacy)-length(replace(legacy,header,'')))/length(header)<>1
  or (length(legacy)-length(replace(legacy,proof,'')))/length(proof)<>2
 then raise exception 'Unexpected original release-claim source contract for generation-bound worker';end if;
 -- The original M79 assignment has its own immutable, one-time owner window.
 -- Legacy/zero-epoch housekeeping may manage EVERY ordinary mission, but may
 -- not rewrite or silently requeue this already owner-bound historical job.
 if (length(legacy)-length(replace(legacy,housekeeping_mission,'')))/length(housekeeping_mission)<>1
  or (length(legacy)-length(replace(legacy,housekeeping_lease,'')))/length(housekeeping_lease)<>1
  or (length(legacy)-length(replace(legacy,housekeeping_failed,'')))/length(housekeeping_failed)<>1
 then raise exception 'Unexpected exact original mission79 maintenance boundary';end if;
 legacy:=replace(legacy,housekeeping_mission,
  $hm2$where status in ('running','awaiting_approval') and benchmark_effective_mission_deadline(id)<=now()
   and id is distinct from 'b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid;$hm2$);
 legacy:=replace(legacy,housekeeping_lease,
  $hl2$where j0.status='running' and lease_until<=now()
   and j0.id is distinct from '85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid;$hl2$);
 legacy:=replace(legacy,housekeeping_failed,
  $hf2$where m0.status='running' and exists(select 1 from mission_assignments a where a.mission_id=m0.id and a.status='failed')
   and m0.id is distinct from 'b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid;$hf2$);
 epoch_body:=replace(legacy,header,
  'FUNCTION public.claim_mission_work_release_epoch(p_release text, p_epoch bigint, p_deployment text)');
 epoch_body:=replace(epoch_body,proof,
  'project_org_retest_claim_release_authorized_epoch(b.project_id,p_release,p_epoch,p_deployment)');
 if (length(epoch_body)-length(replace(epoch_body,claim_lock,'')))/length(claim_lock)<>1
 then raise exception 'Original mission79 claim lock location changed';end if;
 epoch_body:=replace(epoch_body,claim_lock,claim_lock||$m79_finalize$
 -- Original management mission 79 is one authorized attempt, not an
 -- automatic retry. Only an EXACT active gate generation/deployment may
 -- terminalize an expired lease or previously queued unsuccessful attempt.
 -- Unresolved provider activity prevents settlement and release promotion.
 update mission_assignments j79
 set status='failed',lease=null,lease_until=null,updated_at=clock_timestamp(),
  detail=coalesce(nullif(j79.detail,''),'Original mission79 attempt terminally settled after expired lease or rejected automatic retry.')
 from agent_missions m79
 join project_retest_claim_release_receipts receipt on receipt.project_id=m79.project_id
 join project_retest_production_release_gate fence on fence.project_id=m79.project_id
 where j79.id='85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
  and m79.id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
  and j79.mission_id=m79.id and receipt.mission_id=m79.id
  and receipt.assignment_id=j79.id and receipt.bound_release_sha=p_release
  and fence.release_sha=p_release and fence.generation=p_epoch
  and fence.deployment_id=p_deployment and fence.state='active'
  and fence.alias_name='katie-mu.vercel.app'
  and j79.attempts>0
  and ((j79.status='running' and j79.lease_until<=clock_timestamp())
       or (j79.status='queued' and j79.lease is null and j79.lease_until is null))
  and not exists(select 1 from project_provider_requests pending
    where pending.assignment_id=j79.id and pending.resolved_at is null)
 returning j79.* into j;
 if found then
  update agent_missions set status='blocked',
   detail='Original mission79 attempt settled terminally; no automatic second inference attempt.',
   updated_at=clock_timestamp()
  where id='b7c2e557-83e1-41cb-b174-bdb0d77d12e5'::uuid
   and status in ('running','awaiting_approval');
  insert into project_events(project_id,event,data)
   values('fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid,
    'mission79_attempt_terminally_settled',
    jsonb_build_object('missionId','b7c2e557-83e1-41cb-b174-bdb0d77d12e5',
     'assignmentId',j.id,'attempts',j.attempts,'releaseSha',p_release,
     'deploymentId',p_deployment,'generation',p_epoch,
     'settledAt',clock_timestamp()));
 end if;
$m79_finalize$);

 -- The first release predicate is evaluated before waiting on the managed
 -- agent row lock. Recheck on the UPDATE statement itself, after locks, using
 -- clock_timestamp() inside the exact owner-source epoch predicate.
 if (length(epoch_body)-length(replace(epoch_body,'where id=j.id returning * into j;','')))/length('where id=j.id returning * into j;')<>1
 then raise exception 'Unexpected original worker lease write boundary';end if;
 epoch_body:=replace(epoch_body,'where id=j.id returning * into j;',
  $lease$where id=j.id and
    (j.id is distinct from '85e229aa-e571-43ef-9d4a-5cb64f4efcd1'::uuid
     or project_org_retest_claim_release_authorized_epoch(m.project_id,p_release,p_epoch,p_deployment))
    returning * into j;
   if not found then return null; end if;$lease$);
 execute epoch_body;
 -- Fail closed for the original mission79 on older worker deployments that
 -- still invoke the single-argument claim RPC; all other projects are intact.
 execute replace(legacy,proof,'false');
end $epoch_claim_patch$;

revoke all on function
 public.project_org_retest_release_epoch(uuid,text),
 public.project_org_retest_claim_release_authorized_epoch(uuid,text,bigint,text),
 public.claim_mission_work_release_epoch(text,bigint,text)
 from public,anon,authenticated,service_role;
grant execute on function
 public.project_org_retest_release_epoch(uuid,text),
 public.project_org_retest_claim_release_authorized_epoch(uuid,text,bigint,text),
 public.claim_mission_work_release_epoch(text,bigint,text) to service_role;

revoke all on function
 public.project_org_retest_exact_scope_grants(uuid),
 public.project_org_retest_original_owner_lineage(uuid),
 public.project_org_retest_future_window_offer(uuid,uuid,text),
 public.project_org_authorize_retest_future_window(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,bigint,text),
 public.project_org_retest_renewed_assignment(uuid,uuid)
 from public,anon,authenticated,service_role;
grant execute on function
 public.project_org_retest_exact_scope_grants(uuid),
 public.project_org_retest_original_owner_lineage(uuid),
 public.project_org_retest_future_window_offer(uuid,uuid,text),
 public.project_org_authorize_retest_future_window(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,bigint,text),
 public.project_org_retest_renewed_assignment(uuid,uuid)
 to service_role;

revoke all on function
 public.project_org_retest_claim_release_authorized(uuid,text),
 public.project_org_retest_claim_release_offer(uuid,uuid,text),
 public.project_org_bind_retest_claim_release(uuid,uuid,text,uuid,uuid,text,bigint,text)
 from public,anon,authenticated,service_role;
grant execute on function
 public.project_org_retest_claim_release_authorized(uuid,text),
 public.project_org_retest_claim_release_offer(uuid,uuid,text),
 public.project_org_bind_retest_claim_release(uuid,uuid,text,uuid,uuid,text,bigint,text)
 to service_role;
commit;
