-- Ordinary Developer authority uses the existing canonical ledger, approvals,
-- grants and immutable lifecycle proposals. This migration creates NO authority.
-- Benchmark provenance remains mandatory for benchmark rows; ordinary rows have
-- an explicit project binding and cannot carry experimental provenance.
alter table benchmark_budget_accounts
 add column developer_project_id uuid references work_projects(id),
 alter column experiment_id drop not null;
alter table benchmark_budget_accounts drop constraint benchmark_budget_accounts_arm_check;
alter table benchmark_budget_accounts add constraint benchmark_budget_accounts_arm_check
 check(arm in ('direct','orchestrated','native','thin','full','developer'));
alter table benchmark_budget_accounts add constraint budget_account_authority_kind check(
 (arm='developer' and developer_project_id is not null and trial_id is null and experiment_id is null)
 or (arm<>'developer' and developer_project_id is null and experiment_id is not null));
create unique index developer_project_account on benchmark_budget_accounts(developer_project_id)
 where developer_project_id is not null;

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
   (new.arm is distinct from old.arm or new.developer_project_id is distinct from old.developer_project_id
    or new.owner_actor_id is distinct from old.owner_actor_id or new.cap_tokens is distinct from old.cap_tokens
    or new.trial_id is distinct from old.trial_id or new.experiment_id is distinct from old.experiment_id)
   then raise exception 'Original Developer account authority is immutable';end if;
  if new.arm<>'developer' then return new;end if;
  select * into p from work_projects where id=new.developer_project_id;
  if p.id is null or p.actor_id is distinct from new.owner_actor_id
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
   or a.developer_project_id is distinct from p.id or a.owner_actor_id is distinct from new.actor_id
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
 foreach k in array array['cumulativeTokens','developmentTokens','developmentCalls','completionTokens','completionCalls','assessmentTokens','assessmentCalls','perCallMicrousd','ceilingMicrousd','durationSeconds'] loop
  if coalesce(p_limits->>k,'') !~ '^[0-9]{1,12}$' then return false;end if;
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
  or exists(select 1 from benchmark_budget_accounts where developer_project_id=p.id)
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
  'binding',s->'snapshot'->'binding','taskId',p_task,'ownerId',p_owner,
  'snapshotHash',s->>'snapshotHash','scope',s->'snapshot'->'project'->'completion_contract',
  'current',jsonb_build_object('nativeAuthorityEstablished',false,'nativeCalls',null,'ceilingMicrousd',null,
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
 insert into benchmark_budget_accounts(experiment_id,arm,owner_actor_id,cap_tokens,developer_project_id)
 values(null,'developer',p.actor_id,(limits->>'cumulativeTokens')::bigint,p.id) returning id into acct;
 insert into benchmark_mission_bindings(mission_id,account_id,experiment_id,baseline_sha,developer_project_id)
 values(j.mission_id,acct,null,p.baseline_sha,p.id);
 insert into benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority,developer_proposal_id)
 values(p_owner,p.actor_id,p.chat_id,null,acct,(s->'snapshot'->'task'->>'repository_full_name'),o.proposal->>'model',p.approved_hash,
 (limits->>'cumulativeTokens')::bigint,deadline,p.id,p_task,p_task,
 jsonb_build_object('version','ordinary-developer-v1','scopeHash',p.approved_hash,'binding',s->'snapshot'->'binding','limits',limits,'originalTaskId',p_task,'snapshotHash',o.snapshot_hash),o.id)
 returning * into approved;
 insert into benchmark_lifecycle_decisions(proposal_id,owner_id,decision,developer_approval_id)
 values(o.id,p_owner,'approved',approved.id) returning * into d;
 insert into project_events(project_id,event,data) values(p.id,'native_resource_authorization',jsonb_build_object('ownerId',p_owner,'proposalId',o.id,'taskId',p_task,'approvalId',approved.id,'limits',limits));
 return to_jsonb(d);
end $$;
revoke all on function developer_offer_initial(uuid,uuid,jsonb,text),developer_decide_initial(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function developer_offer_initial(uuid,uuid,jsonb,text),developer_decide_initial(uuid,uuid,text,text) to service_role;
