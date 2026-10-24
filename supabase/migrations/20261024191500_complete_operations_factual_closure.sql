-- A real independent comparison found unsupported deployment claims. Create
-- only an exact-edit correction and final review, funded entirely by unused
-- allowance from the same operations workstream. No old deadline is renewed.
begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
do $$
declare m agent_missions; donor agent_missions; d executive_delegations; dd executive_delegations;
 p executive_management_requests; candidate mission_assignments; reviewed mission_assignments;
 k text:='operations_factual_closure_v8_20261024'; n uuid; nd uuid; transfer integer;
 before_source jsonb; after_source jsonb; before_donor jsonb; after_donor jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if exists(select 1 from executive_delegation_events where event=k) then return;end if;
 select * into m from agent_missions where id='d0fde164-a838-4dea-843c-0b7a3c40614f' for update;
 if not found then return;end if;
 select * into donor from agent_missions where id='c1d6ca76-dc21-4025-84bb-1d8a6a30e587' for update;
 if not found then raise exception 'Unused operations source missing';end if;
 select * into candidate from mission_assignments where mission_id=m.id and job_key='revision' for update;
 select * into reviewed from mission_assignments where mission_id=m.id and job_key='review_again' for update;
 if not coalesce(m.status='blocked' and m.actual_tokens=74667 and m.reserved_tokens=74667 and m.calls=5 and m.routing_calls=5
  and candidate.status='completed' and candidate.result->'revisionPatch'->>'resultHash'='abab5e201c4e9d2904fe925972ea8a028a7660f5b3244e948983bb903479b16b'
  and reviewed.status='completed' and reviewed.result->>'verdict'='changes_requested'
  and reviewed.payload->'reviewModelCheckpoint'->>'hash'='1066266dda95924c993a2c456a4b5ba4fb1be29ec8e9432ca4a4aaf58d9bba85'
  and donor.status='blocked' and donor.token_allowance=80000 and donor.actual_tokens=30503 and donor.reserved_tokens=30503
  and not exists(select 1 from mission_calls where job_id in(select id from mission_assignments where mission_id in(m.id,donor.id)) and status in('reserved','uncertain')),false) then raise exception 'Saved findings, candidate or unused authorization changed';end if;
 select * into d from executive_delegations where mission_id=m.id for update;
 select * into dd from executive_delegations where mission_id=donor.id for update;
 select * into p from executive_management_requests where id='3b81cc91-9a68-47dc-8442-dbf700431f15' for update;
 if not coalesce(d.status='cancelled' and dd.status='cancelled' and d.actor_id=dd.actor_id and d.chat_id=dd.chat_id
  and p.actor_id=d.actor_id and p.chat_id=d.chat_id and p.status in('running','blocked')
  and (select event='cancel' and evidence->>'reason'='Mission did not pass independent review' from executive_delegation_events where delegation_id=d.id order by created_at desc limit 1)
  and (select event='cancel' and evidence->>'reason'='Mission did not pass independent review' from executive_delegation_events where delegation_id=dd.id order by created_at desc limit 1)
  and exists(select 1 from jsonb_array_elements(p.plan->'assignments') a where a->>'slug'='operations' and a->>'missionId'=m.id::text),false) then raise exception 'Parent ownership or automatic-cancellation guard changed';end if;
 select jsonb_build_object('mission',to_jsonb(m),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=m.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=m.id))) into before_source;
 select jsonb_build_object('mission',to_jsonb(donor)-'token_allowance','jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=donor.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=donor.id))) into before_donor;
 transfer:=donor.token_allowance-donor.reserved_tokens;
 if transfer<>49497 then raise exception 'Unexpected unused allowance';end if;
 n:=overlay(overlay(md5(k||':'||m.id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
 nd:=overlay(overlay(md5(k||':delegation:'||d.id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
 update agent_missions set token_allowance=reserved_tokens where id=donor.id;
 update executive_delegations set budget_tokens=donor.reserved_tokens where id=dd.id;
 insert into agent_missions(id,objective,team,status,max_calls,token_allowance,max_minutes,deadline,repository_id,project_evidence,detail)
 values(n,m.objective,m.team,'running',3,transfer,30,now()+interval '30 minutes',m.repository_id,
  coalesce(m.project_evidence,'{}')||jsonb_build_object('finalOperationsCorrection',jsonb_build_object('sourceMissionId',m.id,'sourceReviewId',reviewed.id,'allowanceSourceMissionId',donor.id,'transferredUnusedTokens',transfer,'aggregateCeilingUnchanged',true,'scope','Only correct unsupported deployment assertions and explicit coverage/closure in the actual saved report, then run independent comparison. No new audit or source inspection.')),
  'Exact saved report and actual review findings retained for two bounded finishing steps.');
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,result,detail)
 select n,job_key,role,agent_id,instruction,dependencies,payload||jsonb_build_object('reusedFrom',jsonb_build_object('missionId',m.id,'assignmentId',id,'attempts',attempts)),'completed',result,'Verbatim saved worker evidence; original attempts and charges retained.' from mission_assignments where mission_id=m.id and status='completed' and role in('plan','work');
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,result,detail) values
 (n,'compose','compose',candidate.agent_id,candidate.instruction,'{}',jsonb_build_object('reusedFrom',jsonb_build_object('missionId',m.id,'assignmentId',candidate.id)),'completed',candidate.result,'Latest 1,185-word actual report retained verbatim.'),
 (n,'review','review',reviewed.agent_id,reviewed.instruction,array['compose'],reviewed.payload||jsonb_build_object('reusedFrom',jsonb_build_object('missionId',m.id,'assignmentId',reviewed.id)),'completed',reviewed.result,'Actual independent rejection, never an approval.');
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status) values
 (n,'revision','revise',candidate.agent_id,
  'Apply only narrow exact edits to the saved report. Correct EVERY unsupported assertion that deployment receipts were inspected or that failures followed a verified deployment: those receipts were unavailable to these source workers. Preserve the conceptual distinction between release and functional verification as a general rule, not an observed release. Explicitly cover operational transparency (done/blocked/needed) alongside honest reporting. Add a concise closure mapping for the actual prior material findings: length, causal uncertainty, historical c1eaad98 anchor, unavailable deployment coverage and bounded scope. Preserve all evidence IDs, historical timestamps, qualifications and actual findings. Shorten repetition as needed to keep the ENTIRE result below 1,200 words, aiming below 1,100. Return at most eight exact non-overlapping edits within the existing 35-percent change bound. Do not claim final review passed or introduce new facts.',
  array['review'],jsonb_build_object('revisionPatchBaseHash','abab5e201c4e9d2904fe925972ea8a028a7660f5b3244e948983bb903479b16b'),'queued'),
 (n,'review_again','review',reviewed.agent_id,reviewed.instruction,array['revision'],reviewed.payload||jsonb_build_object('continuedFrom',jsonb_build_object('missionId',m.id,'assignmentId',reviewed.id)),'queued');
 insert into executive_delegations(id,orchestrator_id,actor_id,chat_id,request_key,objective,success_criteria,capability,status,delegated_version,budget_tokens,deadline,mission_id)
 values(nd,d.orchestrator_id,d.actor_id,d.chat_id,'exec-specialist-task-'||k,d.objective,d.success_criteria,d.capability,'running',d.delegated_version,transfer,now()+interval '30 minutes',n);
 insert into executive_delegation_events(delegation_id,event,evidence) values(nd,k,jsonb_build_object('sourceMissionId',m.id,'sourceReviewId',reviewed.id,'sourceStateHash',md5(before_source::text),'donorBefore',to_jsonb(donor),'donorDelegationBefore',to_jsonb(dd),'transferredUnusedTokens',transfer,'combinedCeilingBefore',donor.token_allowance,'combinedCeilingAfter',donor.reserved_tokens+transfer,'oldDeadlinesUnchanged',true,'priorParentPlan',p.plan));
 update executive_management_requests set status='running',plan=jsonb_set(jsonb_set(plan,'{assignments}',(select jsonb_agg(case when a->>'missionId'=m.id::text then (a-'blocked')||jsonb_build_object('missionId',n,'previousContinuationMissionId',m.id) else a end) from jsonb_array_elements(plan->'assignments') a)),'{provision}',(select jsonb_agg(case when x->>'blocked'='Source workstreams have not passed independent review; synthesis was not started.' then x-'blocked' else x end) from jsonb_array_elements(plan->'provision') x)),detail='Technical source approved; exact operations factual correction and fresh comparison underway within unchanged aggregate authorization.',updated_at=now() where id=p.id;
 select jsonb_build_object('mission',to_jsonb(s),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=m.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=m.id))) into after_source from agent_missions s where id=m.id;
 select jsonb_build_object('mission',to_jsonb(s)-'token_allowance','jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=donor.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=donor.id))) into after_donor from agent_missions s where id=donor.id;
 if before_source is distinct from after_source or before_donor is distinct from after_donor then raise exception 'Source artifact, deadline or charge changed';end if;
 if (select sum(token_allowance) from agent_missions where id in(donor.id,n))<>donor.token_allowance then raise exception 'Aggregate authorization increased';end if;
 if exists(select 1 from mission_assignments where mission_id=n and role='review' and result->>'verdict'='pass') then raise exception 'Review approval cannot be copied';end if;
end $$;
commit;
