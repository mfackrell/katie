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
   task.actor_id is distinct from q.actor_id or task.chat_id is distinct from p.chat_id or p.actor_id is distinct from q.actor_id or
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
