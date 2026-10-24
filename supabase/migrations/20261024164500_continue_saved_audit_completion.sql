-- Finish saved technical/operational audits after output-capacity and lossless
-- snapshot repairs. Never rerun completed inspections, analyses or revisions.
begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
do $recovery$
declare
 source_id uuid;recovery_key text:='saved_audit_completion_v2_20261024';
 allowance integer;ceiling integer;expected_usage integer;unfinished text[];source_slug text;
 m agent_missions;d executive_delegations;parent executive_management_requests;j mission_assignments;
 new_id uuid;new_d uuid;before_state jsonb;after_state jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 foreach source_id in array array['e3139a58-27f7-4501-8045-ab969eded3fa','6f48cceb-3657-4a56-8fdd-2b120012fc64']::uuid[] loop
 allowance:=case when source_id='e3139a58-27f7-4501-8045-ab969eded3fa' then 50000 else 80000 end;
 ceiling:=case when allowance=50000 then 4 else 6 end;expected_usage:=case when allowance=50000 then 115891 else 108459 end;
 unfinished:=case when allowance=50000 then array['review_again'] else array['revision','review_again'] end;
 source_slug:=case when allowance=50000 then 'software_development' else 'operations' end;
 if exists(select 1 from executive_delegation_events where event=recovery_key and evidence->>'sourceMissionId'=source_id::text) then continue;end if;
 select * into m from agent_missions where id=source_id for update;
 if not found then continue;end if;
 if m.status<>'blocked' or m.project_id is not null or (allowance=50000 and m.repository_id is null) or (allowance=80000 and m.repository_id is not null) or m.deadline<=now()+interval '15 minutes'
  or m.actual_tokens<>expected_usage or m.reserved_tokens<>expected_usage or m.calls<>4 then raise exception 'Saved audit completion source changed';end if;
 select * into j from mission_assignments where mission_id=source_id and job_key=case when allowance=50000 then 'review_again' else 'revision' end;
 if not found or j.status<>'failed' or j.result->>'admissionDenied' is distinct from 'true'
  or not exists(select 1 from mission_assignments where mission_id=source_id and job_key='review' and status='completed' and result->>'verdict'='changes_requested') then raise exception 'Saved failed admission and substantive review missing';end if;
 if allowance=50000 and (not(j.payload ? 'reviewModelCheckpoint') or not(j.payload ? 'operationalEvidenceSnapshot')
  or not exists(select 1 from mission_assignments where mission_id=source_id and job_key='revision' and status='completed' and length(result->>'text')>0)) then raise exception 'Saved technical revision or criteria missing';end if;
 if allowance=80000 and (select count(*) from mission_assignments where mission_id=source_id and job_key in('trace_facts','trace_challenge') and status='completed' and length(result->>'text')>0)<>2 then raise exception 'Actual operational worker analyses missing';end if;
 if exists(select 1 from mission_assignments where mission_id=source_id and status='running' and lease_until>now()) then raise exception 'Active work cannot be copied';end if;
 select * into d from executive_delegations where mission_id=source_id for update;
 if not found or d.status<>'cancelled' or not coalesce((select event='cancel' and evidence->>'reason'='Mission did not pass independent review' from executive_delegation_events where delegation_id=d.id order by created_at desc limit 1),false) then raise exception 'Owner cancellation cannot be overridden';end if;
 select * into parent from executive_management_requests where id='3b81cc91-9a68-47dc-8442-dbf700431f15' for update;
 if not found or parent.status not in ('running','blocked') or parent.actor_id<>d.actor_id or parent.chat_id<>d.chat_id
  or not exists(select 1 from jsonb_array_elements(parent.plan->'assignments') a where a->>'slug'=source_slug and a->>'missionId'=source_id::text) then raise exception 'Parent source binding changed';end if;
 select jsonb_build_object('mission',to_jsonb(m),'jobs',(select jsonb_agg(to_jsonb(a) order by id) from mission_assignments a where mission_id=source_id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=source_id))) into before_state;
 new_id:=overlay(overlay(md5(recovery_key||':'||source_id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
 new_d:=overlay(overlay(md5(recovery_key||':delegation:'||d.id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
 insert into agent_missions(id,objective,team,status,max_calls,token_allowance,max_minutes,deadline,repository_id,project_evidence,detail)
 values(new_id,m.objective,m.team,'draft',ceiling,allowance,m.max_minutes,m.deadline,m.repository_id,
  coalesce(m.project_evidence,'{}')||jsonb_build_object('savedAuditCompletion',jsonb_build_object('sourceMissionId',source_id,'sourceLedgerActual',m.actual_tokens,'sourceLedgerReserved',m.reserved_tokens,'sourceCalls',m.calls,'sourceRoutingCalls',m.routing_calls,
   'reason',case when allowance=50000 then 'Execute only the unadmitted final comparison of the saved technical revision, reusing actual draft-blind criteria. First-call audit output sizing is repaired.' else 'Reuse both completed operational trace analyses and the prior draft/findings. Execute only the remaining revision and independent review after lossless snapshot deduplication.' end,
   'requiredRuntimeRepair','lossless-audit-evidence-v2',
   'authorizedAdditionalTokenCeiling',allowance,'originalDeadlineRetained',true,'authorization','Owner authorized necessary fixes and recovery through production verification')),
  'Saved substantive work retained. Waiting for matching lossless-evidence runtime before the remaining revision/review can execute.');
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
 select new_id,job_key,role,agent_id,instruction,dependencies,
  payload||jsonb_build_object(case when status='completed' then 'reusedFrom' else 'continuedFrom' end,jsonb_build_object('missionId',source_id,'assignmentId',id,'attempts',attempts,'resultHash',md5(coalesce(result::text,'')))),
  case when job_key=any(unfinished) then 'queued' else 'completed' end,0,result,
  case when job_key=any(unfinished) then 'Execute only the saved unfinished stage after matching runtime activation; retain existing evidence and criteria.' else 'Verbatim completed artifact reused with original provenance and charges retained.' end
 from mission_assignments where mission_id=source_id and (status='completed' or job_key=any(unfinished));
 if exists(select 1 from mission_assignments where mission_id=new_id and role='review' and result->>'verdict'='pass') then raise exception 'Review pass cannot be imported';end if;
 if exists(select 1 from mission_assignments a,unnest(a.dependencies) dep where a.mission_id=new_id and not exists(select 1 from mission_assignments b where b.mission_id=new_id and b.job_key=dep)) then raise exception 'Dependency evidence missing';end if;
 insert into executive_delegations(id,orchestrator_id,actor_id,chat_id,request_key,objective,success_criteria,capability,status,delegated_version,budget_tokens,deadline,mission_id)
 values(new_d,d.orchestrator_id,d.actor_id,d.chat_id,'exec-specialist-task-'||recovery_key||':'||source_id::text,d.objective,d.success_criteria,d.capability,'running',d.delegated_version,allowance,m.deadline,new_id);
 insert into executive_delegation_events(delegation_id,event,evidence) values(new_d,recovery_key,jsonb_build_object('sourceMissionId',source_id,'sourceDelegation',to_jsonb(d),'continuationMissionId',new_id,'sourceStateHash',md5(before_state::text),'additionalTokenCeiling',allowance,'originalDeadline',m.deadline,'freshReviewRequired',true,'priorParentPlan',parent.plan));
 update executive_management_requests set status='running',plan=jsonb_set(jsonb_set(plan,'{assignments}',(select jsonb_agg(case when a->>'missionId'=source_id::text then (a-'blocked')||jsonb_build_object('missionId',new_id,'previousContinuationMissionId',source_id) else a end) from jsonb_array_elements(plan->'assignments') a)),
 '{provision}',(select jsonb_agg(case when p->>'blocked'='Source workstreams have not passed independent review; synthesis was not started.' and p->'sourceSlugs' ? source_slug then p-'blocked' else p end) from jsonb_array_elements(plan->'provision') p)),
 detail='Completed audit artifacts are retained; remaining revision/reviews wait for matching lossless-evidence runtime. Both source reviews must pass before synthesis.',updated_at=now() where id=parent.id;
 select jsonb_build_object('mission',to_jsonb(s),'jobs',(select jsonb_agg(to_jsonb(a) order by id) from mission_assignments a where mission_id=source_id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=source_id))) into after_state from agent_missions s where id=source_id;
 if before_state is distinct from after_state then raise exception 'Source artifact, attempt or ledger changed';end if;
 end loop;
end $recovery$;
commit;


-- Migration may run before Vercel finishes building. Only the matching new
-- runtime invokes this service-only start gate; no queued work reaches old code.
create or replace function public.activate_saved_audit_completion() returns integer
language plpgsql security invoker set search_path=public as $$
declare m agent_missions;d executive_delegations;n integer:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 for m in select * from agent_missions where status='draft' and project_id is null
  and project_evidence->'savedAuditCompletion'->>'requiredRuntimeRepair'='lossless-audit-evidence-v2'
  and project_evidence->'savedAuditCompletion'->>'sourceMissionId' in('e3139a58-27f7-4501-8045-ab969eded3fa','6f48cceb-3657-4a56-8fdd-2b120012fc64')
  and calls=0 and routing_calls=0 and actual_tokens=0 and reserved_tokens=0 and deadline>now()
  order by created_at for update
 loop
  select * into d from executive_delegations where mission_id=m.id and status='running' and deadline>now() for update;
  if not found or not exists(select 1 from executive_delegation_events where delegation_id=d.id and event='saved_audit_completion_v2_20261024' and evidence->>'continuationMissionId'=m.id::text) then continue;end if;
  update agent_missions set status='running',detail='Matching lossless audit runtime verified by start gate. Executing only remaining saved stages with original deadline.',updated_at=now() where id=m.id;
  insert into executive_delegation_events(delegation_id,event,evidence) values(d.id,'runtime_started_saved_audit_completion',jsonb_build_object('missionId',m.id,'runtimeRepair','lossless-audit-evidence-v2','deadline',m.deadline,'tokenAllowance',m.token_allowance));
  n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function public.activate_saved_audit_completion() from public,anon,authenticated;
grant execute on function public.activate_saved_audit_completion() to service_role;
