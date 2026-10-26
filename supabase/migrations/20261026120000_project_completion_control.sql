-- Add completion controls around the existing lifecycle. Its approval, budget,
-- lease, immutable-head and independent-acceptance gates remain authoritative.
alter table public.work_projects
 add column completion_contract jsonb,
 add column impediment jsonb,
 add column progress_signature text,
 add column progress_since timestamptz,
 add column error_signature text,
 add column repeated_errors integer not null default 0;
alter table public.work_projects drop constraint work_projects_status_check;
alter table public.work_projects add constraint work_projects_status_check
 check(status in ('running','awaiting_input','awaiting_approval','paused','blocked','stopped','completed','failed'));
drop index public.work_projects_active_chat;
create unique index work_projects_active_chat on public.work_projects(chat_id) where status not in ('completed','stopped','failed');

create function public.project_completion_contract() returns trigger language plpgsql set search_path=public as $$
begin
 -- Server-derived, never copied from worker instructions or approval flags.
 -- Team[1] is the saved project lead. Delegation never changes ownership.
 new.completion_contract:=jsonb_build_object('version',1,'ownerAgentId',new.team[1],
  'outcome',new.objective,'clarifications',new.clarifications,'scopeHash',new.approved_hash,
  'requirements',new.spec->'requirements','allowedPaths',new.spec->'allowedPaths',
  'acceptance',new.spec->'finalContract',
  'stoppingCondition','All approved milestones, immutable-head tests, independent review and deployed acceptance pass; then deliver to the originating conversation and stop.');
 if tg_op='UPDATE' and old.completion_contract is not null then
  new.completion_contract:=jsonb_set(new.completion_contract,'{ownerAgentId}',old.completion_contract->'ownerAgentId');
  -- Neither reviewers nor internal retries can mutate an approved contract.
  if old.approved_hash is not null and new.approved_hash=old.approved_hash and
     (new.spec is distinct from old.spec or new.objective is distinct from old.objective or new.clarifications is distinct from old.clarifications) then
   raise exception 'An approved completion contract requires an explicit scope amendment';
  end if;
 end if;
 return new;
end $$;
create trigger project_completion_contract before insert or update on public.work_projects
 for each row execute function public.project_completion_contract();
-- Metadata only: no authorizations, deadlines, charges, artifacts or history reset.
update public.work_projects set completion_contract=null;

alter function public.finish_work_project(uuid,uuid,text,jsonb) rename to finish_work_project_lifecycle;
revoke all on function public.finish_work_project_lifecycle(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
create function public.finish_work_project(p_id uuid,p_lease uuid,p_action text,p_data jsonb default '{}')
 returns boolean language plpgsql security definer set search_path=public as $$
declare p work_projects; signature text; action text:=p_action; payload jsonb:=p_data; ok boolean; terminal_failure boolean:=false; stall_window interval:=interval '45 minutes';
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'running' or p.lease is distinct from p_lease or p.lease_until<=now() or p.deadline<=now() then return false;end if;
 -- Existing engineering workflows can legitimately run for more than an hour.
 -- Preserve their two-hour reconciliation window; ordinary phase work is shorter.
 if exists(select 1 from agent_tasks t join mission_assignments j on j.id=t.id where j.mission_id=p.active_mission_id) then stall_window:=interval '2 hours';end if;
 -- Activity counters, polling timestamps and repeated analysis are not progress.
 -- Count completed artifacts and externally observed task transitions only.
 select md5(jsonb_build_object('phase',p.phase,'milestone',p.milestone_index,'mission',p.active_mission_id,'head',p.verified_sha,
  'completed',(select coalesce(jsonb_agg(jsonb_build_array(j.id,j.result) order by j.id),'[]') from mission_assignments j where j.mission_id=p.active_mission_id and j.status='completed'),
  'external',(select coalesce(jsonb_agg(jsonb_build_array(t.id,t.status,t.external->>'issueNumber',t.external->>'prNumber',t.external->>'runId',t.external->>'headSha') order by t.id),'[]') from agent_tasks t join mission_assignments j on j.id=t.id where j.mission_id=p.active_mission_id)
 )::text) into signature;
 if p.progress_signature is distinct from signature or p.progress_since is null then
  update work_projects set progress_signature=signature,progress_since=now(),error_signature=null,repeated_errors=0 where id=p.id;
 elsif action='wait' and p.progress_since<=now()-stall_window then
  action:='block';
  payload:=jsonb_build_object('detail','No new completed artifact or external execution transition for '||stall_window||' in '||p.phase||'. Work is blocked; saved results and charges are retained.',
   'impediment',jsonb_build_object('kind','blocked','step',p.phase,'impediment','Saved execution has made no observable progress for '||stall_window||'.',
    'attempted',jsonb_build_array('Inspected persisted assignment artifacts and external task transitions; repeated polling is not execution.'),
    'minimumAction','Restore the stalled worker or external workflow for the saved mission, then resume within the existing authorization.'));
 end if;
 if action='error' then
  if p.error_signature=md5(coalesce(payload->>'detail','')) and p.progress_signature=signature then
   update work_projects set repeated_errors=repeated_errors+1 where id=p.id;
   if p.repeated_errors>=1 then terminal_failure:=true;action:='block';end if;
  else update work_projects set error_signature=md5(coalesce(payload->>'detail','')),repeated_errors=1 where id=p.id;end if;
 end if;
 -- An unchanged failed repair is not permission for another coding cycle.
 if action='retry' then
  if jsonb_typeof(payload->'findings') is distinct from 'array' or jsonb_array_length(payload->'findings')=0 then
   raise exception 'A repair requires material failed acceptance evidence';
  end if;
  if exists(select 1 from project_events where project_id=p.id and event='retry' and data->'findings'=payload->'findings' and data->>'scopeHash'=p.approved_hash and (data->>'milestoneIndex')::integer=least(p.milestone_index,jsonb_array_length(p.spec->'milestones')-1)) then
   terminal_failure:=true;action:='block';payload:=payload||jsonb_build_object('detail','The same acceptance failure remains after targeted repair. Execution failed; no identical repair was started.');
  end if;
  payload:=payload||jsonb_build_object('scopeHash',p.approved_hash,'milestoneIndex',least(p.milestone_index,jsonb_array_length(p.spec->'milestones')-1));
 end if;
 if action='child' then
  payload:=jsonb_set(payload,'{evidence}',(case when jsonb_typeof(payload->'evidence')='object' then payload->'evidence' else '{}'::jsonb end)||jsonb_build_object('completionContract',
   jsonb_build_object('version',1,'ownerAgentId',p.completion_contract->>'ownerAgentId','scopeHash',p.approved_hash,'stoppingCondition',p.completion_contract->>'stoppingCondition')));
 end if;
 if action='complete' then
  -- The lifecycle below must still prove all original gates before publication.
  payload:=payload||jsonb_build_object('result','Completed: '||(p.spec->>'name')||E'.\n\nVerified commit: '||p.verified_sha||'. Independent implementation review and all '||jsonb_array_length(p.spec->'finalContract'->'scenarios')||E' approved deployed acceptance checks passed.\n\nVerified preview: '||(p.preview->>'url'));
 end if;
 ok:=finish_work_project_lifecycle(p_id,p_lease,action,payload);
 if not ok then return false;end if;
 if terminal_failure then
  update work_projects set status='failed',detail=payload->>'detail',impediment=jsonb_build_object('kind','failed','step',p.phase,'impediment',payload->>'detail',
   'attempted',jsonb_build_array('Retried within the saved scope; the same failure recurred without new execution evidence.'),
   'minimumAction','Correct the recorded execution defect before starting a new attempt. Existing artifacts, permissions and charges remain recorded.') where id=p.id;
  insert into project_events(project_id,event,data) values(p.id,'failed',jsonb_build_object('ownerAgentId',p.completion_contract->>'ownerAgentId','cause',payload));
  perform project_publish(p.id,'Failed: '||(payload->>'detail'));
 elsif action in ('block','input','error') then
  update work_projects set impediment=coalesce(payload->'impediment',jsonb_build_object('kind','blocked','step',p.phase,'impediment',payload->>'detail',
   'attempted',jsonb_build_array('Inspected the saved phase and available execution receipts.'),'minimumAction','Resolve the recorded impediment before resuming the saved project.')) where id=p.id;
 elsif action<>'wait' then update work_projects set impediment=null where id=p.id;
 end if;
 return true;
end $$;
revoke all on function public.finish_work_project(uuid,uuid,text,jsonb),public.project_completion_contract() from public,anon,authenticated;
grant execute on function public.finish_work_project(uuid,uuid,text,jsonb) to service_role;
