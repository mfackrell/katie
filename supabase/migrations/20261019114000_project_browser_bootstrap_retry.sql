do $migration$
begin
-- One additional same-code verification retry when an existing verification-only
-- run fails to start the browser due to the /tmp/fonts UID-mapped chown failure.
-- The trusted coordinator separately verifies the GitHub browser artifact.
-- Never mint a coding mission, overwrite reviewed source, or clear model charges.
create function public.retry_project_browser_bootstrap(
 p_id uuid,p_actor uuid,p_chat uuid,p_mission uuid,p_issue bigint,p_run bigint,p_pr bigint,p_head text
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare p work_projects;m agent_missions;j mission_assignments;t agent_tasks;charged bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status<>'blocked' or p.phase<>'development' or
 p.active_mission_id is distinct from p_mission or p.approved_hash is null or
 p.approved_hash is distinct from p.approval_hash or p.deadline<=now() or
 p_head !~ '^[a-f0-9]{40}$' or p_issue<1 or p_run<1 or p_pr<1 then return null;end if;
 if not exists(select 1 from project_events where project_id=p.id and event='verification_retry'
  and data->>'mission_id'=p_mission::text) or
 exists(select 1 from project_events where project_id=p.id and event='browser_bootstrap_retry'
  and data->>'mission_id'=p_mission::text) then return null;end if;
 select * into m from agent_missions where id=p_mission and project_id=p.id and status='blocked' and project_kind='development' for update;
 if not found then return null;end if;
 select * into j from mission_assignments where mission_id=p_mission and role='development' and status='failed'
  and result->'external'->'receipt'->>'outcome'='BLOCKED'
  and result->'external'->'receipt'->>'run_id'=p_run::text
  and result->'external'->'receipt'->>'issue_number'=p_issue::text
  and result->'external'->'receipt'->>'tested_head_sha'=p_head
  and result->'external'->'receipt'->'checks'->>'test'='false'
  and result->'external'->'receipt'->'checks'->>'review'='changes_requested'
  and result->'external'->'receipt'->'checks'->>'repair'='skipped'
 order by created_at limit 1 for update;
 if not found then return null;end if;
 select * into t from agent_tasks where id=j.id and status='blocked' for update;
 if not found or t.external->>'issueNumber' is distinct from p_issue::text or
 t.external->>'prUrl' is distinct from 'https://github.com/'||t.repository_full_name||'/pull/'||p_pr or
 t.external->>'verificationSha' is distinct from p_head or
 t.external->>'verificationPr' is distinct from p_pr::text then return null;end if;
 if not exists(select 1 from project_runs where project_id=p.id and mission_id=p_mission
  and kind='development' and outcome is null and milestone_index=p.milestone_index
  and binding->>'scopeHash'=p.approved_hash) then return null;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged from agent_missions where project_id=p.id;
 if charged>=p.token_allowance then return null;end if;
 insert into project_events(project_id,event,data) values(p.id,'browser_bootstrap_retry',
 jsonb_build_object('mission_id',m.id,'issue',p_issue,'failed_run',p_run,'pr',p_pr,'sha',p_head,
  'original_failure',j.result,'charged_tokens',charged,'reason','trusted Chromium font bootstrap failure'));
 update agent_tasks set status='submitted',
 details='Re-verifying the same saved commit after fixing trusted Chromium font setup.',
 external=coalesce(t.external,'{}'::jsonb)||jsonb_build_object(
  'verificationSince',(now()-interval '1 minute')::text,
  'verificationSha',p_head,'verificationPr',p_pr),
 updated_at=now() where id=t.id;
 update mission_assignments set status='waiting_external',
 detail='Browser initialization repaired; rechecking existing immutable code.',
 lease=null,lease_until=null,available_at=now(),updated_at=now() where id=j.id;
 update agent_missions set status='running',
 detail='Rechecking same approved code after browser bootstrap fix; original charges retained.',
 updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,
 detail='Verification-only browser retry of the same implementation; coding cycle count unchanged.',
 updated_at=now() where id=p.id returning * into p;
 perform project_publish(p.id,p.detail);
 return jsonb_build_object('status',p.status,'phase',p.phase,'cycles',p.cycles,'mission',p.active_mission_id);
end $$;
exception when duplicate_function then
 null;
end $migration$;
revoke all on function public.retry_project_browser_bootstrap(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.retry_project_browser_bootstrap(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text) to service_role;
