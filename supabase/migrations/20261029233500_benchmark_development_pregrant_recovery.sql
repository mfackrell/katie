-- One bounded, append-only recovery of an owner-renewed task that never reached
-- grant issuance. Historical paid calls remain charged; original authority stays.
create table benchmark_development_pregrant_recoveries(
 id uuid primary key default gen_random_uuid(),
 renewal_id uuid not null unique references benchmark_development_renewals(id),
 failed_run bigint not null unique check(failed_run>0),
 receipt jsonb not null, failed_release text not null check(failed_release~'^[a-f0-9]{40}$'),
 release_sha text not null check(release_sha~'^[a-f0-9]{40}$'),
 source_snapshot jsonb not null, source_snapshot_hash text not null,
 created_at timestamptz not null default now(),check(failed_release<>release_sha));
create table benchmark_development_pregrant_dispatches(
 recovery_id uuid primary key references benchmark_development_pregrant_recoveries(id),
 created_at timestamptz not null default now());
alter table benchmark_development_pregrant_recoveries enable row level security;
alter table benchmark_development_pregrant_dispatches enable row level security;
revoke all on benchmark_development_pregrant_recoveries,benchmark_development_pregrant_dispatches from public,anon,authenticated,service_role;
grant select,insert on benchmark_development_pregrant_recoveries,benchmark_development_pregrant_dispatches to service_role;

create function benchmark_development_pregrant_unused(p_renewal uuid)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from benchmark_development_renewals r
 join benchmark_full_continuations c on c.id=r.continuation_id
 join benchmark_native_spending_approvals a on a.id=r.approval_id
 join benchmark_budget_accounts b on b.id=c.account_id
 join agent_missions m on m.id=r.mission_id
 where r.id=p_renewal and benchmark_development_renewal_matches(m.id,c.id)
 and a.consumed_at is null and a.revoked_at is null and a.deadline>now()
 and b.frozen_at is null and b.spent_tokens=c.spent_at_approval
 and not exists(select 1 from benchmark_development_renewal_grants where renewal_id=r.id)
 and not exists(select 1 from benchmark_execution_grants where continuation_id=c.id or (mission_assignment_id=r.task_id and created_at>=r.created_at))
 and not exists(select 1 from benchmark_budget_calls where continuation_id=c.id or (account_id=b.id and (created_at>=r.created_at or state<>'settled' or actual_tokens is null)))
 and (select coalesce(sum(actual_tokens),0) from benchmark_budget_calls where account_id=b.id)=b.spent_tokens
 and m.calls=(c.source_snapshot->'mission'->>'calls')::integer
 and m.actual_tokens=(c.source_snapshot->'mission'->>'actual_tokens')::bigint
 and m.reserved_tokens=(c.source_snapshot->'mission'->>'reserved_tokens')::bigint
 and m.token_allowance=(c.source_snapshot->'mission'->>'token_allowance')::bigint
 and exists(select 1 from model_registry where provider_name='openai' and model_id=a.model and pricing_status='verified'
  and pricing_input_per_1m>0 and pricing_input_per_1m<=28 and pricing_output_per_1m>0 and pricing_output_per_1m<=28));
$$;
create function benchmark_prepare_development_pregrant_recovery(p_renewal uuid,p_run bigint,p_receipt jsonb,p_failed_release text,p_release text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare r benchmark_development_renewals; rec benchmark_development_pregrant_recoveries;
 t agent_tasks;j mission_assignments;m agent_missions;p work_projects; snap jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into r from benchmark_development_renewals where id=p_renewal;
 if r.id is null or not benchmark_development_pregrant_unused(r.id) then raise exception 'Unused owner renewal unavailable';end if;
 select * into rec from benchmark_development_pregrant_recoveries where renewal_id=r.id;
 if found then
  if rec.failed_run=p_run and rec.receipt=p_receipt and rec.failed_release=p_failed_release and rec.release_sha=p_release then return to_jsonb(rec);end if;
  raise exception 'Pregrant recovery already prepared';
 end if;
 select * into t from agent_tasks where id=r.task_id for update;
 select * into j from mission_assignments where id=r.task_id for update;
 select * into m from agent_missions where id=r.mission_id for update;
 select * into p from work_projects where id=m.project_id for update;
 if t.status<>'blocked' or j.status<>'failed' or m.status<>'blocked' or p.status<>'blocked'
 or t.external->>'developmentRenewalId' is distinct from r.id::text or t.external->'receipt' is distinct from p_receipt
 or p_run is null or p_run<=0 or p_run=r.prior_run or p_receipt->>'run_id' is distinct from p_run::text
 or p_receipt->>'issue_number' is distinct from t.external->>'issueNumber'
 or p_receipt->>'repository' is distinct from 'mfackrell/katie' or p_receipt->>'outcome' is distinct from 'BLOCKED'
 or p_receipt->>'pr_url' is not null or p_receipt->>'tested_head_sha' is not null or p_receipt->>'reviewed_head_sha' is not null
 or p_receipt->'checks' is distinct from '{"build":"failure","test":"","review":"","repair":"skipped","retest":"","final_review":""}'::jsonb
 or p_release is null or p_release!~'^[a-f0-9]{40}$' or p_failed_release is null or p_release=p_failed_release
 or not exists(select 1 from benchmark_development_renewal_dispatches where renewal_id=r.id and release_sha=p_failed_release)
 or t.external->>'developmentRenewalRelease' is distinct from p_failed_release then raise exception 'Pregrant failure evidence differs';end if;
 snap:=jsonb_build_object('task',to_jsonb(t),'assignment',to_jsonb(j),'mission',to_jsonb(m),'project',to_jsonb(p),'renewal',to_jsonb(r),
 'approval',(select to_jsonb(a) from benchmark_native_spending_approvals a where id=r.approval_id),
 'continuation',(select to_jsonb(c) from benchmark_full_continuations c where id=r.continuation_id));
 insert into benchmark_development_pregrant_recoveries(renewal_id,failed_run,receipt,failed_release,release_sha,source_snapshot,source_snapshot_hash)
 values(r.id,p_run,p_receipt,p_failed_release,p_release,snap,encode(sha256(convert_to(project_canonical(snap),'UTF8')),'hex')) returning * into rec;
 update agent_tasks set status='dispatching',external=external||jsonb_build_object('pregrantRecoveryId',rec.id),updated_at=now() where id=t.id;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),updated_at=now() where id=j.id;
 update agent_missions set status='running',updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,updated_at=now() where id=p.id;
 return to_jsonb(rec);
end $$;
create function benchmark_claim_development_pregrant_dispatch(p_recovery uuid,p_release text)
returns boolean language plpgsql security invoker set search_path=public as $$
declare rec benchmark_development_pregrant_recoveries;r benchmark_development_renewals;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into rec from benchmark_development_pregrant_recoveries where id=p_recovery;
 select * into r from benchmark_development_renewals where id=rec.renewal_id;
 if rec.id is null or rec.release_sha is distinct from p_release or not benchmark_development_pregrant_unused(r.id)
 or not exists(select 1 from agent_tasks where id=r.task_id and status='dispatching' and external->>'pregrantRecoveryId'=rec.id::text and external->'receipt'=rec.receipt) then return false;end if;
 insert into benchmark_development_pregrant_dispatches(recovery_id) values(rec.id) on conflict do nothing;
 if not found then return false;end if;
 update agent_tasks set external=external||jsonb_build_object('pregrantRecoverySince',now(),'pregrantRecoveryRelease',rec.release_sha),updated_at=now() where id=r.task_id;
 return true;
end $$;
create function benchmark_issue_development_pregrant_recovery_grant(p_recovery uuid,p_digest text,p_approval uuid,p_task uuid,p_release text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare rec benchmark_development_pregrant_recoveries;r benchmark_development_renewals;a benchmark_native_spending_approvals;g uuid;epoch bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into rec from benchmark_development_pregrant_recoveries where id=p_recovery;
 select * into r from benchmark_development_renewals where id=rec.renewal_id;
 select * into a from benchmark_native_spending_approvals where id=r.approval_id for update;
 if rec.id is null or rec.release_sha is distinct from p_release or r.approval_id is distinct from p_approval or r.task_id is distinct from p_task
 or not benchmark_development_pregrant_unused(r.id)
 or not exists(select 1 from benchmark_development_pregrant_dispatches where recovery_id=rec.id)
 or not exists(select 1 from agent_tasks where id=r.task_id and external->>'pregrantRecoveryId'=rec.id::text)
 then raise exception 'Pregrant recovery unavailable';end if;
 select coalesce(max(execution_epoch),0)+1 into epoch from benchmark_execution_grants where trial_id=a.trial_id;
 g:=benchmark_issue_execution_grant(a.owner_id,a.actor_id,a.chat_id,a.trial_id,a.id,a.repository,a.model,epoch,a.deadline,p_digest);
 insert into benchmark_development_renewal_grants(renewal_id,grant_id) values(r.id,g);
 return jsonb_build_object('grantId',g,'executionEpoch',epoch);
end $$;
-- Once a recovery exists, the superseded transport cannot claim the grant.
do $patch$
declare body text;anchor text:=' select * into r from benchmark_development_renewals where id=p_renewal;';
begin
 select pg_get_functiondef('benchmark_issue_development_renewal_grant(uuid,text,uuid,uuid,text)'::regprocedure) into body;
 if position(anchor in body)=0 then raise exception 'Renewal grant patch anchor changed';end if;
 body:=replace(body,anchor,anchor||E'\n if exists(select 1 from benchmark_development_pregrant_recoveries where renewal_id=p_renewal) then raise exception ''Pregrant recovery transport required'';end if;');
 execute body;
end $patch$;
revoke all on function benchmark_development_pregrant_unused(uuid),benchmark_prepare_development_pregrant_recovery(uuid,bigint,jsonb,text,text),benchmark_claim_development_pregrant_dispatch(uuid,text),benchmark_issue_development_pregrant_recovery_grant(uuid,text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function benchmark_development_pregrant_unused(uuid),benchmark_prepare_development_pregrant_recovery(uuid,bigint,jsonb,text,text),benchmark_claim_development_pregrant_dispatch(uuid,text),benchmark_issue_development_pregrant_recovery_grant(uuid,text,uuid,uuid,text) to service_role;
