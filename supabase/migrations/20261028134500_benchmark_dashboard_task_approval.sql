-- Specialist tasks retain their own actor/chat. Prove delegation through the
-- saved project mission and frozen specialist rather than rewriting identity.
create function public.benchmark_full_task_provenance(p_task uuid,p_project uuid)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from agent_tasks t join mission_assignments j on j.id=t.id and j.agent_id=t.agent_id
 join agent_missions m on m.id=j.mission_id join work_projects p on p.id=m.project_id
 join project_runs r on r.mission_id=m.id
 join managed_agents a on a.id=t.agent_id and a.actor_id=t.actor_id
 join chats c on c.id=t.chat_id and c.actor_id=t.actor_id
 where t.id=p_task and p.id=p_project and p.active_mission_id=m.id and j.role='development' and t.kind='development'
 and t.repository_id is not distinct from p.repository_id and m.repository_id is not distinct from p.repository_id
 and t.input=t.initial_input and t.initial_input=j.payload->>'development_input' and j.payload->>'approved'='true'
 and p.approved_hash is not null and p.approved_hash=p.approval_hash and r.binding->>'scopeHash'=p.approved_hash
 and exists(select 1 from jsonb_array_elements(m.team) f where f->>'id'=t.agent_id::text
 and f->'config'=t.snapshot and (f->>'version')::integer=t.definition_version and (f->'config'->>'development')::boolean)
 and not a.archived and a.config=t.snapshot and a.version=t.definition_version);
$$;
revoke all on function public.benchmark_full_task_provenance(uuid,uuid) from public,anon,authenticated;
grant execute on function public.benchmark_full_task_provenance(uuid,uuid) to service_role;
-- Authenticated owner dashboard entry into the existing task-specific approval gate.
-- No project, task, scope approval, spending account, or grant is manufactured.
create function public.benchmark_dashboard_full_task(p_owner uuid,p_task uuid default null,p_scope text default null,p_approve boolean default false)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare q benchmark_production_qualifications; t benchmark_three_arm_trials; a benchmark_budget_accounts;
 b benchmark_full_project_bindings; p work_projects; j mission_assignments; m agent_missions;
 task agent_tasks; r project_runs; approval benchmark_native_spending_approvals; protocol_text text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into q from benchmark_production_qualifications where issue=715 for update;
 if q.owner_id is distinct from p_owner or p_owner is null or q.revoked_at is not null or q.deadline<=now() then raise exception 'live authenticated owner qualification required';end if;
 select * into t from benchmark_three_arm_trials where experiment_id=q.experiment_id and arm='full' for update;
 select * into b from benchmark_full_project_bindings where trial_id=t.id;
 if b.project_id is null then if p_approve then raise exception 'Full project unavailable';end if;return null;end if;
 select * into p from work_projects where id=b.project_id for update;
 select * into m from agent_missions where id=p.active_mission_id for update;
 select * into j from mission_assignments where mission_id=m.id and role='development' order by created_at desc limit 1 for update;
 select * into task from agent_tasks where id=j.id for update;
 if task.id is null then if p_approve then raise exception 'Developer task unavailable';end if;return null;end if;
 select * into a from benchmark_budget_accounts where id=b.account_id for update;
 select * into r from project_runs where mission_id=m.id;
 select * into approval from benchmark_native_spending_approvals where task_id=task.id and trial_id=t.id order by created_at desc limit 1;
 if p_approve then
  if p_task is distinct from task.id or p_scope is null or p_scope is distinct from p.approved_hash or
   p.approved_hash is distinct from p.approval_hash or r.binding->>'scopeHash' is distinct from p_scope or
   j.payload->>'approved' is distinct from 'true' or task.kind<>'development' or task.status<>'dispatching' or
   coalesce((task.external->>'attempted')::boolean,false) or j.status not in ('running','waiting_external','queued') or
   p.status<>'running' or p.phase<>'development' or m.status<>'running' or m.project_id is distinct from p.id or
   not benchmark_full_task_provenance(task.id,p.id) or p.actor_id is distinct from q.actor_id or
   task.repository_id is distinct from p.repository_id or p.deadline<=now() or m.deadline<=now() or
   t.state not in ('qualified','running') or t.owner_actor_id is distinct from q.actor_id or
   t.contract_sha256 is distinct from b.benchmark_contract_hash or t.baseline_sha is distinct from b.baseline_sha or
   b.model<>'gpt-5.3-codex' or a.trial_id is distinct from t.id or a.arm<>'full' or a.cap_tokens<>350000 or
   a.frozen_at is not null or a.spent_tokens>=a.cap_tokens or a.owner_actor_id is distinct from q.actor_id or
   exists(select 1 from benchmark_budget_calls where account_id=a.id and state='unresolved') or
   exists(select 1 from benchmark_development_dispatches where task_id=task.id) then
    raise exception 'saved approved Full task is not eligible';
  end if;
  if approval.id is not null then
   if approval.owner_id is distinct from p_owner or approval.consumed_at is not null or approval.revoked_at is not null or approval.deadline<=now() then raise exception 'prior task authority cannot be replaced';end if;
  else
   protocol_text:=regexp_replace(json_build_object('experimentId',t.experiment_id,'replicate',t.replicate,
    'baselineSha',t.baseline_sha,'contractSha256',t.contract_sha256,'acceptanceSha256',t.acceptance_sha256,
    'toolProfileSha256',t.tool_profile_sha256,'modelPolicySha256',t.model_policy_sha256,'runtimeSha256',t.runtime_sha256,'tokenCap',350000)::text,'[[:space:]]','','g');
   insert into benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id)
   values(p_owner,q.actor_id,p.chat_id,t.id,a.id,'mfackrell/katie',b.model,encode(sha256(convert_to(protocol_text,'UTF8')),'hex'),350000,least(q.deadline,p.deadline,m.deadline),p.id,j.id,task.id) returning * into approval;
   insert into project_events(project_id,event,data) values(p.id,'benchmark_owner_task_approved',jsonb_build_object('task',task.id,'approval',approval.id,'scope',p_scope,'owner',p_owner,'trial',t.id,'deadline',approval.deadline));
  end if;
 end if;
 return jsonb_build_object('taskId',task.id,'projectId',p.id,'chatId',p.chat_id,'scopeHash',p.approved_hash,'request',task.input,
  'trialId',t.id,'model',b.model,'deadline',least(q.deadline,p.deadline,m.deadline),'spentTokens',a.spent_tokens,
  'approvalState',case when approval.id is null then 'pending' when approval.revoked_at is not null then 'revoked' when approval.deadline<=now() then 'expired' when approval.consumed_at is not null then 'consumed' else 'approved' end,
  'approved',approval.id is not null,'approvalId',approval.id,'taskStatus',task.status);
end $$;
revoke all on function public.benchmark_dashboard_full_task(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.benchmark_dashboard_full_task(uuid,uuid,text,boolean) to service_role;

create or replace function public.benchmark_bind_full_development_dispatch(
 p_task uuid,p_project uuid,p_scope_hash text,p_project_contract_hash text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare task public.agent_tasks; j public.mission_assignments; m public.agent_missions;
 p public.work_projects; r public.project_runs; b public.benchmark_full_project_bindings;
 t public.benchmark_three_arm_trials; a public.benchmark_budget_accounts;
 approval public.benchmark_native_spending_approvals; result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into task from public.agent_tasks where id=p_task for update;
 select * into j from public.mission_assignments where id=p_task for update;
 select * into m from public.agent_missions where id=j.mission_id for update;
 select * into p from public.work_projects where id=p_project for update;
 select * into r from public.project_runs where mission_id=m.id;
 select * into b from public.benchmark_full_project_bindings where project_id=p.id;
 if task.id is null or j.id is null or m.id is null or p.id is null or r.id is null or b.project_id is null or
    task.kind<>'development' or task.status<>'dispatching' or
    ((task.actor_id<>p.actor_id or task.chat_id<>p.chat_id) and not benchmark_full_task_provenance(task.id,p.id)) or task.repository_id<>p.repository_id or
    j.role<>'development' or j.status<>'running' or
    m.project_id<>p.id or p.active_mission_id<>m.id or p.status<>'running' or p.phase<>'development' or
    p.approved_hash is null or p.approved_hash is distinct from p.approval_hash or p.approved_hash<>p_scope_hash or
    r.binding->>'scopeHash'<>p_scope_hash or r.binding->>'contractHash'<>p_project_contract_hash then
  raise exception 'approved Full Developer assignment unavailable';
 end if;
 select * into t from public.benchmark_three_arm_trials where id=b.trial_id for update;
 select * into a from public.benchmark_budget_accounts where id=b.account_id for update;
 select * into approval from public.benchmark_native_spending_approvals
  where task_id=p_task and trial_id=t.id and account_id=a.id and project_id=p.id
   and mission_assignment_id=j.id and actor_id=p.actor_id and chat_id=p.chat_id
   and repository='mfackrell/katie' and model=b.model and consumed_at is null and revoked_at is null
   and deadline>now() for update;
 if not found or approval.owner_id is null or t.arm<>'full' or t.owner_actor_id<>p.actor_id or
    t.contract_sha256<>b.benchmark_contract_hash or t.baseline_sha<>b.baseline_sha or
    a.trial_id<>t.id or a.arm<>'full' or a.cap_tokens<>350000 or a.frozen_at is not null then
  raise exception 'live task-specific Full approval unavailable';
 end if;
 insert into public.benchmark_development_dispatches(task_id,trial_id,contract_hash,
   benchmark_contract_hash,baseline_sha,status)
 values(p_task,t.id,p_project_contract_hash,b.benchmark_contract_hash,b.baseline_sha,'qualified')
 on conflict(task_id) do update set status='qualified'
 where benchmark_development_dispatches.trial_id=excluded.trial_id
  and benchmark_development_dispatches.contract_hash=excluded.contract_hash
  and benchmark_development_dispatches.benchmark_contract_hash=excluded.benchmark_contract_hash
  and benchmark_development_dispatches.baseline_sha=excluded.baseline_sha;
 if not found then raise exception 'Full dispatch binding identity conflict';end if;
 result:=jsonb_build_object('trial_id',t.id,'account_id',a.id,'benchmark_contract_hash',b.benchmark_contract_hash,
   'approval_id',approval.id,'model',approval.model,'repository',approval.repository,'deadline',approval.deadline);
 return result;
end $$;
revoke all on function public.benchmark_bind_full_development_dispatch(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.benchmark_bind_full_development_dispatch(uuid,uuid,text,text) to service_role;

-- Consume an approved task-specific grant and activate its trial in one transaction.
-- This function remains service-role only, never callable from model text.
create or replace function public.benchmark_issue_execution_grant(
 p_owner uuid,p_actor uuid,p_chat uuid,p_trial uuid,p_approval uuid,
 p_repository text,p_model text,p_epoch bigint,p_deadline timestamptz,p_digest text)
returns uuid language plpgsql security invoker set search_path=public as $$
declare a public.benchmark_native_spending_approvals;
 t public.benchmark_three_arm_trials; acc public.benchmark_budget_accounts;
 p public.work_projects; j public.mission_assignments; m public.agent_missions;
 atask public.agent_tasks;
 result uuid;
begin
 if p_digest !~ '^[a-f0-9]{64}$' or p_epoch<=0 or p_deadline<=now()
 then raise exception 'invalid grant';end if;
 select * into a from public.benchmark_native_spending_approvals
 where id=p_approval for update;
 if not found or a.consumed_at is not null or a.revoked_at is not null
 or a.deadline<=now() or p_deadline>a.deadline or
 a.owner_id<>p_owner or a.actor_id<>p_actor or a.chat_id<>p_chat or
 a.trial_id<>p_trial or a.repository<>p_repository or a.model<>p_model
 then raise exception 'owner spending authorization missing';end if;
 if a.task_id is null then raise exception 'approved Developer task required';end if;
 select * into atask from public.agent_tasks where id=a.task_id for update;
 if not found or
    ((atask.actor_id<>a.actor_id or atask.chat_id<>a.chat_id) and
     (a.project_id is null or not benchmark_full_task_provenance(atask.id,a.project_id))) or
    atask.status not in ('submitted','dispatching')
 then raise exception 'approved Developer task inactive';end if;
 select * into t from public.benchmark_three_arm_trials where id=a.trial_id for update;
 select * into acc from public.benchmark_budget_accounts where id=a.account_id for update;
 if t.id is null or acc.id is null or t.state not in ('qualified','running') or
 t.owner_actor_id<>a.actor_id or acc.owner_actor_id<>a.actor_id or
 acc.trial_id<>t.id or a.protocol_digest !~ '^[a-f0-9]{64}$'
 then raise exception 'spending binding mismatch';end if;
 if t.arm<>'full' and (atask.actor_id<>a.actor_id or atask.chat_id<>a.chat_id) then raise exception 'nonfull task identity mismatch';end if;
 if t.arm='full' then
  select * into p from public.work_projects where id=a.project_id for update;
  if not found or p.actor_id<>a.actor_id or p.chat_id<>a.chat_id or
    p.status<>'running' or p.phase<>'development' or
    p.deadline<=now() or p.approved_hash is null or
    p.approved_hash is distinct from p.approval_hash
  then raise exception 'live approved Developer project required';end if;
  select * into j from public.mission_assignments where id=a.mission_assignment_id for update;
  if not found or j.role<>'development' or j.status<>'waiting_external'
  then raise exception 'external Developer assignment missing';end if;
  select * into m from public.agent_missions where id=j.mission_id for update;
  if not found or m.status<>'running' or m.project_id is distinct from p.id or
    p.active_mission_id is distinct from m.id or m.deadline<=now()
  then raise exception 'active parent mission missing';end if;
 end if;
 if acc.cap_tokens>a.max_tokens or acc.frozen_at is not null
 then raise exception 'approval ceiling invalid';end if;
 insert into public.benchmark_execution_grants(token_digest,trial_id,account_id,
 owner_actor_id,protocol_digest,repository,model,execution_epoch,deadline,project_id,mission_assignment_id)
 values(p_digest,p_trial,a.account_id,a.actor_id,a.protocol_digest,
 p_repository,p_model,p_epoch,p_deadline,a.project_id,a.mission_assignment_id) returning id into result;
 update public.benchmark_three_arm_trials set state='running' where id=t.id and state='qualified';
 update public.benchmark_native_spending_approvals set consumed_at=now() where id=a.id;
 return result;
end $$;
revoke all on function public.benchmark_issue_execution_grant(uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)
 from public,anon,authenticated;
grant execute on function public.benchmark_issue_execution_grant(uuid,uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text)
 to service_role;

