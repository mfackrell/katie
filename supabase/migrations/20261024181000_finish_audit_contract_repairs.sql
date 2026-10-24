-- Actual remaining failures: technical changes_requested; operations malformed
-- assessment twice and measured 1272 > 1200 words. The matching runtime now
-- checks length before review and constrains review JSON on native transports.
-- Original expired deadlines and every old charge/artifact remain untouched.
begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
do $recovery$
declare
 source_id uuid; recovery_key text:='saved_audit_contract_v5_20261024';
 technical boolean; allowance integer; expected_usage integer; source_slug text;
 m agent_missions; d executive_delegations; parent executive_management_requests;
 new_id uuid; new_d uuid; finishing_deadline timestamptz:=now()+interval '60 minutes';
 before_state jsonb; after_state jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 foreach source_id in array array['6e1d5b7e-e0cd-4158-86e4-2f53b72d934b','c1d6ca76-dc21-4025-84bb-1d8a6a30e587']::uuid[] loop
 technical:=source_id='6e1d5b7e-e0cd-4158-86e4-2f53b72d934b';
 allowance:=case when technical then 60000 else 70000 end;
 expected_usage:=case when technical then 41196 else 30503 end;
 source_slug:=case when technical then 'software_development' else 'operations' end;
 if exists(select 1 from executive_delegation_events where event=recovery_key and evidence->>'sourceMissionId'=source_id::text) then continue;end if;
 select * into m from agent_missions where id=source_id for update;
 if not found then continue;end if;
 if m.status<>'blocked' or m.project_id is not null or technical<>(m.repository_id is not null)
  or m.actual_tokens<>expected_usage or m.reserved_tokens<>expected_usage or m.calls<>(case when technical then 1 else 3 end)
  then raise exception 'Saved final correction source changed';end if;
 if not exists(select 1 from mission_assignments where mission_id=source_id and job_key='revision' and status='completed' and length(result->>'text')>0)
  or not exists(select 1 from mission_assignments where mission_id=source_id and job_key='review_again' and
   ((technical and status='completed' and result->>'verdict'='changes_requested') or
    (not technical and status='failed' and attempts=2 and result->>'reviewPhase'='assessment')))
  then raise exception 'Expected actual revision and failed review missing';end if;
 if not technical and (select count(*) from mission_assignments where mission_id=source_id and job_key in('trace_facts','trace_challenge') and status='completed' and length(result->>'text')>0)<>2 then raise exception 'Actual operational analyses missing';end if;
 if exists(select 1 from mission_assignments where mission_id=source_id and status='running' and lease_until>now()) then raise exception 'Active work cannot be copied';end if;
 select * into d from executive_delegations where mission_id=source_id for update;
 if not found or d.status<>'cancelled' or not coalesce((select event='cancel' and evidence->>'reason'='Mission did not pass independent review' from executive_delegation_events where delegation_id=d.id order by created_at desc limit 1),false) then raise exception 'Owner cancellation cannot be overridden';end if;
 select * into parent from executive_management_requests where id='3b81cc91-9a68-47dc-8442-dbf700431f15' for update;
 if not found or parent.status not in('running','blocked') or parent.actor_id<>d.actor_id or parent.chat_id<>d.chat_id
  or not exists(select 1 from jsonb_array_elements(parent.plan->'assignments') a where a->>'slug'=source_slug and a->>'missionId'=source_id::text) then raise exception 'Parent source binding changed';end if;
 select jsonb_build_object('mission',to_jsonb(m),'jobs',(select jsonb_agg(to_jsonb(a) order by id) from mission_assignments a where mission_id=source_id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=source_id))) into before_state;
 new_id:=overlay(overlay(md5(recovery_key||':'||source_id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
 new_d:=overlay(overlay(md5(recovery_key||':delegation:'||d.id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
 insert into agent_missions(id,objective,team,status,max_calls,token_allowance,max_minutes,deadline,repository_id,project_evidence,detail)
 values(new_id,m.objective,m.team,'draft',6,allowance,60,finishing_deadline,m.repository_id,
  coalesce(m.project_evidence,'{}')||jsonb_build_object('savedAuditContractRecovery',jsonb_build_object('sourceMissionId',source_id,'sourceLedgerActual',m.actual_tokens,'sourceLedgerReserved',m.reserved_tokens,'sourceCalls',m.calls,'sourceRoutingCalls',m.routing_calls,
   'reason','Finish actual remaining corrections with measured length preflight and native structured review; no previous verdict or charge is altered.',
   'requiredRuntimeRepair','measured-length-native-review-v5','authorizedAdditionalTokenCeiling',allowance,'originalDeadline',m.deadline,'originalDeadlineRetained',false,
   'finishingDeadline',finishing_deadline,'authorization','Owner authorized necessary code fixes and recovery through production verification. This bounded finishing window follows the concrete contract fixes; it does not renew the expired source mission.')),
  'Saved artifacts retained. Waiting for measured-length and structured-review runtime before remaining corrections and independent review.');
 -- Only the latest actual candidate is composed; every source worker is copied
 -- verbatim. Technical uses its latest real findings; operations retains its
 -- last substantive review, since the subsequent malformed contract is no review.
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
 select new_id,case when job_key='revision' then 'compose' when job_key='review_again' then 'review' else job_key end,
  case when job_key='revision' then 'compose' else role end,agent_id,instruction,
  case when job_key='revision' then array(select job_key from mission_assignments where mission_id=source_id and role='work' and status='completed') when role='review' then array['compose'] else dependencies end,
  (payload-'continuedFrom')||jsonb_build_object('reusedFrom',jsonb_build_object('missionId',source_id,'assignmentId',id,'attempts',attempts,'resultHash',md5(coalesce(result::text,'')))),
  'completed',0,result,'Verbatim saved artifact; original attempts, observation times and charges retained.'
 from mission_assignments where mission_id=source_id and status='completed' and
  (role in('plan','work') or job_key='revision' or (technical and job_key='review_again') or (not technical and job_key='review'));
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
 select new_id,'revision','revise',agent_id,
  case when technical then 'Apply the actual latest review findings to this saved candidate: reconcile summary effort labels, remove revision-history argument from the report while retaining current evidence-based classifications, and qualify or remove the unsupported SR-4 adjacency to PR 630. Check every cited prior finding against the current text; preserve all immutable source references and prior factual corrections.'
   else 'The saved candidate already includes the latest factual corrections but measures 1272 words against a 1200-word limit. Remove at least 100 words of redundancy, aiming below 1150, while preserving all six coverage areas, actual trace citations, causal uncertainty, recommendations and coverage gaps. Check prior findings against the current candidate and retain its resolved corrections. Do not add a revision log or claim review passed.' end,
  array['review'],jsonb_build_object('continuedFrom',jsonb_build_object('missionId',source_id,'assignmentId',id,'attempts',attempts,'resultHash',md5(coalesce(result::text,''))),
   'revisionPatchBaseHash',encode(sha256(convert_to(result->>'text','UTF8')),'hex')),
  'queued',0,null,'Only remaining exact edits execute before a fresh full independent review.'
 from mission_assignments where mission_id=source_id and job_key='revision';
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
 select new_id,'review_again','review',agent_id,instruction,array['revision'],jsonb_build_object('continuedFrom',jsonb_build_object('missionId',source_id,'assignmentId',id,'attempts',attempts,'resultHash',md5(coalesce(result::text,'')))),
  'queued',0,null,'Fresh structured blind assessment and full source-grounded independent comparison required.'
 from mission_assignments where mission_id=source_id and job_key='review_again';
 if exists(select 1 from mission_assignments where mission_id=new_id and role='review' and result->>'verdict'='pass') then raise exception 'Review pass cannot be imported';end if;
 if exists(select 1 from mission_assignments a,unnest(a.dependencies) dep where a.mission_id=new_id and not exists(select 1 from mission_assignments b where b.mission_id=new_id and b.job_key=dep)) then raise exception 'Dependency evidence missing';end if;
 insert into executive_delegations(id,orchestrator_id,actor_id,chat_id,request_key,objective,success_criteria,capability,status,delegated_version,budget_tokens,deadline,mission_id)
 values(new_d,d.orchestrator_id,d.actor_id,d.chat_id,'exec-specialist-task-'||recovery_key||':'||source_id::text,d.objective,d.success_criteria,d.capability,'running',d.delegated_version,allowance,finishing_deadline,new_id);
 insert into executive_delegation_events(delegation_id,event,evidence) values(new_d,recovery_key,jsonb_build_object('sourceMissionId',source_id,'sourceDelegation',to_jsonb(d),'continuationMissionId',new_id,'sourceStateHash',md5(before_state::text),'additionalTokenCeiling',allowance,'originalDeadline',m.deadline,'finishingDeadline',finishing_deadline,'freshReviewRequired',true,'priorParentPlan',parent.plan));
 update executive_management_requests set status='running',plan=jsonb_set(jsonb_set(plan,'{assignments}',(select jsonb_agg(case when a->>'missionId'=source_id::text then (a-'blocked')||jsonb_build_object('missionId',new_id,'previousContinuationMissionId',source_id) else a end) from jsonb_array_elements(plan->'assignments') a)),
  '{provision}',(select jsonb_agg(case when p->>'blocked'='Source workstreams have not passed independent review; synthesis was not started.' and p->'sourceSlugs' ? source_slug then p-'blocked' else p end) from jsonb_array_elements(plan->'provision') p)),
  detail='Saved source work awaits only remaining contract repairs and fresh independent review. Synthesis still requires both source reviews to pass.',updated_at=now() where id=parent.id;
 select jsonb_build_object('mission',to_jsonb(s),'jobs',(select jsonb_agg(to_jsonb(a) order by id) from mission_assignments a where mission_id=source_id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=source_id))) into after_state from agent_missions s where id=source_id;
 if before_state is distinct from after_state then raise exception 'Source artifact, attempt, deadline or ledger changed';end if;
 end loop;
end $recovery$;
commit;

create or replace function public.activate_saved_audit_contract_recovery() returns integer
language plpgsql security invoker set search_path=public as $$
declare m agent_missions; d executive_delegations; n integer:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 for m in select * from agent_missions where status='draft' and project_id is null
  and project_evidence->'savedAuditContractRecovery'->>'requiredRuntimeRepair'='measured-length-native-review-v5'
  and project_evidence->'savedAuditContractRecovery'->>'sourceMissionId' in('6e1d5b7e-e0cd-4158-86e4-2f53b72d934b','c1d6ca76-dc21-4025-84bb-1d8a6a30e587')
  and calls=0 and routing_calls=0 and actual_tokens=0 and reserved_tokens=0 and deadline>now() order by created_at for update loop
  select * into d from executive_delegations where mission_id=m.id and status='running' and deadline>now() for update;
  if not found or not exists(select 1 from executive_delegation_events where delegation_id=d.id and event='saved_audit_contract_v5_20261024' and evidence->>'continuationMissionId'=m.id::text) then continue;end if;
  update agent_missions set status='running',detail='Matching length-preflight and native structured-review runtime started bounded saved-artifact finishing work.',updated_at=now() where id=m.id;
  insert into executive_delegation_events(delegation_id,event,evidence) values(d.id,'runtime_started_saved_audit_contract_recovery',jsonb_build_object('missionId',m.id,'runtimeRepair','measured-length-native-review-v5','deadline',m.deadline,'tokenAllowance',m.token_allowance));
  n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function public.activate_saved_audit_contract_recovery() from public,anon,authenticated;
grant execute on function public.activate_saved_audit_contract_recovery() to service_role;
