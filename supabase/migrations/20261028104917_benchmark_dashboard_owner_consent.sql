-- Explicit authenticated dashboard consent; neither model tools nor client SQL
-- can create it. This is not project scope approval or a task execution grant.
create table public.benchmark_dashboard_owner_consents (
 id uuid primary key default gen_random_uuid(),
 issue integer not null check(issue=715),
 supersedes uuid unique references public.benchmark_dashboard_owner_consents(id),
 owner_id uuid not null,
 commit_sha text not null check(commit_sha ~ '^[a-f0-9]{40}$'),
 authorization_sha text not null check(authorization_sha='e0b257a0e3045d649c6ac64b982c993585bea727b741f4b2ccea365cbbb60214'),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '1 hour',
 dispatch_started_at timestamptz,
 dispatch_error text,
 run_id text check(run_id ~ '^[0-9]+$'),
 revoked_at timestamptz,
 check(expires_at>created_at and expires_at<=created_at+interval '1 hour')
);
create unique index benchmark_dashboard_initial_consent on public.benchmark_dashboard_owner_consents(issue) where supersedes is null;
alter table public.benchmark_dashboard_owner_consents enable row level security;
revoke all on public.benchmark_dashboard_owner_consents from public,anon,authenticated;
grant select,insert,update on public.benchmark_dashboard_owner_consents to service_role;
-- Pin consent atomically to the first verified workflow run. Concurrent or replay
-- dispatches cannot redirect the approval; same-run retry is permitted.
create function public.benchmark_bind_dashboard_consent(p_id uuid,p_owner uuid,p_sha text,p_run text,p_authorization_sha text)
returns boolean language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_dashboard_owner_consents;
begin
 select * into c from public.benchmark_dashboard_owner_consents where id=p_id for update;
 if not found or c.owner_id is distinct from p_owner or c.commit_sha is distinct from p_sha or c.authorization_sha is distinct from p_authorization_sha or
    c.revoked_at is not null or c.expires_at<=now() or p_run is null or p_run !~ '^[0-9]+$' or
    (c.run_id is not null and c.run_id<>p_run) then raise exception 'Dashboard owner consent refused';end if;
 update public.benchmark_dashboard_owner_consents set run_id=p_run where id=p_id;
 return true;
end $$;
revoke all on function public.benchmark_bind_dashboard_consent(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.benchmark_bind_dashboard_consent(uuid,uuid,text,text,text) to service_role;

-- An explicit owner reconfirmation may resume after a correction; it never edits
-- benchmark accounts, transfer receipts or their original spending deadline.
create function public.benchmark_record_dashboard_consent(p_owner uuid,p_sha text,p_previous uuid,p_renew boolean)
returns public.benchmark_dashboard_owner_consents language plpgsql security invoker set search_path=public as $$
declare c public.benchmark_dashboard_owner_consents; n public.benchmark_dashboard_owner_consents;
begin
 perform pg_advisory_xact_lock(hashtextextended('benchmark715.dashboard.consent',0));
 if p_owner is null or p_sha is null or p_sha !~ '^[a-f0-9]{40}$' then raise exception 'Invalid owner consent';end if;
 select * into c from public.benchmark_dashboard_owner_consents where issue=715 order by created_at desc limit 1 for update;
 if found then
  if c.owner_id is distinct from p_owner then raise exception 'Owner mismatch';end if;
  if c.id is distinct from p_previous or not coalesce(p_renew,false) then return c;end if;
  update public.benchmark_dashboard_owner_consents set revoked_at=coalesce(revoked_at,now()) where id=c.id;
 elsif p_previous is not null then raise exception 'Consent checkpoint missing';end if;
 insert into public.benchmark_dashboard_owner_consents(issue,supersedes,owner_id,commit_sha,authorization_sha)
 values(715,c.id,p_owner,p_sha,'e0b257a0e3045d649c6ac64b982c993585bea727b741f4b2ccea365cbbb60214') returning * into n;
 return n;
end $$;
revoke all on function public.benchmark_record_dashboard_consent(uuid,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.benchmark_record_dashboard_consent(uuid,text,uuid,boolean) to service_role;
