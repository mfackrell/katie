-- Runtime-gated recovery after comparison-context/output sizing repair.
-- Redistribute ONLY the completed sibling's unused allowance. The aggregate
-- 120,000-token ceiling, all charges, artifacts and deadline remain unchanged.
create or replace function public.resume_compact_audit_comparison() returns integer
language plpgsql security invoker set search_path=public as $$
declare m agent_missions; t agent_missions; j mission_assignments;
 d executive_delegations; td executive_delegations; p executive_management_requests;
 transfer integer; total_before integer; artifacts_before jsonb; artifacts_after jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if exists(select 1 from executive_delegation_events where event='compact_audit_comparison_resumed_v7') then return 0;end if;
 select * into m from agent_missions where id='d0fde164-a838-4dea-843c-0b7a3c40614f' for update;
 if not found then return 0;end if;
 select * into t from agent_missions where id='e0d14a70-7499-4fa4-8b3a-886612aea2c1' for update;
 if not found then return 0;end if;
 select * into j from mission_assignments where mission_id=m.id and job_key='review_again' for update;
 if not found then return 0;end if;
 if not coalesce(m.status='blocked' and m.actual_tokens=49725 and m.reserved_tokens=49725 and m.calls=4 and m.routing_calls=4 and m.token_allowance=70000
  and t.status='completed' and t.actual_tokens=40493 and t.reserved_tokens=40493 and t.calls=1 and t.routing_calls=1 and t.token_allowance=50000
  and m.deadline=t.deadline and m.deadline>now()+interval '5 minutes'
  and j.status='failed' and j.attempts=1 and j.result->>'admissionDenied'='true'
  and j.payload->'reviewModelCheckpoint'->>'hash'='1066266dda95924c993a2c456a4b5ba4fb1be29ec8e9432ca4a4aaf58d9bba85'
  and exists(select 1 from mission_assignments where mission_id=m.id and job_key='revision' and status='completed' and result->'revisionPatch'->>'resultHash'='abab5e201c4e9d2904fe925972ea8a028a7660f5b3244e948983bb903479b16b')
  and exists(select 1 from mission_assignments where mission_id=t.id and job_key='review_again' and status='completed' and result->>'verdict'='pass')
  and not exists(select 1 from mission_calls where job_id in(select id from mission_assignments where mission_id in(m.id,t.id)) and status in('reserved','uncertain')),false) then return 0;end if;
 select * into d from executive_delegations where mission_id=m.id for update;
 select * into td from executive_delegations where mission_id=t.id for update;
 select * into p from executive_management_requests where id='3b81cc91-9a68-47dc-8442-dbf700431f15' for update;
 if not coalesce(d.status='cancelled' and td.status='verified' and d.actor_id=td.actor_id and d.chat_id=td.chat_id
  and p.actor_id=d.actor_id and p.chat_id=d.chat_id and p.status in('running','blocked')
  and (select event='cancel' and evidence->>'reason'='Mission did not pass independent review' from executive_delegation_events where delegation_id=d.id order by created_at desc limit 1)
  and exists(select 1 from jsonb_array_elements(p.plan->'assignments') a where a->>'slug'='operations' and a->>'missionId'=m.id::text)
  and exists(select 1 from jsonb_array_elements(p.plan->'assignments') a where a->>'slug'='software_development' and a->>'missionId'=t.id::text),false) then return 0;end if;
 transfer:=t.token_allowance-t.reserved_tokens;total_before:=m.token_allowance+t.token_allowance;
 if transfer<>9507 or total_before<>120000 then raise exception 'Existing allowance pool changed';end if;
 select jsonb_build_object('jobs',(select jsonb_agg(to_jsonb(a) order by id) from mission_assignments a where mission_id in(m.id,t.id) and id<>j.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id in(m.id,t.id)))) into artifacts_before;
 insert into executive_delegation_events(delegation_id,event,evidence) values(d.id,'compact_audit_comparison_resumed_v7',jsonb_build_object(
  'operationsBefore',to_jsonb(m),'technicalBefore',to_jsonb(t),'reviewBefore',to_jsonb(j),'delegationBefore',to_jsonb(d),'priorParentPlan',p.plan,
  'transferredUnusedTokens',transfer,'combinedCeilingBefore',total_before,'combinedCeilingAfter',total_before,'deadlineUnchanged',true,
  'reason','Full comparison reuses valid blind criteria, omits redundant historical passed matrices, retains all current checks and failed findings, and sizes short-report verdicts proportionally. No new budget or approval is created.'));
 update agent_missions set token_allowance=token_allowance-transfer where id=t.id;
 update executive_delegations set budget_tokens=t.token_allowance-transfer where id=td.id;
 update agent_missions set token_allowance=token_allowance+transfer,status='running',detail='Final independent comparison resumed within the existing combined ceiling; all artifacts and charges retained.',updated_at=now() where id=m.id;
 update executive_delegations set budget_tokens=m.token_allowance+transfer,status='running' where id=d.id;
 update mission_assignments set status='queued',available_at=now(),detail='Reuse saved blind criteria; full current candidate and sources still require independent comparison.',updated_at=now() where id=j.id;
 update executive_management_requests set status='running',plan=jsonb_set(plan,'{provision}',(select jsonb_agg(case when x->>'blocked'='Source workstreams have not passed independent review; synthesis was not started.' then x-'blocked' else x end) from jsonb_array_elements(plan->'provision') x)),detail='Technical source approved; operations final comparison resumed within unchanged total authorization.',updated_at=now() where id=p.id;
 if (select sum(token_allowance) from agent_missions where id in(m.id,t.id))<>total_before then raise exception 'Recovery increased the combined ceiling';end if;
 select jsonb_build_object('jobs',(select jsonb_agg(to_jsonb(a) order by id) from mission_assignments a where mission_id in(m.id,t.id) and id<>j.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id in(m.id,t.id)))) into artifacts_after;
 if artifacts_before is distinct from artifacts_after then raise exception 'Completed artifacts or charges changed';end if;
 return 1;
end $$;
revoke all on function public.resume_compact_audit_comparison() from public,anon,authenticated;
grant execute on function public.resume_compact_audit_comparison() to service_role;
