-- Service-only structural recovery, with no new composition attempt or charge.
-- The worker runs the full canonical validator before this exact-diff commit.
create function public.recover_specification_route(p_id uuid,p_job uuid,p_source text,p_original jsonb,p_scope text,p_plan jsonb)
returns boolean language plpgsql security invoker set search_path=public as $$
declare p work_projects; m agent_missions; j mission_assignments; c benchmark_full_continuations;
 raw jsonb; expected jsonb; contract jsonb; directories text[]; directory text; route text; old_path text; scopes text[];
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id for update;
 if not found or p.profile<>'game' or p.phase<>'specification' or p.status<>'blocked' or p.deadline<=now()
  or p.approved_hash is not null or (p.lease is not null and p.lease_until>now())
  or p_scope is distinct from p.objective||E'\n'||coalesce(p.clarifications,'') then return false;end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.project_kind<>'specification' or m.deadline<=now() then return false;end if;
 select * into j from mission_assignments where id=p_job and mission_id=m.id for update;
 if not found or j.role<>'compose' or j.job_key<>'compose' or j.status<>'failed'
  or j.result is distinct from p_original or j.result->>'rejectedSpecification' is distinct from p_source
  or (j.lease is not null and j.lease_until>now())
  or exists(select 1 from mission_assignments where mission_id=m.id and status in ('running','waiting_external','awaiting_approval'))
  or not exists(select 1 from mission_assignments where mission_id=m.id and job_key='review' and role='review' and status='queued' and dependencies=array['compose']::text[])
  or exists(select 1 from mission_assignments where mission_id=m.id and role not in ('plan','compose','review'))
  or exists(select 1 from mission_assignments where mission_id=m.id and role='review' and (job_key<>'review' or status<>'queued'))
  or exists(select 1 from mission_calls mc join mission_assignments a on a.id=mc.job_id where a.mission_id=m.id and (mc.status<>'completed' or mc.actual_tokens is null))
  or exists(select 1 from project_events where project_id=p.id and event='specification_route_recovered' and data->>'jobId'=j.id::text)
 then return false;end if;
 if exists(select 1 from benchmark_full_project_bindings where project_id=p.id) then
  select * into c from benchmark_full_continuations where project_id=p.id;
  if not found or not benchmark_continuation_live(c.id,c.account_id,p.id) or m.deadline>c.deadline
   or m.created_at<c.created_at or m.project_evidence->>'benchmarkContinuationId' is distinct from c.id::text
   or m.project_evidence->>'benchmarkContinuationPlanHash' is distinct from c.plan_hash
   or exists(select 1 from benchmark_budget_calls where account_id=c.account_id and (state<>'settled' or actual_tokens is null)) then return false;end if;
 end if;
 begin raw:=p_source::jsonb;exception when others then return false;end;
 if raw->>'specificationFormat' is distinct from 'registered-game-v1'
  or jsonb_typeof(raw->'milestones') is distinct from 'array' or jsonb_array_length(raw->'milestones')<>1
  or raw->'milestones'->0 ? 'contract'
  or jsonb_typeof(raw->'game'->'acceptance'->'scenarios') is distinct from 'array'
  or jsonb_typeof(raw->'allowedPaths') is distinct from 'array'
  or (raw->'finalContract')- 'path'<>'{}'::jsonb then return false;end if;
 select array_agg(rtrim(t,'.')) into scopes from unnest(regexp_split_to_array(p_scope,'[[:space:],;]+')) t;
 select array_agg(distinct t) into directories from unnest(scopes) t where t like 'app/%';
 if coalesce(cardinality(directories),0)<>1 or directories[1]!~'^app/([A-Za-z0-9_-]+/)+$' then return false;end if;
 directory:=directories[1];route:='/'||trim(trailing '/' from substring(directory from 5));old_path:=raw->'finalContract'->>'path';
 if old_path is null or old_path!~'^(tests|lib|components|public|docs)/[A-Za-z0-9_./-]+\.(mjs|cjs|js|ts|tsx|jsx|json|md|html|css)$' or not old_path=any(scopes)
  or not (raw->'allowedPaths') ? old_path or not (raw->'allowedPaths') ? directory then return false;end if;
 if not exists(select 1 from jsonb_array_elements(raw->'game'->'acceptance'->'scenarios') s where s->>'kind'='browser')
  or exists(select 1 from jsonb_array_elements(raw->'game'->'acceptance'->'scenarios') s where s->>'kind'='browser' and
   (not exists(select 1 from jsonb_array_elements(s->'steps') t where t->>'action'='goto')
    or exists(select 1 from jsonb_array_elements(s->'steps') t where t->>'action'='goto' and t->>'path' is distinct from route))) then return false;end if;
 select jsonb_build_object('path',route,'scenarios',jsonb_agg(jsonb_build_object('name',s->>'id','steps',s->'steps') order by ordinal)) into contract
  from jsonb_array_elements(raw->'game'->'acceptance'->'scenarios') with ordinality as scenarios(s,ordinal) where s->>'kind'='browser';
 expected:=jsonb_set(jsonb_set(raw-'specificationFormat','{finalContract}',contract),'{milestones,0,contract}',contract);
 -- Independently prohibit any gameplay, scope, test, or narrative modification.
 if expected is distinct from p_plan then return false;end if;
 insert into project_events(project_id,event,data) values(p.id,'specification_route_recovered',jsonb_build_object(
  'jobId',j.id,'missionId',m.id,'originalResult',j.result,'source',p_source,
  'sourceHash',encode(sha256(convert_to(p_source,'UTF8')),'hex'),
  'correctedCandidate',p_plan,'correctedHash',encode(sha256(convert_to(p_plan::text,'UTF8')),'hex'),
  'correction',jsonb_build_object('pointer','/finalContract/path','before',old_path,'after',route),
  'freshReviewRequired',true,'compositionInference',false,'attempts',j.attempts));
 update mission_assignments set status='completed',lease=null,lease_until=null,
  result=j.result||jsonb_build_object('text',p_plan::text,'sources','[]'::jsonb,'calculations','[]'::jsonb,
   'recovery',jsonb_build_object('kind','deterministic_application_route','freshReviewRequired',true)),
  detail='Saved draft structurally corrected and fully validated; independent review required.',updated_at=now() where id=j.id;
 update agent_missions set status='running',updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,
  detail='Saved specification route corrected without inference. Awaiting independent review.',updated_at=now() where id=p.id;
 return true;
end $$;
revoke all on function public.recover_specification_route(uuid,uuid,text,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.recover_specification_route(uuid,uuid,text,jsonb,text,jsonb) to service_role;
