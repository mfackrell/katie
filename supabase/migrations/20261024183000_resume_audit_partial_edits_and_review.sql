-- Recover fully returned edit objects, never the truncated final object. Resume
-- operations inside its existing ledger/deadline. Technical review-only work
-- preserves the failed GPT-5 Pro call's uncertain 30,237-token reservation.
begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
do $$
declare m agent_missions; d executive_delegations; p executive_management_requests;
 k text:='saved_audit_terminal_review_v6_20261024'; n uuid; nd uuid; before_state jsonb; after_state jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if exists(select 1 from executive_delegation_events where event=k) then return;end if;
 select * into m from agent_missions where id='07bb60f2-db69-4961-8ea6-20f7d883fa59' for update;
 if not found then return;end if;
 if m.status<>'blocked' or m.project_id is not null or m.repository_id is null or m.actual_tokens<>27254 or m.reserved_tokens<>57491 or m.calls<>3 or m.routing_calls<>3 or m.deadline<=now()+interval '5 minutes' then raise exception 'Technical terminal review source changed';end if;
 if not exists(select 1 from mission_calls where id='b32ede9b-c821-4074-bd2e-83f289e5174c' and status='uncertain' and reserved_tokens=30237 and actual_tokens is null)
  or not exists(select 1 from mission_assignments where id='a2d4c109-961e-4656-9164-5cde01651c8f' and status='failed' and result->>'admissionDenied'='true' and payload->'reviewModelCheckpoint'->'response'->>'text' is not null)
  or not exists(select 1 from mission_assignments where mission_id=m.id and job_key='revision' and status='completed' and length(result->>'text')>0) then raise exception 'Saved technical candidate, criteria or uncertain call missing';end if;
 select * into d from executive_delegations where mission_id=m.id for update;
 if not found or d.status<>'cancelled' or not coalesce((select event='cancel' and evidence->>'reason'='Mission did not pass independent review' from executive_delegation_events where delegation_id=d.id order by created_at desc limit 1),false) then raise exception 'Owner cancellation cannot be overridden';end if;
 select * into p from executive_management_requests where id='3b81cc91-9a68-47dc-8442-dbf700431f15' for update;
 if not found or p.status not in('running','blocked') or p.actor_id<>d.actor_id or p.chat_id<>d.chat_id or not exists(select 1 from jsonb_array_elements(p.plan->'assignments') a where a->>'slug'='software_development' and a->>'missionId'=m.id::text) then raise exception 'Parent source binding changed';end if;
 select jsonb_build_object('mission',to_jsonb(m),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=m.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=m.id))) into before_state;
 n:=overlay(overlay(md5(k||':'||m.id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
 nd:=overlay(overlay(md5(k||':delegation:'||d.id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
 insert into agent_missions(id,objective,team,status,max_calls,token_allowance,max_minutes,deadline,repository_id,project_evidence,detail)
 values(n,m.objective,m.team,'draft',3,50000,m.max_minutes,m.deadline,m.repository_id,coalesce(m.project_evidence,'{}')||jsonb_build_object('savedAuditTerminalReview',jsonb_build_object('sourceMissionId',m.id,'requiredRuntimeRepair','partial-edits-synchronous-models-v6','sourceActual',m.actual_tokens,'sourceReserved',m.reserved_tokens,'uncertainReservationPreserved',30237,'additionalTokenCeiling',50000,'originalDeadlineRetained',true,'reason','Only full independent comparison remains. Reuse completed correction and valid blind assessment; the synchronous transport now excludes long-running variants requiring background execution.')),'Waiting for synchronous-model compatibility fix; all completed work and uncertain usage retained.');
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
 select n,job_key,role,agent_id,instruction,dependencies,(payload-'continuedFrom')||jsonb_build_object('reusedFrom',jsonb_build_object('missionId',m.id,'assignmentId',id,'attempts',attempts,'resultHash',md5(coalesce(result::text,'')))),'completed',0,result,'Verbatim saved artifact; original attempts and usage retained.' from mission_assignments where mission_id=m.id and status='completed';
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
 select n,job_key,role,agent_id,instruction,dependencies,(payload-'reusedFrom')||jsonb_build_object('continuedFrom',jsonb_build_object('missionId',m.id,'assignmentId',id,'attempts',attempts,'resultHash',md5(coalesce(result::text,'')))),'queued',0,null,'Only remaining comparison; exact saved blind contract checkpoint retained.' from mission_assignments where id='a2d4c109-961e-4656-9164-5cde01651c8f';
 if exists(select 1 from mission_assignments where mission_id=n and role='review' and result->>'verdict'='pass') then raise exception 'Review pass cannot be imported';end if;
 insert into executive_delegations(id,orchestrator_id,actor_id,chat_id,request_key,objective,success_criteria,capability,status,delegated_version,budget_tokens,deadline,mission_id)
 values(nd,d.orchestrator_id,d.actor_id,d.chat_id,'exec-specialist-task-'||k,d.objective,d.success_criteria,d.capability,'running',d.delegated_version,50000,m.deadline,n);
 insert into executive_delegation_events(delegation_id,event,evidence) values(nd,k,jsonb_build_object('sourceMissionId',m.id,'sourceDelegation',to_jsonb(d),'sourceStateHash',md5(before_state::text),'continuationMissionId',n,'priorParentPlan',p.plan,'freshFullComparisonRequired',true));
 update executive_management_requests set status='running',plan=jsonb_set(plan,'{assignments}',(select jsonb_agg(case when a->>'missionId'=m.id::text then (a-'blocked')||jsonb_build_object('missionId',n,'previousContinuationMissionId',m.id) else a end) from jsonb_array_elements(plan->'assignments') a)),detail='Saved technical correction and blind criteria retained for full review; operations partial edits await bounded recovery.',updated_at=now() where id=p.id;
 select jsonb_build_object('mission',to_jsonb(s),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=m.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=m.id))) into after_state from agent_missions s where id=m.id;
 if before_state is distinct from after_state then raise exception 'Technical source or uncertain charge changed';end if;
end $$;
commit;

create or replace function public.resume_saved_partial_audit_edits() returns integer
language plpgsql security invoker set search_path=public as $$
declare m agent_missions; j mission_assignments; d executive_delegations; n integer:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into m from agent_missions where id='d0fde164-a838-4dea-843c-0b7a3c40614f' for update;
 if found and not exists(select 1 from executive_delegation_events where event='saved_partial_edits_resumed_v6') then
  select * into j from mission_assignments where id='a43dcd4c-96d2-40ab-908d-5ee8581f6f48' and mission_id=m.id for update;
  select * into d from executive_delegations where mission_id=m.id for update;
  if m.status='blocked' and m.actual_tokens=29052 and m.reserved_tokens=29052 and m.calls=2 and m.routing_calls=1 and m.token_allowance=70000 and m.deadline>now()+interval '5 minutes'
   and j.status='failed' and j.attempts=1 and j.result->>'incompleteReason'='max_output_tokens'
   and encode(sha256(convert_to(j.result->>'partialText','UTF8')),'hex')='230a304115303ccf3990c2523f4c4f463d4f2909b39f7a836363d86959118913'
   and d.status='cancelled' and coalesce((select event='cancel' and evidence->>'reason'='Mission did not pass independent review' from executive_delegation_events where delegation_id=d.id order by created_at desc limit 1),false)
   and exists(select 1 from executive_management_requests p,jsonb_array_elements(p.plan->'assignments') a where p.id='3b81cc91-9a68-47dc-8442-dbf700431f15' and p.status in('running','blocked') and a->>'slug'='operations' and a->>'missionId'=m.id::text) then
   -- Archive the exact partial response and previous state before retrying.
   insert into executive_delegation_events(delegation_id,event,evidence) values(d.id,'saved_partial_edits_resumed_v6',jsonb_build_object('sourceMission',to_jsonb(m),'sourceAssignment',to_jsonb(j),'sourceDelegation',to_jsonb(d),'reason','Recover seven complete actual edits, omit the unfinished eighth, and ask the model only for the remaining measured correction. Independent review still required.','budgetAndDeadlineUnchanged',true));
   update mission_assignments set status='queued',available_at=now(),detail='Saved complete edit prefix recoverable; only remaining correction executes.',updated_at=now() where id=j.id;
   update agent_missions set status='running',detail='Recovering actual completed edits within the existing ledger and deadline; independent review remains required.',updated_at=now() where id=m.id;
   update executive_delegations set status='running' where id=d.id;
   n:=n+1;
  end if;
 end if;
 for m in select * from agent_missions where status='draft' and project_evidence->'savedAuditTerminalReview'->>'requiredRuntimeRepair'='partial-edits-synchronous-models-v6'
  and project_evidence->'savedAuditTerminalReview'->>'sourceMissionId'='07bb60f2-db69-4961-8ea6-20f7d883fa59' and calls=0 and routing_calls=0 and actual_tokens=0 and reserved_tokens=0 and deadline>now() for update loop
  select * into d from executive_delegations where mission_id=m.id and status='running' and deadline>now() for update;
  if not found then continue;end if;
  update agent_missions set status='running',detail='Only full independent comparison remains; corrected runtime and saved criteria verified.',updated_at=now() where id=m.id;
  insert into executive_delegation_events(delegation_id,event,evidence) values(d.id,'terminal_review_runtime_started_v6',jsonb_build_object('missionId',m.id,'deadline',m.deadline,'tokenAllowance',m.token_allowance));
  n:=n+1;
 end loop;
 if n>0 then
  update executive_management_requests set status='running',plan=jsonb_set(plan,'{provision}',(select jsonb_agg(case when p->>'blocked'='Source workstreams have not passed independent review; synthesis was not started.' then p-'blocked' else p end) from jsonb_array_elements(plan->'provision') p)),detail='Saved audit corrections and final review resumed; both source passes still required before synthesis.',updated_at=now() where id='3b81cc91-9a68-47dc-8442-dbf700431f15' and status in('running','blocked');
 end if;
 return n;
end $$;
revoke all on function public.resume_saved_partial_audit_edits() from public,anon,authenticated;
grant execute on function public.resume_saved_partial_audit_edits() to service_role;
