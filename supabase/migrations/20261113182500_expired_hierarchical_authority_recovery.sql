begin;

-- The original organization can outlive both the provider window and the
-- Project Director appointment. A new owner receipt (not a replay of an old
-- management decision) may renew the exact existing hierarchy. No scope,
-- capability, provider budget, job attempt, or provider receipt is reset.
create table public.project_hierarchy_recovery_receipts (
 authorization_id uuid primary key references public.project_execution_windows(id),
 project_id uuid not null references public.work_projects(id),
 owner_id uuid not null,
 decision_id uuid not null references public.project_organization_decisions(id),
 release_sha text not null check (release_sha ~ '^[a-f0-9]{40}$'),
 prior_cutoff timestamptz not null,
 prior_director_cutoff timestamptz not null,
 cutoff timestamptz not null,
 state_hash text not null check (state_hash ~ '^[a-f0-9]{64}$'),
 prior_active_mission_id uuid,
 affected_node_count integer not null check (affected_node_count>0),
 transaction_id bigint not null default txid_current(),
 authorized_at timestamptz not null default clock_timestamp(),
 check (isfinite(prior_cutoff) and isfinite(prior_director_cutoff) and isfinite(cutoff)
        and cutoff>greatest(prior_cutoff,prior_director_cutoff)),
 unique (project_id,prior_cutoff)
);
alter table public.project_hierarchy_recovery_receipts enable row level security;
revoke all on public.project_hierarchy_recovery_receipts from public,anon,authenticated,service_role;
grant select on public.project_hierarchy_recovery_receipts to service_role;
create trigger project_hierarchy_recovery_immutable before update or delete
 on public.project_hierarchy_recovery_receipts for each row
 execute function public.project_org_change_immutable();

-- This hash describes the ORIGINAL project, provider execution, organizational
-- contracts/decisions and terminal active mission. It is recomputed under the
-- transaction-wide management lock when the owner approves an exact deadline.
create function public.project_org_hierarchy_recovery_state(p_project uuid) returns text
language sql stable security definer set search_path=public,pg_temp as $$
 select encode(sha256(convert_to(project_canonical(jsonb_build_object(
   'project',jsonb_build_object('id',p.id,'status',p.status,'phase',p.phase,
      'organizationVersion',p.organization_version,'deadline',p.deadline,
      'activeMissionId',p.active_mission_id,'approvedHash',p.approved_hash,
      'approvalHash',p.approval_hash,'spec',p.spec,'repositoryId',p.repository_id,
      'objective',p.objective,'clarifications',p.clarifications),
   'provider',jsonb_build_object('ownerId',a.owner_id,'objectiveHash',a.objective_hash,
      'deadline',a.deadline,'windowId',a.window_id,'continuationDecisionId',a.continuation_decision_id,
      'continuationReleaseSha',a.continuation_release_sha,'approvedScope',a.approved_scope),
   'organizationHash',project_org_scope_ratification_state(p.id),
   'executionHash',project_org_scope_ratification_execution_state(p.id)
 )),'UTF8')),'hex')
 from work_projects p join project_provider_execution a on a.project_id=p.id where p.id=p_project;
$$;

-- An inert preflight is only visible through the authenticated owner API.
-- This does NOT start execution, renew anything, or propose a new game scope.
create function public.project_org_hierarchy_recovery_offer(p_owner uuid,p_project uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object(
  'projectId',p.id,'priorCutoff',p.deadline,'directorCutoff',n.deadline,
  'decisionId',d.id,'stateHash',project_org_hierarchy_recovery_state(p.id),
  'nodeCount',(select count(*) from project_organization_nodes x where x.project_id=p.id),
  'maxHours',24,
  'activeMissionId',p.active_mission_id)
 from work_projects p
 join project_provider_execution a on a.project_id=p.id
 join project_organization_nodes n on n.project_id=p.id and n.kind='project_director'
   and n.parent_id is null and n.status='active'
 join project_organization_decisions d on d.id=a.continuation_decision_id
   and d.project_id=p.id and d.node_id=n.id
 join mission_assignments j on j.id=d.assignment_id and j.status='completed'
 join agent_missions m on m.id=j.mission_id and m.project_id=p.id and m.status='completed'
 where p.id=p_project and a.owner_id=p_owner
  and standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  and p.organization_version=1 and p.status='blocked'
  and p.phase in ('research','specification','approval')
  and p.spec is null and p.approval_hash is null and p.approved_hash is null
  and a.approved_scope is null and a.continued_at is not null
  and a.deadline=p.deadline and a.objective_hash=encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
  and p.deadline<=clock_timestamp() and n.deadline<=clock_timestamp()
  and not project_provider_request_pending(p.id)
  and not exists(select 1 from project_hierarchy_recovery_receipts r where r.project_id=p.id and r.prior_cutoff=p.deadline);
$$;

-- Preserve the ordinary exact-delegation and owner-window paths. Additionally
-- permit a same-transaction, receipt-bound contract extension of each old node
-- deadline, even when old subordinate deadlines differ from the provider cutoff.
-- No ability to modify tools or scope is introduced by this new path.
create or replace function public.project_org_change_allowed(
 p_node uuid,p_project uuid,p_parent uuid,p_old_deadline timestamptz,p_deadline timestamptz,
 p_old_tools text[],p_tools text[]
) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(
  select 1 from project_organization_contract_changes c
  left join project_execution_windows w on w.id=c.window_id and w.project_id=c.project_id
  left join project_organization_decisions d on d.id=c.decision_id and d.project_id=c.project_id and d.node_id=p_parent
  left join project_hierarchy_recovery_receipts r on r.authorization_id=c.window_id and r.project_id=c.project_id
  where c.node_id=p_node and c.project_id=p_project and c.transaction_id=txid_current()
    and c.prior_deadline=p_old_deadline and c.deadline=p_deadline
    and c.prior_tools=p_old_tools and c.tools=p_tools
    and (
      (w.id is not null and w.cutoff=p_deadline and w.prior_cutoff=p_old_deadline and p_tools=p_old_tools)
      or (w.id is not null and r.authorization_id=w.id and r.cutoff=p_deadline
          and r.transaction_id=txid_current() and r.owner_id=w.owner_id and r.release_sha=w.release_sha
          and r.decision_id=w.decision_id and r.prior_cutoff=w.prior_cutoff
          and p_tools=p_old_tools)
      or d.id is not null
    )
 );
$$;

create function public.project_org_recover_hierarchy(
 p_owner uuid,p_project uuid,p_release text,p_decision uuid,
 p_prior_cutoff timestamptz,p_director_cutoff timestamptz,p_cutoff timestamptz,
 p_authorization uuid,p_state_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 p work_projects; a project_provider_execution; root project_organization_nodes;
 n project_organization_nodes; d project_organization_decisions;
 was_hash text; stamp timestamptz; affected uuid[]:='{}'::uuid[];
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 if p.id is null or a.owner_id is null or a.owner_id is distinct from p_owner
    or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 then raise exception 'Authenticated original project owner required';end if;
 select * into root from project_organization_nodes
  where project_id=p.id and kind='project_director' and parent_id is null and status='active' for update;
 select * into d from project_organization_decisions where id=p_decision and project_id=p.id
  and node_id=root.id;
 stamp:=clock_timestamp();
 if root.id is null or d.id is null or a.continuation_decision_id is distinct from p_decision
    or not exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
      where j.id=d.assignment_id and j.status='completed' and m.status='completed' and m.project_id=p.id)
    or p_release is null or p_release !~ '^[a-f0-9]{40}$'
    or p_authorization is null or p_state_hash is null or p_state_hash !~ '^[a-f0-9]{64}$'
    or p_prior_cutoff is distinct from p.deadline or p_prior_cutoff is distinct from a.deadline
    or p_director_cutoff is distinct from root.deadline
    or p_cutoff is null or not isfinite(p_cutoff) or p_cutoff<=stamp
    or p_prior_cutoff>=stamp or p_director_cutoff>=stamp
    or p_cutoff<=greatest(p_prior_cutoff,p_director_cutoff)
    or p_cutoff>stamp+interval '24 hours'
 then raise exception 'Exact expired hierarchy, completed Director decision and bounded owner cutoff required';end if;
 if p.organization_version<>1 or p.status<>'blocked'
    or p.phase not in ('research','specification','approval')
    or p.spec is not null or p.approved_hash is not null or p.approval_hash is not null
    or a.approved_scope is not null or a.continued_at is null
    or a.objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
    or exists(select 1 from project_execution_windows w where w.id=p_authorization or (w.project_id=p.id and w.prior_cutoff=p_prior_cutoff))
    or exists(select 1 from project_hierarchy_recovery_receipts r where r.project_id=p.id and r.prior_cutoff=p_prior_cutoff)
    or exists(select 1 from project_organization_nodes x where x.project_id=p.id and (x.status<>'active' or x.deadline>p_cutoff))
    or exists(select 1 from agent_missions m where m.project_id=p.id and m.status in ('draft','running','awaiting_approval'))
    or exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
       where m.project_id=p.id and j.status in ('queued','running','waiting_external'))
    or exists(select 1 from project_organization_work w join project_organization_nodes x on x.id=w.node_id
       where x.project_id=p.id and w.status in ('queued','running'))
    or exists(select 1 from project_work_packages pkg where pkg.project_id=p.id and pkg.status<>'accepted')
    or project_provider_request_pending(p.id)
 then raise exception 'Inactive or changed organizational execution state cannot be renewed';end if;
 -- Lock the entire existing roster and verify that every child belongs to an
 -- active ancestral chain. The owner is renewing appointments, NOT delegating
 -- new capabilities.
 perform 1 from project_organization_nodes x where x.project_id=p.id order by x.depth,x.id for update;
 if (select count(*) from project_organization_nodes x where x.project_id=p.id and x.parent_id is null)<>1
    or exists(select 1 from project_organization_nodes x
     where x.project_id=p.id and x.id<>root.id and
      (x.parent_id is null or not exists(select 1 from project_organization_nodes parent
       where parent.id=x.parent_id and parent.project_id=p.id and parent.depth<x.depth
         and x.tools<@parent.tools)))
 then raise exception 'Only the original valid organization hierarchy may be renewed';end if;
 was_hash:=project_org_hierarchy_recovery_state(p.id);
 if was_hash is distinct from p_state_hash then
  raise exception 'Recovery state changed; refresh the exact owner offer';end if;

 insert into project_execution_windows(
  id,project_id,owner_id,release_sha,decision_id,prior_cutoff,cutoff,prior_release_sha
 ) values(p_authorization,p.id,p_owner,p_release,p_decision,p_prior_cutoff,p_cutoff,a.continuation_release_sha);

 insert into project_hierarchy_recovery_receipts(
  authorization_id,project_id,owner_id,decision_id,release_sha,prior_cutoff,
  prior_director_cutoff,cutoff,state_hash,prior_active_mission_id,affected_node_count
 ) values(p_authorization,p.id,p_owner,p_decision,p_release,p_prior_cutoff,
   p_director_cutoff,p_cutoff,p_state_hash,p.active_mission_id,
   (select count(*) from project_organization_nodes x where x.project_id=p.id and x.deadline<p_cutoff));

 update project_provider_execution set deadline=p_cutoff,window_id=p_authorization,
  continuation_release_sha=p_release where project_id=p.id;
 update work_projects set deadline=p_cutoff,updated_at=clock_timestamp() where id=p.id;
 for n in select * from project_organization_nodes where project_id=p.id order by depth,id for update loop
   if n.deadline<p_cutoff then
    insert into project_organization_contract_changes(
      project_id,node_id,window_id,prior_deadline,deadline,prior_tools,tools,prior_submission
    ) values(p.id,n.id,p_authorization,n.deadline,p_cutoff,n.tools,n.tools,n.completion_submission);
    update project_organization_nodes set deadline=p_cutoff,
      decision_needed=case when kind='worker' then decision_needed else true end
      where id=n.id;
    affected:=array_append(affected,n.id);
   end if;
 end loop;
 if (select count(*) from project_organization_nodes where project_id=p.id and deadline<>p_cutoff)>0
    or cardinality(affected)<>(select affected_node_count from project_hierarchy_recovery_receipts where authorization_id=p_authorization)
    or not project_provider_continued(p.id)
 then raise exception 'Atomic hierarchy renewal failed authorization invariants';end if;
 -- Stay blocked, retaining the terminal management mission pointer. The
 -- ordinary scope-ratification RPC alone may later reconcile that pointer.
 insert into project_events(project_id,event,data) values(p.id,'project_hierarchy_recovery_authorized',
  jsonb_build_object('authorizationId',p_authorization,'ownerId',p_owner,'releaseSha',p_release,
   'priorCutoff',p_prior_cutoff,'priorDirectorCutoff',p_director_cutoff,'cutoff',p_cutoff,
   'stateHash',p_state_hash,'activeMissionId',p.active_mission_id,'renewedNodeIds',affected));
 return jsonb_build_object('projectId',p.id,'decisionId',p_decision,'releaseSha',p_release,
   'authorizationId',p_authorization,'stateHash',p_state_hash,'priorCutoff',p_prior_cutoff,
   'priorDirectorCutoff',p_director_cutoff,'cutoff',p_cutoff,'activeMissionId',p.active_mission_id,
   'renewedNodeIds',affected,'authorizedAt',stamp,'existing',false);
end $$;

revoke all on function public.project_org_hierarchy_recovery_state(uuid),
 public.project_org_hierarchy_recovery_offer(uuid,uuid),
 public.project_org_recover_hierarchy(uuid,uuid,text,uuid,timestamptz,timestamptz,timestamptz,uuid,text)
 from public,anon,authenticated,service_role;
grant execute on function public.project_org_hierarchy_recovery_offer(uuid,uuid),
 public.project_org_recover_hierarchy(uuid,uuid,text,uuid,timestamptz,timestamptz,timestamptz,uuid,text)
 to service_role;
commit;
