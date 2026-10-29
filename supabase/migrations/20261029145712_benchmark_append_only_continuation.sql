-- Append-only owner renewal: no deadline, charge, trial, or failed attempt is reset.
alter table public.benchmark_full_continuations
 add column previous_continuation_id uuid unique references public.benchmark_full_continuations(id),
 drop constraint benchmark_full_continuations_project_id_key,
 drop constraint benchmark_full_continuations_trial_id_key,
 drop constraint benchmark_full_continuations_account_id_key,
 drop constraint benchmark_full_continuations_additional_token_cap_check,
 add constraint benchmark_continuation_bounded_plan check (
  (previous_continuation_id is null and additional_token_cap=270000) or
  (previous_continuation_id is not null and additional_token_cap=240000));
create unique index benchmark_continuation_original_project on benchmark_full_continuations(project_id) where previous_continuation_id is null;
create unique index benchmark_continuation_original_trial on benchmark_full_continuations(trial_id) where previous_continuation_id is null;
create unique index benchmark_continuation_original_account on benchmark_full_continuations(account_id) where previous_continuation_id is null;

alter function public.benchmark_dashboard_continuation(uuid,uuid,text,boolean) rename to benchmark_dashboard_continuation_original;
revoke all on function public.benchmark_dashboard_continuation_original(uuid,uuid,text,boolean) from public,anon,authenticated;

create function public.benchmark_dashboard_continuation(p_owner uuid,p_project uuid default null,p_plan_hash text default null,p_approve boolean default false)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare q benchmark_production_qualifications; b benchmark_full_project_bindings; p work_projects; m agent_missions;
 a benchmark_budget_accounts; t benchmark_three_arm_trials; c benchmark_full_continuations; prior benchmark_full_continuations;
 source mission_assignments; snapshot jsonb; plan jsonb; hash text; snapshot_hash text; original jsonb; eligible boolean;
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
 select * into prior from benchmark_full_continuations where project_id=p.id order by created_at desc,id desc limit 1;
 if prior.id is null then return benchmark_dashboard_continuation_original(p_owner,p_project,p_plan_hash,p_approve);end if;
 original:=jsonb_build_object('approved',true,'id',prior.id,'projectId',prior.project_id,'trialId',prior.trial_id,'accountId',prior.account_id,
  'deadline',prior.deadline,'planHash',prior.plan_hash,'plan',prior.plan,'spentTokens',a.spent_tokens,
  'live',benchmark_continuation_live(prior.id,prior.account_id,prior.project_id),'sourceSnapshotHash',prior.source_snapshot_hash);
 if prior.deadline>now() or (p_approve and p_project=prior.project_id and p_plan_hash=prior.plan_hash) then
  if p_approve and (p_project is distinct from prior.project_id or p_plan_hash is distinct from prior.plan_hash) then raise exception 'Continuation identity differs';end if;
  return original;
 end if;
 select * into m from agent_missions where id=p.active_mission_id for update;
 select * into source from mission_assignments where mission_id=m.id and role in ('compose','revise') and status='completed'
  and jsonb_typeof(result->'text')='string' order by updated_at desc,created_at desc,id desc limit 1 for update;
 eligible:=p.phase='specification' and p.status in ('blocked','paused','failed') and m.id is not null and m.status in ('blocked','stopped')
 and m.project_id=p.id and m.project_kind='specification' and m.project_evidence->>'benchmarkContinuationId'=prior.id::text
 and source.id is not null and p.approved_hash is null and p.approval_hash is null
 and p.actor_id=q.actor_id and p.deadline>now()+interval '4 hours' and (p.lease is null or p.lease_until<=now())
 and a.arm='full' and a.trial_id=t.id and a.owner_actor_id=q.actor_id and a.cap_tokens=350000 and a.frozen_at is null
 and a.spent_tokens+240000<=350000 and p.token_allowance<=350000
 and (select coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0) from agent_missions where project_id=p.id)+240000<=p.token_allowance
 and (select count(*) from project_runs where project_id=p.id)+3<=p.max_missions
 and t.baseline_sha='0015bcdb8ac9ad94b7c74d1a4cd76737903b1319' and b.model='gpt-5.3-codex'
 and t.contract_sha256=b.benchmark_contract_hash and t.baseline_sha=b.baseline_sha
 and not exists(select 1 from benchmark_budget_calls where account_id=a.id and (state<>'settled' or actual_tokens is null))
 and (select coalesce(sum(actual_tokens),0) from benchmark_budget_calls where account_id=a.id)=a.spent_tokens
 and not exists(select 1 from benchmark_execution_grants where account_id=a.id and deadline>now() and revoked_at is null and stopped_at is null)
 and not exists(select 1 from agent_missions where project_id=p.id and status in ('running','awaiting_approval'));
 if eligible is distinct from true then
  if p_approve then raise exception 'Failed Full checkpoint is not eligible for renewal';end if;return original;
 end if;
 -- JSON provenance is checked here; the ordinary worker still runs the complete
 -- canonical validator before reuse. Compose has zero paid allowance.
 begin
  if jsonb_typeof((source.result->>'text')::jsonb->'game') is distinct from 'object'
   or jsonb_typeof((source.result->>'text')::jsonb->'milestones') is distinct from 'array'
   or jsonb_array_length((source.result->>'text')::jsonb->'milestones') is distinct from 1 then
   raise exception 'One retained game milestone required';end if;
 exception when others then
  if p_approve then raise exception 'Retained candidate cannot authorize this renewal';end if;return original;
 end;
 snapshot:=jsonb_build_object('qualification',to_jsonb(q),'trial',to_jsonb(t),'project',to_jsonb(p),'mission',to_jsonb(m),
  'account',to_jsonb(a),'previousContinuation',to_jsonb(prior),
  'calls',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from benchmark_budget_calls x where account_id=a.id),
  'drafts',(select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at,d.id),'[]') from mission_specification_drafts d where d.mission_id=m.id),
  'assignments',(select coalesce(jsonb_agg(to_jsonb(j) order by j.id),'[]') from mission_assignments j where j.mission_id=m.id));
 snapshot_hash:=encode(sha256(convert_to(project_canonical(snapshot),'UTF8')),'hex');
 plan:=jsonb_build_object('version',2,'issue',715,'sourceIssue',650,'projectId',p.id,'trialId',t.id,'accountId',a.id,
  'previousContinuationId',prior.id,'baselineSha',t.baseline_sha,'model','gpt-5.3-codex','additionalTokenCap',240000,
  'existingAccountTokenCap',350000,'remainingAccountTokens',350000-a.spent_tokens,'existingArmUsdCents',1000,'newFunds',0,
  'durationSeconds',14400,'specificationTokens',60000,
  'specificationStages',jsonb_build_object('compose',0,'review',18000,'revision',24000,'reviewAgain',18000),
  'developmentTokens',120000,'assessmentTokens',60000,'sourceSnapshotHash',snapshot_hash,
  'savedSpecificationCheckpoint',jsonb_build_object('sourceJobId',source.id,'sourceMissionId',m.id,'status','unreviewed',
    'fullSpecificationHash',encode(sha256(convert_to(project_canonical((source.result->>'text')::jsonb),'UTF8')),'hex')),
  'maximumRevisionJobs',1,'frozenRequirements',true,'repeatResearch',false,'regenerateSpecification',false,
  'scopeApprovalRequired',true,'taskApprovalRequired',true,'productionPublication',false);
 hash:=encode(sha256(convert_to(project_canonical(plan),'UTF8')),'hex');
 if p_approve then
  if p_project is distinct from p.id or p_plan_hash is distinct from hash then raise exception 'Review current continuation plan';end if;
  insert into benchmark_full_continuations(owner_id,project_id,trial_id,account_id,source_mission_id,source_snapshot,source_snapshot_hash,
   plan,plan_hash,spent_at_approval,additional_token_cap,deadline,previous_continuation_id)
  values(p_owner,p.id,t.id,a.id,m.id,snapshot,snapshot_hash,plan,hash,a.spent_tokens,240000,now()+interval '4 hours',prior.id) returning * into c;
  update work_projects set status='running',active_mission_id=null,lease=null,lease_until=null,
   detail='Owner approved continuation from retained specification. Earlier deadlines, failures and charges remain unchanged.',updated_at=now() where id=p.id;
  insert into project_events(project_id,event,data) values(p.id,'benchmark_owner_continuation_approved',jsonb_build_object(
   'continuationId',c.id,'previousContinuationId',prior.id,'planHash',hash,'sourceSnapshotHash',snapshot_hash,'owner',p_owner,
   'sourceMission',m.id,'spentTokens',a.spent_tokens,'additionalTokenCap',240000,'deadline',c.deadline,'originalBenchmarkOutcomePreserved',true));
 end if;
 return jsonb_build_object('approved',p_approve,'id',c.id,'projectId',p.id,'trialId',t.id,'accountId',a.id,
  'deadline',c.deadline,'planHash',hash,'plan',plan,'spentTokens',a.spent_tokens,'live',p_approve,'sourceSnapshotHash',snapshot_hash);
end $$;
revoke all on function public.benchmark_dashboard_continuation(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.benchmark_dashboard_continuation(uuid,uuid,text,boolean) to service_role;

-- Resolve the newest authorization everywhere a former unique key was used.
do $patch$
declare body text; signature text;
begin
 foreach signature in array array[
  'public.benchmark_production_call_guard()', 'public.benchmark_dashboard_full_task(uuid,uuid,text,boolean)',
  'public.recover_specification_route(uuid,uuid,text,jsonb,text,jsonb)',
  'public.recover_verified_price_review(uuid)', 'public.recover_uncharged_continuation_specification(uuid)',
  'public.recover_mission_credit_failure(uuid)'] loop
  if to_regprocedure(signature) is null then
   if signature in ('public.benchmark_production_call_guard()','public.benchmark_dashboard_full_task(uuid,uuid,text,boolean)') then raise exception 'Required continuation guard missing: %',signature;end if;
   continue;
  end if;
  select pg_get_functiondef(signature::regprocedure) into body;
  body:=replace(body,'from benchmark_full_continuations where project_id=p.id;',
   'from benchmark_full_continuations where project_id=p.id order by created_at desc,id desc limit 1;');
  body:=replace(body,'from benchmark_full_continuations where account_id=a.id;',
   'from benchmark_full_continuations where account_id=a.id order by created_at desc,id desc limit 1;');
  body:=replace(body,$anchor$phase_cap:=case m.project_kind when 'specification' then 90000 when 'development' then 120000 when 'assessment' then 60000 else 0 end;$anchor$,
   $anchor$phase_cap:=case m.project_kind when 'specification' then (c.plan->>'specificationTokens')::integer when 'development' then (c.plan->>'developmentTokens')::integer when 'assessment' then (c.plan->>'assessmentTokens')::integer else 0 end;$anchor$);
  if signature='public.benchmark_production_call_guard()' then
   body:=replace(body,'phase_cap integer;', 'phase_cap integer; stage_cap integer; used_stage bigint;');
   body:=replace(body,'  if phase_cap=0 or m.token_allowance>phase_cap', $inject$
  if m.project_kind='specification' then
   stage_cap:=coalesce((c.plan->'specificationStages'->>(case when j.role='compose' then 'compose' when j.role='revise' then 'revision' when j.job_key='review_again' then 'reviewAgain' when j.role='review' then 'review' else '' end))::integer,0);
   select coalesce(sum(case when bc.state='settled' then coalesce(bc.actual_tokens,bc.reserved_tokens) else greatest(bc.reserved_tokens,coalesce(bc.actual_tokens,0)) end),0)
    into used_stage from benchmark_budget_calls bc join mission_calls mc on mc.id::text=coalesce(bc.legacy_mission_call_id::text,bc.request_key)
    join mission_assignments sj on sj.id=mc.job_id
    where bc.continuation_id=c.id and sj.job_key=j.job_key;
   if stage_cap<=0 or used_stage+new.reserved_tokens>stage_cap then raise exception 'Continuation stage ceiling exhausted';end if;
  end if;
  if phase_cap=0 or m.token_allowance>phase_cap$inject$);
  end if;
  execute body;
 end loop;
 select pg_get_functiondef('public.finish_work_project(uuid,uuid,text,jsonb)'::regprocedure) into body;
 if position('spec_required:=90000;spec_future:=180000;' in body)=0 or position('p.token_allowance-spec_spent<270000' in body)=0 then raise exception 'Expected continuation scheduler missing';end if;
 body:=replace(body,'spec_required:=90000;spec_future:=180000;',
  $anchor$spec_required:=(spec_cont.plan->>'specificationTokens')::integer;spec_future:=(spec_cont.plan->>'developmentTokens')::integer+(spec_cont.plan->>'assessmentTokens')::integer;$anchor$);
 body:=replace(body,'p.token_allowance-spec_spent<270000','p.token_allowance-spec_spent<spec_required+spec_future');
 body:=replace(body,$anchor$'missionTokens',90000,'futureTokens',180000$anchor$,$anchor$'missionTokens',spec_required,'futureTokens',spec_future$anchor$);
 body:=replace(body,$anchor$token_allowance=case project_kind when 'specification' then 90000 when 'development' then 120000 when 'assessment' then 60000 else token_allowance end$anchor$,
  $anchor$token_allowance=case project_kind when 'specification' then (spec_cont.plan->>'specificationTokens')::integer when 'development' then (spec_cont.plan->>'developmentTokens')::integer when 'assessment' then (spec_cont.plan->>'assessmentTokens')::integer else token_allowance end$anchor$);
 body:=replace(body,$anchor$   spec_required:=(spec_cont.plan->>'specificationTokens')::integer;$anchor$,$inject$
   if spec_cont.previous_continuation_id is not null then
    spec_checkpoint_data:=spec_cont.plan->'savedSpecificationCheckpoint';
    select j.* into spec_source from mission_assignments j join agent_missions sm on sm.id=j.mission_id
     where j.id::text=spec_checkpoint_data->>'sourceJobId' and sm.id=spec_cont.source_mission_id
      and sm.project_id=p.id and sm.project_kind='specification' and j.status='completed' and j.role in ('compose','revise');
    if not found or encode(sha256(convert_to(project_canonical((spec_source.result->>'text')::jsonb),'UTF8')),'hex')
      is distinct from spec_checkpoint_data->>'fullSpecificationHash' then raise exception 'Renewal checkpoint changed';end if;
    payload:=jsonb_set(payload,'{evidence,savedSpecificationCheckpoint}',spec_checkpoint_data);
   end if;
   spec_required:=(spec_cont.plan->>'specificationTokens')::integer;$inject$);
 execute body;
 select pg_get_functiondef('public.specification_call_capacity(uuid,uuid)'::regprocedure) into body;
 if position('stage_cap:=case when j.role=''compose'' then 30000 when j.role=''revise'' then 24000 when j.role=''review'' then 18000 else 0 end;' in body)=0 then raise exception 'Expected stage capacity guard missing';end if;
 body:=replace(body,$anchor$stage_cap:=case when j.role='compose' then 30000 when j.role='revise' then 24000 when j.role='review' then 18000 else 0 end;$anchor$,$inject$
  select (c.plan->'specificationStages'->>(case when j.role='compose' then 'compose' when j.role='revise' then 'revision' when j.job_key='review_again' then 'reviewAgain' when j.role='review' then 'review' else '' end))::integer
   into stage_cap from benchmark_full_continuations c where c.id::text=m.project_evidence->>'benchmarkContinuationId';
  stage_cap:=coalesce(stage_cap,0);$inject$);
 execute body;
end $patch$;

do $patch$
declare body text;
begin
 select pg_get_functiondef('public.benchmark_continuation_live(uuid,uuid,uuid)'::regprocedure) into body;
 body:=replace(body,'where c.id=p_id and c.account_id=p_account and c.project_id=p_project and c.deadline>now()',
  'where c.id=p_id and c.account_id=p_account and c.project_id=p_project and c.deadline>now() and not exists(select 1 from benchmark_full_continuations newer where newer.previous_continuation_id=c.id)');
 execute body;
end $patch$;
