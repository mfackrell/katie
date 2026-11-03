-- Task 4A pre-inference native handoff recovery.
-- This migration installs read-only proposal + one-shot explicit-owner action.
-- It does not correct historical rows, authorize charges, or dispatch anything.
create or replace function public.task4a_native_recovery_proposal()
returns jsonb language plpgsql stable set search_path=public as $$
declare p work_projects; m agent_missions; j mission_assignments; t agent_tasks;
 bad benchmark_native_spending_approvals; acct benchmark_budget_accounts;
 a project_continuation_authorizations; r project_runs;
 limits jsonb; proposal jsonb; deadline timestamptz;
begin
 select * into p from work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into m from agent_missions where id='d3fd3d95-7287-4bfc-8c97-c105fde46c36'::uuid and project_id=p.id;
 select * into j from mission_assignments where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid and mission_id=m.id;
 select * into t from agent_tasks where id=j.id;
 select * into r from project_runs where project_id=p.id and mission_id=m.id;
 select * into bad from benchmark_native_spending_approvals
  where id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid and project_id=p.id and task_id=t.id;
 select * into acct from benchmark_budget_accounts where id=bad.account_id;
 select * into a from project_continuation_authorizations
  where id='405ea82c-6f52-49e5-babf-891ecac64d14'::uuid and project_id=p.id;
 deadline:=least(bad.deadline,a.deadline,p.deadline);
 limits:=bad.developer_authority->'limits';
 if p.id is null or p.status<>'blocked' or p.phase<>'development'
  or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash
  or p.active_mission_id is distinct from m.id
  or p.baseline_sha is distinct from '49c8a5f791e66c351436bb97839193b53d7a1cd1'
  or p.repository_full_name is distinct from 'mfackrell/katie'
  or m.status<>'blocked' or m.project_kind<>'development'
  or j.role<>'development' or j.status<>'failed'
  or t.status<>'blocked' or t.repository_full_name<>'mfackrell/katie'
  or t.external->>'developerApprovalId' is distinct from bad.id::text
  or t.external->>'issueNumber' is distinct from '969'
  or t.external->'receipt'->>'run_id' is distinct from '41673059705'
  or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or t.external->'receipt'->>'pr_url' is not null
  or t.external->>'attempted' is distinct from 'true'
  or r.binding->>'projectId' is distinct from p.id::text
  or r.binding->>'scopeHash' is distinct from p.approved_hash
  or r.binding->>'baselineSha' is distinct from p.baseline_sha
  or r.binding->>'contractHash' is distinct from 'e8b08da72779ae0d7e864ed57c5ecc76b03d1fce6ddc9e14815e9c4c3dff332e'
  or bad.consumed_at is not null or bad.revoked_at is not null
  or bad.previous_developer_approval_id is not null
  or bad.developer_authority->>'version'<>'ordinary-developer-v1'
  or bad.developer_authority ? 'task4aContinuationId'
  or bad.developer_authority->'binding' is distinct from r.binding
  or bad.model is distinct from 'gpt-5.3-codex'
  or bad.owner_id is distinct from task4a_original_owner_id(p.actor_id,p.chat_id)
  or acct.arm<>'developer' or acct.developer_task_id is distinct from t.id
  or acct.developer_project_id is distinct from p.id or acct.id is null
  or acct.cap_tokens is distinct from 180000
  or acct.frozen_at is not null
  or a.id is null or a.revoked_at is not null or deadline<=clock_timestamp()+interval '60 seconds'
  or p.deadline<=clock_timestamp()
  or limits->>'cumulativeTokens' is distinct from '180000'
  or limits->>'developmentTokens' is distinct from '120000'
  or limits->>'ceilingMicrousd' is distinct from '2520000'
  or limits->>'developmentCalls' is distinct from '12'
  or limits->>'assessmentCalls' is distinct from '4'
  or limits->>'completionCalls' is distinct from '4'
  or exists(select 1 from benchmark_native_spending_approvals child where child.previous_developer_approval_id=bad.id)
  or exists(select 1 from benchmark_execution_grants g where g.developer_approval_id=bad.id)
  or exists(select 1 from benchmark_budget_calls c where c.account_id=acct.id)
  or exists(select 1 from mission_calls c join mission_assignments assignment on assignment.id=c.job_id where assignment.mission_id=m.id)
  or exists(select 1 from project_events e where e.project_id=p.id and e.event='task4a_native_pregrant_recovered')
 then return null;end if;
 proposal:=jsonb_build_object('version',1,'kind','task4a_preinference_failed_gate_replacement',
  'projectId',p.id,'missionId',m.id,'taskId',t.id,'ownerId',bad.owner_id,
  'oldApprovalId',bad.id,'accountId',acct.id,'continuationId',a.id,
  'issueNumber',969,'failedRunId',41673059705,
  'scopeHash',p.approved_hash,'contractHash',r.binding->>'contractHash',
  'baselineSha',p.baseline_sha,'model',bad.model,
  'limits',limits,'originalNativeDeadline',bad.deadline,
  'continuationDeadline',a.deadline,'replacementDeadline',deadline,
  'consumedNativeCalls',0,'consumedNativeTokens',0,
  'originalApprovalPreserved',true,'oldApprovalRevokedOnConsent',true,
  'sameAccountSameCeiling',true,'productionPublicationAllowed',false,
  'newExplicitOwnerConsentRequired',true);
 return jsonb_build_object('ready',true,'proposal',proposal,
  'digest',encode(sha256(convert_to(project_canonical(proposal),'UTF8')),'hex'));
end $$;
revoke all on function public.task4a_native_recovery_proposal() from public,anon,authenticated;
grant execute on function public.task4a_native_recovery_proposal() to service_role;

create or replace function public.task4a_confirm_pregrant_recovery(p_owner uuid,p_digest text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare visible jsonb; proposal jsonb;p work_projects;m agent_missions;
 j mission_assignments;t agent_tasks;
 bad benchmark_native_spending_approvals;child benchmark_native_spending_approvals;
 a project_continuation_authorizations; receipt uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into bad from benchmark_native_spending_approvals
  where id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid for update;
 select * into a from project_continuation_authorizations where id='405ea82c-6f52-49e5-babf-891ecac64d14'::uuid for update;
 select * into t from agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid for update;
 select * into j from mission_assignments where id=t.id for update;
 select * into m from agent_missions where id=j.mission_id for update;
 visible:=task4a_native_recovery_proposal();
 if visible is null or visible->>'digest' is distinct from p_digest
  or p_owner is null or bad.owner_id is distinct from p_owner
  or bad.owner_id is distinct from task4a_original_owner_id(p.actor_id,p.chat_id)
 then raise exception 'TASK4A_NATIVE_RECOVERY_STALE_OR_UNAUTHORIZED';end if;
 proposal:=visible->'proposal';
 -- Keep the old immutable approval and all historical owner decisions.
 update benchmark_native_spending_approvals set revoked_at=clock_timestamp() where id=bad.id;
 insert into benchmark_native_spending_approvals(
  owner_id,actor_id,chat_id,trial_id,account_id,repository,model,
  protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,
  developer_authority,previous_developer_approval_id)
 values(bad.owner_id,bad.actor_id,bad.chat_id,null,bad.account_id,bad.repository,bad.model,
  bad.protocol_digest,bad.max_tokens,(proposal->>'replacementDeadline')::timestamptz,
  bad.project_id,bad.mission_assignment_id,bad.task_id,
  bad.developer_authority||jsonb_build_object('task4aContinuationId',a.id,
   'task4aRecovery',jsonb_build_object(
    'version','preinference-invalid-handoff-v1','oldApprovalId',bad.id,
    'issueNumber',969,'runId',41673059705,'ownerConsentDigest',p_digest)),
  bad.id) returning * into child;
 update work_projects set status='running',lease=null,lease_until=null,impediment=null,
  detail='Owner-confirmed Task 4A native pre-inference authorization correction; same saved issue and task.' where id=p.id;
 update agent_missions set status='running',detail='Recovering one original Task 4A native pre-inference dispatch.' where id=m.id;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,
  detail='Original Task 4A native handoff failed before inference; owner-confirmed corrected dispatch.',
  available_at=now() where id=j.id;
 update agent_tasks set status='dispatching',details='Owner-confirmed continuation-bound native dispatch, original issue retained.'
  where id=t.id;
 if not task4a_native_authority_ready(p.id,t.id,a.id)
 then raise exception 'TASK4A_NATIVE_RECOVERY_AUTHORITY_NOT_LIVE';end if;
 insert into project_events(project_id,event,data) values(p.id,'task4a_native_pregrant_recovered',
  jsonb_build_object('version',1,'originalTaskId',t.id,'originalIssueNumber',969,
   'originalRunId',41673059705,'previousApprovalId',bad.id,
   'replacementApprovalId',child.id,'continuationId',a.id,'ownerId',p_owner,
   'consentDigest',p_digest,'originalApproval',to_jsonb(bad),
   'replacementApproval',to_jsonb(child),'proposal',proposal,
   'originalTaskExternal',t.external,'originalAssignmentResult',j.result,
   'paidCallsCreated',0,'accountReused',true,'limitsNotIncreased',true))
 returning id into receipt;
 perform project_publish(p.id,'Task 4A owner-confirmed native authority repair saved. Original issue #969 is eligible for a single bounded redispatch; protected preview remains required.');
 return jsonb_build_object('recovered',true,'receiptId',receipt,'projectId',p.id,
  'taskId',t.id,'originalIssueNumber',969,'oldApprovalId',bad.id,
  'newApprovalId',child.id,'continuationId',a.id,'nativeDeadline',child.deadline,
  'ownerConsentRecorded',true,'developmentDispatched',false);
end $$;
revoke all on function public.task4a_confirm_pregrant_recovery(uuid,text) from public,anon,authenticated;
grant execute on function public.task4a_confirm_pregrant_recovery(uuid,text) to service_role;

create or replace function public.task4a_pregrant_redispatch_ready(p_task uuid,p_approval uuid)
returns boolean language plpgsql stable set search_path=public as $$
declare a benchmark_native_spending_approvals;t agent_tasks;
begin
 select * into a from benchmark_native_spending_approvals
  where id=p_approval and task_id=p_task;
 select * into t from agent_tasks where id=p_task;
 return coalesce(a.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
  and a.previous_developer_approval_id='ddccc7a1-743f-4031-8ecd-a6926568ca98'::uuid
  and a.developer_authority->'task4aRecovery'->>'version'='preinference-invalid-handoff-v1'
  and a.developer_authority->'task4aRecovery'->>'oldApprovalId'=a.previous_developer_approval_id::text
  and t.external->>'issueNumber'='969'
  and t.external->'receipt'->>'run_id'='41673059705'
  and t.external->'receipt'->>'outcome'='BLOCKED'
  and t.external->'receipt'->>'pr_url' is null
  and t.external->>'developerApprovalId' in (a.previous_developer_approval_id::text,a.id::text)
  and t.status='dispatching'
  and not exists(select 1 from benchmark_budget_calls c where c.account_id=a.account_id)
  and not exists(select 1 from benchmark_execution_grants g where g.developer_approval_id=a.id)
  and not exists(select 1 from mission_calls c join mission_assignments j on j.id=c.job_id
    where j.id=p_task)
  and a.revoked_at is null and a.consumed_at is null
  and a.deadline>clock_timestamp()
  and exists(select 1 from benchmark_native_spending_approvals old
   where old.id=a.previous_developer_approval_id and old.revoked_at is not null
    and old.consumed_at is null)
  and exists(select 1 from project_events e where e.project_id=a.project_id
   and e.event='task4a_native_pregrant_recovered'
   and e.data->>'replacementApprovalId'=a.id::text
   and e.data->>'consentDigest'=a.developer_authority->'task4aRecovery'->>'ownerConsentDigest')
  and task4a_native_authority_ready(a.project_id,p_task,
   (a.developer_authority->>'task4aContinuationId')::uuid),false);
end $$;
revoke all on function public.task4a_pregrant_redispatch_ready(uuid,uuid) from public,anon,authenticated;
grant execute on function public.task4a_pregrant_redispatch_ready(uuid,uuid) to service_role;
