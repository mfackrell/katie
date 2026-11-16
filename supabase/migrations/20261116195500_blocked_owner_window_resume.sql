begin;

-- #1061 follow-on: one explicit owner-controlled window for the ORIGINAL,
-- already-renewed/resumed, blocked and expired TTT development project.
-- No installation-time project mutations, no inference or automatic resume.
create table public.project_blocked_owner_windows (
 authorization_id uuid primary key references public.project_execution_windows(id),
 project_id uuid not null unique references public.work_projects(id)
  check(project_id='fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid),
 owner_id uuid not null,
 prior_window_id uuid not null references public.project_execution_windows(id)
  check(prior_window_id='a08d3cac-6e3f-4c14-a75a-5f524987a676'::uuid),
 decision_id uuid not null references public.project_organization_decisions(id),
 prior_release_sha text not null check(prior_release_sha ~ '^[a-f0-9]{40}$'),
 resume_release_sha text not null check(resume_release_sha ~ '^[a-f0-9]{40}$' and resume_release_sha<>prior_release_sha),
 scope_hash text not null check(scope_hash='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'),
 prior_cutoff timestamptz not null check(prior_cutoff='2026-11-16T18:00:00Z'::timestamptz),
 cutoff timestamptz not null check(isfinite(cutoff) and cutoff>prior_cutoff),
 state_hash text not null check(state_hash ~ '^[a-f0-9]{64}$'),
 historical_missions integer not null check(historical_missions=76),
 node_count integer not null check(node_count=13),
 authorized_at timestamptz not null default clock_timestamp()
);
alter table public.project_blocked_owner_windows enable row level security;
revoke all on public.project_blocked_owner_windows from public,anon,authenticated,service_role;
grant select on public.project_blocked_owner_windows to service_role;
create trigger blocked_owner_window_immutable before update or delete on public.project_blocked_owner_windows
 for each row execute function public.project_org_change_immutable();

create table public.project_blocked_owner_resumes (
 authorization_id uuid primary key references public.project_blocked_owner_windows(authorization_id),
 project_id uuid not null unique references public.work_projects(id),
 owner_id uuid not null,
 release_sha text not null check(release_sha ~ '^[a-f0-9]{40}$'),
 state_hash text not null check(state_hash ~ '^[a-f0-9]{64}$'),
 resumed_at timestamptz not null default clock_timestamp()
);
alter table public.project_blocked_owner_resumes enable row level security;
revoke all on public.project_blocked_owner_resumes from public,anon,authenticated,service_role;
grant select on public.project_blocked_owner_resumes to service_role;
create trigger blocked_owner_resume_immutable before update or delete on public.project_blocked_owner_resumes
 for each row execute function public.project_org_change_immutable();

-- After the separate resume, recognize only the exact new owner window,
-- matching release and durable receipt. Existing claim/replay guards are reused.
create function public.project_org_blocked_owner_release(p_window uuid,p_release text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_blocked_owner_windows r
 join project_blocked_owner_resumes s on s.authorization_id=r.authorization_id
  and s.project_id=r.project_id and s.owner_id=r.owner_id and s.release_sha=r.resume_release_sha
 join project_execution_windows w on w.id=r.authorization_id and w.project_id=r.project_id
  and w.owner_id=r.owner_id and w.decision_id=r.decision_id
  and w.prior_cutoff=r.prior_cutoff and w.cutoff=r.cutoff
  and w.release_sha=r.prior_release_sha
 join project_provider_execution a on a.project_id=r.project_id and a.owner_id=r.owner_id
  and a.window_id=r.authorization_id and a.continuation_decision_id=r.decision_id
  and a.continuation_release_sha=s.release_sha and a.deadline=r.cutoff and a.approved_scope=r.scope_hash
 join work_projects p on p.id=r.project_id and p.deadline=r.cutoff
  and p.approved_hash=r.scope_hash and p.approval_hash=r.scope_hash
 where r.authorization_id=p_window and s.release_sha=p_release
 and (select count(*) from project_organization_contract_changes c
  where c.project_id=r.project_id and c.window_id=r.authorization_id and c.deadline=r.cutoff
   and c.prior_deadline=r.prior_cutoff and c.tools=c.prior_tools)=13
 and (select count(*) from project_organization_nodes n
  where n.project_id=r.project_id and n.deadline=r.cutoff and n.status='active')=13);
$$;
-- Exact existing authority predicates gain one additive receipt case; no new
-- project source, old mission or stale window becomes claimable.
do $patch$
declare body text;sig text;anchor text;replacement text;
begin
 for sig,anchor,replacement in values
 ('public.project_provider_continued(uuid)',
  'project_org_management_resume_release(w.id,a.continuation_release_sha)',
  'project_org_blocked_owner_release(w.id,a.continuation_release_sha)'),
 ('public.project_org_window_authorized(uuid,uuid,text,uuid,timestamp with time zone)',
  'project_org_management_resume_release(w.id,p_release)',
  'project_org_blocked_owner_release(w.id,p_release)')
 loop
  body:=pg_get_functiondef(sig::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
  then raise exception 'Unexpected prior #1057 authority function; refuse changed source';end if;
  execute replace(body,anchor,'('||anchor||' or '||replacement||')');
 end loop;
end $patch$;

-- Read-only preflight for the exact original project. Unlike the original
-- one-use offer, this recognizes the already-consumed historical receipts.
create function public.project_org_blocked_owner_offer(p_owner uuid,p_project uuid,p_release text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p work_projects;a project_provider_execution;
 old_window project_execution_windows;old_renew project_paused_window_renewals;
 old_resume project_management_resume_receipts;r project_blocked_owner_windows;
 s project_blocked_owner_resumes;used integer;count_nodes integer;stage text;
begin
 select * into p from work_projects where id=p_project;
 select * into a from project_provider_execution where project_id=p_project;
 if p_project is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 or p.id is null or p_owner is null or a.owner_id is distinct from p_owner
 or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 or p_release is null or p_release !~ '^[a-f0-9]{40}$'
 then raise exception 'Original authenticated owner and current release required';end if;
 select * into old_renew from project_paused_window_renewals where project_id=p.id;
 select * into old_resume from project_management_resume_receipts where project_id=p.id;
 select * into r from project_blocked_owner_windows where project_id=p.id;
 select * into s from project_blocked_owner_resumes where project_id=p.id;
 select count(*) into used from agent_missions where project_id=p.id;
 select count(*) into count_nodes from project_organization_nodes where project_id=p.id;
 if p.organization_version<>1 or p.phase<>'development' or p.approved_hash is distinct from
 '4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6'
 or p.approval_hash is distinct from p.approved_hash or a.approved_scope is distinct from p.approved_hash
 or a.objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
 or p.max_missions<>96 or p.token_allowance<>600000 or used<>76 or count_nodes<>13
 or p.active_mission_id is not null or p.lease is not null or p.lease_until is not null
 or a.continuation_decision_id is null or a.continued_at is null
 or old_renew.project_id is null or old_resume.project_id is null
 or old_resume.window_id is distinct from old_renew.authorization_id
 or old_resume.owner_id is distinct from p_owner or old_renew.owner_id is distinct from p_owner
 or old_resume.source_mission_id is distinct from old_renew.source_mission_id
 or old_resume.release_sha is distinct from old_renew.release_sha
 or old_renew.authorization_id is distinct from 'a08d3cac-6e3f-4c14-a75a-5f524987a676'::uuid
 or exists(select 1 from project_work_packages where project_id=p.id)
 or exists(select 1 from agent_missions where project_id=p.id and status in ('draft','running','awaiting_approval'))
 or exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
  where m.project_id=p.id and j.status in ('queued','running','waiting_external'))
 or exists(select 1 from project_organization_work w join project_organization_nodes n on n.id=w.node_id
  where n.project_id=p.id and w.status in ('queued','running'))
 or exists(select 1 from agent_tasks t join mission_assignments j on j.id=t.id join agent_missions m on m.id=j.mission_id
  where m.project_id=p.id and t.status in ('dispatching','submitted'))
 or project_provider_request_pending(p.id)
 or exists(with recursive qa as (select id from project_organization_nodes where project_id=p.id and area in ('quality_assurance','independent_qa')
  union all select n.id from project_organization_nodes n join qa on n.parent_id=qa.id)
  select 1 from qa join project_organization_nodes n on n.id=qa.id where 'development'=any(n.tools))
 or exists(select 1 from project_organization_nodes n where n.project_id=p.id
  and (n.status<>'active' or (n.parent_id is not null and not exists(
   select 1 from project_organization_nodes parent where parent.id=n.parent_id and parent.project_id=p.id
    and parent.depth=n.depth-1 and n.tools<@parent.tools))))
 then raise exception 'Original blocked development history, scope or safeguards changed';end if;
 if r.project_id is null then
  if p.status<>'blocked' or p.deadline is distinct from '2026-11-16T18:00:00Z'::timestamptz
   or a.deadline is distinct from p.deadline or a.window_id is distinct from old_renew.authorization_id
   or a.continuation_release_sha is distinct from old_resume.release_sha
   or old_renew.cutoff is distinct from p.deadline or old_resume.cutoff is distinct from p.deadline
   or not project_provider_continued(p.id) or p.deadline>=clock_timestamp()
   or (select count(*) from project_organization_nodes n where n.project_id=p.id and n.deadline=p.deadline)<>13
   or p_release=a.continuation_release_sha
  then raise exception 'Current blocked and expired owner window required';end if;
  stage:='authorize';
 else
  select * into old_window from project_execution_windows where id=r.authorization_id;
  if r.owner_id is distinct from p_owner or r.resume_release_sha is distinct from p_release
   or r.prior_window_id is distinct from old_renew.authorization_id
   or r.decision_id is distinct from a.continuation_decision_id
   or r.historical_missions<>used or r.scope_hash is distinct from p.approved_hash
   or r.prior_release_sha is distinct from old_resume.release_sha
   or r.prior_cutoff is distinct from old_resume.cutoff
   or old_window.id is null or old_window.project_id is distinct from p.id
   or old_window.owner_id is distinct from p_owner or old_window.release_sha is distinct from r.prior_release_sha
   or old_window.decision_id is distinct from r.decision_id
   or old_window.cutoff is distinct from r.cutoff or old_window.prior_cutoff is distinct from r.prior_cutoff
   or a.window_id is distinct from r.authorization_id or a.deadline is distinct from r.cutoff
   or p.deadline is distinct from r.cutoff
   or (select count(*) from project_organization_contract_changes c
    where c.project_id=p.id and c.window_id=r.authorization_id and c.prior_deadline=r.prior_cutoff
     and c.deadline=r.cutoff and c.tools=c.prior_tools)<>13
   or (select count(*) from project_organization_nodes n where n.project_id=p.id and n.deadline=r.cutoff)<>13
  then raise exception 'Current owner renewal receipt or contracts changed';end if;
  if s.project_id is null then
   if p.status<>'blocked' or a.continuation_release_sha is distinct from r.prior_release_sha
    or not project_provider_continued(p.id) then
    raise exception 'Unresumed owner window authority changed';end if;
   stage:=case when r.cutoff<=clock_timestamp()+interval '5 minutes' then 'expired' else 'resume' end;
  else
   if s.owner_id is distinct from p_owner or s.authorization_id is distinct from r.authorization_id
    or s.release_sha is distinct from r.resume_release_sha or p.status<>'running'
    or a.continuation_release_sha is distinct from r.resume_release_sha
    or not project_org_blocked_owner_release(r.authorization_id,r.resume_release_sha)
    or not project_provider_continued(p.id)
   then raise exception 'Recorded blocked owner resume changed';end if;
   stage:='resumed';
  end if;
 end if;
 return jsonb_build_object('projectId',p.id,'stage',stage,'releaseSha',p_release,
  'scopeHash',p.approved_hash,'sourceMissionId',old_resume.source_mission_id,
  'expectedReleaseSha',case when r.project_id is null then a.continuation_release_sha else r.prior_release_sha end,
  'priorWindowId',old_renew.authorization_id,
  'windowId',case when r.project_id is null then a.window_id else r.authorization_id end,
  'priorCutoff',case when r.project_id is null then p.deadline else r.prior_cutoff end,
  'cutoff',case when r.project_id is null then null else r.cutoff end,
  'authorizationId',r.authorization_id,'stateHash',project_org_hierarchy_recovery_state(p.id),
  'status',p.status,'historicalMissions',used,'maxMissions',96,'tokenAllowance',600000,'nodeCount',13,
  'maxHours',24,'authorizedAt',r.authorized_at);
end $$;

-- One explicit authenticated click records a future deadline in a new window,
-- preserving all historical receipts. This RPC cannot resume/dispatch work.
create function public.project_org_authorize_blocked_owner_window(
 p_owner uuid,p_project uuid,p_release text,p_prior_window uuid,p_prior_cutoff timestamptz,
 p_cutoff timestamptz,p_authorization uuid,p_state_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare offer jsonb;p work_projects;a project_provider_execution;n project_organization_nodes;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 offer:=project_org_blocked_owner_offer(p_owner,p_project,p_release);
 if offer->>'stage' is distinct from 'authorize' or p_authorization is null
 or p_prior_window is distinct from (offer->>'windowId')::uuid
 or p_prior_cutoff is distinct from (offer->>'priorCutoff')::timestamptz
 or p_state_hash is null or p_state_hash is distinct from offer->>'stateHash'
 or p_cutoff is null or not isfinite(p_cutoff)
 or p_cutoff<=clock_timestamp()+interval '5 minutes'
 or p_cutoff>clock_timestamp()+interval '24 hours'
 or exists(select 1 from project_execution_windows where id=p_authorization)
 or exists(select 1 from project_blocked_owner_windows where project_id=p_project)
 then raise exception 'Fresh exact owner authorization and bounded future cutoff required';end if;
 perform 1 from project_organization_nodes where project_id=p.id order by depth,id for update;
 if project_org_hierarchy_recovery_state(p.id) is distinct from p_state_hash
 then raise exception 'Owner recovery state changed during authorization';end if;
 insert into project_execution_windows(id,project_id,owner_id,release_sha,decision_id,prior_cutoff,cutoff,prior_release_sha)
 values(p_authorization,p.id,p_owner,a.continuation_release_sha,a.continuation_decision_id,p.deadline,p_cutoff,a.continuation_release_sha);
 insert into project_blocked_owner_windows(authorization_id,project_id,owner_id,prior_window_id,decision_id,
  prior_release_sha,resume_release_sha,scope_hash,prior_cutoff,cutoff,state_hash,historical_missions,node_count)
 values(p_authorization,p.id,p_owner,a.window_id,a.continuation_decision_id,a.continuation_release_sha,
  p_release,p.approved_hash,p.deadline,p_cutoff,p_state_hash,76,13);
 update project_provider_execution set window_id=p_authorization,deadline=p_cutoff where project_id=p.id;
 update work_projects set deadline=p_cutoff,updated_at=clock_timestamp() where id=p.id;
 for n in select * from project_organization_nodes where project_id=p.id order by depth,id for update loop
  insert into project_organization_contract_changes(project_id,node_id,window_id,prior_deadline,deadline,prior_tools,tools,prior_submission)
   values(p.id,n.id,p_authorization,n.deadline,p_cutoff,n.tools,n.tools,n.completion_submission);
  update project_organization_nodes set deadline=p_cutoff where id=n.id;
 end loop;
 if not project_provider_continued(p.id)
 or (select count(*) from project_organization_nodes where project_id=p.id and deadline=p_cutoff)<>13
 then raise exception 'Atomic blocked owner renewal failed original authority invariants';end if;
 insert into project_events(project_id,event,data) values(p.id,'blocked_owner_window_authorized',
  jsonb_build_object('ownerId',p_owner,'authorizationId',p_authorization,'priorWindowId',a.window_id,
   'priorCutoff',p.deadline,'cutoff',p_cutoff,'releaseSha',p_release,'scopeHash',p.approved_hash,
   'historicalMissions',76,'maxMissions',96,'tokenAllowance',600000,'nodeCount',13));
 return jsonb_build_object('projectId',p.id,'stage','resume','authorizationId',p_authorization,
  'releaseSha',p_release,'cutoff',p_cutoff,'status','blocked','historicalMissions',76,'existing',false);
end $$;

-- Second separate authenticated click, under the same transaction lock, records
-- a new release-bound receipt and reopens only normal management scheduling.
create function public.project_org_resume_blocked_owner_confirmed(
 p_owner uuid,p_project uuid,p_release text,p_authorization uuid,p_cutoff timestamptz,p_state_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare offer jsonb;p work_projects;a project_provider_execution;
 management_node uuid; eligible_count integer; changed_count integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 offer:=project_org_blocked_owner_offer(p_owner,p_project,p_release);
 if p_authorization is null or offer->>'authorizationId' is distinct from p_authorization::text
 or p_cutoff is distinct from (offer->>'cutoff')::timestamptz
 or p_state_hash is null or p_state_hash is distinct from offer->>'stateHash'
 then raise exception 'Current exact owner release/window/state receipt required';end if;
 if offer->>'stage'='resumed'
 then return jsonb_build_object('projectId',p.id,'stage','resumed','releaseSha',p_release,
  'authorizationId',p_authorization,'cutoff',p_cutoff,'status','running','existing',true);end if;
 if offer->>'stage' is distinct from 'resume' or p_cutoff<=clock_timestamp()+interval '5 minutes'
 or p.status<>'blocked' or p.active_mission_id is not null
 then raise exception 'Unexpired authorized blocked window required before separate resume';end if;
 perform 1 from project_organization_nodes where project_id=p.id order by depth,id for update;
 if project_org_hierarchy_recovery_state(p.id) is distinct from p_state_hash
 then raise exception 'Owner resume state changed during confirmation';end if;
 insert into project_blocked_owner_resumes(authorization_id,project_id,owner_id,release_sha,state_hash)
 values(p_authorization,p.id,p_owner,p_release,p_state_hash);
 update project_provider_execution set continuation_release_sha=p_release where project_id=p.id;
 if not project_provider_continued(p.id)
 or not project_org_window_authorized(p.id,p_owner,p_release,a.continuation_decision_id,p_cutoff)
 then raise exception 'Source-bound owner continuation did not bind';end if;
 update work_projects set status='running',updated_at=clock_timestamp(),
 detail='Owner resumed original blocked organization under a separately approved window; all history and limits retained.'
 where id=p.id;
 -- QA1068-01: a status flip does not wake the lawful scheduler when all
 -- original organization decision_needed flags are false. Prepare exactly
 -- the existing Game Delivery Functional Director for one normal management
 -- decision. Neither owner click creates a mission, assignment or worker.
 select count(*)::int,min(n.id) into eligible_count,management_node
 from project_organization_nodes n
 join project_organization_nodes root on root.id=n.parent_id
  and root.project_id=n.project_id and root.kind='project_director'
  and root.parent_id is null and root.status='active'
 where n.project_id=p.id and n.kind='manager'
  and n.management_level='functional_director' and n.area='game_delivery'
  and n.status='active' and n.deadline=p_cutoff and not n.decision_needed
  and 'development'=any(n.tools) and project_org_dependencies_ready(n.id)
  and (select count(*) from project_organization_nodes q where q.project_id=p.id and q.decision_needed)=0;
 if eligible_count<>1 or management_node is null
 then raise exception 'Approved Game Delivery Functional Director not eligible for bounded recovery';end if;
 update project_organization_nodes set decision_needed=true where id=management_node
  and project_id=p.id and not decision_needed;
 get diagnostics changed_count=row_count;
 if changed_count<>1 then raise exception 'Bounded management scheduler wake-up changed';end if;
 insert into project_events(project_id,event,data) values(p.id,'blocked_owner_management_resumed',
 jsonb_build_object('ownerId',p_owner,'authorizationId',p_authorization,'releaseSha',p_release,
  'cutoff',p_cutoff,'historicalMissions',76,'maxMissions',96,'tokenAllowance',600000));
 return jsonb_build_object('projectId',p.id,'stage','resumed','releaseSha',p_release,
  'authorizationId',p_authorization,'cutoff',p_cutoff,'status','running','existing',false);
end $$;
revoke all on function public.project_org_blocked_owner_release(uuid,text),
 public.project_org_blocked_owner_offer(uuid,uuid,text),
 public.project_org_authorize_blocked_owner_window(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid,text),
 public.project_org_resume_blocked_owner_confirmed(uuid,uuid,text,uuid,timestamptz,text)
 from public,anon,authenticated,service_role;
grant execute on function public.project_org_blocked_owner_offer(uuid,uuid,text),
 public.project_org_authorize_blocked_owner_window(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid,text),
 public.project_org_resume_blocked_owner_confirmed(uuid,uuid,text,uuid,timestamptz,text)
 to service_role;
commit;
