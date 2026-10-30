-- One instrumented successor of a terminal failed native run under the SAME
-- still-live owner approval. Original consent, calls, grants and limits persist.
create table benchmark_development_paid_successors(
 id uuid primary key default gen_random_uuid(),
 renewal_id uuid not null unique references benchmark_development_renewals(id),
 old_grant_id uuid not null unique references benchmark_execution_grants(id),
 failed_run bigint not null unique check(failed_run>0), receipt jsonb not null,
 failed_release text not null check(failed_release~'^[a-f0-9]{40}$'),
 release_sha text not null check(release_sha~'^[a-f0-9]{40}$'),
 run_started_at timestamptz not null,run_finished_at timestamptz not null,
 diagnostic_version text not null check(diagnostic_version='bounded-schema-v1'),
 source_snapshot jsonb not null,source_snapshot_hash text not null,
 created_at timestamptz not null default now(),check(failed_release<>release_sha));
create table benchmark_development_paid_successor_dispatches(
 successor_id uuid primary key references benchmark_development_paid_successors(id),created_at timestamptz not null default now());
create table benchmark_development_paid_successor_grants(
 successor_id uuid primary key references benchmark_development_paid_successors(id),grant_id uuid not null unique references benchmark_execution_grants(id),created_at timestamptz not null default now());
alter table benchmark_development_paid_successors enable row level security;
alter table benchmark_development_paid_successor_dispatches enable row level security;
alter table benchmark_development_paid_successor_grants enable row level security;
revoke all on benchmark_development_paid_successors,benchmark_development_paid_successor_dispatches,benchmark_development_paid_successor_grants from public,anon,authenticated,service_role;
grant select,insert on benchmark_development_paid_successors,benchmark_development_paid_successor_dispatches,benchmark_development_paid_successor_grants to service_role;

create function benchmark_development_paid_successor_capacity(p_renewal uuid,p_grant uuid)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from benchmark_development_renewals r
 join benchmark_full_continuations c on c.id=r.continuation_id
 join benchmark_native_spending_approvals a on a.id=r.approval_id
 join benchmark_budget_accounts b on b.id=c.account_id
 join agent_missions m on m.id=r.mission_id
 join work_projects p on p.id=m.project_id
 join benchmark_execution_grants g on g.id=p_grant
 where r.id=p_renewal and benchmark_development_renewal_matches(m.id,c.id)
 and a.consumed_at is not null and a.revoked_at is null and a.deadline>now()
 and g.deadline=a.deadline and g.revoked_at is null and g.continuation_id=c.id
 and g.project_id=p.id and g.mission_assignment_id=r.task_id and g.account_id=b.id
 and g.trial_id=a.trial_id and g.owner_actor_id=a.actor_id and g.model=a.model and g.repository=a.repository and g.protocol_digest=a.protocol_digest
 and exists(select 1 from benchmark_development_renewal_grants where renewal_id=r.id and grant_id=g.id)
 and a.actor_id=p.actor_id and a.chat_id=p.chat_id and benchmark_full_task_provenance(r.task_id,p.id)
 and b.frozen_at is null and b.cap_tokens=350000 and b.cap_tokens<=a.max_tokens
 and not exists(select 1 from benchmark_execution_grants x where x.account_id=b.id and x.id<>g.id and x.revoked_at is null and x.stopped_at is null and x.deadline>now())
 and not exists(select 1 from benchmark_budget_calls where account_id=b.id and (state<>'settled' or actual_tokens is null))
 and (select coalesce(sum(actual_tokens),0) from benchmark_budget_calls where account_id=b.id)=b.spent_tokens
 and not exists(select 1 from mission_calls x where x.job_id=r.task_id and (x.actual_tokens is null or x.status<>'completed'))
 and m.calls=(select count(*) from mission_calls where job_id=r.task_id)
 and m.actual_tokens=(select coalesce(sum(actual_tokens),0) from mission_calls where job_id=r.task_id)
 and m.reserved_tokens=m.actual_tokens
 and m.max_calls=(c.source_snapshot->'mission'->>'max_calls')::integer
 and m.token_allowance=(c.source_snapshot->'mission'->>'token_allowance')::bigint and m.token_allowance=120000
 and m.calls<m.max_calls and m.actual_tokens<m.token_allowance
 and b.spent_tokens+(m.token_allowance-m.actual_tokens)+60000<=b.cap_tokens
 and b.spent_tokens-c.spent_at_approval+(m.token_allowance-m.actual_tokens)+60000<=c.additional_token_cap
 and (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)+(m.token_allowance-m.actual_tokens)+60000<=p.token_allowance
 and exists(select 1 from mission_calls where job_id=r.task_id and lease=g.id and actual_tokens>0)
 and not exists(select 1 from benchmark_budget_calls bc left join mission_calls mc on mc.id=bc.legacy_mission_call_id where bc.continuation_id=c.id and (mc.id is null or mc.lease<>g.id or mc.job_id<>r.task_id))
 and exists(select 1 from model_registry where provider_name='openai' and model_id=a.model and pricing_status='verified' and pricing_verified_at>now()-interval '24 hours' and pricing_verified_at<=now()
  and pricing_input_per_1m>0 and pricing_input_per_1m<=28 and pricing_output_per_1m>0 and pricing_output_per_1m<=28));
$$;
create function benchmark_prepare_development_paid_successor(p_renewal uuid,p_grant uuid,p_run bigint,p_receipt jsonb,p_failed_release text,p_release text,p_started timestamptz,p_finished timestamptz,p_diagnostics text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare r benchmark_development_renewals; s benchmark_development_paid_successors;
 t agent_tasks;j mission_assignments;m agent_missions;p work_projects;g benchmark_execution_grants;snap jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into r from benchmark_development_renewals where id=p_renewal;
 select * into g from benchmark_execution_grants where id=p_grant for update;
 if r.id is null or g.id is null or not benchmark_development_paid_successor_capacity(r.id,g.id) then raise exception 'Settled live successor capacity unavailable';end if;
 select * into s from benchmark_development_paid_successors where renewal_id=r.id;
 if found then
  if s.failed_run=p_run and s.old_grant_id=p_grant and s.receipt=p_receipt and s.failed_release=p_failed_release and s.release_sha=p_release and s.run_started_at=p_started and s.run_finished_at=p_finished and s.diagnostic_version=p_diagnostics then return to_jsonb(s);end if;
  raise exception 'Paid successor already prepared';
 end if;
 if g.stopped_at is not null then raise exception 'Stopped execution cannot prepare a successor';end if;
 select * into t from agent_tasks where id=r.task_id for update;
 select * into j from mission_assignments where id=r.task_id for update;
 select * into m from agent_missions where id=r.mission_id for update;
 select * into p from work_projects where id=m.project_id for update;
 if t.status<>'blocked' or j.status<>'failed' or m.status<>'blocked' or p.status<>'blocked'
 or t.external->>'developmentRenewalId' is distinct from r.id::text or t.external->'receipt' is distinct from p_receipt
 or p_run is null or p_run<=0 or p_receipt->>'run_id' is distinct from p_run::text
 or p_receipt->>'issue_number' is distinct from t.external->>'issueNumber' or p_receipt->>'repository' is distinct from 'mfackrell/katie' or p_receipt->>'outcome' is distinct from 'BLOCKED'
 or p_receipt->>'pr_url' is not null or p_receipt->>'tested_head_sha' is not null or p_receipt->>'reviewed_head_sha' is not null
 or p_receipt->'checks' is distinct from '{"build":"failure","test":"","review":"","repair":"skipped","retest":"","final_review":""}'::jsonb
 or p_release is null or p_release!~'^[a-f0-9]{40}$' or p_failed_release is null or p_release=p_failed_release
 or coalesce(t.external->>'pregrantRecoveryRelease',t.external->>'developmentRenewalRelease') is distinct from p_failed_release
 or p_started is null or p_finished is null or p_started>=p_finished or p_finished>now() or g.created_at not between p_started and p_finished
 or p_diagnostics is distinct from 'bounded-schema-v1'
 or exists(select 1 from mission_calls where lease=g.id and (created_at<p_started or created_at>p_finished))
 or (j.lease is not null and j.lease_until>now()) or (p.lease is not null and p.lease_until>now())
 then raise exception 'Paid successor terminal evidence differs';end if;
 snap:=jsonb_build_object('task',to_jsonb(t),'assignment',to_jsonb(j),'mission',to_jsonb(m),'project',to_jsonb(p),
 'approval',(select to_jsonb(a) from benchmark_native_spending_approvals a where id=r.approval_id),
 'continuation',(select to_jsonb(c) from benchmark_full_continuations c where id=r.continuation_id),
 'account',(select to_jsonb(a) from benchmark_budget_accounts a where id=g.account_id),
 'oldGrant',to_jsonb(g)-'token_digest',
 'calls',(select jsonb_agg(to_jsonb(x) order by id) from benchmark_budget_calls x where account_id=g.account_id));
 insert into benchmark_development_paid_successors(renewal_id,old_grant_id,failed_run,receipt,failed_release,release_sha,run_started_at,run_finished_at,diagnostic_version,source_snapshot,source_snapshot_hash)
 values(r.id,g.id,p_run,p_receipt,p_failed_release,p_release,p_started,p_finished,p_diagnostics,snap,encode(sha256(convert_to(project_canonical(snap),'UTF8')),'hex')) returning * into s;
 update benchmark_execution_grants set stopped_at=coalesce(stopped_at,now()) where id=g.id;
 update agent_tasks set status='dispatching',external=external||jsonb_build_object('paidSuccessorId',s.id),updated_at=now() where id=t.id;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),updated_at=now() where id=j.id;
 update agent_missions set status='running',updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,impediment=null,detail='One instrumented successor continues the same live owner authorization; prior paid calls and failed attempts remain recorded.',updated_at=now() where id=p.id;
 return to_jsonb(s);
end $$;
create function benchmark_claim_development_paid_successor(p_successor uuid,p_release text)
returns boolean language plpgsql security invoker set search_path=public as $$
declare s benchmark_development_paid_successors;r benchmark_development_renewals;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into s from benchmark_development_paid_successors where id=p_successor;
 select * into r from benchmark_development_renewals where id=s.renewal_id;
 if s.id is null or s.release_sha is distinct from p_release or not benchmark_development_paid_successor_capacity(r.id,s.old_grant_id)
 or not exists(select 1 from benchmark_budget_accounts where id=(s.source_snapshot->'account'->>'id')::uuid and spent_tokens=(s.source_snapshot->'account'->>'spent_tokens')::bigint)
 or not exists(select 1 from agent_tasks where id=r.task_id and status='dispatching' and external->>'paidSuccessorId'=s.id::text and external->'receipt'=s.receipt)
 then return false;end if;
 insert into benchmark_development_paid_successor_dispatches(successor_id) values(s.id) on conflict do nothing;
 if not found then return false;end if;
 update agent_tasks set external=external||jsonb_build_object('paidSuccessorSince',now(),'paidSuccessorRelease',s.release_sha),updated_at=now() where id=r.task_id;
 return true;
end $$;
create function benchmark_issue_development_paid_successor_grant(p_successor uuid,p_digest text,p_approval uuid,p_task uuid,p_release text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare s benchmark_development_paid_successors;r benchmark_development_renewals;a benchmark_native_spending_approvals;g benchmark_execution_grants;p work_projects;m agent_missions;j mission_assignments;n uuid;epoch bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into s from benchmark_development_paid_successors where id=p_successor;
 select * into r from benchmark_development_renewals where id=s.renewal_id;
 select * into a from benchmark_native_spending_approvals where id=r.approval_id for update;
 select * into g from benchmark_execution_grants where id=s.old_grant_id for update;
 select * into m from agent_missions where id=r.mission_id for update;
 select * into j from mission_assignments where id=r.task_id for update;
 select * into p from work_projects where id=m.project_id for update;
 if s.id is null or s.release_sha is distinct from p_release or r.approval_id is distinct from p_approval or r.task_id is distinct from p_task
 or p_digest is null or p_digest!~'^[a-f0-9]{64}$' or g.stopped_at is null
 or not benchmark_development_paid_successor_capacity(r.id,g.id)
 or p.status<>'running' or m.status<>'running' or j.status<>'waiting_external' or p.active_mission_id<>m.id
 or not exists(select 1 from benchmark_development_paid_successor_dispatches where successor_id=s.id)
 or exists(select 1 from benchmark_development_paid_successor_grants where successor_id=s.id)
 or not exists(select 1 from agent_tasks where id=r.task_id and status in ('dispatching','submitted') and external->>'paidSuccessorId'=s.id::text)
 or not exists(select 1 from benchmark_budget_accounts where id=g.account_id and spent_tokens=(s.source_snapshot->'account'->>'spent_tokens')::bigint)
 or m.calls<>(s.source_snapshot->'mission'->>'calls')::integer or m.actual_tokens<>(s.source_snapshot->'mission'->>'actual_tokens')::bigint
 or a.consumed_at<>(s.source_snapshot->'approval'->>'consumed_at')::timestamptz
 then raise exception 'Bounded paid successor unavailable';end if;
 select coalesce(max(execution_epoch),0)+1 into epoch from benchmark_execution_grants where trial_id=a.trial_id;
 insert into benchmark_execution_grants(token_digest,trial_id,account_id,owner_actor_id,protocol_digest,repository,model,execution_epoch,deadline,project_id,mission_assignment_id,continuation_id)
 values(p_digest,a.trial_id,a.account_id,a.actor_id,a.protocol_digest,a.repository,a.model,epoch,least(a.deadline,g.deadline,benchmark_effective_mission_deadline(m.id),p.deadline),p.id,j.id,a.continuation_id) returning id into n;
 insert into benchmark_development_paid_successor_grants(successor_id,grant_id) values(s.id,n);
 return jsonb_build_object('grantId',n,'executionEpoch',epoch);
end $$;
revoke all on function benchmark_development_paid_successor_capacity(uuid,uuid),benchmark_prepare_development_paid_successor(uuid,uuid,bigint,jsonb,text,text,timestamptz,timestamptz,text),benchmark_claim_development_paid_successor(uuid,text),benchmark_issue_development_paid_successor_grant(uuid,text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function benchmark_development_paid_successor_capacity(uuid,uuid),benchmark_prepare_development_paid_successor(uuid,uuid,bigint,jsonb,text,text,timestamptz,timestamptz,text),benchmark_claim_development_paid_successor(uuid,text),benchmark_issue_development_paid_successor_grant(uuid,text,uuid,uuid,text) to service_role;
