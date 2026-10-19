-- Controlled end-to-end exercise of REAL durable PostgreSQL recovery
-- transitions. GitHub issue creation, CI results and owner release are
-- simulated by trusted fixture state; no production project is altered.
DO $$ declare p work_projects;m agent_missions;j mission_assignments;
 c recovery_cases;claimed jsonb;after jsonb;spent bigint;before_count int;
 begin
  begin
   select * into strict p from work_projects where id='44444444-4444-4444-8444-444444444444';
   select * into strict m from agent_missions where id=p.active_mission_id;
   select * into strict j from mission_assignments where mission_id=m.id and role='development';
   select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into spent from agent_missions where project_id=p.id;
   select count(*) into before_count from project_runs where project_id=p.id;

   -- Inject a failure in the trusted verification setup, NOT the gameplay.
   -- This is rollback-only and never changes the real user project.
   update work_projects set status='blocked',phase='development',cycles=7,
     token_allowance=600000,updated_at=now(),
     detail='Trusted baseline dependency preparation failed; candidate tests were not run'
    where id=p.id;
   update agent_missions set status='blocked',detail='Verification infrastructure blocked',updated_at=now() where id=m.id;
   update mission_assignments set status='failed',result=jsonb_build_object('external',
     jsonb_build_object('receipt',jsonb_build_object(
       'outcome','BLOCKED','issue_number',539,'tested_head_sha',repeat('a',40),
       'checks',jsonb_build_object('build','success','test','false','review','pass','repair','failure'))))
    where id=j.id;
   update agent_tasks set status='blocked',external=jsonb_build_object(
     'issueNumber',539,'prUrl','https://github.com/owner/repo/pull/540')
    where id=j.id;

   if discover_recovery_cases()<1 then raise exception 'Failure was not discovered by recovery control plane';end if;
   select * into strict c from recovery_cases where source_type='project' and source_id=p.id
    and source_revision='development:0:7:'||m.id::text;
   if c.status<>'observed' then raise exception 'Recovery discovery did not save an observed case';end if;
   claimed:=claim_recovery_case();
   if claimed->>'id'<>c.id::text or claimed->>'status'<>'claimed' then raise exception 'The detected failure was not leased';end if;
   if finish_recovery_case(c.id,gen_random_uuid(),'delegated','verification_infrastructure','scoped_repair','Wrong lease') is not null then
    raise exception 'Foreign worker forged a delegated repair';end if;

   -- Simulate owner-authorized specialist issue creation after the real
   -- classification tests select a narrow infrastructure repair path.
   after:=finish_recovery_case(c.id,(claimed->>'lease')::uuid,
     'delegated','verification_infrastructure','scoped_repair',
     'Recovery specialist delegated to a scoped draft PR',jsonb_build_object('synthetic',true,'phase','delegation'),
     'https://github.com/owner/repo/issues/77',null,repeat('b',40));
   if after->>'status'<>'delegated' or after->>'repair_issue_url'<>'https://github.com/owner/repo/issues/77' then
    raise exception 'Repair delegation was not durably recorded';end if;

   -- No source may resume merely because a repair issue exists.
   if resume_project_after_recovery(c.id,p.actor_id,p.chat_id,539,540,repeat('a',40)) is not null then
    raise exception 'Repair issue bypassed independent review and release gate';end if;
   -- The independent GitHub CI/review simulation sets awaiting_release.
   update recovery_cases set status='awaiting_release',
     repair_pr_url='https://github.com/owner/repo/pull/77',
     updated_at=now()
    where id=c.id and status='delegated';
   if resume_project_after_recovery(c.id,gen_random_uuid(),p.chat_id,539,540,repeat('a',40)) is not null then
    raise exception 'Foreign actor replayed the recovered project';end if;
   if resume_project_after_recovery(c.id,p.actor_id,p.chat_id,539,541,repeat('a',40)) is not null then
    raise exception 'Different original PR was admitted';end if;
   if resume_project_after_recovery(c.id,p.actor_id,p.chat_id,539,540,repeat('b',40)) is not null then
    raise exception 'Changed original head was admitted';end if;

   -- Owner merger and production proof are checked by the supervisor's
   -- Github adapter (in the paired JS test); this service-role RPC is invoked
   -- only after those checks.
   after:=resume_project_after_recovery(c.id,p.actor_id,p.chat_id,539,540,repeat('a',40));
   if after->>'status'<>'running' or (after->>'cycles')::integer<>7 or
      after->>'mission'<>m.id::text then raise exception 'Original mission was not restored';end if;
   if resume_project_after_recovery(c.id,p.actor_id,p.chat_id,539,540,repeat('a',40)) is not null then
     raise exception 'Repeated release caused duplicate resumption';end if;
   if (select count(*) from project_runs where project_id=p.id)<>before_count or
      (select active_mission_id from work_projects where id=p.id)<>m.id or
      (select cycles from work_projects where id=p.id)<>7 or
      (select approved_hash from work_projects where id=p.id) is distinct from p.approved_hash or
      (select status from agent_tasks where id=j.id)<>'submitted' or
      (select status from mission_assignments where id=j.id)<>'waiting_external' or
      (select status from recovery_cases where id=c.id)<>'verifying' then
     raise exception 'Resumption changed scope, coding cycle, actor, or assignment lineage';end if;
   if (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)<>spent then
     raise exception 'Recovery reset token accounting';end if;
   if (select count(*) from recovery_events where case_id=c.id and event='original_project_resumed')<>1 then
     raise exception 'Resumption lacked auditable verified release transition';end if;
   raise exception using errcode='P2199',message='controlled self-healing transaction rolled back';
  exception when sqlstate 'P2199' then null;end;
 end $$;