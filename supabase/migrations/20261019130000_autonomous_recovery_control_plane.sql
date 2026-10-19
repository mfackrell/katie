-- Durable recovery control plane for projects, missions, and saved tasks.
-- Diagnosis and delegation are separate from existing execution authorization.
create table public.recovery_cases (
 id uuid primary key default gen_random_uuid(),
 source_type text not null check (source_type in ('project','mission','task')),
 source_id uuid not null,
 source_revision text not null check(length(source_revision) between 1 and 250),
 actor_id uuid not null references public.actors(id),
 chat_id uuid references public.chats(id),
 repository_id uuid references public.repo_sync_runs(id),
 status text not null default 'observed' check(status in ('observed','claimed','delegated','awaiting_release','verifying','resolved','requires_owner','blocked')),
 category text check(category in ('provider_transient','verification_infrastructure','implementation','configuration','permissions','budget','unknown')),
 strategy text check(strategy in ('retry_original','reverify_existing','scoped_repair','diagnose','owner_required')),
 attempt integer not null default 0 check(attempt between 0 and 2),
 lease uuid,
 lease_until timestamptz,
 details text not null default 'Waiting for diagnosis' check(length(details)<=2000),
 evidence jsonb not null default '{}'::jsonb,
 repair_issue_url text,
 repair_pr_url text,
 repair_head_sha text,
 opened_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(source_type,source_id,source_revision)
);
create index recovery_cases_claim on public.recovery_cases(status,updated_at);
create index recovery_cases_actor on public.recovery_cases(actor_id,opened_at desc);
create table public.recovery_events(
 id uuid primary key default gen_random_uuid(),
 case_id uuid not null references public.recovery_cases(id) on delete restrict,
 event text not null check(length(event) between 1 and 80),
 evidence jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index recovery_events_case on public.recovery_events(case_id,created_at);
alter table public.recovery_cases enable row level security;
alter table public.recovery_events enable row level security;
revoke all on public.recovery_cases,public.recovery_events from public,anon,authenticated,service_role;
grant select,insert,update on public.recovery_cases to service_role;
grant select,insert on public.recovery_events to service_role;

-- Discover idempotently, independent of what kind of work a user requested.
-- Deliberately exclude stopped/paused tasks, superseded project branches and
-- tasks already represented by their parent blocked mission.
create function public.discover_recovery_cases() returns integer
language plpgsql security invoker set search_path=public as $$
declare n integer:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.recovery.state',0));
 insert into recovery_cases(source_type,source_id,source_revision,actor_id,chat_id,repository_id,details)
 select 'project',p.id,p.phase||':'||p.milestone_index||':'||p.cycles||':'||coalesce(p.active_mission_id::text,'none'),
 p.actor_id,p.chat_id,p.repository_id,left(coalesce(p.detail,'Project blocked'),2000)
 from work_projects p
 where p.status='blocked' and p.deadline>now() and p.updated_at>now()-interval '14 days'
 and p.approved_hash is not distinct from p.approval_hash
 and (select count(*) from recovery_cases r where r.source_type='project' and r.source_id=p.id)<4
 on conflict do nothing;
 get diagnostics n=row_count;
 insert into recovery_cases(source_type,source_id,source_revision,actor_id,repository_id,details)
 select 'mission',m.id,m.status||':'||coalesce((select max(j.id::text||':'||j.attempts::text) from mission_assignments j where j.mission_id=m.id and j.status='failed'),'none'),
 (m.team->0->>'actor_id')::uuid,m.repository_id,left(coalesce(m.detail,'Mission blocked'),2000)
 from agent_missions m
 where m.status='blocked' and m.project_id is null and m.updated_at>now()-interval '14 days'
 and (m.team->0->>'actor_id') is not null
 and (select count(*) from recovery_cases r where r.source_type='mission' and r.source_id=m.id)<3
 on conflict do nothing;
 insert into recovery_cases(source_type,source_id,source_revision,actor_id,chat_id,repository_id,details)
 select 'task',t.id,t.request_id,t.actor_id,t.chat_id,t.repository_id,left(coalesce(t.details,'Task blocked'),2000)
 from agent_tasks t
 where t.status in ('blocked','failed') and t.updated_at>now()-interval '14 days'
 and not exists(select 1 from mission_assignments j where j.id=t.id)
 and (select count(*) from recovery_cases r where r.source_type='task' and r.source_id=t.id)<3
 on conflict do nothing;
 return n;
end $$;

-- Atomic lease: only one supervisor may initiate external repair work.
create function public.claim_recovery_case() returns jsonb
language plpgsql security invoker set search_path=public as $$
declare c recovery_cases;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.recovery.state',0));
 update recovery_cases set status=case when attempt<2 then 'observed' else 'blocked' end,
   lease=null,lease_until=null,details=case when attempt<2 then 'Recovering a stale diagnosis lease' else 'Diagnosis limit reached; manual review required' end,
   updated_at=now() where status='claimed' and lease_until<now();
 select * into c from recovery_cases where status='observed' and attempt<2
  order by opened_at limit 1 for update skip locked;
 if not found then return null;end if;
 update recovery_cases set status='claimed',attempt=attempt+1,lease=gen_random_uuid(),
  lease_until=now()+interval '4 minutes',updated_at=now()
 where id=c.id returning * into c;
 insert into recovery_events(case_id,event,evidence) values(c.id,'claimed',jsonb_build_object('attempt',c.attempt));
 return to_jsonb(c);
end $$;

create function public.finish_recovery_case(p_id uuid,p_lease uuid,p_status text,
 p_category text,p_strategy text,p_details text,p_evidence jsonb default '{}'::jsonb,
 p_issue text default null,p_pr text default null,p_head text default null) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare c recovery_cases;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.recovery.state',0));
 select * into c from recovery_cases where id=p_id and status='claimed' and lease=p_lease and lease_until>now() for update;
 if not found then return null;end if;
 if p_status not in ('delegated','awaiting_release','verifying','resolved','requires_owner','blocked') or
 p_category not in ('provider_transient','verification_infrastructure','implementation','configuration','permissions','budget','unknown') or
 p_strategy not in ('retry_original','reverify_existing','scoped_repair','diagnose','owner_required') or
 length(coalesce(p_details,'')) not between 1 and 2000 or
 jsonb_typeof(p_evidence)<>'object' or length(p_evidence::text)>12000 or
 (p_issue is not null and (length(p_issue)>500 or p_issue !~ '^https://github[.]com/')) or
 (p_pr is not null and (length(p_pr)>500 or p_pr !~ '^https://github[.]com/')) or
 (p_head is not null and p_head !~ '^[a-f0-9]{40}$') then raise exception 'Invalid recovery outcome';end if;
 update recovery_cases set status=p_status,category=p_category,strategy=p_strategy,
 details=p_details,evidence=p_evidence,repair_issue_url=p_issue,repair_pr_url=p_pr,
 repair_head_sha=p_head,lease=null,lease_until=null,updated_at=now()
 where id=c.id returning * into c;
 insert into recovery_events(case_id,event,evidence) values(c.id,p_status,
  jsonb_build_object('category',p_category,'strategy',p_strategy,'details',p_details,'issue',p_issue,'pr',p_pr));
 return to_jsonb(c);
end $$;

-- Replay a transient ordinary mission assignment at most once, with its
-- original deadline, team, cost accounting, dependencies and authorization.
-- Project mission transitions must instead use the existing project controller.
create function public.retry_recovery_assignment(p_case uuid,p_lease uuid,p_assignment uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c recovery_cases;m agent_missions;j mission_assignments;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into c from recovery_cases where id=p_case and status='claimed'
  and lease=p_lease and lease_until>now() and source_type='mission' for update;
 if not found then return false;end if;
 select * into m from agent_missions where id=c.source_id and status='blocked'
  and project_id is null and deadline>now() for update;
 if not found or m.calls>=m.max_calls or greatest(m.reserved_tokens,m.actual_tokens)+8000>m.token_allowance then return false;end if;
 select * into j from mission_assignments where id=p_assignment and mission_id=m.id
   and status='failed' and attempts=1 and role<>'development' for update;
 if not found then return false;end if;
 update mission_assignments set status='queued',lease=null,lease_until=null,
  available_at=now(),detail='Autonomous transient recovery; charges and deadline preserved.',
  updated_at=now() where id=j.id;
 update agent_missions set status='running',detail='Retrying a verified transient worker failure within original budget.',
  updated_at=now() where id=m.id;
 insert into recovery_events(case_id,event,evidence) values(c.id,'ordinary_retry',
  jsonb_build_object('mission',m.id,'assignment',j.id,'prior_attempts',j.attempts));
 return true;
end $$;
revoke all on function public.discover_recovery_cases(),public.claim_recovery_case(),
 public.finish_recovery_case(uuid,uuid,text,text,text,text,jsonb,text,text,text),
 public.retry_recovery_assignment(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.discover_recovery_cases(),public.claim_recovery_case(),
 public.finish_recovery_case(uuid,uuid,text,text,text,text,jsonb,text,text,text),
 public.retry_recovery_assignment(uuid,uuid,uuid) to service_role;
