-- Retry one saved, uncharged provider-admission failure after its recorded
-- cooldown. Discovery and cooldown expiry never establish paid availability:
-- only the existing leased mission and atomic model ledger may probe inference.
create or replace function public.recover_mission_credit_failure(p_id uuid)
returns boolean language plpgsql set search_path=public as $$
declare p work_projects; m agent_missions; j mission_assignments; charged bigint;
 c benchmark_full_continuations; provider text; evidence jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'blocked' or p.active_mission_id is null or p.deadline<=now() or p.approved_hash is not null then return false;end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.deadline<=now() or m.calls>=m.max_calls or greatest(m.reserved_tokens,m.actual_tokens)>=m.token_allowance then return false;end if;
 if exists(select 1 from benchmark_full_project_bindings where project_id=p.id) then
  select * into c from benchmark_full_continuations where project_id=p.id;
  if not found or m.project_evidence->>'benchmarkContinuationId' is distinct from c.id::text
   or not benchmark_continuation_live(c.id,c.account_id,p.id) or m.created_at<c.created_at or m.deadline>c.deadline then return false;end if;
  provider:='openai';
 else provider:=null;end if;
 select * into j from mission_assignments where mission_id=m.id and status='failed'
  and role in ('review','compose','revise','work','plan') order by updated_at desc limit 1 for update;
 if not found then return false;end if;
 if exists(select 1 from mission_assignments where mission_id=m.id and status='running')
  or exists(select 1 from mission_calls mc join mission_assignments a on a.id=mc.job_id where a.mission_id=m.id and mc.status in ('reserved','uncertain'))
  or exists(select 1 from project_events where project_id=p.id and event in ('mission_credit_fallback_recovered','mission_provider_availability_recovered') and data->>'jobId'=j.id::text)
 then return false;end if;
 evidence:=coalesce(j.result->'diagnostic'->'providerAvailability','[]'::jsonb);
 if jsonb_typeof(evidence)<>'array' then return false;end if;
 if jsonb_array_length(evidence)>0 then
  -- Do not reinterpret authentication/capability failures as billing failures.
  if not exists(select 1 from jsonb_array_elements(evidence) e where e->>'kind' in ('cooldown','billing_quota','discovery_unavailable') and (provider is null or e->>'provider'=provider))
   or exists(select 1 from jsonb_array_elements(evidence) e where e->>'kind' in ('credentials','unsupported_model') and (provider is null or e->>'provider'=provider)) then return false;end if;
 else
  -- Backward compatibility only for the observed legacy failure, corroborated
  -- by a provider-health record already present when this assignment failed.
  if j.detail is distinct from 'No connected provider supports the required bounded orchestration tools'
   and coalesce(j.detail,'') not ilike '%no credits remaining%'
   and coalesce(j.detail,'') not ilike '%insufficient_quota%' then return false;end if;
 end if;
 if not exists(select 1 from provider_health h where (provider is null or h.provider_name=provider)
  and h.updated_at<=j.updated_at and h.blocked_until is not null and h.blocked_until<=now()
  and h.reason in ('provider billing or quota is unavailable','the provider rate-limited the request','the provider timed out','the provider could not complete the request')) then return false;end if;
 if exists(select 1 from provider_health h where (provider is null or h.provider_name=provider) and h.status='blocked' and h.blocked_until>now()) then return false;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged from agent_missions where project_id=p.id;
 if p.token_allowance-charged<8000 then return false;end if;
 insert into project_events(project_id,event,data) values(p.id,'mission_provider_availability_recovered',
  jsonb_build_object('jobId',j.id,'missionId',m.id,'chargedTokens',charged,'priorDetail',j.detail,'priorResult',j.result,'priorAttempts',j.attempts,'continuationId',c.id,'availabilityVerified',false));
 update mission_assignments set status='queued',lease=null,lease_until=null,available_at=now(),
  result=coalesce(result,'{}'::jsonb)||jsonb_build_object('providerAvailabilityRecovery',true),
  detail='Provider cooldown expired; rechecking availability through the original authorized mission and ledger.',updated_at=now() where id=j.id;
 update agent_missions set status='running',detail='Rechecking provider availability on the same bounded assignment.',updated_at=now() where id=m.id;
 update work_projects set status='running',lease=null,lease_until=null,failures=0,
  detail='Resuming saved assignment after provider cooldown; model policy and accounting remain enforced.',updated_at=now() where id=p.id;
 perform project_publish(p.id,'Saved assignment queued to verify provider availability within existing authorization.');
 return true;
end $$;
revoke all on function public.recover_mission_credit_failure(uuid) from public,anon,authenticated;
