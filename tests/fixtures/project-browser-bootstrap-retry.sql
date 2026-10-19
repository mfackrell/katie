-- The browser-bootstrap retry remains pinned to the original approved
-- development mission and exact immutable PR head, with unchanged model usage.
DO $$ declare p work_projects;m agent_missions;j mission_assignments;used bigint;res jsonb;receipt jsonb;
begin
 begin
  select * into strict p from work_projects where id='44444444-4444-4444-8444-444444444444';
  select * into strict m from agent_missions where id=p.active_mission_id;
  select * into strict j from mission_assignments where mission_id=m.id and role='development';
  select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into used from agent_missions where project_id=p.id;
  update work_projects set status='blocked',token_allowance=600000 where id=p.id;
  update agent_missions set status='blocked' where id=m.id;
  insert into project_events(project_id,event,data) values(p.id,'verification_retry',
    jsonb_build_object('mission_id',m.id,'run',39179517270));
  receipt:=jsonb_build_object('outcome','BLOCKED','run_id',39182519377,'issue_number',539,
   'tested_head_sha',repeat('a',40),'checks',jsonb_build_object('test','false','review','changes_requested','repair','skipped'));
  update mission_assignments set status='failed',result=jsonb_build_object('external',jsonb_build_object('receipt',receipt)) where id=j.id;
  update agent_tasks set status='blocked',external=jsonb_build_object(
    'issueNumber',539,'prUrl','https://github.com/owner/repo/pull/540',
    'verificationSha',repeat('a',40),'verificationPr',540) where id=j.id;
  res:=retry_project_browser_bootstrap(p.id,gen_random_uuid(),p.chat_id,m.id,539,39182519377,540,repeat('a',40));
  if res is not null then raise exception 'Foreign actor retried browser verification';end if;
  res:=retry_project_browser_bootstrap(p.id,p.actor_id,p.chat_id,m.id,539,39182519378,540,repeat('a',40));
  if res is not null then raise exception 'Wrong browser run retried verification';end if;
  res:=retry_project_browser_bootstrap(p.id,p.actor_id,p.chat_id,m.id,539,39182519377,541,repeat('a',40));
  if res is not null then raise exception 'Wrong PR retried browser verification';end if;
  res:=retry_project_browser_bootstrap(p.id,p.actor_id,p.chat_id,m.id,539,39182519377,540,repeat('b',40));
  if res is not null then raise exception 'Wrong SHA retried browser verification';end if;
  res:=retry_project_browser_bootstrap(p.id,p.actor_id,p.chat_id,m.id,539,39182519377,540,repeat('a',40));
  if res->>'status'<>'running' or (res->>'cycles')::integer<>p.cycles or res->>'mission'<>m.id::text then
    raise exception 'Existing coding mission not preserved';end if;
  if retry_project_browser_bootstrap(p.id,p.actor_id,p.chat_id,m.id,539,39182519377,540,repeat('a',40)) is not null then
    raise exception 'Duplicate browser bootstrap retry admitted';end if;
  if (select active_mission_id from work_projects where id=p.id)<>m.id or
     (select cycles from work_projects where id=p.id)<>p.cycles or
     (select approved_hash from work_projects where id=p.id) is distinct from p.approved_hash or
     (select status from agent_tasks where id=j.id)<>'submitted' or
     (select status from mission_assignments where id=j.id)<>'waiting_external' then
    raise exception 'Browser retry changed coding mission, budget, or scope';end if;
  if (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)<>used then
    raise exception 'Browser retry changed charged token accounting';end if;
  raise exception using errcode='P2114',message='rollback browser bootstrap fixture';
 exception when sqlstate 'P2114' then null;end;
end $$;