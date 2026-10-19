-- One read-only repair mission may reuse completed research. Prior missions,
-- charges, deadlines, coding cycles and the aggregate project ceiling stay saved.
create function public.recover_project_research(p_id uuid,p_lease uuid default null) returns boolean
language plpgsql security invoker set search_path=public as $$
declare p work_projects;m agent_missions;r mission_assignments;mid uuid;charged bigint;seq integer;evidence jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id for update;
 if not found or p.phase<>'research' or p.status not in ('running','blocked') or p.deadline<=now() or p.active_mission_id is null then return false;end if;
 if p.status='running' and (p_lease is null or p.lease is distinct from p_lease or p.lease_until<=now()) then return false;end if;
 if p.status='blocked' and (p_lease is not null or p.lease_until>now()) then return false;end if;
 if exists(select 1 from project_events where project_id=p.id and event='research_review_recovery') then return false;end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.project_kind<>'research' or m.repository_id is not null or m.deadline<=now() then return false;end if;
 -- Recover substantive review findings only. Essential clarification, execution
 -- failures, active work and malformed contracts cannot enter this path.
 if exists(select 1 from mission_assignments where mission_id=m.id and (role='development' or status<>'completed')) then return false;end if;
 select * into r from mission_assignments where mission_id=m.id and job_key='review_again' and role='review'
  and result->>'verdict'='changes_requested' and coalesce(result->'clarification'->>'essential','false')='false';
 if not found or not exists(select 1 from mission_assignments where mission_id=m.id and job_key='revision' and role='revise' and length(result->>'text')>0) then return false;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged from agent_missions where project_id=p.id;
 seq:=(select count(*)+1 from project_runs where project_id=p.id);
 if p.token_allowance-charged<10000 or seq>p.max_missions then return false;end if;
 evidence:=coalesce(m.project_evidence,'{}'::jsonb)||jsonb_build_object('researchRecovery',jsonb_build_object(
  'sourceMissionId',m.id,'lastCandidate',(select result from mission_assignments where mission_id=m.id and job_key='revision'),
  'independentFindings',r.result));
 if length(evidence::text)>30000 then return false;end if;
 mid:=gen_random_uuid();perform create_mission(mid,m.objective,p.team,120,null);
 update agent_missions set team=m.team,token_allowance=least(120000,p.token_allowance-charged),project_id=p.id,project_kind='research',project_evidence=evidence where id=mid;
 perform control_mission(mid,'start');
 update agent_missions set deadline=least(m.deadline,p.deadline) where id=mid;
 update mission_assignments set status='completed',result='{"detail":"Reuse saved completed research; no new search or implementation."}' where mission_id=mid and job_key='plan';
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,result)
  select mid,job_key,role,agent_id,instruction,'{}',payload,'completed',result from mission_assignments where mission_id=m.id and role='work';
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies) values
  (mid,'compose','compose',(m.team->0->>'id')::uuid,'Repair the concise research deliverable using the saved source-supported work and researchRecovery findings. Remove peripheral detail while preserving every material original rule and later implementation/testing obligation. No new research or coding.',array(select job_key from mission_assignments where mission_id=mid and role='work')),
  (mid,'review','review',r.agent_id,'Independently verify the entire repaired research result against the original objective and saved sources. Do not waive material findings.',array['compose']);
 update project_runs set outcome=jsonb_build_object('research_review_recovery',true,'nextMissionId',mid) where mission_id=m.id and outcome is null;
 insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index) values(p.id,mid,'research',seq,p.milestone_index);
 update work_projects set status='running',active_mission_id=mid,lease=null,lease_until=null,
  detail='Repairing the saved research once with independent review. Prior work, charges, coding cycles and deadlines are preserved.',updated_at=now() where id=p.id returning * into p;
 insert into project_events(project_id,event,data) values(p.id,'research_review_recovery',jsonb_build_object('sourceMissionId',m.id,'missionId',mid,'chargedTokens',charged,'codingCycles',p.cycles));
 perform project_publish(p.id,p.detail);return true;
end $$;
revoke all on function public.recover_project_research(uuid,uuid) from public,anon,authenticated;
grant execute on function public.recover_project_research(uuid,uuid) to service_role;
