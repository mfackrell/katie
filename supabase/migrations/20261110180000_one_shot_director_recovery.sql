begin;

create table public.project_director_recoveries (
 project_id uuid primary key references public.project_provider_execution(project_id),
 mission_id uuid not null unique references public.agent_missions(id),
 assignment_id uuid not null unique references public.mission_assignments(id),
 owner_id uuid not null,
 release_sha text not null check(release_sha ~ '^[0-9a-f]{40}$'),
 cutoff timestamptz not null,
 admitted_at timestamptz not null check(admitted_at<cutoff)
);
alter table public.project_director_recoveries enable row level security;
revoke all on public.project_director_recoveries from public,anon,authenticated,service_role;
grant select on public.project_director_recoveries to service_role;

create function public.project_admit_director_recovery(p_owner uuid,p_project uuid,p_release text,p_cutoff timestamptz)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p work_projects; a project_provider_execution; n project_organization_nodes;
 r project_director_recoveries; mid uuid; jid uuid; checked_at timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project;
 if a.owner_id is null or a.owner_id is distinct from p_owner or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 then raise exception 'Authenticated trial owner required';end if;
 if p_release is null or p_release !~ '^[0-9a-f]{40}$' or p_cutoff is null or not isfinite(p_cutoff)
 then raise exception 'Exact release and cutoff required';end if;
 select * into r from project_director_recoveries where project_id=p_project;
 if found then
  if r.release_sha is distinct from p_release or r.cutoff is distinct from p_cutoff
  then raise exception 'One-shot Director recovery already admitted';end if;
  return jsonb_build_object('projectId',p_project,'missionId',r.mission_id,'assignmentId',r.assignment_id,'cutoff',r.cutoff,'existing',true);
 end if;
 checked_at:=clock_timestamp();
 select * into n from project_organization_nodes where project_id=p_project and kind='project_director' and parent_id is null and status='active';
 if n.id is null or p_cutoff<=checked_at or p_cutoff>least(a.deadline,p.deadline,n.deadline)
 then raise exception 'Recovery cutoff must be unexpired and within the existing trial deadline';end if;
 if p.status<>'blocked' or p.phase<>'research' or p.organization_version<>1 or p.spec is not null
 or p.approved_hash is not null or p.approval_hash is not null or a.approved_scope is not null
 or not exists(select 1 from agent_missions where id=p.active_mission_id and project_id=p.id)
 or exists(select 1 from project_organization_nodes where project_id=p.id and id<>n.id)
 or exists(select 1 from project_organization_decisions where project_id=p.id)
 or (select count(*) from agent_missions where project_id=p.id)<>2
 or (select count(*) from agent_missions m join mission_assignments j on j.mission_id=m.id
     join project_organization_assignments b on b.assignment_id=j.id
     where m.project_id=p.id and m.project_kind='management' and m.status='blocked' and m.calls=1
       and b.node_id=n.id and j.agent_id=n.agent_id and j.status='failed'
       and (select count(*) from project_provider_requests q where q.mission_id=m.id and q.assignment_id=j.id
            and q.project_id=p.id and q.worker_id=n.agent_id and q.resolved_at is not null and q.operation='model-list')=1
       and (select count(*) from project_provider_requests q where q.mission_id=m.id and q.assignment_id=j.id
            and q.project_id=p.id and q.worker_id=n.agent_id and q.resolved_at is not null and q.operation='inference')=1)<>2
 or (select count(*) from project_provider_requests where project_id=p.id)<>4
 or project_provider_request_pending(p.id)
 then raise exception 'Recovery requires the original blocked Director attempts and four resolved provider requests';end if;
 mid:=gen_random_uuid();
 perform create_mission(mid,n.objective,array[p.team[1]],20,null);
 update agent_missions set project_id=p.id,project_kind='management',
  project_evidence=jsonb_build_object('organizationNodeId',n.id,'previousMissionId',p.active_mission_id,'directorRecoveryRelease',p_release),
  team=jsonb_build_array((select to_jsonb(agent) from managed_agents agent where id=n.agent_id)),
  deadline=p_cutoff,status='running' where id=mid;
 update work_projects set active_mission_id=mid,status='running',lease=null,lease_until=null,updated_at=now(),
  detail='One owner-authorized Project Director recovery decision; downstream execution remains paused.' where id=p.id;
 update mission_assignments set role='work',agent_id=n.agent_id,
  payload=jsonb_build_object('organizationNodeId',n.id),instruction='Commission Functional Directors without dispatching downstream work.'
  where mission_id=mid returning id into jid;
 insert into project_organization_assignments values(jid,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex'),now());
 insert into project_director_recoveries values(p.id,mid,jid,p_owner,p_release,p_cutoff,checked_at);
 return jsonb_build_object('projectId',p.id,'missionId',mid,'assignmentId',jid,'cutoff',p_cutoff,'existing',false);
end $$;

-- Preserve the installed claimant's concurrency, expiry and historical project
-- logic. Old deployments retain the zero-argument entry point and cannot claim
-- the recovery. A consumed lease can never be issued again.
do $migration$
declare body text; step record;
begin
 body:=pg_get_functiondef('public.claim_mission_work()'::regprocedure);
 for step in select * from (values
  ('FUNCTION public.claim_mission_work()', 'FUNCTION public.claim_mission_work_release(p_release text)'),
  ('attempts<2 then ''queued''', 'attempts<2 and not exists(select 1 from project_director_recoveries recovery where recovery.assignment_id=j0.id) then ''queued'''),
  ('and a.available_at<=now()', 'and a.available_at<=now()
    and (not exists(select 1 from project_director_recoveries recovery where recovery.project_id=b.project_id)
     or exists(select 1 from project_director_recoveries recovery where recovery.project_id=b.project_id
      and recovery.assignment_id=a.id and recovery.mission_id=b.id and recovery.release_sha=p_release
      and recovery.cutoff>clock_timestamp() and a.attempts=0 and a.status=''queued''))')
 ) as patches(original,replacement) loop
  if (length(body)-length(replace(body,step.original,'')))/length(step.original)<>1
  then raise exception 'Unexpected installed mission claimant definition';end if;
  body:=replace(body,step.original,step.replacement);
 end loop;
 execute body;
end $migration$;
create or replace function public.claim_mission_work() returns jsonb
language sql security invoker set search_path=public as $$
 select public.claim_mission_work_release(null)
$$;

alter function public.project_org_schedule(uuid,uuid) rename to project_org_schedule_before_director_recovery;
create function public.project_org_schedule(p_project uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r project_director_recoveries;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into r from project_director_recoveries where project_id=p_project;
 if not found then return project_org_schedule_before_director_recovery(p_project,p_lease);end if;
 if r.cutoff>clock_timestamp() and exists(select 1 from agent_missions m where m.id=r.mission_id and m.status='running')
 then
  update work_projects set lease=null,lease_until=null,updated_at=now()
   where id=p_project and lease=p_lease and lease_until>now() and status='running';
 else
  update work_projects set status='blocked',lease=null,lease_until=null,updated_at=now(),
   detail='One-shot Project Director recovery ended; downstream execution remains paused.'
   where id=p_project and lease=p_lease and lease_until>now() and status='running';
 end if;
 return jsonb_build_object('handled',true);
end $$;

alter function public.project_provider_request(uuid,text,uuid,text,text,text,text) rename to project_provider_request_before_director_recovery;
create function public.project_provider_request(p_job uuid,p_attempt text,p_request uuid,p_operation text,p_hash text,
 p_scope text default null,p_receipt text default null) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare r project_director_recoveries;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select recovery.* into r from project_director_recoveries recovery
 join agent_missions m on m.project_id=recovery.project_id
 join mission_assignments j on j.mission_id=m.id where j.id=p_job;
 if found then
  if r.assignment_id<>p_job or p_scope is not null or r.cutoff<=clock_timestamp() then return false;end if;
  if p_receipt is null then
   if exists(select 1 from project_provider_requests where assignment_id=p_job and operation=p_operation)
   or (p_operation='inference' and not exists(select 1 from project_provider_requests
       where assignment_id=p_job and execution_attempt=p_attempt and operation='model-list' and resolved_at is not null))
   then return false;end if;
  end if;
 end if;
 return project_provider_request_before_director_recovery(p_job,p_attempt,p_request,p_operation,p_hash,p_scope,p_receipt);
end $$;

alter function public.project_org_decide(uuid,uuid,jsonb) rename to project_org_decide_before_director_recovery;
create function public.project_org_decide(p_job uuid,p_lease uuid,p_commands jsonb) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare r project_director_recoveries; decided boolean;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select recovery.* into r from project_director_recoveries recovery
 join agent_missions m on m.project_id=recovery.project_id
 join mission_assignments j on j.mission_id=m.id where j.id=p_job;
 if not found then return project_org_decide_before_director_recovery(p_job,p_lease,p_commands);end if;
 if r.assignment_id<>p_job or r.cutoff<=clock_timestamp() or not exists(
  select 1 from project_provider_requests where assignment_id=p_job and operation='inference'
  and execution_attempt=p_lease::text and resolved_at is not null)
 then raise exception 'Live one-shot Director authority and resolved inference required';end if;
 if jsonb_typeof(p_commands) is distinct from 'array' or exists(select 1 from jsonb_array_elements(p_commands) command
  where coalesce(command->>'action','') not in ('plan','appoint','ready'))
 then raise exception 'Recovery permits planning and Functional Director appointments only';end if;
 decided:=project_org_decide_before_director_recovery(p_job,p_lease,p_commands);
 update work_projects set status='blocked',lease=null,lease_until=null,updated_at=now(),
  detail='Project Director recovery decision recorded; downstream execution remains paused.' where id=r.project_id;
 return decided;
end $$;

revoke all on function public.project_org_schedule_before_director_recovery(uuid,uuid),
 public.project_provider_request_before_director_recovery(uuid,text,uuid,text,text,text,text),
 public.project_org_decide_before_director_recovery(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.project_admit_director_recovery(uuid,uuid,text,timestamptz),
 public.claim_mission_work_release(text),public.project_org_schedule(uuid,uuid),
 public.project_provider_request(uuid,text,uuid,text,text,text,text),public.project_org_decide(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.project_admit_director_recovery(uuid,uuid,text,timestamptz),
 public.claim_mission_work_release(text),public.project_org_schedule(uuid,uuid),
 public.project_provider_request(uuid,text,uuid,text,text,text,text),public.project_org_decide(uuid,uuid,jsonb) to service_role;
commit;
