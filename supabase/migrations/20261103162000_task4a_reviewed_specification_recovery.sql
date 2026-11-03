-- One-shot, owner-authenticated saved-specification recovery for the original Task 4A.
-- This migration installs controls only; it does not change production data.
-- A server route must authenticate the real owner and validateProjectPlan() before RPC.
create or replace function public.recover_task4a_reviewed_specification(
 p_actor uuid, p_chat uuid, p_source_hash text, p_review_hash text,
 p_corrected jsonb, p_corrected_hash text, p_baseline_sha text
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare
 p public.work_projects;
 m public.agent_missions;
 revision public.mission_assignments;
 reviewer public.mission_assignments;
 authority public.project_continuation_authorizations;
 source_spec jsonb; checked_spec jsonb; scope_data jsonb;
 source_hash text; review_hash text; corrected_hash text; scope_hash text;
 repo_name text; used_tokens bigint; used_calls bigint; consumed_tokens bigint; consumed_calls bigint;
 receipt_id uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects
  where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
   and actor_id=p_actor and chat_id=p_chat for update;
 if p.id is null or p.chat_id is distinct from 'e53defeb-16eb-457e-aa07-435141165ee8'::uuid
  or p.status<>'failed' or p.phase<>'specification'
  or p.active_mission_id is distinct from '20a837cb-98ae-470f-8308-8526d8dceed3'::uuid
  or p.profile is distinct from 'software'
  or p.spec is not null or p.approval_hash is not null or p.approved_hash is not null
  or p.baseline_sha is not null or p.verified_sha is not null
  or p.lease is not null or p.lease_until is not null
  or p.deadline<=clock_timestamp()
  or p.detail is distinct from
    'Project coordination error: Error; Scope requires isolated application/source/test paths; dependencies, secrets and deployment configuration need a separate decision'
 then raise exception 'Task 4A original failed state or owner identity changed';end if;
 if exists(select 1 from public.project_events e where e.project_id=p.id
  and e.event='task4a_saved_specification_recovered') then
  raise exception 'Task 4A saved specification already recovered';end if;
 select r.repository_full_name into repo_name from public.repo_sync_runs r where r.id=p.repository_id;
 if repo_name is distinct from 'mfackrell/katie'
  or p_baseline_sha !~ '^[a-f0-9]{40}$'
 then raise exception 'Repository binding or verified baseline unavailable';end if;
 select * into authority from public.project_continuation_authorizations a
  where a.project_id=p.id and a.actor_id=p.actor_id and a.chat_id=p.chat_id for update;
 if authority.id is null or authority.revoked_at is not null
  or authority.deadline<=clock_timestamp()
  or authority.source_mission_id is distinct from 'd35b71d3-fbe2-4e9b-8bde-4d0fe8c9968e'::uuid
 then raise exception 'Task 4A original financial authority expired or changed';end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0),
        coalesce(sum(calls+routing_calls),0)
  into used_tokens,used_calls from public.agent_missions where project_id=p.id;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0),
        coalesce(sum(calls+routing_calls),0)
  into consumed_tokens,consumed_calls from public.agent_missions
  where project_id=p.id and created_at>=authority.authorized_at;
 if used_tokens>p.token_allowance
  or consumed_tokens>authority.incremental_tokens or consumed_calls>authority.incremental_calls
  or exists(select 1 from public.mission_calls c
   join public.mission_assignments j on j.id=c.job_id
   join public.agent_missions am on am.id=j.mission_id
   where am.project_id=p.id and c.status<>'completed')
 then raise exception 'Task 4A historical accounting or financial admission unsafe';end if;
 select * into m from public.agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if m.id is null or m.status<>'completed' or m.project_kind<>'specification'
  or m.result is null or m.result=''
  or exists(select 1 from public.mission_assignments j where j.mission_id=m.id and j.status<>'completed')
  or (select count(*) from public.mission_assignments j where j.mission_id=m.id)<>5
 then raise exception 'Task 4A completed specification evidence changed';end if;
 select * into revision from public.mission_assignments
  where id='08a62aa5-e4c0-49a3-ae9d-ae5b77275a71'::uuid
   and mission_id=m.id and job_key='revision' and role='revise'
   and status='completed' and attempts=1 for update;
 select * into reviewer from public.mission_assignments
  where id='dd46bc5a-50cf-49fe-a8dd-ab36e52d6d73'::uuid
   and mission_id=m.id and job_key='review_again' and role='review'
   and status='completed' and attempts=1 for update;
 if revision.id is null or reviewer.id is null or reviewer.result->>'verdict'<>'pass'
  or jsonb_typeof(reviewer.result->'checks')<>'array'
  or jsonb_array_length(reviewer.result->'checks')<>6
  or exists(select 1 from jsonb_array_elements(reviewer.result->'checks') c
       where c->>'passed' is distinct from 'true')
 then raise exception 'Original independent review PASS lineage missing';end if;
 begin
  source_spec:=(revision.result->>'text')::jsonb;
 exception when others then
  raise exception 'Saved revised specification cannot be parsed';
 end;
 if source_spec is distinct from m.result::jsonb
  or source_spec->'allowedPaths' is distinct from '["/project-pilots/task4a-preview-probe/"]'::jsonb
  or source_spec->'finalContract'->>'path' is distinct from '/project-pilots/task4a-preview-probe/'
  or jsonb_array_length(source_spec->'milestones')<>1
  or source_spec->'milestones'->0->'contract' is distinct from source_spec->'finalContract'
 then raise exception 'Saved specification or original browser contract changed';end if;
 source_hash:=encode(sha256(convert_to(public.project_canonical(source_spec),'UTF8')),'hex');
 review_hash:=encode(sha256(convert_to(public.project_canonical(reviewer.result),'UTF8')),'hex');
 if source_hash is distinct from p_source_hash
  or review_hash is distinct from p_review_hash
 then raise exception 'Saved specification/review integrity hash mismatch';end if;
 checked_spec:=jsonb_set(source_spec,'{allowedPaths}',
  '["app/project-pilots/task4a-preview-probe/"]'::jsonb,false);
 if p_corrected is distinct from checked_spec
  or p_corrected->'finalContract' is distinct from source_spec->'finalContract'
  or p_corrected->'milestones' is distinct from source_spec->'milestones'
  or p_corrected->'requirements' is distinct from source_spec->'requirements'
 then raise exception 'Recovery attempted to change more than allowedPaths';end if;
 corrected_hash:=encode(sha256(convert_to(public.project_canonical(checked_spec),'UTF8')),'hex');
 if corrected_hash is distinct from p_corrected_hash
 then raise exception 'Corrected specification canonical hash mismatch';end if;
 scope_data:=jsonb_build_object(
  'objective',p.objective,'clarifications',p.clarifications,
  'spec',checked_spec,'repository',p.repository_id,
  'repository_name',repo_name,'baseline',p_baseline_sha,
  'max_cycles',p.max_cycles,'max_missions',p.max_missions,
  'token_allowance',p.token_allowance,'deadline',p.deadline
 );
 scope_hash:=encode(sha256(convert_to(public.project_canonical(scope_data),'UTF8')),'hex');
 insert into public.project_events(project_id,event,data) values(
  p.id,'task4a_saved_specification_recovered',jsonb_build_object(
   'version',1,'sourceMissionId',m.id,'sourceRevisionJobId',revision.id,
   'sourceReviewJobId',reviewer.id,
   'sourceArtifact',source_spec,'originalRevisionResult',revision.result,
   'originalReviewResult',reviewer.result,
   'sourceHash',source_hash,'reviewHash',review_hash,
   'correctedArtifact',checked_spec,'correctedHash',corrected_hash,
   'correction',jsonb_build_object(
    'pointer','/allowedPaths/0','before','/project-pilots/task4a-preview-probe/',
    'after','app/project-pilots/task4a-preview-probe/'),
   'sourceReviewOnly',true,'correctedBytesReviewedByModel',false,
   'validatedBy','validateProjectPlan','scopeHash',scope_hash,
   'baselineSha',p_baseline_sha,'financialAuthorityId',authority.id,
   'historicalTokens',used_tokens,'historicalCalls',used_calls,
   'remainingAuthorityTokens',authority.incremental_tokens-consumed_tokens,
   'remainingAuthorityCalls',authority.incremental_calls-consumed_calls,
   'developmentApproved',false
  )) returning id into receipt_id;
 update public.project_runs set outcome=jsonb_build_object(
  'savedSpecificationRecovery',true,'originalReviewPreserved',true,
  'sourceReviewJobId',reviewer.id,'originalHash',source_hash,
  'correctedHash',corrected_hash,'recoveryReceiptId',receipt_id)
  where project_id=p.id and mission_id=m.id and kind='specification' and outcome is null;
 if not found then raise exception 'Original specification run is not recoverable';end if;
 update public.work_projects set spec=checked_spec,repository_full_name=repo_name,
  baseline_sha=p_baseline_sha,approval_hash=scope_hash,approved_hash=null,
  status='awaiting_approval',phase='approval',active_mission_id=null,
  detail='Task 4A saved specification path corrected and structurally validated; original review retained as source evidence. Explicit owner scope approval is required.',
  impediment=null,updated_at=clock_timestamp() where id=p.id;
 perform public.project_publish(p.id,public.project_scope_proposal(p.id));
 return jsonb_build_object('recovered',true,'receiptId',receipt_id,
  'projectId',p.id,'sourceHash',source_hash,'reviewHash',review_hash,
  'correctedHash',corrected_hash,'scopeHash',scope_hash,
  'status','awaiting_approval','scopeApprovalRequired',true,
  'historicalTokens',used_tokens,'historicalCalls',used_calls,
  'continuationDeadline',authority.deadline);
end $$;
revoke all on function public.recover_task4a_reviewed_specification(
 uuid,uuid,text,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.recover_task4a_reviewed_specification(
 uuid,uuid,text,text,jsonb,text,text) to service_role;

-- One original project, one audited recovery. Evidence is append-only.
create unique index if not exists task4a_single_saved_specification_recovery
 on public.project_events(project_id)
 where event='task4a_saved_specification_recovered';
create or replace function public.task4a_lock_saved_specification_evidence()
returns trigger language plpgsql set search_path=public as $$
begin
 if old.event='task4a_saved_specification_recovered' then
  raise exception 'Saved Task 4A specification recovery evidence is immutable';
 end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger task4a_saved_specification_evidence_immutable
 before update or delete on public.project_events
 for each row execute function public.task4a_lock_saved_specification_evidence();
