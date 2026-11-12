begin;

-- Owner execution windows and management contract revisions are authority receipts,
-- not resets of the appointments, decisions, attempts or provider-request history.
create table public.project_execution_windows (
 id uuid primary key, project_id uuid not null references work_projects(id),
 owner_id uuid not null, release_sha text not null check(release_sha ~ '^[0-9a-f]{40}$'),
 decision_id uuid not null references project_organization_decisions(id),
 prior_cutoff timestamptz not null, cutoff timestamptz not null,
 prior_release_sha text, authorized_at timestamptz not null default clock_timestamp(),
 check(isfinite(prior_cutoff) and isfinite(cutoff) and cutoff>prior_cutoff),
 unique(project_id,prior_cutoff)
);
create table public.project_organization_contract_changes (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references work_projects(id),
 node_id uuid not null references project_organization_nodes(id),
 decision_id uuid references project_organization_decisions(id),
 window_id uuid references project_execution_windows(id),
 prior_deadline timestamptz not null, deadline timestamptz not null,
 prior_tools text[] not null, tools text[] not null, prior_submission jsonb,
 transaction_id bigint not null default txid_current(), changed_at timestamptz not null default clock_timestamp(),
 check((decision_id is null)<>(window_id is null))
);
alter table public.project_provider_execution add column window_id uuid references project_execution_windows(id);
alter table public.project_execution_windows enable row level security;
alter table public.project_organization_contract_changes enable row level security;
revoke all on public.project_execution_windows,public.project_organization_contract_changes from public,anon,authenticated,service_role;
grant select on public.project_execution_windows,public.project_organization_contract_changes to service_role;
create function public.project_org_change_immutable() returns trigger language plpgsql as $$
begin raise exception 'Organizational authorization history is append-only';end $$;
create trigger execution_window_immutable before update or delete on project_execution_windows for each row execute function project_org_change_immutable();
create trigger organization_change_immutable before update or delete on project_organization_contract_changes for each row execute function project_org_change_immutable();

-- The guard stays SECURITY INVOKER: existing reporting/leadership current_user
-- restrictions must not become privileged just to read the private audit table.
create function public.project_org_change_allowed(p_node uuid,p_project uuid,p_parent uuid,p_old_deadline timestamptz,p_deadline timestamptz,p_old_tools text[],p_tools text[])
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_organization_contract_changes c
 left join project_execution_windows w on w.id=c.window_id and w.project_id=c.project_id
 left join project_organization_decisions d on d.id=c.decision_id and d.project_id=c.project_id and d.node_id=p_parent
 where c.node_id=p_node and c.project_id=p_project and c.transaction_id=txid_current()
 and c.prior_deadline=p_old_deadline and c.deadline=p_deadline and c.prior_tools=p_old_tools and c.tools=p_tools
 and ((w.id is not null and w.cutoff=p_deadline and w.prior_cutoff=p_old_deadline and p_tools=p_old_tools) or d.id is not null));
$$;
do $patch$
declare body text;old text:='(new.project_id,new.kind,new.token_limit,new.deadline,new.scope_paths,new.tools,new.objective,new.acceptance,new.area,new.management_contract)';
begin
 body:=pg_get_functiondef('public.project_org_identity_guard()'::regprocedure);
 if strpos(body,old)=0 then raise exception 'Unexpected organization identity guard';end if;
 body:=replace(body,old,'(new.project_id,new.kind,new.token_limit,new.scope_paths,new.objective,new.acceptance,new.area,new.management_contract)');
 body:=replace(body,'(old.project_id,old.kind,old.token_limit,old.deadline,old.scope_paths,old.tools,old.objective,old.acceptance,old.area,old.management_contract)',
 '(old.project_id,old.kind,old.token_limit,old.scope_paths,old.objective,old.acceptance,old.area,old.management_contract)');
 body:=replace(body,'return new;', $guard$if (new.deadline,new.tools) is distinct from (old.deadline,old.tools)
 and not project_org_change_allowed(old.id,old.project_id,old.parent_id,old.deadline,new.deadline,old.tools,new.tools)
 then raise exception 'Delegation amendment requires exact authenticated authorization';end if;
 return new;$guard$);
 execute body;
end $patch$;

create function public.project_org_amend_delegation(p_parent uuid,p_decision uuid,c jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare n project_organization_nodes;ch project_organization_nodes;p work_projects;wanted text[];expected text[];until_at timestamptz;tree uuid[];
begin
 select * into n from project_organization_nodes where id=p_parent;
 select * into p from work_projects where id=n.project_id;
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id and project_id=p.id for update;
 if ch.id is null or ch.status<>'active' or n.kind='worker' or (n.kind='project_director' and (ch.kind<>'manager' or ch.management_level<>'functional_director'))
 or not exists(select 1 from project_organization_decisions where id=p_decision and node_id=n.id and project_id=p.id)
 then raise exception 'Amendment requires an active direct subordinate and authenticated management decision';end if;
 if jsonb_typeof(c->'tools') is distinct from 'array' or jsonb_typeof(c->'expectedTools') is distinct from 'array'
 or c->>'expectedDeadline' is null or length(coalesce(c->>'reason','')) not between 1 and 2000
 then raise exception 'Exact prior delegation and amendment reason required';end if;
 wanted:=array(select jsonb_array_elements_text(c->'tools') order by 1);
 expected:=array(select jsonb_array_elements_text(c->'expectedTools') order by 1);
 if cardinality(wanted)<>(select count(distinct x) from unnest(wanted) x)
 or cardinality(expected)<>(select count(distinct x) from unnest(expected) x)
 or exists(select 1 from unnest(wanted||expected) x where x is null or x not in ('manage','analysis','research','development','repository_review'))
 then raise exception 'Distinct known delegated capabilities required';end if;
 if expected is distinct from array(select unnest(ch.tools) order by 1) or (c->>'expectedDeadline')::timestamptz is distinct from ch.deadline
 then raise exception 'Delegation changed; refresh the exact prior contract';end if;
 until_at:=coalesce((c->>'deadline')::timestamptz,ch.deadline);
 if not isfinite(until_at) or until_at<ch.deadline or until_at<=clock_timestamp() or until_at>least(n.deadline,p.deadline)
 or (ch.kind='worker' and until_at<>ch.deadline) or not wanted<@n.tools
 or (ch.kind<>'worker' and not 'manage'=any(wanted)) or (ch.kind='worker' and 'manage'=any(wanted))
 then raise exception 'Amended delegation exceeds parent or approved execution authority';end if;
 if wanted=array(select unnest(ch.tools) order by 1) and until_at=ch.deadline then raise exception 'No delegation change requested';end if;
 if 'development'=any(wanted) and exists(with recursive ancestors as (
 select id,parent_id,area from project_organization_nodes where id=ch.id union all
 select x.id,x.parent_id,x.area from project_organization_nodes x join ancestors a on x.id=a.parent_id)
 select 1 from ancestors where area='quality_assurance') then raise exception 'Independent QA cannot inherit implementation authority';end if;
 select array_agg(id) into tree from (with recursive descendants as (
 select id from project_organization_nodes where id=ch.id union all
 select x.id from project_organization_nodes x join descendants d on x.parent_id=d.id) select id from descendants) x;
 if exists(select 1 from project_organization_nodes where id=any(tree) and id<>ch.id and not tools<@wanted)
 then raise exception 'Amendment would exceed descendant authority';end if;
 if exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id join project_organization_assignments b on b.assignment_id=j.id
 where b.node_id=any(tree) and j.status in ('queued','running','waiting_external'))
 or exists(select 1 from project_organization_work where node_id=any(tree) and status in ('queued','running'))
 or exists(select 1 from project_work_packages where (manager_id=any(tree) or worker_id=any(tree) or writer_id=any(tree) or reviewer_id=any(tree)) and status<>'accepted')
 then raise exception 'Outstanding work must resolve before delegation amendment';end if;
 insert into project_organization_contract_changes(project_id,node_id,decision_id,prior_deadline,deadline,prior_tools,tools,prior_submission)
 values(p.id,ch.id,p_decision,ch.deadline,until_at,ch.tools,wanted,ch.completion_submission);
 update project_organization_nodes set tools=wanted,deadline=until_at,status='active',evidence=null,decision_needed=(kind<>'worker') where id=ch.id;
 insert into project_events(project_id,event,data) values(p.id,'delegation_amended',jsonb_build_object('nodeId',ch.id,'parentId',n.id,'decisionId',p_decision,'priorTools',ch.tools,'tools',wanted,'priorDeadline',ch.deadline,'deadline',until_at,'reason',c->>'reason'));
end $$;
-- All existing role, hierarchy and command diagnostics remain authoritative.
do $patch$ declare body text;anchor text:='elsif c->>''action''=''appoint'' then';begin
 body:=pg_get_functiondef('public.project_org_decide_hierarchy(uuid,uuid,jsonb)'::regprocedure);
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'Unexpected management command boundary';end if;
 execute replace(body,anchor,'elsif c->>''action''=''amend_delegation'' then perform project_org_amend_delegation(n.id,did,c); '||anchor);
end $patch$;

-- A revoked capability cannot survive in a blocked/retryable SMART assignment.
do $patch$ declare body text;anchor text:='if c.project_id is distinct from p.id';begin
 body:=pg_get_functiondef('public.project_smart_admit(uuid,bigint)'::regprocedure);
 if strpos(body,anchor)=0 then raise exception 'Unexpected SMART capability admission boundary';end if;
 execute replace(body,anchor,$guard$if not coalesce((case when j.role='development' then 'development' when j.role in ('plan','compose','review','revise') then 'analysis' when j.payload->>'capability'='writing' then 'analysis' else j.payload->>'capability' end)=any(w.tools),false) then raise exception 'Current delegated worker capability required';end if;
 if c.project_id is distinct from p.id$guard$);
end $patch$;

create function public.project_org_window_authorized(p_project uuid,p_owner uuid,p_release text,p_decision uuid,p_cutoff timestamptz)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_provider_execution a join project_execution_windows w on w.id=a.window_id
 where a.project_id=p_project and w.project_id=a.project_id and w.owner_id=p_owner and w.release_sha=p_release
 and w.decision_id=p_decision and w.cutoff=p_cutoff and a.deadline=w.cutoff);
$$;
create or replace function public.project_provider_continued(p_project uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_provider_execution a
 join project_organization_decisions d on d.id=a.continuation_decision_id and d.project_id=a.project_id
 join project_organization_nodes n on n.id=d.node_id and n.project_id=a.project_id and n.kind='project_director' and n.parent_id is null
 join mission_assignments j on j.id=d.assignment_id and j.status='completed'
 join agent_missions m on m.id=j.mission_id and m.project_id=a.project_id and m.status='completed'
 left join project_director_recoveries r on r.project_id=a.project_id and r.owner_id=a.owner_id
 left join project_execution_windows w on w.id=a.window_id and w.project_id=a.project_id and w.owner_id=a.owner_id
  and w.decision_id=d.id and w.release_sha=a.continuation_release_sha and w.cutoff=a.deadline
 where a.project_id=p_project and a.continued_at is not null and a.continuation_release_sha ~ '^[0-9a-f]{40}$'
 and ((r.project_id is not null and d.assignment_id=r.assignment_id) or w.id is not null)
 and (a.window_id is null or w.id is not null));
$$;
-- Historical recovery cutoffs stay historical. New missions carry the current
-- owner window identity; old missions cannot become eligible after renewal.
do $patch$ declare body text;sig text;anchor text:='or p_cutoff is distinct from r.cutoff';begin
 body:=pg_get_functiondef('public.project_provider_continue(uuid,uuid,text,uuid,timestamptz)'::regprocedure);
 if strpos(body,anchor)=0 then raise exception 'Unexpected continuation cutoff boundary';end if;
 execute replace(body,anchor,'or (p_cutoff is distinct from r.cutoff and not project_org_window_authorized(p_project,p_owner,p_release,p_decision,p_cutoff))');
 body:=pg_get_functiondef('public.project_provider_continued_assignment(uuid)'::regprocedure);
 if strpos(body,'and public.project_provider_continued(a.project_id)')=0 then raise exception 'Unexpected assignment window boundary';end if;
 body:=replace(body,'join project_director_recoveries r','left join project_director_recoveries r');
 body:=replace(body,'j.id<>r.assignment_id','j.id is distinct from r.assignment_id');
 execute replace(body,'and public.project_provider_continued(a.project_id)',
 'and (m.project_evidence->>''providerContinuationWindow'') is not distinct from a.window_id::text and public.project_provider_continued(a.project_id)');
 foreach sig in array array['public.project_org_schedule(uuid,uuid)','public.finish_work_project_lifecycle(uuid,uuid,text,jsonb)'] loop
  body:=pg_get_functiondef(sig::regprocedure);
  if strpos(body,'''providerContinuationRelease'',a.continuation_release_sha)')=0 then raise exception 'Unexpected trusted scheduler window boundary';end if;
  execute replace(body,'''providerContinuationRelease'',a.continuation_release_sha)',
   '''providerContinuationRelease'',a.continuation_release_sha,''providerContinuationWindow'',a.window_id)');
 end loop;
end $patch$;

-- Existing non-recovery branches must not bypass a renewed owner window.
do $patch$
declare body text;sig text;anchor text;replacement text;
begin
 body:=pg_get_functiondef('public.project_org_schedule(uuid,uuid)'::regprocedure);
 body:=replace(body,'if not found then return project_org_schedule_before_director_recovery(p_project,p_lease);end if;',
 'if not found and not project_provider_continued(p_project) then return project_org_schedule_before_director_recovery(p_project,p_lease);end if;');
 body:=replace(body,'m.id<>r.mission_id','m.id is distinct from r.mission_id');execute body;
 body:=pg_get_functiondef('public.claim_mission_work_release(text)'::regprocedure);
 anchor:='and ((project_provider_continued_assignment(a.id)';
 if strpos(body,anchor)=0 then raise exception 'Unexpected window claimant boundary';end if;
 execute replace(body,anchor,$guard$and (not exists(select 1 from project_provider_execution wa where wa.project_id=b.project_id and wa.window_id is not null)
 or (project_provider_continued_assignment(a.id) and p_release=(select continuation_release_sha from project_provider_execution where project_id=b.project_id)))
 and ((project_provider_continued_assignment(a.id)$guard$);
 foreach sig in array array['public.project_provider_request(uuid,text,uuid,text,text,text,text)','public.project_org_decide(uuid,uuid,jsonb)'] loop
  body:=pg_get_functiondef(sig::regprocedure);
  anchor:='perform pg_advisory_xact_lock(hashtextextended(''katie.mission.state'',0));';
  replacement:=anchor||$guard$
 if exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id join project_provider_execution a on a.project_id=m.project_id
 where j.id=p_job and a.window_id is not null) and not project_provider_continued_assignment(p_job) then $guard$||
 case when sig like '%project_provider_request%' then 'return false;' else 'raise exception ''Current owner execution window required'';' end||' end if;';
  if strpos(body,anchor)=0 then raise exception 'Unexpected window dispatch boundary';end if;
  execute replace(body,anchor,replacement);
 end loop;
end $patch$;

create function public.project_org_renew_continue(p_owner uuid,p_project uuid,p_release text,p_decision uuid,p_prior_cutoff timestamptz,p_cutoff timestamptz,p_authorization uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p work_projects;a project_provider_execution;root project_organization_nodes;ch project_organization_nodes;receipt jsonb;affected uuid[]:='{}';
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 if p.id is null or a.owner_id is distinct from p_owner or p_owner is null or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 then raise exception 'Authenticated project owner required';end if;
 if p_authorization is null or exists(select 1 from project_execution_windows where id=p_authorization)
 then raise exception 'Deadline authorization missing or already consumed';end if;
 select * into root from project_organization_nodes where project_id=p.id and kind='project_director' and parent_id is null and status='active' for update;
 if p_release is null or p_release !~ '^[0-9a-f]{40}$' or p_prior_cutoff is distinct from p.deadline or p_prior_cutoff is distinct from a.deadline
 or p_cutoff is null or not isfinite(p_cutoff) or p_cutoff<=greatest(clock_timestamp(),p.deadline)
 or root.id is null or p_cutoff>root.deadline
 then raise exception 'Exact prior cutoff and future cutoff within Project Director authority required';end if;
 if p.organization_version<>1 or p.status<>'blocked'
 or a.objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
 or (a.continuation_decision_id is not null and a.continuation_decision_id is distinct from p_decision)
 or not exists(select 1 from project_organization_decisions d join mission_assignments j on j.id=d.assignment_id join agent_missions m on m.id=j.mission_id
  where d.id=p_decision and d.node_id=root.id and d.project_id=p.id and m.project_id=p.id and j.status='completed' and m.status='completed')
 or exists(select 1 from agent_missions where project_id=p.id and status in ('draft','running','awaiting_approval'))
 or project_provider_request_pending(p.id)
 then raise exception 'Idle blocked organization with accepted Director evidence and resolved provider requests required';end if;
 insert into project_execution_windows(id,project_id,owner_id,release_sha,decision_id,prior_cutoff,cutoff,prior_release_sha)
 values(p_authorization,p.id,p_owner,p_release,p_decision,p_prior_cutoff,p_cutoff,a.continuation_release_sha);
 update project_provider_execution set deadline=p_cutoff,window_id=p_authorization,
  continuation_release_sha=case when continued_at is not null then p_release else null end where project_id=p.id;
 update work_projects set deadline=p_cutoff where id=p.id;
 for ch in select * from project_organization_nodes where project_id=p.id and kind='manager' and status='active' and deadline=p_prior_cutoff order by depth,id for update loop
  if exists(with recursive ancestors as (select id,parent_id,deadline from project_organization_nodes where id=ch.parent_id
   union all select n.id,n.parent_id,n.deadline from project_organization_nodes n join ancestors x on n.id=x.parent_id)
   select 1 from ancestors where deadline<p_cutoff) then raise exception 'Renewed management contract exceeds ancestor deadline';end if;
  insert into project_organization_contract_changes(project_id,node_id,window_id,prior_deadline,deadline,prior_tools,tools,prior_submission)
   values(p.id,ch.id,p_authorization,ch.deadline,p_cutoff,ch.tools,ch.tools,ch.completion_submission);
  update project_organization_nodes set deadline=p_cutoff,status='active',evidence=null,decision_needed=true where id=ch.id;
  affected:=array_append(affected,ch.id);
 end loop;
 if exists(select 1 from project_director_recoveries where project_id=p.id) then
  receipt:=project_provider_continue(p_owner,p.id,p_release,p_decision,p_cutoff);
 else
  update project_provider_execution set continuation_decision_id=p_decision,continuation_release_sha=p_release,continued_at=coalesce(continued_at,clock_timestamp()) where project_id=p.id;
  receipt:=jsonb_build_object('projectId',p.id,'decisionId',p_decision,'releaseSha',p_release,'cutoff',p_cutoff,'admittedAt',clock_timestamp(),'existing',false);
 end if;
 update work_projects set status='running',active_mission_id=null,lease=null,lease_until=null,updated_at=clock_timestamp(),detail='Owner authorized the execution window; existing organization and accepted work retained.' where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'execution_deadline_authorized',jsonb_build_object('authorizationId',p_authorization,'ownerId',p_owner,'priorCutoff',p_prior_cutoff,'cutoff',p_cutoff,'releaseSha',p_release,'renewedManagementIds',affected));
 return receipt||jsonb_build_object('authorizationId',p_authorization,'priorCutoff',p_prior_cutoff,'authorizedAt',(select authorized_at from project_execution_windows where id=p_authorization),'renewedManagementIds',affected);
end $$;

-- A generic owner-bound offer, independent of an original recovery receipt.
create function public.project_org_owner_window_offer(p_owner uuid,p_project uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('decisionId',d.id,'admittedAt',a.continued_at,'cutoff',p.deadline,'maxCutoff',n.deadline,'authorizationId',w.id,'authorizedAt',w.authorized_at)
 from work_projects p join project_provider_execution a on a.project_id=p.id
 left join project_execution_windows w on w.id=a.window_id and w.project_id=p.id and w.owner_id=a.owner_id
 join project_organization_nodes n on n.project_id=p.id and n.kind='project_director' and n.parent_id is null and n.status='active'
 join lateral (select x.* from project_organization_decisions x join mission_assignments j on j.id=x.assignment_id join agent_missions m on m.id=j.mission_id
  where x.project_id=p.id and x.node_id=n.id and j.status='completed' and m.status='completed'
  and (a.continuation_decision_id is null or x.id=a.continuation_decision_id)
  order by x.created_at desc,x.id limit 1) d on true
 where p.id=p_project and a.owner_id=p_owner and standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 and p.organization_version=1 and p.status in ('blocked','running');
$$;
revoke all on function public.project_org_owner_window_offer(uuid,uuid) from public,anon,authenticated;
grant execute on function public.project_org_owner_window_offer(uuid,uuid) to service_role;

revoke all on function project_org_change_immutable(),project_org_change_allowed(uuid,uuid,uuid,timestamptz,timestamptz,text[],text[]),
 project_org_amend_delegation(uuid,uuid,jsonb),project_org_window_authorized(uuid,uuid,text,uuid,timestamptz),
 project_org_renew_continue(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function project_org_renew_continue(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid) to service_role;
commit;
