-- Resume the exact original approved project after a separately verified
-- infrastructure repair has been merged by the human owner. This does not
-- alter the original coding scope, grant a new permission, or spawn a new
-- coding mission. The coordinator verifies the GitHub release separately.
do $migration$
begin
create function public.resume_project_after_recovery(
 p_case uuid,p_actor uuid,p_chat uuid,p_original_issue bigint,p_original_pr bigint,p_original_sha text
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare c recovery_cases;p work_projects;m agent_missions;j mission_assignments;t agent_tasks;used bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into c from recovery_cases where id=p_case and actor_id=p_actor and chat_id=p_chat
  and status='awaiting_release' and category='verification_infrastructure' and strategy='scoped_repair'
  and repair_pr_url is not null and repair_head_sha~'^[a-f0-9]{40}$' for update;
 if not found then return null;end if;
 select * into p from work_projects where id=c.source_id and actor_id=p_actor and chat_id=p_chat
  and status='blocked' and phase='development' and active_mission_id is not null
  and approved_hash is not null and approved_hash=approval_hash and deadline>now() for update;
 if not found or p_original_issue<1 or p_original_pr<1 or p_original_sha!~'^[a-f0-9]{40}$' then return null;end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id and status='blocked'
  and project_kind='development' for update;
 if not found then return null;end if;
 select * into j from mission_assignments where mission_id=m.id and role='development' and status='failed'
  and result->'external'->'receipt'->>'outcome'='BLOCKED'
  and result->'external'->'receipt'->>'tested_head_sha'=p_original_sha
  and result->'external'->'receipt'->>'issue_number'=p_original_issue::text for update;
 if not found then return null;end if;
 select * into t from agent_tasks where id=j.id and status='blocked'
  and external->>'issueNumber'=p_original_issue::text
  and external->>'prUrl'='https://github.com/'||repository_full_name||'/pull/'||p_original_pr for update;
 if not found then return null;end if;
 if not exists(select 1 from project_runs where project_id=p.id and mission_id=m.id and kind='development'
   and outcome is null and milestone_index=p.milestone_index and binding->>'scopeHash'=p.approved_hash) then return null;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into used from agent_missions where project_id=p.id;
 if used>=p.token_allowance then return null;end if;
 if exists(select 1 from recovery_events where case_id=c.id and event='original_project_resumed') then return null;end if;
 update agent_tasks set status='submitted',details='Existing code verification resumed after owner-released infrastructure fix.',
  external=coalesce(external,'{}'::jsonb)||jsonb_build_object('verificationSince',(now()-interval '1 minute')::text,
   'verificationSha',p_original_sha,'verificationPr',p_original_pr),
  updated_at=now() where id=t.id;
 update mission_assignments set status='waiting_external',detail='Original code awaiting post-repair independent verification.',
  lease=null,lease_until=null,available_at=now(),updated_at=now() where id=j.id;
 update agent_missions set status='running',detail='Retesting original code after verified repair release.',
  updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,detail='Rechecking original approved code after released repair. Coding cycles unchanged.',
  updated_at=now() where id=p.id;
 update recovery_cases set status='verifying',
  details='Owner-released repair is verified; original code re-verification was dispatched without recoding.',
  updated_at=now() where id=c.id;
 insert into recovery_events(case_id,event,evidence) values(c.id,'original_project_resumed',
  jsonb_build_object('original_mission',m.id,'original_issue',p_original_issue,'original_pr',p_original_pr,
    'original_sha',p_original_sha,'original_cycles',p.cycles,'charged_tokens',used));
 return jsonb_build_object('status','running','cycles',p.cycles,'mission',m.id);
end $$;
exception when duplicate_function then null;
end $migration$;
revoke all on function public.resume_project_after_recovery(uuid,uuid,uuid,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.resume_project_after_recovery(uuid,uuid,uuid,bigint,bigint,text) to service_role;
