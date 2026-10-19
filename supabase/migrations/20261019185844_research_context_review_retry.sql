-- Retry one failed read-only research comparison after context compaction.
-- This reuses the same job and attempts; substantive rejection is not approval.
create or replace function public.retry_project_review(p_id uuid,p_actor uuid,p_chat uuid) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare p work_projects;m agent_missions;j mission_assignments;charged bigint;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into strict p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if p.status<>'blocked' or p.active_mission_id is null or p.deadline<=now() then return null;end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.project_kind is distinct from p.phase or m.deadline<=now() or m.calls>=m.max_calls or greatest(m.reserved_tokens,m.actual_tokens)>=m.token_allowance then return null;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged from agent_missions where project_id=p.id;
 if charged>=p.token_allowance then return null;end if;
 select * into j from mission_assignments where mission_id=m.id and role='review' and status='failed' and attempts=1
 and (result->>'detail'='Invalid task conflict provenance' or result->>'detail' like 'Independent assessment contract validation failed:%' or (m.project_kind='research' and m.project_evidence->'researchRecovery'->>'sourceMissionId' is not null and result->>'detail'='Mission evidence exceeds bounded context. Narrow the objective or deliverable.')) order by created_at limit 1 for update;
 if not found then return null;end if;
 update mission_assignments set status='queued',lease=null,lease_until=null,available_at=now(),
  result=coalesce(result,'{}'::jsonb)||case when j.result->>'detail'='Mission evidence exceeds bounded context. Narrow the objective or deliverable.' then jsonb_build_object('reviewPhase','comparison','contextRepairSource',j.result->>'detail') else jsonb_build_object('reviewPhase','assessment','reviewContractFeedback',left(j.result->>'detail',600)) end,
  detail='Retrying the failed independent review once against its original sources.',updated_at=now() where id=j.id;
 update agent_missions set status='running',detail='Retrying the failed independent review; existing calls, charges and deadline remain.',updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,detail='Retrying source validation for the saved independent review. Prior work, attempts, usage charges and limits are preserved.',updated_at=now() where id=p.id returning * into p;
 insert into project_events(project_id,event,data) values(p.id,'review_retry',jsonb_build_object('mission_id',m.id,'job_id',j.id,'attempts_used',j.attempts,'charged_tokens',charged));
 perform project_publish(p.id,p.detail);return to_jsonb(p);
end $$;
revoke all on function public.retry_project_review(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.retry_project_review(uuid,uuid,uuid) to service_role;
