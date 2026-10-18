-- Keep informational project notes from forcing a new scope approval and research loop.
create or replace function public.control_work_project(p_id uuid,p_actor uuid,p_chat uuid,p_action text,p_text text default '',p_hash text default null,p_repository uuid default null) returns jsonb language plpgsql security invoker set search_path=public as $$ declare p work_projects;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));select * into strict p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if p_action='status' then return to_jsonb(p);end if;
 -- Non-scope notes are events, not clarifications. No lease, budget, mission,
 -- approved scope, existing research or verified implementation is changed.
 if p_action='note' and p.status not in ('completed','stopped') then
  if length(trim(p_text)) not between 1 and 4000 then raise exception 'Project note exceeds permitted length';end if;
  insert into project_events(project_id,event,data) values(p.id,'note',jsonb_build_object('text',p_text,'phase',p.phase,'status',p.status,'active_mission_id',p.active_mission_id));
  return to_jsonb(p);
 end if;
 if p_action='amend' and p.status not in ('completed','stopped') then
  if length(trim(p_text)) not between 1 and 4000 or length(p.clarifications)+length(p_text)>8000 then raise exception 'Clarification exceeds project context limit';end if;
  if p.active_mission_id is not null then
   if exists(select 1 from agent_missions where id=p.active_mission_id and status in ('draft','running','awaiting_approval')) then perform control_mission(p.active_mission_id,'stop');end if;
   update project_runs set outcome=coalesce(outcome,'{}'::jsonb)||jsonb_build_object('superseded',true,'reason','Explicit user clarification requires revised scope approval') where mission_id=p.active_mission_id;
  end if;
  update work_projects set clarifications=clarifications||E'\nUSER AMENDMENT: '||p_text,approved_hash=null,approval_hash=null,spec=null,phase='research',status=case when p.status='paused' then 'paused' else 'running' end,active_mission_id=null,lease=null,lease_until=null,milestone_index=0,detail='Your project clarification is saved. I will revise research/specification and request a new scope approval; prior work and charges are preserved.'||case when p.status='paused' then ' The project remains paused until you explicitly resume it.' else '' end,updated_at=now() where id=p.id;
 elsif p_action in ('pause','stop') and p.status not in ('completed','stopped') then
  update work_projects set status=case when p_action='pause' then 'paused' else 'stopped' end,lease=null,lease_until=null,detail='Project '||p_action||'d. An already admitted external dispatch may still finish; no new work will be authorized.',updated_at=now() where id=p.id;
  update mission_assignments set status=case when role='development' and exists(select 1 from agent_tasks where id=mission_assignments.id) then 'waiting_external' else 'queued' end,lease=null,lease_until=null where mission_id=p.active_mission_id and status='running';
 elsif p_action='resume' and p.status in ('paused','blocked') and p.deadline>now() then
  if p.active_mission_id is not null and exists(select 1 from agent_missions where id=p.active_mission_id and (status in ('blocked','stopped') or deadline<=now())) then raise exception 'This milestone is blocked or expired. Explain the blocker before asking for a revised project scope; budgets are not reset by resume';end if;
  update work_projects set status='running',failures=0,detail='Resuming the saved project and its existing budgets.',updated_at=now() where id=p.id;
 elsif p_action='approve' and p.status='awaiting_approval' and p_hash=p.approval_hash and p.repository_id is not null and p.baseline_sha~'^[a-f0-9]{40}$' and p.deadline>now() then
  update work_projects set approved_hash=approval_hash,status='running',phase='development',milestone_index=0,active_mission_id=null,detail='Approved scoped project. Successive isolated draft increments and preview verification are authorized; production merge is not.',updated_at=now() where id=p.id;
 elsif p_action='answer' and p.status in ('awaiting_input','awaiting_approval') and p.approved_hash is null then
  if length(trim(p_text)) not between 1 and 4000 or length(p.clarifications)+length(p_text)>8000 then raise exception 'Clarification exceeds project context limit';end if;
  if p_repository is not null and not exists(select 1 from repo_sync_runs where id=p_repository) then raise exception 'Connected repository unavailable';end if;
  if p.verified_sha is not null and p_repository is not null and p_repository is distinct from p.repository_id then raise exception 'A verified project cannot silently change target repository; start a separate project for porting';end if;
  update work_projects set clarifications=clarifications||E'\nUSER CLARIFICATION: '||p_text,repository_id=coalesce(p_repository,repository_id),status='running',phase=case when spec is not null and p_repository is not null and lower(trim(p_text))=(select lower(repository_full_name) from repo_sync_runs where id=p_repository) then 'approval' when spec is not null then 'specification' else 'research' end,active_mission_id=null,approval_hash=null,lease=null,lease_until=null,detail='Incorporating your clarification before scope approval.',updated_at=now() where id=p.id;
 else raise exception 'Project action is unavailable or approval is stale';end if;
 insert into project_events(project_id,event,data) values(p.id,p_action,jsonb_build_object('text',p_text,'approval_hash',p_hash,'previous_status',p.status));
 select * into strict p from work_projects where id=p.id;perform project_publish(p.id,coalesce(p.detail,p.status));return to_jsonb(p);
end $$;
