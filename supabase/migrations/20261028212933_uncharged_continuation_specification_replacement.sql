-- A live parent continuation can admit one fresh child after an entirely
-- uncharged provider-admission failure. The expired child is never renewed.
create function public.benchmark_uncharged_specification_source(p_project uuid,p_cont uuid,p_source uuid)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from work_projects p join agent_missions m on m.id=p_source and m.project_id=p.id
 join benchmark_full_continuations c on c.id=p_cont and c.project_id=p.id
 where p.id=p_project and p.phase='specification' and p.deadline>now() and p.approved_hash is null
 and benchmark_continuation_live(c.id,c.account_id,p.id) and c.deadline>now()+interval '5 minutes'
 and m.project_kind='specification' and m.status='blocked' and m.deadline<=now()
 and m.created_at>=c.created_at and m.project_evidence->>'benchmarkContinuationId'=c.id::text and m.project_evidence->>'benchmarkContinuationPlanHash'=c.plan_hash
 and m.actual_tokens=0 and m.reserved_tokens=0 and m.calls=0 and m.routing_calls=0
 and not exists(select 1 from mission_calls mc join mission_assignments a on a.id=mc.job_id where a.mission_id=m.id)
 and not exists(select 1 from benchmark_budget_calls bc where bc.account_id=c.account_id and (bc.state<>'settled' or bc.actual_tokens is null))
 and not exists(select 1 from mission_assignments a where a.mission_id=m.id and a.status in ('running','waiting_external','awaiting_approval'))
 and exists(select 1 from mission_assignments a join provider_health h on h.provider_name='openai'
   where a.mission_id=m.id and a.status='failed' and a.role='compose'
   and a.detail='No connected provider supports the required bounded orchestration tools'
   and (not (coalesce(a.result->'diagnostic','{}'::jsonb) ? 'providerAvailability') or
     (a.result->'diagnostic'->'providerAvailability') @> '[{"kind":"cooldown","provider":"openai"}]'::jsonb)
   and not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(a.result->'diagnostic'->'providerAvailability')='array' then a.result->'diagnostic'->'providerAvailability' else '[]'::jsonb end) e where e->>'provider'='openai' and e->>'kind' in ('credentials','unsupported_model'))
   and h.reason='provider billing or quota is unavailable' and h.updated_at<=a.updated_at and h.blocked_until>=a.updated_at and h.blocked_until<=now())
 and (select count(*) from agent_missions x where x.project_id=p.id and x.project_kind='specification' and x.project_evidence->>'benchmarkContinuationId'=c.id::text)=1
 and (select count(*) from project_runs where project_id=p.id)+3<=p.max_missions
 and p.token_allowance-(select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)>=270000);
$$;
revoke all on function public.benchmark_uncharged_specification_source(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.benchmark_uncharged_specification_source(uuid,uuid,uuid) to service_role;

create function public.recover_uncharged_continuation_specification(p_id uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
declare p work_projects; c benchmark_full_continuations; m agent_missions;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'blocked' or p.active_mission_id is null or (p.lease is not null and p.lease_until>now()) then return false;end if;
 select * into c from benchmark_full_continuations where project_id=p.id;
 select * into m from agent_missions where id=p.active_mission_id for update;
 if c.id is null or not benchmark_uncharged_specification_source(p.id,c.id,m.id)
  or exists(select 1 from project_events where project_id=p.id and event='uncharged_continuation_specification_replacement_prepared') then return false;end if;
 insert into project_events(project_id,event,data) values(p.id,'uncharged_continuation_specification_replacement_prepared',
  jsonb_build_object('continuationId',c.id,'sourceMissionId',m.id,'sourceMission',to_jsonb(m),
   'sourceAssignments',(select jsonb_agg(to_jsonb(a)) from mission_assignments a where a.mission_id=m.id),
   'parentDeadline',c.deadline,'uncharged',true,'availabilityVerified',false));
 update work_projects set status='running',active_mission_id=null,lease=null,lease_until=null,
  detail='Live continuation admitted one fresh specification child after an expired, uncharged provider-admission failure. Original child is preserved.',updated_at=now() where id=p.id;
 perform project_publish(p.id,'Existing Developer Orchestrator will create one bounded replacement child within the unchanged continuation.');
 return true;
end $$;
revoke all on function public.recover_uncharged_continuation_specification(uuid) from public,anon,authenticated;
grant execute on function public.recover_uncharged_continuation_specification(uuid) to service_role;

DO $patch$
declare body text; anchor text;
begin
 select pg_get_functiondef('public.finish_work_project(uuid,uuid,text,jsonb)'::regprocedure) into body;
 anchor:=$old$if exists(select 1 from agent_missions where project_id=p.id and project_kind='specification' and project_evidence->>'benchmarkContinuationId'=spec_cont.id::text) then raise exception 'continuation specification already dispatched';end if;$old$;
 if position(anchor in body)=0 then raise exception 'Existing continuation scheduler guard required';end if;
 body:=replace(body,anchor,$new$
 if exists(select 1 from agent_missions where project_id=p.id and project_kind='specification' and project_evidence->>'benchmarkContinuationId'=spec_cont.id::text) then
  if not exists(select 1 from project_events e where e.project_id=p.id and e.event='uncharged_continuation_specification_replacement_prepared'
   and e.data->>'continuationId'=spec_cont.id::text and benchmark_uncharged_specification_source(p.id,spec_cont.id,(e.data->>'sourceMissionId')::uuid))
   or exists(select 1 from project_events where project_id=p.id and event='uncharged_continuation_specification_replacement_dispatched') then raise exception 'continuation specification already dispatched';end if;
 end if;
$new$);
 anchor:=$old$if action='child' and spec_cont.id is not null then
  update agent_missions$old$;
 if position(anchor in body)=0 then raise exception 'Existing child deadline fence required';end if;
 body:=replace(body,anchor,$new$if action='child' and spec_cont.id is not null then
  if p.phase='specification' and exists(select 1 from project_events where project_id=p.id and event='uncharged_continuation_specification_replacement_prepared') then
   insert into project_events(project_id,event,data) values(p.id,'uncharged_continuation_specification_replacement_dispatched',jsonb_build_object('continuationId',spec_cont.id,'replacementMissionId',(select active_mission_id from work_projects where id=p.id),'parentDeadline',spec_cont.deadline));
  end if;
  update agent_missions$new$);
 execute body;
end $patch$;
