-- Explicit owner-authorized continuation; the failed benchmark is never restarted.
create table public.benchmark_full_continuations(
 id uuid primary key default gen_random_uuid(), owner_id uuid not null,
 project_id uuid not null unique references work_projects(id),
 trial_id uuid not null unique references benchmark_three_arm_trials(id),
 account_id uuid not null unique references benchmark_budget_accounts(id),
 source_mission_id uuid not null references agent_missions(id),
 source_snapshot jsonb not null, source_snapshot_hash text not null,
 plan jsonb not null, plan_hash text not null,
 spent_at_approval bigint not null check(spent_at_approval>=0),
 additional_token_cap integer not null check(additional_token_cap=270000),
 created_at timestamptz not null default now(), deadline timestamptz not null,
 check(deadline=created_at+interval '4 hours'),
 check(spent_at_approval+additional_token_cap<=350000)
);
alter table benchmark_full_continuations enable row level security;
revoke all on benchmark_full_continuations from public,anon,authenticated,service_role;
grant select,insert on benchmark_full_continuations to service_role;
create function benchmark_continuation_immutable() returns trigger language plpgsql as $$
begin raise exception 'Continuation authorization and failed benchmark evidence are immutable';end $$;
create trigger benchmark_continuation_immutable before update or delete on benchmark_full_continuations
 for each row execute function benchmark_continuation_immutable();
revoke all on function benchmark_continuation_immutable() from public,anon,authenticated;
alter table benchmark_native_spending_approvals add column continuation_id uuid references benchmark_full_continuations(id);
alter table benchmark_execution_grants add column continuation_id uuid references benchmark_full_continuations(id);
alter table benchmark_budget_calls add column continuation_id uuid references benchmark_full_continuations(id);

create function benchmark_continuation_live(p_id uuid,p_account uuid,p_project uuid)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from benchmark_full_continuations c
 join benchmark_budget_accounts a on a.id=c.account_id
 join benchmark_full_project_bindings b on b.project_id=c.project_id and b.account_id=a.id and b.trial_id=c.trial_id
 join benchmark_three_arm_trials t on t.id=c.trial_id
 join benchmark_production_qualifications q on q.experiment_id=a.experiment_id
 where c.id=p_id and c.account_id=p_account and c.project_id=p_project and c.deadline>now()
 and q.issue=715 and q.owner_id=c.owner_id and q.actor_id=a.owner_actor_id and q.revoked_at is null
 and a.arm='full' and a.cap_tokens=350000 and a.frozen_at is null
 and a.trial_id=t.id and t.arm='full' and t.owner_actor_id=q.actor_id
 and t.baseline_sha=b.baseline_sha and t.contract_sha256=b.benchmark_contract_hash
 and t.baseline_sha='0015bcdb8ac9ad94b7c74d1a4cd76737903b1319'
 and b.model='gpt-5.3-codex' and to_jsonb(t)=c.source_snapshot->'trial');
$$;
create function benchmark_active_full_continuation(p_project uuid) returns jsonb
language sql stable security invoker set search_path=public as $$
 select to_jsonb(c)-'source_snapshot' from benchmark_full_continuations c
 where c.project_id=p_project and benchmark_continuation_live(c.id,c.account_id,c.project_id);
$$;
revoke all on function benchmark_continuation_live(uuid,uuid,uuid),benchmark_active_full_continuation(uuid) from public,anon,authenticated;
grant execute on function benchmark_continuation_live(uuid,uuid,uuid),benchmark_active_full_continuation(uuid) to service_role;

-- GET and POST use the same locked authoritative plan; approval cannot accept a
-- stale plan hash or replace an existing/expired continuation.
create function benchmark_dashboard_continuation(p_owner uuid,p_project uuid default null,p_plan_hash text default null,p_approve boolean default false)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare q benchmark_production_qualifications; b benchmark_full_project_bindings;
 p work_projects; m agent_missions; a benchmark_budget_accounts; t benchmark_three_arm_trials;
 c benchmark_full_continuations; snapshot jsonb; plan jsonb; hash text; snapshot_hash text; calls jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into q from benchmark_production_qualifications where issue=715 for update;
 if not found and not p_approve then return null;end if;
 if p_owner is null or q.owner_id is distinct from p_owner or q.revoked_at is not null then raise exception 'Authenticated original owner required';end if;
 select * into t from benchmark_three_arm_trials where experiment_id=q.experiment_id and arm='full' and replicate=2 for update;
 select * into b from benchmark_full_project_bindings where trial_id=t.id;
 if b.project_id is null then return null;end if;
 select * into p from work_projects where id=b.project_id for update;
 select * into a from benchmark_budget_accounts where id=b.account_id for update;
 select * into c from benchmark_full_continuations where project_id=p.id;
 if c.id is not null then
  if p_approve and (p_project is distinct from c.project_id or p_plan_hash is distinct from c.plan_hash) then raise exception 'Continuation identity differs';end if;
  return jsonb_build_object('approved',true,'id',c.id,'projectId',c.project_id,'trialId',c.trial_id,'accountId',c.account_id,
   'deadline',c.deadline,'planHash',c.plan_hash,'plan',c.plan,'spentTokens',a.spent_tokens,
   'live',benchmark_continuation_live(c.id,c.account_id,c.project_id),'sourceSnapshotHash',c.source_snapshot_hash);
 end if;
 select * into m from agent_missions where id=p.active_mission_id for update;
 if p.phase<>'specification' or p.status not in ('blocked','paused','failed') or m.id is null or m.status not in ('blocked','stopped')
 or m.project_id is distinct from p.id or m.project_kind<>'specification' or p.approved_hash is not null or p.approval_hash is not null
 or p.actor_id is distinct from q.actor_id or p.deadline<=now()+interval '4 hours'
 or (p.lease is not null and p.lease_until>now()) or a.arm<>'full' or a.trial_id is distinct from t.id
 or a.owner_actor_id is distinct from q.actor_id or a.cap_tokens<>350000 or a.frozen_at is not null
 or a.spent_tokens+270000>350000 or p.token_allowance>350000
 or (select coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0) from agent_missions where project_id=p.id)+270000>p.token_allowance
 or (select count(*) from project_runs where project_id=p.id)+3>p.max_missions
 or t.baseline_sha<>'0015bcdb8ac9ad94b7c74d1a4cd76737903b1319' or b.model<>'gpt-5.3-codex'
 or t.contract_sha256 is distinct from b.benchmark_contract_hash or t.baseline_sha is distinct from b.baseline_sha
 or exists(select 1 from benchmark_budget_calls where account_id=a.id and (state<>'settled' or actual_tokens is null))
 or (select coalesce(sum(actual_tokens),0) from benchmark_budget_calls where account_id=a.id)<>a.spent_tokens
 or exists(select 1 from benchmark_execution_grants where account_id=a.id and deadline>now() and revoked_at is null and stopped_at is null)
 or exists(select 1 from agent_missions where project_id=p.id and status in ('running','awaiting_approval'))
 then if p_approve then raise exception 'Failed Full checkpoint is not eligible for continuation';end if;return null;end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into calls from benchmark_budget_calls x where account_id=a.id;
 snapshot:=jsonb_build_object('qualification',to_jsonb(q),'trial',to_jsonb(t),'project',to_jsonb(p),'mission',to_jsonb(m),
  'account',to_jsonb(a),'calls',calls,'drafts',(select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at,d.id),'[]') from mission_specification_drafts d where d.mission_id=m.id),'assignments',(select coalesce(jsonb_agg(to_jsonb(j) order by j.id),'[]') from mission_assignments j where j.mission_id=m.id));
 snapshot_hash:=encode(sha256(convert_to(project_canonical(snapshot),'UTF8')),'hex');
 plan:=jsonb_build_object('version',1,'issue',715,'sourceIssue',650,'projectId',p.id,'trialId',t.id,'accountId',a.id,
  'baselineSha',t.baseline_sha,'model','gpt-5.3-codex','additionalTokenCap',270000,'existingAccountTokenCap',350000,
  'existingArmUsdCents',1000,'newFunds',0,'durationSeconds',14400,'specificationTokens',90000,
  'specificationStages',jsonb_build_object('compose',30000,'review',18000,'revision',24000,'reviewAgain',18000),
  'developmentTokens',120000,'assessmentTokens',60000,'sourceSnapshotHash',snapshot_hash,
  'frozenRequirements',true,'repeatResearch',false,'scopeApprovalRequired',true,'taskApprovalRequired',true,'productionPublication',false);
 hash:=encode(sha256(convert_to(project_canonical(plan),'UTF8')),'hex');
 if p_approve then
  if p_project is distinct from p.id or p_plan_hash is distinct from hash then raise exception 'Review current continuation plan';end if;
  insert into benchmark_full_continuations(owner_id,project_id,trial_id,account_id,source_mission_id,source_snapshot,source_snapshot_hash,
   plan,plan_hash,spent_at_approval,additional_token_cap,deadline)
  values(p_owner,p.id,t.id,a.id,m.id,snapshot,snapshot_hash,plan,hash,a.spent_tokens,270000,now()+interval '4 hours') returning * into c;
  -- Same project, newly authorized phase; historical mission and deadlines stay intact.
  update work_projects set status='running',active_mission_id=null,lease=null,lease_until=null,
   detail='Owner authorized a bounded continuation from the saved failed specification. Original benchmark failure and charges are preserved.',updated_at=now() where id=p.id;
  insert into project_events(project_id,event,data) values(p.id,'benchmark_owner_continuation_approved',jsonb_build_object(
   'continuationId',c.id,'planHash',hash,'sourceSnapshotHash',snapshot_hash,'owner',p_owner,'sourceMission',m.id,
   'spentTokens',a.spent_tokens,'additionalTokenCap',270000,'deadline',c.deadline,'originalBenchmarkOutcomePreserved',true));
 end if;
 return jsonb_build_object('approved',p_approve,'id',c.id,'projectId',p.id,'trialId',t.id,'accountId',a.id,
  'deadline',c.deadline,'planHash',hash,'plan',plan,'spentTokens',a.spent_tokens,'live',p_approve,'sourceSnapshotHash',snapshot_hash);
end $$;
revoke all on function benchmark_dashboard_continuation(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function benchmark_dashboard_continuation(uuid,uuid,text,boolean) to service_role;

-- Preserve original trial result and expired qualification after owner approval.
create function benchmark_failed_trial_immutable() returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if exists(select 1 from benchmark_full_continuations where trial_id=old.id) then raise exception 'Original benchmark trial is immutable after continuation';end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger benchmark_failed_trial_immutable before update or delete on benchmark_three_arm_trials
 for each row execute function benchmark_failed_trial_immutable();
revoke all on function benchmark_failed_trial_immutable() from public,anon,authenticated;

create or replace function benchmark_production_call_guard() returns trigger
language plpgsql security invoker set search_path=public as $$
declare a benchmark_budget_accounts; q benchmark_production_qualifications; c benchmark_full_continuations;
 price model_registry; held bigint; used_phase bigint; phase_cap integer; m agent_missions; j mission_assignments;
begin
 select * into a from benchmark_budget_accounts where id=new.account_id for update;
 if exists(select 1 from benchmark_production_transfer_claims where experiment_id=a.experiment_id) then raise exception 'Staging allowance has transferred';end if;
 select * into q from benchmark_production_qualifications where experiment_id=a.experiment_id;
 if not found then
  if new.continuation_id is not null then raise exception 'Continuation requires production qualification';end if;
  return new;
 end if;
 select * into c from benchmark_full_continuations where account_id=a.id;
 if c.id is not null then
  if new.continuation_id is distinct from c.id or not benchmark_continuation_live(c.id,a.id,c.project_id)
  then raise exception 'Exact live continuation required';end if;
  select job.* into j from mission_assignments job join mission_calls mc on mc.job_id=job.id
   where mc.id::text=coalesce(new.legacy_mission_call_id::text,new.request_key);
  select * into m from agent_missions where id=j.mission_id;
  if m.id is null or m.id=c.source_mission_id or m.project_id is distinct from c.project_id
   or m.project_evidence->>'benchmarkContinuationId' is distinct from c.id::text
   or m.created_at<c.created_at or m.status<>'running' or m.deadline>c.deadline or m.deadline<=now()
   or not exists(select 1 from work_projects p where p.id=c.project_id and p.status='running' and p.active_mission_id=m.id and p.deadline>now())
  then raise exception 'Continuation mission provenance denied';end if;
  phase_cap:=case m.project_kind when 'specification' then 90000 when 'development' then 120000 when 'assessment' then 60000 else 0 end;
  if phase_cap=0 or m.token_allowance>phase_cap then raise exception 'Continuation phase allowance denied';end if;
  select coalesce(sum(case when bc.state='settled' then coalesce(bc.actual_tokens,bc.reserved_tokens) else greatest(bc.reserved_tokens,coalesce(bc.actual_tokens,0)) end),0)
   into used_phase from benchmark_budget_calls bc
   join mission_calls mc on mc.id::text=coalesce(bc.legacy_mission_call_id::text,bc.request_key)
   join mission_assignments mj on mj.id=mc.job_id join agent_missions mm on mm.id=mj.mission_id
   where bc.continuation_id=c.id and mm.project_kind=m.project_kind;
  if used_phase+new.reserved_tokens>phase_cap then raise exception 'Continuation phase ceiling exhausted';end if;
 elsif new.continuation_id is not null or q.deadline<=now() then raise exception 'Production qualification expired';end if;
 select * into price from model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 if q.revoked_at is not null or a.frozen_at is not null or a.cap_tokens<>350000 or
  new.model not in ('gpt-5.3-codex','openai:gpt-5.3-codex') or new.reserved_tokens is null or new.reserved_tokens<=0 or
  price.model_id is null or price.pricing_status<>'verified' or price.pricing_verified_at is null or price.pricing_verified_at<now()-interval '24 hours' or
  price.pricing_input_per_1m is null or price.pricing_output_per_1m is null or price.pricing_input_per_1m<=0 or price.pricing_output_per_1m<=0 or
  price.pricing_input_per_1m>28 or price.pricing_output_per_1m>28 or
  exists(select 1 from benchmark_budget_calls where account_id=a.id and state in ('unresolved','overrun'))
 then raise exception 'Production benchmark admission denied';end if;
 select coalesce(sum(reserved_tokens),0) into held from benchmark_budget_calls where account_id=a.id and state='reserved';
 if a.spent_tokens+held+new.reserved_tokens>350000 or
  (c.id is not null and a.spent_tokens-c.spent_at_approval+held+new.reserved_tokens>c.additional_token_cap)
 then raise exception 'Production benchmark budget exhausted';end if;
 return new;
end $$;

-- Patch the existing execution path; no alternative orchestrator is introduced.
DO $patch$
declare body text; old text;
begin
 select pg_get_functiondef('benchmark_reserve_mission_call(uuid,uuid,uuid,text,integer,boolean)'::regprocedure) into body;
 old:=$s$t.state not in ('qualified','running')$s$;
 if position(old in body)=0 then raise exception 'Expected Full admission trial gate missing';end if;
 body:=replace(body,old,$s$(t.state not in ('qualified','running') and not benchmark_continuation_live(nullif(m.project_evidence->>'benchmarkContinuationId','')::uuid,a.id,p.id))$s$);
 body:=replace(body,'benchmark_budget_calls(account_id,request_key,model,reserved_tokens)',
  'benchmark_budget_calls(account_id,request_key,model,reserved_tokens,continuation_id)');
 body:=replace(body,'values(a.id,p_call::text,p_model,p_tokens)',
  $s$values(a.id,p_call::text,p_model,p_tokens,nullif(m.project_evidence->>'benchmarkContinuationId','')::uuid)$s$);
 execute body;

 select pg_get_functiondef('benchmark_dashboard_full_task(uuid,uuid,text,boolean)'::regprocedure) into body;
 body:=replace(body,'protocol_text text;','protocol_text text; cont benchmark_full_continuations;');
 body:=replace(body,'or q.deadline<=now() then',$s$then$s$);
 old:='select * into p from work_projects where id=b.project_id for update;';
 if position(old in body)=0 then raise exception 'Expected dashboard project gate missing';end if;
 body:=replace(body,old,old||$s$
 select * into cont from benchmark_full_continuations where project_id=p.id;
 if cont.id is not null then
  if not benchmark_continuation_live(cont.id,b.account_id,p.id) then raise exception 'Continuation expired or revoked';end if;
  q.deadline:=cont.deadline;
 elsif q.deadline<=now() then raise exception 'Qualification expired';end if;
$s$);
 body:=replace(body,$s$t.state not in ('qualified','running')$s$,$s$(t.state not in ('qualified','running') and cont.id is null)$s$);
 body:=replace(body,$s$not benchmark_full_task_provenance(task.id,p.id) or$s$,$s$(cont.id is not null and (m.project_evidence->>'benchmarkContinuationId' is distinct from cont.id::text or m.id=cont.source_mission_id)) or not benchmark_full_task_provenance(task.id,p.id) or$s$);
 body:=replace(body,'if approval.owner_id is distinct from p_owner or','if approval.continuation_id is distinct from cont.id or approval.owner_id is distinct from p_owner or');
 body:=replace(body,'deadline,project_id,mission_assignment_id,task_id)', 'deadline,project_id,mission_assignment_id,task_id,continuation_id)');
 body:=replace(body,'p.id,j.id,task.id) returning','p.id,j.id,task.id,cont.id) returning');
 body:=replace(body,$s$'trialId',t.id,'model'$s$,$s$'continuationId',cont.id,'trialId',t.id,'model'$s$);
 execute body;

 select pg_get_functiondef('benchmark_bind_full_development_dispatch(uuid,uuid,text,text)'::regprocedure) into body;
 old:=$s$if not found or approval.owner_id is null or$s$;
 if position(old in body)=0 then raise exception 'Expected dispatch approval gate missing';end if;
 body:=replace(body,old,$s$if not found or approval.continuation_id::text is distinct from m.project_evidence->>'benchmarkContinuationId' or
 (approval.continuation_id is not null and not benchmark_continuation_live(approval.continuation_id,a.id,p.id)) or approval.owner_id is null or$s$);
 body:=replace(body,$s$'approval_id',approval.id,$s$,$s$'continuation_id',approval.continuation_id,'approval_id',approval.id,$s$);
 execute body;

 select pg_get_functiondef('benchmark_issue_execution_grant(uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)'::regprocedure) into body;
 body:=replace(body,E'begin\n',E'begin\n perform pg_advisory_xact_lock(hashtextextended(''katie.mission.state'',0));\n');
 body:=replace(body,$s$t.state not in ('qualified','running')$s$,$s$(t.state not in ('qualified','running') and not benchmark_continuation_live(a.continuation_id,acc.id,a.project_id))$s$);
 old:=$s$if acc.cap_tokens>a.max_tokens$s$;
 if position(old in body)=0 then raise exception 'Expected grant ceiling gate missing';end if;
 body:=replace(body,old,$s$if exists(select 1 from benchmark_full_continuations where account_id=acc.id) and a.continuation_id is null then raise exception 'Original authority cannot authorize continuation';end if;
 if a.continuation_id::text is distinct from m.project_evidence->>'benchmarkContinuationId' then raise exception 'Grant continuation identity mismatch';end if;
 if a.continuation_id is not null and (not benchmark_continuation_live(a.continuation_id,acc.id,a.project_id) or p_deadline>(select deadline from benchmark_full_continuations where id=a.continuation_id)) then raise exception 'Grant continuation denied';end if;
 if acc.cap_tokens>a.max_tokens$s$);
 body:=replace(body,'deadline,project_id,mission_assignment_id)', 'deadline,project_id,mission_assignment_id,continuation_id)');
 body:=replace(body,'p_deadline,a.project_id,a.mission_assignment_id)', 'p_deadline,a.project_id,a.mission_assignment_id,a.continuation_id)');
 body:=replace(body,$s$where id=t.id and state='qualified';$s$,$s$where id=t.id and state='qualified' and a.continuation_id is null;$s$);
 execute body;

 select pg_get_functiondef('benchmark_full_native_reserve(text,uuid,bigint,text,text,bigint)'::regprocedure) into body;
 body:=replace(body,$s$t.state<>'running'$s$,$s$(t.state<>'running' and not benchmark_continuation_live(g.continuation_id,g.account_id,g.project_id))$s$);
 old:='select * into p from public.work_projects where id=g.project_id for update;';
 if position(old in body)=0 then raise exception 'Expected native parent gate missing';end if;
 body:=replace(body,old,$s$if g.continuation_id::text is distinct from m.project_evidence->>'benchmarkContinuationId' then raise exception 'Native continuation identity mismatch';end if;
$s$||old);
 body:=replace(body,'reserved_tokens,legacy_mission_call_id)', 'reserved_tokens,legacy_mission_call_id,continuation_id)');
 body:=replace(body,'p_tokens,mission_call)', 'p_tokens,mission_call,g.continuation_id)');
 execute body;
end $patch$;

create or replace function benchmark_gateway_execution_live(p_digest text,p_trial uuid,p_epoch bigint)
returns boolean language sql security invoker set search_path=public as $$
 select exists(select 1 from benchmark_execution_grants g join benchmark_three_arm_trials t on t.id=g.trial_id
 where g.token_digest=p_digest and g.trial_id=p_trial and g.execution_epoch=p_epoch
 and g.revoked_at is null and g.stopped_at is null and g.deadline>now()
 and ((g.continuation_id is null and t.state='running' and not exists(select 1 from benchmark_full_continuations c where c.trial_id=t.id))
 or (g.continuation_id is not null and benchmark_continuation_live(g.continuation_id,g.account_id,g.project_id))));
$$;
