-- A trusted newer infrastructure release can justify ONE verification-only
-- replay of a blocked approved code increment, without another coding cycle.
-- The supervisor verifies the GitHub release/test artifacts and exact PR SHA
-- before calling this service-only locked transition.
do $migration$
begin
create function public.reverify_project_after_existing_fix(
 p_case uuid,p_lease uuid,p_issue bigint,p_pr bigint,p_head text,p_release_sha text
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare c recovery_cases;p work_projects;m agent_missions;j mission_assignments;t agent_tasks;used bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into c from recovery_cases where id=p_case and status='claimed'
  and source_type='project' and lease=p_lease and lease_until>now() for update;
 if not found or p_issue<1 or p_pr<1 or p_head !~ '^[a-f0-9]{40}$'
  or p_release_sha !~ '^[a-f0-9]{40}$' or p_head=p_release_sha then return null;end if;
 if exists(select 1 from recovery_events where case_id=c.id and event='existing_fix_reverification') then return null;end if;
 select * into p from work_projects where id=c.source_id and actor_id=c.actor_id and chat_id=c.chat_id
  and status='blocked' and phase='development' and active_mission_id is not null
  and approved_hash is not null and approved_hash=approval_hash and deadline>now() for update;
 if not found then return null;end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id
  and status='blocked' and project_kind='development' for update;
 if not found then return null;end if;
 select * into j from mission_assignments where mission_id=m.id and role='development' and status='failed'
  and result->'external'->'receipt'->>'outcome'='BLOCKED'
  and result->'external'->'receipt'->>'issue_number'=p_issue::text
  and result->'external'->'receipt'->>'tested_head_sha'=p_head for update;
 if not found then return null;end if;
 select * into t from agent_tasks where id=j.id and status='blocked' and
  external->>'issueNumber'=p_issue::text and
  external->>'prUrl'='https://github.com/'||repository_full_name||'/pull/'||p_pr for update;
 if not found then return null;end if;
 if not exists(select 1 from project_runs where project_id=p.id and mission_id=m.id
   and kind='development' and milestone_index=p.milestone_index and outcome is null
   and binding->>'scopeHash'=p.approved_hash) then return null;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into used from agent_missions where project_id=p.id;
 if used>=p.token_allowance then return null;end if;
 update agent_tasks set status='submitted',details='Independent same-commit re-verification after newer trusted infrastructure release.',
  external=coalesce(external,'{}'::jsonb)||jsonb_build_object(
   'verificationSince',(now()-interval '1 minute')::text,'verificationSha',p_head,'verificationPr',p_pr),
  updated_at=now() where id=t.id;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),
  detail='Existing project commit re-verification after trusted infrastructure update.',updated_at=now() where id=j.id;
 update agent_missions set status='running',detail='Retesting unchanged reviewed code against repaired infrastructure.',
  updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,
  detail='Independent retest of existing approved code after newer infrastructure release. No coding cycle consumed.',
  updated_at=now() where id=p.id;
 update recovery_cases set status='verifying',category='verification_infrastructure',strategy='reverify_existing',
  details='Trusted infrastructure changed; original code is undergoing same-commit browser verification.',
  lease=null,lease_until=null,updated_at=now() where id=c.id;
 insert into recovery_events(case_id,event,evidence) values(c.id,'existing_fix_reverification',
  jsonb_build_object('original_sha',p_head,'release_sha',p_release_sha,'mission',m.id,
   'prior_cycles',p.cycles,'charged_tokens',used));
 return jsonb_build_object('status','running','cycles',p.cycles,'mission',m.id);
end $$;
exception when duplicate_function then null;
end $migration$;
revoke all on function public.reverify_project_after_existing_fix(uuid,uuid,bigint,bigint,text,text)
 from public,anon,authenticated;
grant execute on function public.reverify_project_after_existing_fix(uuid,uuid,bigint,bigint,text,text) to service_role;
