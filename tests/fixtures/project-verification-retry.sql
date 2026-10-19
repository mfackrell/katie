-- Isolated transactional regression for the unchanged-code retry.
DO $$ declare p work_projects;m agent_missions;j mission_assignments;t agent_tasks;
 receipt jsonb;args jsonb;used bigint;res jsonb;
begin
 begin
  select * into strict p from work_projects where id='44444444-4444-4444-8444-444444444444';
  select * into strict m from agent_missions where id=p.active_mission_id;
  select * into strict j from mission_assignments where mission_id=m.id and role='development';
  select * into strict t from agent_tasks where id=j.id;
  select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into used from agent_missions where project_id=p.id;
  update work_projects set status='blocked',token_allowance=600000 where id=p.id;
  update agent_missions set status='blocked' where id=m.id;
  receipt:=jsonb_build_object('outcome','BLOCKED','run_id',39177788633,'issue_number',535,
    'tested_head_sha',repeat('a',40),'checks',jsonb_build_object('test','false','review','pass','repair','failure'));
  update mission_assignments set status='failed',result=jsonb_build_object('external',jsonb_build_object('receipt',receipt)) where id=j.id;
  update agent_tasks set status='blocked',external=jsonb_build_object(
    'issueNumber',535,'prUrl','https://github.com/owner/repo/pull/536') where id=j.id;
  res:=retry_project_verification(p.id,gen_random_uuid(),p.chat_id,m.id,535,39177788633,536,repeat('a',40));
  if res is not null then raise exception 'Wrong actor retried verification';end if;
  res:=retry_project_verification(p.id,p.actor_id,p.chat_id,m.id,535,39177788634,536,repeat('a',40));
  if res is not null then raise exception 'Wrong run retried verification';end if;
  res:=retry_project_verification(p.id,p.actor_id,p.chat_id,m.id,535,39177788633,537,repeat('a',40));
  if res is not null then raise exception 'Wrong PR retried verification';end if;
  res:=retry_project_verification(p.id,p.actor_id,p.chat_id,m.id,535,39177788633,536,repeat('b',40));
  if res is not null then raise exception 'Wrong SHA retried verification';end if;
  res:=retry_project_verification(p.id,p.actor_id,p.chat_id,m.id,535,39177788633,536,repeat('a',40));
  if res->>'status'<>'running' or (res->>'cycles')::int<>p.cycles or res->>'mission'<>m.id::text then
    raise exception 'Verification-only recovery failed to retain original mission/cycles';end if;
  if retry_project_verification(p.id,p.actor_id,p.chat_id,m.id,535,39177788633,536,repeat('a',40)) is not null then
    raise exception 'Verification-only recovery was duplicated';end if;
  if (select approved_hash from work_projects where id=p.id) is distinct from p.approved_hash or
     (select active_mission_id from work_projects where id=p.id)<>m.id or
     (select cycles from work_projects where id=p.id)<>p.cycles or
     (select status from agent_tasks where id=j.id)<>'submitted' or
     (select status from mission_assignments where id=j.id)<>'waiting_external' or
     (select count(*) from project_events where project_id=p.id and event='verification_retry')<>1 then
    raise exception 'Verification-only retry lost approval, task state, or audit record';end if;
  if (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)<>used then
    raise exception 'Verification-only retry reset or increased model spending';end if;
  raise exception using errcode='P2004',message='rollback verification fixture';
 exception when sqlstate 'P2004' then null;end;
end $$;
