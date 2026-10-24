-- One owner-authorized continuation after deployed routing/review repairs.
-- Does not reset any source charge, attempt, artifact, deadline or review.
-- Release prerequisite: PR #712 must be verified serving before this is merged.

begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
do $recovery$
declare
 ids uuid[]:=array['9ecb8f69-6a7a-4428-8b1b-206d013d44bc','7d866a71-1c66-4a7a-832c-765591f7741b','bf5b73b6-c265-4c2a-8125-435d78c3a450']::uuid[];
 m agent_missions; d executive_delegations; parent executive_management_requests;
 before_state jsonb; after_state jsonb; mapping jsonb:='{}'; new_id uuid; new_d uuid; allowance integer; expires timestamptz:=now()+interval '120 minutes';
 recovery_key text:='eo703_saved_work_continuation_20261024';
 release_evidence jsonb:=jsonb_build_object('commit','6fd74cb8fdab1e701a024ab448b68eb79668d832','deploymentId','dpl_7fk2AvdNeewxz1JmZ2yKtR2uux2x','productionVersionVerifiedAt','2026-10-24T15:53:15Z','rootCauseFixes',jsonb_build_array('PR630 accounted routing deadline and review capacity','PR633 material review and saved draft retention','PR648 bounded revision context','PR712 separate deliverables from internal revision notes and enforce under word limits'),'scope','Later release verification only; immutable source inspections remain at their recorded commits.');
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if exists(select 1 from executive_provisioning_events where request_id='14ded4d4-b1c3-460e-84f3-4a29cc12ef6e' and event=recovery_key) then return; end if;
 select * into parent from executive_management_requests where id='3b81cc91-9a68-47dc-8442-dbf700431f15' for update;
 if not found then return;end if;
 if parent.status<>'blocked' or parent.actor_id<>'81c01658-6dc5-4544-b5f2-ea4c5423ca60' or parent.chat_id<>'0f94a3e2-87d3-4e1e-9496-1a16505e4764' then raise exception 'Parent changed; recovery aborted';end if;
 if (select count(*) from agent_missions where id=any(ids) and status='blocked' and project_id is null)<>3 then raise exception 'Mission precondition changed';end if;
 if exists(select 1 from mission_assignments where mission_id=any(ids) and status='running' and lease_until>now()) then raise exception 'Active work cannot be continued';end if;
 select jsonb_build_object(
  'missions',(select jsonb_agg(to_jsonb(x) order by id) from agent_missions x where id=any(ids)),
  'assignments',(select jsonb_agg(to_jsonb(x) order by id) from mission_assignments x where mission_id=any(ids)),
  'calls',(select jsonb_agg(to_jsonb(x) order by id) from mission_calls x where job_id in(select id from mission_assignments where mission_id=any(ids)))
 ) into before_state;
 for m in select * from agent_missions where id=any(ids) order by id loop
  new_id:=overlay(overlay(md5(recovery_key||':'||m.id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
  allowance:=case m.id when ids[1] then 120000 when ids[2] then 100000 else 80000 end;
  mapping:=mapping||jsonb_build_object(m.id::text,new_id);
  insert into agent_missions(id,objective,team,status,max_calls,token_allowance,max_minutes,deadline,repository_id,project_evidence,detail)
  values(new_id,m.objective,m.team,'running',20,allowance,120,expires,m.repository_id,
   coalesce(m.project_evidence,'{}')||jsonb_build_object('continuation',jsonb_build_object('sourceMissionId',m.id,'sourceLedgerReserved',m.reserved_tokens,'sourceLedgerActual',m.actual_tokens,'sourceCalls',m.calls,'sourceRoutingCalls',m.routing_calls,'reason','Resume saved unfinished steps after deployed routing/review fixes. All original artifacts, attempts and uncertain charges remain owned by the source mission. No review verdict is copied.','authorizedAdditionalTokenCeiling',allowance,'authorization','Owner explicitly authorized fixes and recovery through production verification','releaseVerification',release_evidence)),
   'Bounded continuation of saved work. Fresh independent review is mandatory; no result is accepted by recovery.');
  insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
  select new_id,job_key,role,agent_id,instruction,dependencies,
   payload||jsonb_build_object(case when status='completed' and role<>'review' then 'reusedFrom' else 'continuedFrom' end,jsonb_build_object('missionId',m.id,'assignmentId',id,'attempts',attempts,'status',status,'resultHash',md5(coalesce(result::text,'')))),
   case when status='completed' and role<>'review' then 'completed' else 'queued' end,0,
   case when role='review' and status='completed' then null else result end,
   case when status='completed' and role<>'review' then 'Verbatim saved artifact reused; original execution and charges retained at reusedFrom.' else 'Unfinished step continued after deployed fixes; previous diagnostics and attempts remain at continuedFrom.' end
  from mission_assignments where mission_id=m.id;
  if m.id<>ids[3] then
   select * into d from executive_delegations where mission_id=m.id for update;
   if not found or d.status<>'cancelled' or d.actor_id<>parent.actor_id or d.chat_id<>parent.chat_id then raise exception 'Delegation precondition changed';end if;
   new_d:=overlay(overlay(md5(recovery_key||':delegation:'||d.id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
   insert into executive_delegations(id,orchestrator_id,actor_id,chat_id,request_key,objective,success_criteria,capability,status,delegated_version,budget_tokens,deadline,mission_id)
   values(new_d,d.orchestrator_id,d.actor_id,d.chat_id,'exec-specialist-task-eo703-continuation-'||m.id::text,d.objective,d.success_criteria,d.capability,'running',d.delegated_version,allowance,expires,new_id);
   insert into executive_delegation_events(delegation_id,event,evidence) values(new_d,recovery_key,jsonb_build_object('sourceDelegation',to_jsonb(d),'sourceMissionId',m.id,'continuationMissionId',new_id,'additionalTokenCeiling',allowance,'freshReviewRequired',true,'releaseVerification',release_evidence));
   insert into executive_delegation_events(delegation_id,event,evidence) values(d.id,recovery_key,jsonb_build_object('continuationDelegationId',new_d,'continuationMissionId',new_id,'originalMissionUnchanged',true));
  end if;
 end loop;
 insert into executive_provisioning_events(request_id,event,evidence)
 select id,recovery_key,jsonb_build_object('previousRequest',to_jsonb(p),'previousParentPlan',parent.plan,'missionMapping',mapping,'originalStateHash',md5(before_state::text),'additionalTokenCeiling',300000,'releaseVerification',release_evidence,'freshReviewRequired',true)
 from executive_provisioning_requests p where id='14ded4d4-b1c3-460e-84f3-4a29cc12ef6e' and status='blocked' and evidence->>'acceptanceMissionId'=ids[3]::text;
 if not found then raise exception 'Provision precondition changed';end if;
 update executive_provisioning_requests set status='configured',evidence=jsonb_build_object('acceptanceMissionId',mapping->>ids[3]::text,'acceptanceCapability',capability,'continuationSourceMissionId',ids[3],'previousBlockerEvidence',evidence,'freshReviewRequired',true),updated_at=now()
 where id='14ded4d4-b1c3-460e-84f3-4a29cc12ef6e';
 update executive_management_requests set status='running',
 plan=jsonb_set(jsonb_set(plan,'{assignments}',(select jsonb_agg((a-'blocked')||case when mapping ? (a->>'missionId') then jsonb_build_object('missionId',mapping->>(a->>'missionId'),'sourceMissionId',a->>'missionId') else '{}' end) from jsonb_array_elements(plan->'assignments') a)),'{provision}',(select jsonb_agg(p-'blocked') from jsonb_array_elements(plan->'provision') p)),
 detail='Saved source audits and specialist acceptance continued after deployed routing/review fixes. Original work and charges are retained; no completion or review is asserted.',updated_at=now()
 where id=parent.id;
 select jsonb_build_object(
  'missions',(select jsonb_agg(to_jsonb(x) order by id) from agent_missions x where id=any(ids)),
  'assignments',(select jsonb_agg(to_jsonb(x) order by id) from mission_assignments x where mission_id=any(ids)),
  'calls',(select jsonb_agg(to_jsonb(x) order by id) from mission_calls x where job_id in(select id from mission_assignments where mission_id=any(ids)))
 ) into after_state;
 if before_state is distinct from after_state then raise exception 'Original artifacts or ledger changed; rolling back';end if;
end $recovery$;
commit;
select event,evidence->'missionMapping' as missions,evidence->>'originalStateHash' as preserved_state_hash from executive_provisioning_events where request_id='14ded4d4-b1c3-460e-84f3-4a29cc12ef6e' and event='eo703_saved_work_continuation_20261024';
