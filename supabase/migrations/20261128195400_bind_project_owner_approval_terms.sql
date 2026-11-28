-- The ordinary owner approval must refer to the terms actually displayed.
-- Replace the old signature so omitting the snapshot cannot bypass the check.
begin;
drop function public.project_org_authorize(uuid,uuid,text,numeric,numeric,boolean);

create function public.project_org_authorize(
 p_owner uuid,p_project uuid,p_objective_hash text,p_ceiling numeric,
 p_per_call numeric,p_autonomous boolean,p_terms jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p work_projects;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project and organization_version=1
  and status not in ('completed','stopped','failed') and deadline>now() for update;
 if p.id is null or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 or p_objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
 or p_ceiling is null or p_per_call is null or p_ceiling<=0 or p_per_call<=0 or p_per_call>p_ceiling or p_ceiling>1000000000
 then raise exception 'Exact owner-approved objective and financial ceiling required';end if;
 if project_provider_mode(p.id) then raise exception 'Trial uses provider account controls';end if;
 -- Compare every displayed field while holding the row lock. Timestamp spelling
 -- may differ between PostgREST and JavaScript, but the exact instant must match.
 if p_terms is distinct from jsonb_build_object(
   'objective',p.objective,'clarifications',p.clarifications,
   'repositoryId',p.repository_id,'repository',p.repository_full_name,
   'deadline',p_terms->>'deadline','limits',jsonb_build_object(
     'codingJobs',p.max_cycles,'missions',p.max_missions,'modelTokens',p.token_allowance))
  or (p_terms->>'deadline')::timestamptz is distinct from p.deadline
 then raise exception 'Displayed project terms changed; refresh and approve the current terms';end if;
 if exists(select 1 from project_organization_authority where project_id=p.id) then
  if not exists(select 1 from project_organization_authority where project_id=p.id and owner_id=p_owner
    and objective_hash=p_objective_hash and ceiling_microusd=p_ceiling and per_call_microusd=p_per_call
    and autonomous_execution=p_autonomous) then raise exception 'Existing authority cannot be silently amended';end if;
  return true;
 end if;
 insert into project_organization_authority values(p.id,p_owner,p_objective_hash,p_ceiling,p_per_call,p_autonomous,now());
 insert into project_events(project_id,event,data) values(p.id,'organization_financial_authority',jsonb_build_object(
  'owner',p_owner,'objectiveHash',p_objective_hash,'ceilingMicrousd',p_ceiling,
  'perCallMicrousd',p_per_call,'autonomousExecution',p_autonomous,'terms',p_terms));
 return true;
end $$;
revoke all on function public.project_org_authorize(uuid,uuid,text,numeric,numeric,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.project_org_authorize(uuid,uuid,text,numeric,numeric,boolean,jsonb) to service_role;
commit;
