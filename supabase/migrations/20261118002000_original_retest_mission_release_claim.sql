begin;

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
  or p.deadline is distinct from '2026-11-18T14:00:00Z'::timestamptz
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
 p_owner uuid,p_project uuid,p_release text,p_mission uuid,p_assignment uuid,p_state_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
declare p work_projects;offer jsonb;stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 select * into p from work_projects where id=p_project for update;
 perform 1 from project_provider_execution where project_id=p_project for update;
 select 1 from agent_missions where id=p_mission and project_id=p_project for update;
 select 1 from mission_assignments where id=p_assignment and mission_id=p_mission for update;
 offer:=project_org_retest_claim_release_offer(p_owner,p_project,p_release);
 if offer->>'stage' is distinct from 'bind'
  or p_mission is distinct from (offer->>'missionId')::uuid
  or p_assignment is distinct from (offer->>'assignmentId')::uuid
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

revoke all on function
 public.project_org_retest_claim_release_authorized(uuid,text),
 public.project_org_retest_claim_release_offer(uuid,uuid,text),
 public.project_org_bind_retest_claim_release(uuid,uuid,text,uuid,uuid,text)
 from public,anon,authenticated,service_role;
grant execute on function
 public.project_org_retest_claim_release_authorized(uuid,text),
 public.project_org_retest_claim_release_offer(uuid,uuid,text),
 public.project_org_bind_retest_claim_release(uuid,uuid,text,uuid,uuid,text)
 to service_role;
commit;
