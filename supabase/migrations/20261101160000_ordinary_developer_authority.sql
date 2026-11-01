-- Ordinary Developer authority uses the existing canonical ledger, approvals,
-- grants and immutable lifecycle proposals. This migration creates NO authority.
-- Benchmark provenance remains mandatory for benchmark rows; ordinary rows have
-- an explicit project binding and cannot carry experimental provenance.
alter table benchmark_budget_accounts
 add column developer_task_id uuid references agent_tasks(id),
 add column developer_project_id uuid references work_projects(id),
 alter column experiment_id drop not null;
alter table benchmark_budget_accounts drop constraint benchmark_budget_accounts_arm_check;
alter table benchmark_budget_accounts add constraint benchmark_budget_accounts_arm_check
 check(arm in ('direct','orchestrated','native','thin','full','developer'));
alter table benchmark_budget_accounts add constraint budget_account_authority_kind check(
 (arm='developer' and developer_task_id is not null and developer_project_id is not null and trial_id is null and experiment_id is null)
 or (arm<>'developer' and developer_task_id is null and developer_project_id is null and experiment_id is not null));
create unique index developer_task_account on benchmark_budget_accounts(developer_task_id)
 where developer_task_id is not null;

alter table benchmark_native_spending_approvals
 add column developer_authority jsonb,
 add column previous_developer_approval_id uuid references benchmark_native_spending_approvals(id),
 add column developer_proposal_id text references benchmark_lifecycle_proposals(id),
 alter column trial_id drop not null;
alter table benchmark_native_spending_approvals add constraint spending_approval_authority_kind check(
 (developer_authority is null and trial_id is not null and previous_developer_approval_id is null and developer_proposal_id is null)
 or (developer_authority is not null and trial_id is null and continuation_id is null
     and project_id is not null and task_id is not null and mission_assignment_id is not null and mission_assignment_id=task_id
     and jsonb_typeof(developer_authority)='object'
     and (developer_authority->>'version') is not distinct from 'ordinary-developer-v1'));
create unique index developer_approval_single_child on benchmark_native_spending_approvals(previous_developer_approval_id)
 where previous_developer_approval_id is not null;
create unique index developer_approval_single_proposal on benchmark_native_spending_approvals(developer_proposal_id)
 where developer_proposal_id is not null;
create unique index developer_original_task_authority on benchmark_native_spending_approvals(task_id)
 where developer_authority is not null and previous_developer_approval_id is null;

alter table benchmark_execution_grants
 add column developer_approval_id uuid references benchmark_native_spending_approvals(id),
 alter column trial_id drop not null;
alter table benchmark_execution_grants add constraint execution_grant_authority_kind check(
 (developer_approval_id is null and trial_id is not null)
 or (developer_approval_id is not null and trial_id is null and continuation_id is null
     and project_id is not null and mission_assignment_id is not null));
create unique index developer_approval_single_grant on benchmark_execution_grants(developer_approval_id)
 where developer_approval_id is not null;
create unique index developer_task_execution_epoch on benchmark_execution_grants(mission_assignment_id,execution_epoch)
 where developer_approval_id is not null;

alter table benchmark_mission_bindings
 add column developer_project_id uuid references work_projects(id),
 alter column experiment_id drop not null;
alter table benchmark_mission_bindings add constraint mission_binding_authority_kind check(
 (developer_project_id is null and experiment_id is not null)
 or (developer_project_id is not null and experiment_id is null));

-- Immutability applies to authority, never to legitimate consumption/revocation.
create function developer_authority_identity_guard() returns trigger
language plpgsql security definer set search_path=public as $$
declare a benchmark_budget_accounts; p work_projects; j mission_assignments; m agent_missions;
begin
 if tg_table_name='benchmark_budget_accounts' then
  if tg_op='UPDATE' and (new.arm='developer' or old.arm='developer') and
   (new.developer_task_id is distinct from old.developer_task_id or new.arm is distinct from old.arm or new.developer_project_id is distinct from old.developer_project_id
    or new.owner_actor_id is distinct from old.owner_actor_id or new.cap_tokens is distinct from old.cap_tokens
    or new.trial_id is distinct from old.trial_id or new.experiment_id is distinct from old.experiment_id)
   then raise exception 'Original Developer account authority is immutable';end if;
  if new.arm<>'developer' then return new;end if;
  select * into p from work_projects where id=new.developer_project_id;
  if p.id is null or p.actor_id is distinct from new.owner_actor_id
   or not exists(select 1 from mission_assignments bound_job join agent_missions bound_mission on bound_mission.id=bound_job.mission_id where bound_job.id=new.developer_task_id and bound_mission.project_id=p.id and bound_job.role='development')
   or exists(select 1 from benchmark_full_project_bindings where project_id=p.id)
   then raise exception 'Ordinary project account binding denied';end if;
 elsif tg_table_name='benchmark_native_spending_approvals' then
  if tg_op='UPDATE' and (old.developer_authority is not null or new.developer_authority is not null)
   and (to_jsonb(new)-'consumed_at'-'revoked_at') is distinct from (to_jsonb(old)-'consumed_at'-'revoked_at')
   then raise exception 'Developer approval history is immutable';end if;
  select * into a from benchmark_budget_accounts where id=new.account_id;
  if (new.developer_authority is not null) is distinct from (a.arm='developer') then
   raise exception 'Approval/account authority kind differs';end if;
  if new.developer_authority is null then return new;end if;
  if tg_op='UPDATE' and ((old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) or (old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at)) then raise exception 'Developer authority cannot be reused';end if;
  select * into p from work_projects where id=new.project_id;
  select * into j from mission_assignments where id=new.task_id;
  select * into m from agent_missions where id=j.mission_id;
  if p.id is null or j.id is null or j.role<>'development' or m.project_id is distinct from p.id
   or a.developer_task_id is distinct from new.task_id or a.developer_project_id is distinct from p.id or a.owner_actor_id is distinct from new.actor_id
   or p.actor_id is distinct from new.actor_id or p.chat_id is distinct from new.chat_id
   or new.developer_authority->>'scopeHash' is distinct from p.approved_hash
   or p.approved_hash is null or p.approval_hash is distinct from p.approved_hash
   then raise exception 'Ordinary approval task/scope binding denied';end if;
 elsif tg_table_name='benchmark_execution_grants' then
  select * into a from benchmark_budget_accounts where id=new.account_id;
  if (new.developer_approval_id is not null) is distinct from (a.arm='developer') then
   raise exception 'Grant/account authority kind differs';end if;
  if new.developer_approval_id is null then return new;end if;
  if tg_op='UPDATE' and ((old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) or (old.stopped_at is not null and new.stopped_at is distinct from old.stopped_at)) then raise exception 'Developer execution cannot be reactivated';end if;
  if not exists(select 1 from benchmark_native_spending_approvals s where s.id=new.developer_approval_id
    and s.developer_authority is not null and s.account_id=new.account_id and s.task_id=new.mission_assignment_id
    and s.project_id=new.project_id and s.actor_id=new.owner_actor_id and s.protocol_digest=new.protocol_digest
    and s.repository=new.repository and s.model=new.model and s.deadline>=new.deadline)
   then raise exception 'Ordinary execution grant binding denied';end if;
  if tg_op='UPDATE' and (to_jsonb(new)-'stopped_at'-'revoked_at') is distinct from (to_jsonb(old)-'stopped_at'-'revoked_at')
   then raise exception 'Developer execution grant identity is immutable';end if;
 else
  if tg_op='UPDATE' and (old.developer_project_id is not null or new.developer_project_id is not null)
   and to_jsonb(new) is distinct from to_jsonb(old) then raise exception 'Developer mission accounting binding is immutable';end if;
  select * into a from benchmark_budget_accounts where id=new.account_id;
  if (new.developer_project_id is not null) is distinct from (a.arm='developer') then
   raise exception 'Mission/account authority kind differs';end if;
  if new.developer_project_id is not null and (new.developer_project_id is distinct from a.developer_project_id
    or not exists(select 1 from agent_missions where id=new.mission_id and project_id=new.developer_project_id))
   then raise exception 'Ordinary mission binding denied';end if;
 end if;
 return new;
end $$;
create trigger developer_account_identity before insert or update on benchmark_budget_accounts
 for each row execute function developer_authority_identity_guard();
create trigger developer_approval_identity before insert or update on benchmark_native_spending_approvals
 for each row execute function developer_authority_identity_guard();
create trigger developer_grant_identity before insert or update on benchmark_execution_grants
 for each row execute function developer_authority_identity_guard();
create trigger developer_mission_identity before insert or update on benchmark_mission_bindings
 for each row execute function developer_authority_identity_guard();
revoke all on function developer_authority_identity_guard() from public,anon,authenticated,service_role;

-- Ordinary task ownership is derived from the original project's verified owner
-- binding, not the managed developer actor or caller-supplied actor/chat strings.
create function developer_task_binding(p_owner uuid,p_task uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare t agent_tasks;j mission_assignments;m agent_missions;p work_projects;r project_runs;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into t from agent_tasks where id=p_task for update;
 select * into j from mission_assignments where id=p_task for update;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into p from work_projects where id=m.project_id for update;
 select * into r from project_runs where project_id=p.id and mission_id=m.id;
 if p_owner is null or t.id is null or j.id is null or p.id is null or r.id is null
  or t.kind<>'development' or j.role<>'development' or m.project_kind<>'development'
  or t.agent_id is distinct from j.agent_id or t.repository_id is distinct from p.repository_id
  or p.active_mission_id is distinct from m.id or p.phase<>'development'
  or p.status in ('completed','stopped','failed') or m.status in ('completed','stopped')
  or p.approved_hash is null or p.approval_hash is distinct from p.approved_hash
  or r.binding->>'scopeHash' is distinct from p.approved_hash
  or r.binding->>'projectId' is distinct from p.id::text
  or r.binding->>'baselineSha' is distinct from p.baseline_sha
  or coalesce(r.binding->>'contractHash','') !~ '^[a-f0-9]{64}$'
  or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
  or exists(select 1 from benchmark_full_project_bindings where project_id=p.id)
  or exists(select 1 from benchmark_development_dispatches where task_id=t.id)
  then raise exception 'Ordinary Developer owner/task/scope binding denied';end if;
 return jsonb_build_object('task',to_jsonb(t),'assignment',to_jsonb(j),'mission',to_jsonb(m),
  'project',to_jsonb(p),'binding',r.binding,'ownerId',p_owner);
end $$;

create function developer_validate_limits(p_limits jsonb) returns boolean
language plpgsql immutable set search_path=public as $$
declare k text;
begin
 if jsonb_typeof(p_limits) is distinct from 'object' then return false;end if;
 foreach k in array array['cumulativeTokens','developmentTokens','developmentCalls','completionTokens','completionCalls','assessmentTokens','assessmentCalls','durationSeconds'] loop
  if coalesce(p_limits->>k,'') !~ '^[0-9]{1,12}$' then return false;end if;
 end loop;
 foreach k in array array['perCallMicrousd','ceilingMicrousd'] loop
  if coalesce(p_limits->>k,'') !~ '^[0-9]{1,12}(\.[0-9]{1,12})?$' then return false;end if;
 end loop;
 if (select count(*) from jsonb_object_keys(p_limits))<>10 then return false;end if;
 return (p_limits->>'cumulativeTokens')::bigint between 1 and 10000000
  and (p_limits->>'developmentTokens')::bigint between 1 and (p_limits->>'cumulativeTokens')::bigint
  and (p_limits->>'completionTokens')::bigint between 1 and (p_limits->>'developmentTokens')::bigint
  and (p_limits->>'assessmentTokens')::bigint between 1 and (p_limits->>'cumulativeTokens')::bigint
  and (p_limits->>'completionTokens')::bigint+(p_limits->>'assessmentTokens')::bigint<=(p_limits->>'cumulativeTokens')::bigint
  and (p_limits->>'developmentCalls')::bigint between 1 and 10000
  and (p_limits->>'completionCalls')::bigint between 1 and (p_limits->>'developmentCalls')::bigint
  and (p_limits->>'assessmentCalls')::bigint between 1 and 10000
  and (p_limits->>'perCallMicrousd')::numeric>0
  and (p_limits->>'ceilingMicrousd')::numeric>=(p_limits->>'perCallMicrousd')::numeric
  and (p_limits->>'durationSeconds')::bigint between 60 and 31536000;
end $$;

-- Original native authority is an explicit owner decision, never a conversion
-- of a historical coding approval. Legacy unmetered attempts cannot enroll.
create function developer_initial_snapshot(p_owner uuid,p_task uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s jsonb; t agent_tasks; j mission_assignments; p work_projects; used bigint;
begin
 s:=developer_task_binding(p_owner,p_task);
 select * into t from agent_tasks where id=p_task;
 select * into j from mission_assignments where id=p_task;
 select * into p from work_projects where id=(s->'project'->>'id')::uuid;
 if exists(select 1 from benchmark_native_spending_approvals where task_id=p_task)
  or exists(select 1 from benchmark_budget_accounts where developer_task_id=p_task)
  or exists(select 1 from benchmark_budget_accounts a join benchmark_budget_calls c on c.account_id=a.id where a.developer_project_id=p.id and c.state<>'settled')
  or exists(select 1 from mission_calls c join mission_assignments a on a.id=c.job_id where a.mission_id=j.mission_id)
  or coalesce(t.external->>'attempted','false')<>'false'
  or t.external ?| array['receipt','runId','issueNumber','prNumber','dispatchStartedAt']
  or coalesce((s->'mission'->>'calls')::integer,0)<>0
  or coalesce((s->'mission'->>'routing_calls')::integer,0)<>0
  or coalesce((s->'mission'->>'reserved_tokens')::bigint,0)<>0
  or coalesce((s->'mission'->>'actual_tokens')::bigint,0)<>0
  then raise exception 'Initial authority requires verified zero native history';end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into used from agent_missions where project_id=p.id;
 s:=s||jsonb_build_object('projectEncumberedTokens',used,'authorityKind','ordinary-developer','nativeAuthorityEstablished',false,
  'ownerBinding',(select to_jsonb(b) from standalone_owner_bindings b where b.owner_id=p_owner and b.actor_id=p.actor_id and b.chat_id=p.chat_id));
 return jsonb_build_object('snapshot',s,'snapshotHash',encode(sha256(convert_to(project_canonical(s),'UTF8')),'hex'));
end $$;
revoke all on function developer_task_binding(uuid,uuid),developer_initial_snapshot(uuid,uuid),developer_validate_limits(jsonb) from public,anon,authenticated,service_role;
grant execute on function developer_initial_snapshot(uuid,uuid) to service_role;

create function developer_offer_initial(p_owner uuid,p_task uuid,p_limits jsonb,p_model text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s jsonb; p jsonb; offer benchmark_lifecycle_proposals; identity text; expires timestamptz;
begin
 s:=developer_initial_snapshot(p_owner,p_task);
 if not developer_validate_limits(p_limits) or p_model<>'gpt-5.3-codex'
  or (p_limits->>'cumulativeTokens')::bigint>(s->'snapshot'->'project'->>'token_allowance')::bigint-(s->'snapshot'->>'projectEncumberedTokens')::bigint
  or (p_limits->>'developmentTokens')::bigint>(s->'snapshot'->'mission'->>'token_allowance')::bigint
  then raise exception 'Initial resource proposal exceeds existing project token authority';end if;
 -- These are explicit proposed native/$ authority, not inherited permissions.
 p:=jsonb_build_object('version','ordinary-native-authorization-v1','kind','proposal_not_authorization',
  'binding',(s->'snapshot'->'binding')||jsonb_build_object('taskId',p_task),'taskId',p_task,'ownerId',p_owner,
  'snapshotHash',s->>'snapshotHash','scope',jsonb_build_object('specification',s->'snapshot'->'project'->'spec','taskContract',s->'snapshot'->'binding'->'contract'),
  'remaining',jsonb_build_array('implementation','independent_review','repair_if_required','verification','final_review','completion','assessment'),'historicalNativeSpendingMicrousd','0',
  'current',jsonb_build_object('nativeAuthorityEstablished',false,'nativeCalls',null,'ceilingMicrousd',null,
   'executionExpiresAt',floor(extract(epoch from (s->'snapshot'->'project'->>'deadline')::timestamptz)*1000)::bigint,
   'projectTokens',s->'snapshot'->'project'->'token_allowance','projectEncumberedTokens',s->'snapshot'->'projectEncumberedTokens'),
  'proposed',p_limits,'model',p_model,'guaranteedCompletion',false,
  'monetarySemantics','ceilingMicrousd is a new cumulative maximum for the original development task, completion and assessment; it is not estimated spending',
  'scopeSemantics','Existing project scope and total project token admission remain authoritative');
 identity:=encode(sha256(convert_to(project_canonical(p),'UTF8')),'hex');
 select * into offer from benchmark_lifecycle_proposals where fingerprint=identity and task_id=p_task
  and (expires_at>clock_timestamp() or exists(select 1 from benchmark_lifecycle_decisions where proposal_id=benchmark_lifecycle_proposals.id));
 if found then return to_jsonb(offer);end if;
 expires:=least(clock_timestamp()+interval '1 hour',(s->'snapshot'->'project'->>'deadline')::timestamptz);
 if expires<=clock_timestamp() then raise exception 'Original project authorization expired';end if;
 p:=p||jsonb_build_object('expiresAt',floor(extract(epoch from expires)*1000)::bigint);
 insert into benchmark_lifecycle_proposals(id,owner_id,task_id,project_id,snapshot_hash,fingerprint,proposal,checkpoint,expires_at)
 values(encode(sha256(convert_to(project_canonical(p),'UTF8')),'hex'),p_owner,p_task,(s->'snapshot'->'project'->>'id')::uuid,
  s->>'snapshotHash',identity,p,jsonb_build_object('kind','verified-zero-native-history','baselineSha',s->'snapshot'->'binding'->>'baselineSha'),expires)
 returning * into offer;
 return to_jsonb(offer);
end $$;

-- Extend the existing decision record; legacy benchmark inserts are made
-- explicit before adding a column, preserving their exact existing semantics.
do $$ declare body text;begin
 select pg_get_functiondef('benchmark_lifecycle_decide(uuid,uuid,text,text,text)'::regprocedure) into body;
 if position('insert into benchmark_lifecycle_decisions values' in body)=0 then raise exception 'Lifecycle decision insertion anchor missing';end if;
 body:=replace(body,'insert into benchmark_lifecycle_decisions values','insert into benchmark_lifecycle_decisions(proposal_id,owner_id,decision,continuation_id,created_at) values');execute body;
end $$;
alter table benchmark_lifecycle_decisions add column developer_approval_id uuid unique references benchmark_native_spending_approvals(id);
do $$ declare item record;begin
 for item in select conname from pg_constraint where conrelid='benchmark_lifecycle_decisions'::regclass and contype='c' and pg_get_constraintdef(oid) like '%continuation_id%' loop
  execute format('alter table benchmark_lifecycle_decisions drop constraint %I',item.conname);
 end loop;
end $$;
alter table benchmark_lifecycle_decisions add constraint lifecycle_decision_authority_kind check(
 (decision='rejected' and continuation_id is null and developer_approval_id is null)
 or (decision='approved' and ((continuation_id is not null and developer_approval_id is null)
                            or (continuation_id is null and developer_approval_id is not null))));

create function developer_decide_initial(p_owner uuid,p_task uuid,p_proposal text,p_decision text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o benchmark_lifecycle_proposals; d benchmark_lifecycle_decisions;s jsonb;p work_projects;
 j mission_assignments;acct uuid;approved benchmark_native_spending_approvals;limits jsonb;deadline timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into o from benchmark_lifecycle_proposals where id=p_proposal for update;
 if o.id is null or o.owner_id is distinct from p_owner or o.task_id is distinct from p_task
  or o.proposal->>'version' is distinct from 'ordinary-native-authorization-v1'
  or p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Exact original owner proposal required';end if;
 -- Ownership is checked even for idempotent reads.
 perform developer_task_binding(p_owner,p_task);
 select * into d from benchmark_lifecycle_decisions where proposal_id=o.id;
 if found then
  if d.decision<>p_decision then raise exception 'Owner decision already committed';end if;
  return to_jsonb(d);
 end if;
 s:=developer_initial_snapshot(p_owner,p_task);
 if o.expires_at<=clock_timestamp() or o.snapshot_hash is distinct from s->>'snapshotHash'
 then raise exception 'Initial proposal expired or stale';end if;
 if p_decision='rejected' then
  insert into benchmark_lifecycle_decisions(proposal_id,owner_id,decision) values(o.id,p_owner,'rejected') returning * into d;
  insert into project_events(project_id,event,data) values(o.project_id,'lifecycle_owner_rejected',jsonb_build_object('proposalId',o.id,'taskId',p_task));
  return to_jsonb(d);
 end if;
 limits:=o.proposal->'proposed';
 if not developer_validate_limits(limits) then raise exception 'Invalid immutable original limits';end if;
 select * into p from work_projects where id=o.project_id;
 select * into j from mission_assignments where id=p_task;
 deadline:=least(p.deadline,clock_timestamp()+make_interval(secs=>(limits->>'durationSeconds')::integer));
 if deadline<=clock_timestamp() then raise exception 'Original project authority expired';end if;
 insert into benchmark_budget_accounts(experiment_id,arm,owner_actor_id,cap_tokens,developer_project_id,developer_task_id)
 values(null,'developer',p.actor_id,(limits->>'cumulativeTokens')::bigint,p.id,p_task) returning id into acct;
 insert into benchmark_mission_bindings(mission_id,account_id,experiment_id,baseline_sha,developer_project_id)
 values(j.mission_id,acct,null,p.baseline_sha,p.id);
 insert into benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority,developer_proposal_id)
 values(p_owner,p.actor_id,p.chat_id,null,acct,(s->'snapshot'->'task'->>'repository_full_name'),o.proposal->>'model',p.approved_hash,
 (limits->>'cumulativeTokens')::bigint,deadline,p.id,p_task,p_task,
 jsonb_build_object('version','ordinary-developer-v1','scopeHash',p.approved_hash,'binding',s->'snapshot'->'binding','completionContract',s->'snapshot'->'project'->'completion_contract','limits',limits,'originalTaskId',p_task,'snapshotHash',o.snapshot_hash),o.id)
 returning * into approved;
 insert into benchmark_lifecycle_decisions(proposal_id,owner_id,decision,developer_approval_id)
 values(o.id,p_owner,'approved',approved.id) returning * into d;
 insert into project_events(project_id,event,data) values(p.id,'native_resource_authorization',jsonb_build_object('ownerId',p_owner,'proposalId',o.id,'taskId',p_task,'approvalId',approved.id,'limits',limits));
 return to_jsonb(d);
end $$;
revoke all on function developer_offer_initial(uuid,uuid,jsonb,text),developer_decide_initial(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function developer_offer_initial(uuid,uuid,jsonb,text),developer_decide_initial(uuid,uuid,text,text) to service_role;

create function developer_lifecycle_snapshot(p_task uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a benchmark_native_spending_approvals;acct benchmark_budget_accounts;g benchmark_execution_grants;
 s jsonb;limits jsonb;position jsonb;snapshot jsonb;calls jsonb;exposures jsonb;grants jsonb;pricing jsonb;
 held bigint;committed numeric;outstanding numeric;counted bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into a from benchmark_native_spending_approvals x where task_id=p_task and developer_authority is not null
  and not exists(select 1 from benchmark_native_spending_approvals child where child.previous_developer_approval_id=x.id) for update;
 if a.id is null then raise exception 'Ordinary execution authority unavailable';end if;
 s:=developer_task_binding(a.owner_id,p_task);
 select * into acct from benchmark_budget_accounts where id=a.account_id for update;
 select * into g from benchmark_execution_grants where developer_approval_id=a.id;
 limits:=a.developer_authority->'limits';
 if acct.id is null or acct.arm<>'developer' or acct.developer_task_id is distinct from p_task or acct.developer_project_id is distinct from a.project_id
  or not developer_validate_limits(limits) or a.developer_authority->'binding' is distinct from s->'binding'
  or a.developer_authority->'completionContract' is distinct from s->'project'->'completion_contract'
  then raise exception 'Ordinary resource binding unavailable';end if;
 select coalesce(jsonb_agg(to_jsonb(c) order by id),'[]') into calls from benchmark_budget_calls c where account_id=acct.id;
 select coalesce(jsonb_agg(to_jsonb(e) order by call_id),'[]') into exposures from benchmark_dollar_exposures e where account_id=acct.id;
 select coalesce(jsonb_agg(to_jsonb(x)-'token_digest' order by id),'[]') into grants from benchmark_execution_grants x where account_id=acct.id;
 if jsonb_array_length(calls)>2000 or jsonb_array_length(exposures)<>jsonb_array_length(calls)
  or exists(select 1 from benchmark_budget_calls c left join benchmark_dollar_exposures e on e.call_id=c.id and e.account_id=c.account_id where c.account_id=acct.id and e.call_id is null)
  or acct.spent_tokens<>(select coalesce(sum(actual_tokens),0) from benchmark_budget_calls where account_id=acct.id and state='settled')
  then raise exception 'Ordinary accounting evidence incomplete';end if;
 select count(*) into counted from mission_calls c join mission_assignments j on j.id=c.job_id where j.mission_id=(s->'mission'->>'id')::uuid;
 if counted<>(s->'mission'->>'calls')::bigint+(s->'mission'->>'routing_calls')::bigint then raise exception 'Ordinary call counters inconsistent';end if;
 select coalesce(sum(reserved_tokens),0) into held from benchmark_budget_calls where account_id=acct.id and state in ('reserved','unresolved');
 select coalesce(sum(exposure_microusd) filter(where c.state='settled'),0),coalesce(sum(exposure_microusd) filter(where c.state<>'settled'),0)
 into committed,outstanding from benchmark_dollar_exposures e join benchmark_budget_calls c on c.id=e.call_id where e.account_id=acct.id;
 position:=jsonb_build_object('cumulativeTokens',a.max_tokens,'developmentTokens',(limits->>'developmentTokens')::bigint,
  'developmentCalls',(limits->>'developmentCalls')::integer,'completionTokens',(limits->>'completionTokens')::bigint,
  'completionCalls',(limits->>'completionCalls')::integer,'assessmentTokens',(limits->>'assessmentTokens')::bigint,
  'assessmentCalls',(limits->>'assessmentCalls')::integer,'assessmentConsumedCalls',0,
  'accountEncumberedTokens',acct.spent_tokens+held,'developmentEncumberedTokens',greatest((s->'mission'->>'actual_tokens')::bigint,(s->'mission'->>'reserved_tokens')::bigint),
  'developmentConsumedCalls',counted,'committedMicrousd',committed::text,'outstandingMicrousd',outstanding::text,
  'ceilingMicrousd',limits->>'ceilingMicrousd','expiresAt',floor(extract(epoch from least(a.deadline,(s->'project'->>'deadline')::timestamptz,g.deadline))*1000)::bigint);
 select jsonb_build_object('status',pricing_status,'source','verified_model_registry','serviceTier','default',
  'verifiedAt',floor(extract(epoch from pricing_verified_at)*1000)::bigint,'inputUsdPerMillion',pricing_input_per_1m::text,'outputUsdPerMillion',pricing_output_per_1m::text)
 into pricing from model_registry where provider_name='openai' and model_id=a.model;
 snapshot:=s||jsonb_build_object('approval',to_jsonb(a),'account',to_jsonb(acct),'calls',calls,'exposures',exposures,'grants',grants,'pricing',pricing,'position',position);
 return jsonb_build_object('authorityKind','ordinary-developer','snapshot',snapshot,
  'snapshotHash',encode(sha256(convert_to(project_canonical(snapshot),'UTF8')),'hex'),
  'ownerId',a.owner_id,'actorId',a.actor_id,'chatId',a.chat_id,'accountId',acct.id,'approvalId',a.id,'missionId',s->'mission'->>'id',
  'binding',jsonb_build_object('taskId',p_task,'projectId',a.project_id,'scopeHash',a.developer_authority->>'scopeHash','baselineSha',s->'binding'->>'baselineSha','contractHash',s->'binding'->>'contractHash'),
  'scope',jsonb_build_object('specification',s->'project'->'spec','completionContract',s->'project'->'completion_contract'),
  'acceptance',s->'binding'->'contract','position',position,'originalWindowSeconds',(limits->>'durationSeconds')::integer,
  'revoked',a.revoked_at is not null or g.revoked_at is not null,'frozen',acct.frozen_at is not null,
  'grantRenewable',g.id is not null,'model',a.model,'pricing',pricing,'exposureMicrousd',(committed+outstanding)::text);
end $$;
alter function benchmark_lifecycle_snapshot(uuid) rename to benchmark_lifecycle_snapshot_benchmark;
create function benchmark_lifecycle_snapshot(p_task uuid) returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from benchmark_native_spending_approvals where task_id=p_task and developer_authority is not null)
 then return developer_lifecycle_snapshot(p_task);end if;
 return benchmark_lifecycle_snapshot_benchmark(p_task);
end $$;
revoke all on function developer_lifecycle_snapshot(uuid),benchmark_lifecycle_snapshot_benchmark(uuid),benchmark_lifecycle_snapshot(uuid) from public,anon,authenticated,service_role;
grant execute on function benchmark_lifecycle_snapshot(uuid) to service_role;

create function developer_current_mission_authority(p_mission uuid) returns jsonb
language sql stable security definer set search_path=public as $$
 select to_jsonb(a) from benchmark_mission_bindings b
 join benchmark_budget_accounts acct on acct.id=b.account_id and acct.arm='developer'
 join agent_missions m on m.id=b.mission_id
 join work_projects p on p.id=b.developer_project_id and p.id=m.project_id
 join benchmark_native_spending_approvals a on a.account_id=acct.id and a.developer_authority is not null
 where b.mission_id=p_mission and a.revoked_at is null and acct.frozen_at is null
 and p.status='running' and m.status='running' and p.active_mission_id=m.id
 and a.deadline>now() and p.deadline>now() and a.developer_authority->>'scopeHash'=p.approved_hash
 and p.approved_hash=p.approval_hash and standalone_verify_scope(a.owner_id,p.actor_id,p.chat_id)
 and a.developer_authority->'completionContract'=p.completion_contract
 and exists(select 1 from mission_assignments original_job join project_runs original_run on original_run.mission_id=original_job.mission_id where original_job.id=a.task_id and original_run.binding=a.developer_authority->'binding')
 and not exists(select 1 from benchmark_native_spending_approvals child where child.previous_developer_approval_id=a.id)
$$;
alter function benchmark_effective_mission_allowance(uuid,uuid) rename to benchmark_effective_mission_allowance_benchmark;
create function benchmark_effective_mission_allowance(p_mission uuid,p_continuation uuid) returns bigint
language sql stable security definer set search_path=public as $$
 select coalesce((developer_current_mission_authority(p_mission)->'developer_authority'->'limits'->>
  case when (select project_kind from agent_missions where id=p_mission)='assessment' then 'assessmentTokens' else 'developmentTokens' end)::bigint,
  benchmark_effective_mission_allowance_benchmark(p_mission,p_continuation))
$$;
alter function benchmark_effective_mission_call_limit(uuid,uuid) rename to benchmark_effective_mission_call_limit_benchmark;
create function benchmark_effective_mission_call_limit(p_mission uuid,p_continuation uuid) returns integer
language sql stable security definer set search_path=public as $$
 select coalesce((developer_current_mission_authority(p_mission)->'developer_authority'->'limits'->>
  case when (select project_kind from agent_missions where id=p_mission)='assessment' then 'assessmentCalls' else 'developmentCalls' end)::integer,
  benchmark_effective_mission_call_limit_benchmark(p_mission,p_continuation))
$$;
alter function benchmark_effective_mission_deadline(uuid) rename to benchmark_effective_mission_deadline_benchmark;
create function benchmark_effective_mission_deadline(p_mission uuid) returns timestamptz
language sql stable security definer set search_path=public as $$
 select coalesce((developer_current_mission_authority(p_mission)->>'deadline')::timestamptz,benchmark_effective_mission_deadline_benchmark(p_mission))
$$;

create function developer_issue_execution_grant(p_approval uuid,p_task uuid,p_digest text,p_release text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a benchmark_native_spending_approvals;s jsonb;g benchmark_execution_grants;epoch bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into a from benchmark_native_spending_approvals where id=p_approval for update;
 if a.id is null or a.developer_authority is null or a.task_id is distinct from p_task
  or a.consumed_at is not null or a.revoked_at is not null or a.deadline<=clock_timestamp()
  or coalesce(p_digest,'')!~'^[a-f0-9]{64}$' or coalesce(p_release,'')!~'^[a-f0-9]{40}$'
  or exists(select 1 from benchmark_native_spending_approvals where previous_developer_approval_id=a.id)
  then raise exception 'Ordinary grant authority unavailable';end if;
 s:=developer_task_binding(a.owner_id,p_task);
 if a.developer_authority->'binding' is distinct from s->'binding'
  or a.developer_authority->'completionContract' is distinct from s->'project'->'completion_contract'
  or s->'project'->>'status'<>'running' or s->'mission'->>'status'<>'running'
  or s->'task'->'external'->>'developerApprovalId' is distinct from a.id::text
  or s->'task'->'external'->>'developerReleaseSha' is distinct from p_release
  or not exists(select 1 from project_events where project_id=a.project_id and event='developer_native_dispatch_claimed' and data->>'approvalId'=a.id::text and data->>'releaseSha'=p_release)
  or exists(select 1 from benchmark_budget_calls where account_id=a.account_id and state<>'settled')
  then raise exception 'Ordinary dispatch binding or accounting unavailable';end if;
 perform 1 from benchmark_budget_accounts where id=a.account_id and arm='developer' and frozen_at is null for update;
 if not found then raise exception 'Ordinary account frozen or unavailable';end if;
 select coalesce(max(execution_epoch),0)+1 into epoch from benchmark_execution_grants where account_id=a.account_id;
 insert into benchmark_execution_grants(token_digest,trial_id,account_id,owner_actor_id,protocol_digest,repository,model,execution_epoch,deadline,project_id,mission_assignment_id,developer_approval_id)
 values(p_digest,null,a.account_id,a.actor_id,a.protocol_digest,a.repository,a.model,epoch,least(a.deadline,(s->'project'->>'deadline')::timestamptz),a.project_id,p_task,a.id) returning * into g;
 update benchmark_native_spending_approvals set consumed_at=clock_timestamp() where id=a.id;
 return jsonb_build_object('grantId',g.id,'executionEpoch',g.execution_epoch);
end $$;

create function developer_gateway_execution_live(p_digest text,p_project uuid,p_epoch bigint) returns boolean
language plpgsql security definer set search_path=public as $$
declare g benchmark_execution_grants;a benchmark_native_spending_approvals;s jsonb;
begin
 select * into g from benchmark_execution_grants where token_digest=p_digest and project_id=p_project and execution_epoch=p_epoch and developer_approval_id is not null;
 if g.id is null or g.revoked_at is not null or g.stopped_at is not null or g.deadline<=clock_timestamp() then return false;end if;
 select * into a from benchmark_native_spending_approvals where id=g.developer_approval_id;
 if a.id is null or a.revoked_at is not null or a.consumed_at is null or a.deadline<=clock_timestamp()
  or exists(select 1 from benchmark_native_spending_approvals where previous_developer_approval_id=a.id)
  or not exists(select 1 from benchmark_budget_accounts where id=a.account_id and arm='developer' and frozen_at is null)
  then return false;end if;
 s:=developer_task_binding(a.owner_id,a.task_id);
 return a.developer_authority->'binding'=s->'binding'
  and a.developer_authority->'completionContract'=s->'project'->'completion_contract'
  and s->'project'->>'status'='running' and s->'mission'->>'status'='running'
  and (s->'project'->>'deadline')::timestamptz>clock_timestamp();
end $$;

-- The same canonical receipt settlement handles both kinds. Ordinary exposure
-- must exist on EVERY operation; reserve cannot enter through an old unlinked RPC.
create function developer_dollar_admission() returns trigger
language plpgsql security definer set search_path=public as $$
declare acct benchmark_budget_accounts;a jsonb;limits jsonb;mc mission_calls;j mission_assignments;m agent_missions;
 price model_registry;rate numeric;used numeric;held bigint;protected bigint;
begin
 select * into acct from benchmark_budget_accounts where id=new.account_id for update;
 if acct.arm<>'developer' then return new;end if;
 select * into mc from mission_calls where id=new.legacy_mission_call_id;
 select * into j from mission_assignments where id=mc.job_id;
 select * into m from agent_missions where id=j.mission_id;
 a:=developer_current_mission_authority(m.id);limits:=a->'developer_authority'->'limits';
 if a is null or mc.id is null or new.continuation_id is not null or new.state<>'reserved'
  or new.actual_tokens is not null or new.request_key<>mc.id::text
  or new.reserved_tokens is distinct from mc.reserved_tokens or new.model is distinct from mc.model
  or a->>'account_id'<>acct.id::text or new.model not in (a->>'model','openai:'||(a->>'model'))
  or m.project_id is distinct from acct.developer_project_id or m.project_kind not in ('development','assessment')
  or exists(select 1 from benchmark_budget_calls where account_id=acct.id and state in ('unresolved','overrun'))
  then raise exception 'Ordinary financial admission denied';end if;
 if new.model=a->>'model' then
  if not exists(select 1 from benchmark_execution_grants g where g.id=mc.lease and g.developer_approval_id=(a->>'id')::uuid
   and g.mission_assignment_id=j.id and g.deadline>clock_timestamp() and g.revoked_at is null and g.stopped_at is null)
   then raise exception 'Ordinary native grant unavailable';end if;
 elsif j.lease is distinct from mc.lease or j.status<>'running' or j.lease_until<=clock_timestamp()
 then raise exception 'Ordinary worker lease unavailable';end if;
 if (select count(*) from mission_calls c join mission_assignments x on x.id=c.job_id where x.mission_id=m.id)>
  (limits->>case when m.project_kind='assessment' then 'assessmentCalls' else 'developmentCalls' end)::integer
  then raise exception 'Ordinary cumulative call ceiling exhausted';end if;
 if exists(select 1 from benchmark_budget_calls c left join benchmark_dollar_exposures e on e.call_id=c.id where c.account_id=acct.id and c.id<>new.id and e.call_id is null)
 then raise exception 'Ordinary financial history incomplete';end if;
 select * into price from model_registry where provider_name='openai' and model_id=a->>'model' for share;
 if price.pricing_status is distinct from 'verified' or price.pricing_verified_at is null
  or price.pricing_verified_at<clock_timestamp()-interval '24 hours' or price.pricing_verified_at>clock_timestamp()
  or price.pricing_input_per_1m is null or price.pricing_output_per_1m is null
  or price.pricing_input_per_1m not between 0.000001 and 28 or price.pricing_output_per_1m not between 0.000001 and 28
  then raise exception 'Ordinary verified pricing unavailable';end if;
 rate:=greatest(price.pricing_input_per_1m,price.pricing_output_per_1m);
 select coalesce(sum(exposure_microusd),0) into used from benchmark_dollar_exposures where account_id=acct.id;
 if ceil(new.reserved_tokens*rate)>(limits->>'perCallMicrousd')::numeric
  or used+ceil(new.reserved_tokens*rate)>(limits->>'ceilingMicrousd')::numeric
  then raise exception 'Ordinary monetary ceiling exhausted';end if;
 select coalesce(sum(reserved_tokens),0) into held from benchmark_budget_calls where account_id=acct.id and state in ('reserved','unresolved');
 protected:=case when m.project_kind='assessment' then 0 else (limits->>'assessmentTokens')::bigint end
  +case when new.model=a->>'model' then (limits->>'completionTokens')::bigint else 0 end;
 if acct.spent_tokens+held+protected>(a->>'max_tokens')::bigint then raise exception 'Ordinary protected account reserves';end if;
 insert into benchmark_dollar_exposures(call_id,account_id,reserved_microusd,exposure_microusd,price_per_million,basis,price_evidence)
 values(new.id,acct.id,ceil(new.reserved_tokens*rate),ceil(new.reserved_tokens*rate),rate,'reserved',
 jsonb_build_object('provider','openai','model',a->>'model','serviceTier','default','inputPerMillion',price.pricing_input_per_1m,'outputPerMillion',price.pricing_output_per_1m,'verifiedAt',price.pricing_verified_at));
 return new;
end $$;
create trigger developer_dollar_admission after insert on benchmark_budget_calls for each row execute function developer_dollar_admission();

create function developer_native_reserve(p_digest text,p_project uuid,p_epoch bigint,p_request_key text,p_model text,p_tokens bigint) returns uuid
language plpgsql security definer set search_path=public as $$
declare g benchmark_execution_grants;a benchmark_native_spending_approvals;j mission_assignments;m agent_missions;p work_projects;
 limits jsonb;call_id uuid;operation uuid;project_used bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if p_tokens is null or p_tokens not between 1 and 120000 or coalesce(p_request_key,'')!~'^[a-f0-9-]{36}$'
  or developer_gateway_execution_live(p_digest,p_project,p_epoch) is distinct from true then raise exception 'Ordinary native admission denied';end if;
 select * into g from benchmark_execution_grants where token_digest=p_digest and project_id=p_project and execution_epoch=p_epoch and developer_approval_id is not null for update;
 select * into a from benchmark_native_spending_approvals where id=g.developer_approval_id;
 select * into j from mission_assignments where id=g.mission_assignment_id for update;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into p from work_projects where id=p_project for update;
 limits:=a.developer_authority->'limits';
 if p_model is distinct from a.model or j.role<>'development' or j.status not in ('waiting_external','running')
  or m.calls+m.routing_calls+1>(limits->>'developmentCalls')::bigint-(limits->>'completionCalls')::bigint
  or greatest(m.actual_tokens,m.reserved_tokens)+p_tokens>(limits->>'developmentTokens')::bigint-(limits->>'completionTokens')::bigint
  then raise exception 'Ordinary native capacity or protected completion reserve exhausted';end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into project_used from agent_missions where project_id=p.id;
 if project_used+p_tokens>p.token_allowance then raise exception 'Original project token admission denied';end if;
 call_id:=p_request_key::uuid;
 insert into mission_calls(id,job_id,lease,model,reserved_tokens) values(call_id,j.id,g.id,p_model,p_tokens);
 insert into benchmark_budget_calls(account_id,request_key,model,reserved_tokens,legacy_mission_call_id)
 values(a.account_id,call_id::text,p_model,p_tokens,call_id) returning id into operation;
 update agent_missions set calls=calls+1,reserved_tokens=reserved_tokens+p_tokens,updated_at=now() where id=m.id;
 return operation;
end $$;

create function developer_mission_projection_required() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from mission_assignments j join benchmark_mission_bindings b on b.mission_id=j.mission_id where j.id=new.job_id and b.developer_project_id is not null)
 and not exists(select 1 from benchmark_budget_calls c join benchmark_dollar_exposures e on e.call_id=c.id and e.account_id=c.account_id
  join mission_assignments j on j.id=new.job_id join benchmark_mission_bindings b on b.mission_id=j.mission_id and b.account_id=c.account_id
  where c.legacy_mission_call_id=new.id and c.request_key=new.id::text)
 then raise exception 'Ordinary provider reservation requires canonical financial projection';end if;
 return new;
end $$;
create constraint trigger developer_mission_projection_required after insert on mission_calls
 deferrable initially deferred for each row execute function developer_mission_projection_required();

-- Preserve ordinary mission admission, then attach the same financial operation.
-- A failure rolls back BOTH reservations before a provider can be contacted.
alter function benchmark_reserve_mission_call(uuid,uuid,uuid,text,integer,boolean) rename to benchmark_reserve_mission_call_benchmark;
create function benchmark_reserve_mission_call(p_job uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer,p_routing boolean) returns uuid
language plpgsql security definer set search_path=public as $$
declare b benchmark_mission_bindings;j mission_assignments;a jsonb;op uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_job;
 select * into b from benchmark_mission_bindings where mission_id=j.mission_id;
 if b.developer_project_id is null then return benchmark_reserve_mission_call_benchmark(p_job,p_lease,p_call,p_model,p_tokens,p_routing);end if;
 a:=developer_current_mission_authority(j.mission_id);
 if a is null or p_model is distinct from 'openai:'||(a->>'model') then return null;end if;
 if not try_reserve_mission_capacity(p_job,p_lease,p_call,p_model,p_tokens,p_routing) then return null;end if;
 insert into benchmark_budget_calls(account_id,request_key,model,reserved_tokens,legacy_mission_call_id)
 values(b.account_id,p_call::text,p_model,p_tokens,p_call) returning id into op;
 return op;
end $$;

create function developer_claim_dispatch(p_approval uuid,p_release text) returns boolean
language plpgsql security definer set search_path=public as $$
declare a benchmark_native_spending_approvals;s jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into a from benchmark_native_spending_approvals where id=p_approval for update;
 if a.id is null or a.developer_authority is null or a.consumed_at is not null or a.revoked_at is not null or a.deadline<=clock_timestamp()
  or (a.developer_authority ? 'releaseSha' and a.developer_authority->>'releaseSha' is distinct from p_release)
  or coalesce(p_release,'')!~'^[a-f0-9]{40}$' or exists(select 1 from benchmark_native_spending_approvals where previous_developer_approval_id=a.id)
  then return false;end if;
 s:=developer_task_binding(a.owner_id,a.task_id);
 if a.developer_authority->'binding' is distinct from s->'binding'
  or a.developer_authority->'completionContract' is distinct from s->'project'->'completion_contract'
  or exists(select 1 from project_events where project_id=a.project_id and event='developer_native_dispatch_claimed' and data->>'approvalId'=a.id::text)
  or exists(select 1 from benchmark_budget_calls where account_id=a.account_id and state<>'settled')
  or s->'project'->>'status'<>'running' or s->'mission'->>'status'<>'running' then return false;end if;
 insert into project_events(project_id,event,data) values(a.project_id,'developer_native_dispatch_claimed',jsonb_build_object('approvalId',a.id,'taskId',a.task_id,'releaseSha',p_release));
 update agent_tasks set status='dispatching',external=external||jsonb_build_object('developerApprovalId',a.id,'developerReleaseSha',p_release,'developerDispatchSince',clock_timestamp(),'attempted',true,'dispatchStartedAt',clock_timestamp()),updated_at=now() where id=a.task_id;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),updated_at=now() where id=a.task_id;
 return true;
end $$;

do $$ declare r record;begin
 for r in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace and
  (proname like 'developer_%' or proname in ('benchmark_effective_mission_allowance','benchmark_effective_mission_call_limit','benchmark_effective_mission_deadline','benchmark_reserve_mission_call',
   'benchmark_effective_mission_allowance_benchmark','benchmark_effective_mission_call_limit_benchmark','benchmark_effective_mission_deadline_benchmark','benchmark_reserve_mission_call_benchmark')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
  if r.proname in ('developer_initial_snapshot','developer_offer_initial','developer_decide_initial','developer_issue_execution_grant','developer_gateway_execution_live','developer_native_reserve','developer_claim_dispatch',
   'benchmark_effective_mission_allowance','benchmark_effective_mission_call_limit','benchmark_effective_mission_deadline','benchmark_reserve_mission_call') then
   execute format('grant execute on function %s to service_role',r.signature);
  end if;
 end loop;
end $$;

create function developer_lifecycle_decide(p_owner uuid,p_task uuid,p_proposal text,p_decision text,p_release text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o benchmark_lifecycle_proposals;d benchmark_lifecycle_decisions;s jsonb;a benchmark_native_spending_approvals;
 fresh benchmark_native_spending_approvals;n jsonb;limits jsonb;deadline timestamptz;k text;task agent_tasks;mission uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into o from benchmark_lifecycle_proposals where id=p_proposal for update;
 if o.id is null or o.owner_id is distinct from p_owner or o.task_id is distinct from p_task
  or o.proposal->>'version' is distinct from 'lifecycle-owner-proposal-v1'
  or p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Exact ordinary owner proposal required';end if;
 perform developer_task_binding(p_owner,p_task);
 select * into d from benchmark_lifecycle_decisions where proposal_id=o.id;
 if found then
  if d.decision<>p_decision then raise exception 'Owner decision already committed';end if;
  return jsonb_build_object('state',d.decision,'proposalId',o.id,'approvalId',d.developer_approval_id,'authorityKind','ordinary-developer');
 end if;
 s:=developer_lifecycle_snapshot(p_task);
 if o.expires_at<=clock_timestamp() or o.snapshot_hash is distinct from s->>'snapshotHash'
  or (s->>'revoked')::boolean or (s->>'frozen')::boolean then raise exception 'Ordinary proposal stale, expired or denied';end if;
 if p_decision='rejected' then
  insert into benchmark_lifecycle_decisions(proposal_id,owner_id,decision) values(o.id,p_owner,'rejected');
  insert into project_events(project_id,event,data) values(o.project_id,'lifecycle_owner_rejected',jsonb_build_object('proposalId',o.id,'taskId',p_task));
  return jsonb_build_object('state','rejected','proposalId',o.id,'authorityKind','ordinary-developer');
 end if;
 select * into a from benchmark_native_spending_approvals where id=(s->>'approvalId')::uuid for update;
 select * into task from agent_tasks where id=p_task;
 mission:=(s->>'missionId')::uuid;
 if task.status<>'blocked' or task.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or task.external->'receipt'->>'run_id' is distinct from o.checkpoint->>'runId'
  or o.checkpoint->>'scopeHash' is distinct from s->'binding'->>'scopeHash'
  or o.checkpoint->>'approvalId' is distinct from a.id::text
  or coalesce(p_release,'')!~'^[a-f0-9]{40}$'
  or not exists(select 1 from benchmark_execution_grants where developer_approval_id=a.id)
  or exists(select 1 from benchmark_budget_calls where account_id=a.account_id and state<>'settled')
  then raise exception 'Authenticated original checkpoint and reconciled history required';end if;
 n:=o.proposal->'proposed';
 foreach k in array array['cumulativeTokens','developmentTokens','developmentCalls','completionTokens','completionCalls','assessmentTokens','assessmentCalls','ceilingMicrousd'] loop
  if n->>k is null or (n->>k)::numeric<(s->'position'->>k)::numeric then raise exception 'Ordinary proposal reduces protected authority';end if;
 end loop;
 deadline:=case when n->>'windowStartsAt'='authenticated_commit' then clock_timestamp()+make_interval(secs=>(n->>'durationSeconds')::integer)
  else a.deadline end;
 if n->>'windowStartsAt' not in ('authenticated_commit','unchanged') or (n->>'windowStartsAt'='unchanged' and n->'expiresAt' is distinct from s->'position'->'expiresAt') then raise exception 'Ordinary continuation window differs';end if;
 if deadline<=clock_timestamp() or deadline<a.deadline then raise exception 'Invalid ordinary continuation window';end if;
 limits:=a.developer_authority->'limits';
 foreach k in array array['cumulativeTokens','developmentTokens','developmentCalls','completionTokens','completionCalls','assessmentTokens','assessmentCalls','ceilingMicrousd'] loop
  limits:=jsonb_set(limits,array[k],n->k);
 end loop;
 if n->>'windowStartsAt'='authenticated_commit' then limits:=jsonb_set(limits,'{durationSeconds}',n->'durationSeconds');end if;
 if not developer_validate_limits(limits) then raise exception 'Ordinary amendment limits invalid';end if;
 insert into benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority,previous_developer_approval_id,developer_proposal_id)
 values(p_owner,a.actor_id,a.chat_id,null,a.account_id,a.repository,a.model,a.protocol_digest,(n->>'cumulativeTokens')::bigint,deadline,a.project_id,p_task,p_task,
 a.developer_authority||jsonb_build_object('limits',limits,'checkpoint',o.checkpoint,'releaseSha',p_release,'snapshotHash',o.snapshot_hash),a.id,o.id) returning * into fresh;
 insert into benchmark_lifecycle_decisions(proposal_id,owner_id,decision,developer_approval_id) values(o.id,p_owner,'approved',fresh.id);
 update benchmark_execution_grants set stopped_at=coalesce(stopped_at,clock_timestamp()) where account_id=a.account_id and stopped_at is null;
 update agent_tasks set status='dispatching',external=(external-'developerDispatchSince'-'developerReleaseSha')||jsonb_build_object('developerApprovalId',fresh.id,'lifecycleProposalId',o.id),updated_at=now() where id=p_task;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),updated_at=now() where id=p_task;
 update agent_missions set status='running',updated_at=now() where id=mission;
 update work_projects set status='running',token_allowance=token_allowance+(fresh.max_tokens-a.max_tokens)::integer,
  budget_authorization_source='user_approved',deadline=greatest(work_projects.deadline,fresh.deadline),lease=null,lease_until=null,impediment=null,
  detail='Owner amendment committed; original Developer task awaiting verified continuation.',updated_at=now() where id=a.project_id;
 insert into project_events(project_id,event,data) values(a.project_id,'lifecycle_amendment_authorized',jsonb_build_object('ownerId',p_owner,'proposalId',o.id,'taskId',p_task,'approvalId',fresh.id,'previousApprovalId',a.id,'limits',limits));
 return jsonb_build_object('state','approved','proposalId',o.id,'approvalId',fresh.id,'authorityKind','ordinary-developer','deadline',deadline);
end $$;
alter function benchmark_lifecycle_decide(uuid,uuid,text,text,text) rename to benchmark_lifecycle_decide_benchmark;
create function benchmark_lifecycle_decide(p_owner uuid,p_task uuid,p_proposal text,p_decision text,p_release text) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from benchmark_native_spending_approvals where task_id=p_task and developer_authority is not null)
 then return developer_lifecycle_decide(p_owner,p_task,p_proposal,p_decision,p_release);end if;
 return benchmark_lifecycle_decide_benchmark(p_owner,p_task,p_proposal,p_decision,p_release);
end $$;
revoke all on function developer_lifecycle_decide(uuid,uuid,text,text,text),benchmark_lifecycle_decide_benchmark(uuid,uuid,text,text,text),benchmark_lifecycle_decide(uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function benchmark_lifecycle_decide(uuid,uuid,text,text,text) to service_role;

alter function benchmark_effective_account_cap(uuid) rename to benchmark_effective_account_cap_benchmark;
create function benchmark_effective_account_cap(p_account uuid) returns bigint language sql stable security definer set search_path=public as $$
 select case when exists(select 1 from benchmark_budget_accounts where id=p_account and arm='developer') then
 (select a.max_tokens from benchmark_native_spending_approvals a where a.account_id=p_account and a.developer_authority is not null
  and not exists(select 1 from benchmark_native_spending_approvals child where child.previous_developer_approval_id=a.id))
 else benchmark_effective_account_cap_benchmark(p_account) end
$$;
revoke all on function benchmark_effective_account_cap(uuid),benchmark_effective_account_cap_benchmark(uuid) from public,anon,authenticated,service_role;
grant execute on function benchmark_effective_account_cap(uuid) to service_role;

create function developer_history_delete_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if (to_jsonb(old)->>'developer_project_id') is not null or (to_jsonb(old)->>'developer_approval_id') is not null
  or (to_jsonb(old)->>'developer_authority') is not null then raise exception 'Ordinary authorization history is append-only';end if;
 return old;
end $$;
create trigger developer_account_history before delete on benchmark_budget_accounts for each row execute function developer_history_delete_guard();
create trigger developer_approval_history before delete on benchmark_native_spending_approvals for each row execute function developer_history_delete_guard();
create trigger developer_grant_history before delete on benchmark_execution_grants for each row execute function developer_history_delete_guard();
create trigger developer_mission_history before delete on benchmark_mission_bindings for each row execute function developer_history_delete_guard();
revoke all on function developer_history_delete_guard() from public,anon,authenticated,service_role;

-- Prepare original authority from existing project allocation, with an explicit
-- new monetary ceiling. This is a proposal only; no grant or budget is changed.
create function developer_prepare_initial(p_owner uuid,p_task uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s jsonb;m jsonb;p jsonb;price model_registry;tokens bigint;duration integer;rate numeric;
begin
 s:=developer_initial_snapshot(p_owner,p_task);m:=s->'snapshot'->'mission';p:=s->'snapshot'->'project';
 select * into price from model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 if price.pricing_status is distinct from 'verified' or price.pricing_verified_at is null
  or price.pricing_verified_at<clock_timestamp()-interval '24 hours'
  or price.pricing_verified_at>clock_timestamp() or price.pricing_input_per_1m<=0 or price.pricing_output_per_1m<=0
  then raise exception 'Verified native pricing required for original authority proposal';end if;
 rate:=greatest(price.pricing_input_per_1m,price.pricing_output_per_1m);
 if rate is null or rate>28 then raise exception 'Native conservative pricing bound unsupported';end if;
 tokens:=(m->>'token_allowance')::bigint+60000;
 duration:=least(86400,floor(extract(epoch from (p->>'deadline')::timestamptz-(p->>'created_at')::timestamptz))::integer);
 if (m->>'token_allowance')::bigint<=60000 or (m->>'max_calls')::integer<8
  or tokens>(p->>'token_allowance')::bigint-(s->'snapshot'->>'projectEncumberedTokens')::bigint or duration<60
  then raise exception 'Existing ordinary allocation cannot establish protected native lifecycle authority';end if;
 return developer_offer_initial(p_owner,p_task,jsonb_build_object(
  'cumulativeTokens',tokens,'developmentTokens',(m->>'token_allowance')::bigint,
  'developmentCalls',(m->>'max_calls')::integer,'completionTokens',60000,'completionCalls',4,
  'assessmentTokens',60000,'assessmentCalls',4,'perCallMicrousd',ceil((m->>'token_allowance')::numeric*rate),
  'ceilingMicrousd',ceil(tokens*rate),'durationSeconds',duration),'gpt-5.3-codex');
end $$;
create function developer_next_initial_task(p_owner uuid,p_chat uuid default null) returns uuid
language plpgsql security definer set search_path=public as $$
declare candidate record;
begin
 for candidate in select t.id from agent_tasks t join mission_assignments j on j.id=t.id
 join agent_missions m on m.id=j.mission_id join work_projects p on p.id=m.project_id
 where j.role='development' and p.active_mission_id=m.id and p.phase='development' and p.status='running'
 and (p_chat is null or p.chat_id=p_chat) and standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 and not exists(select 1 from benchmark_full_project_bindings where project_id=p.id)
 and not exists(select 1 from benchmark_native_spending_approvals where task_id=t.id)
 order by t.created_at desc limit 8 loop
  begin perform developer_initial_snapshot(p_owner,candidate.id);return candidate.id;
  exception when others then continue;end;
 end loop;
 return null;
end $$;
revoke all on function developer_prepare_initial(uuid,uuid),developer_next_initial_task(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function developer_prepare_initial(uuid,uuid),developer_next_initial_task(uuid,uuid) to service_role;

create function developer_bound_mission_authority(p_mission uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare b benchmark_mission_bindings;a jsonb;
begin
 select * into b from benchmark_mission_bindings where mission_id=p_mission and developer_project_id is not null;
 if b.mission_id is null then return null;end if;
 a:=developer_current_mission_authority(p_mission);
 return jsonb_build_object('bound',true,'live',a is not null,'model',a->>'model','accountId',b.account_id);
end $$;
create function developer_bind_assessment_account() returns trigger
language plpgsql security definer set search_path=public as $$
declare a benchmark_budget_accounts;p work_projects;
begin
 if new.project_id is null or new.project_kind<>'assessment' then return new;end if;
 select account.* into a from benchmark_budget_accounts account join mission_assignments job on job.id=account.developer_task_id
 join project_runs run on run.mission_id=job.mission_id
 where account.developer_project_id=new.project_id order by run.milestone_index desc,run.created_at desc limit 1;
 if a.id is null then return new;end if;
 select * into p from work_projects where id=new.project_id;
 insert into benchmark_mission_bindings(mission_id,account_id,experiment_id,baseline_sha,developer_project_id)
 values(new.id,a.id,null,p.baseline_sha,p.id) on conflict(mission_id) do nothing;
 if not exists(select 1 from benchmark_mission_bindings where mission_id=new.id and account_id=a.id and developer_project_id=p.id) then raise exception 'Assessment canonical account binding differs';end if;
 return new;
end $$;
create trigger developer_assessment_account after insert or update of project_id,project_kind on agent_missions
 for each row execute function developer_bind_assessment_account();
revoke all on function developer_bound_mission_authority(uuid),developer_bind_assessment_account() from public,anon,authenticated,service_role;
grant execute on function developer_bound_mission_authority(uuid) to service_role;

-- Ordinary spending rows cannot become durable authority without the matching
-- append-only authenticated decision in the same transaction.
create function developer_approval_decision_guard() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.developer_authority is not null and not exists(
  select 1 from benchmark_lifecycle_decisions d join benchmark_lifecycle_proposals proposal on proposal.id=d.proposal_id
  where d.developer_approval_id=new.id and d.proposal_id=new.developer_proposal_id and d.decision='approved'
   and d.owner_id=new.owner_id and proposal.owner_id=new.owner_id and proposal.task_id=new.task_id and proposal.project_id=new.project_id)
  then raise exception 'Ordinary authority requires its committed exact owner decision';end if;
 return new;
end $$;
create constraint trigger developer_approval_decision after insert on benchmark_native_spending_approvals
 deferrable initially deferred for each row execute function developer_approval_decision_guard();
revoke all on function developer_approval_decision_guard() from public,anon,authenticated,service_role;
