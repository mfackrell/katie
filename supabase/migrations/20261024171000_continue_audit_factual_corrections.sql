-- Continue only identified factual corrections and empty-output provider failure
-- after the matching runtime repair. Preserve original evidence and all charges.
begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
do $recovery$
declare
 source_id uuid;recovery_key text:='saved_audit_corrections_v3_20261024';
 allowance integer;ceiling integer;expected_usage integer;source_slug text;
 m agent_missions;d executive_delegations;parent executive_management_requests;j mission_assignments;
 new_id uuid;new_d uuid;before_state jsonb;after_state jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 foreach source_id in array array['3229be40-69ed-47c7-8057-d8c4e05394ef','f8734d8d-7c2c-4fce-84d9-b1a6ba0ecca7']::uuid[] loop
 allowance:=case when source_id='3229be40-69ed-47c7-8057-d8c4e05394ef' then 100000 else 120000 end;
 ceiling:=case when allowance=100000 then 4 else 6 end;expected_usage:=case when allowance=100000 then 43293 else 76456 end;
 source_slug:=case when allowance=100000 then 'software_development' else 'operations' end;
 if exists(select 1 from executive_delegation_events where event=recovery_key and evidence->>'sourceMissionId'=source_id::text) then continue;end if;
 select * into m from agent_missions where id=source_id for update;
 if not found then continue;end if;
 if m.status<>'blocked' or m.project_id is not null or (allowance=100000 and m.repository_id is null) or (allowance=120000 and m.repository_id is not null) or m.deadline<=now()+interval '15 minutes'
  or m.actual_tokens<>expected_usage or m.reserved_tokens<>expected_usage or m.calls<>(case when allowance=100000 then 1 else 2 end) then raise exception 'Saved audit completion source changed';end if;
 select * into j from mission_assignments where mission_id=source_id and job_key=case when allowance=100000 then 'review_again' else 'revision' end;
 if not found or (allowance=100000 and (j.status<>'completed' or j.result->>'verdict' is distinct from 'changes_requested'))
  or (allowance=120000 and (j.status<>'failed' or j.result->>'incompleteReason' is distinct from 'max_output_tokens' or coalesce(j.result->>'partialText','')<>''))
  or not exists(select 1 from mission_assignments where mission_id=source_id and job_key='review' and status='completed' and result->>'verdict'='changes_requested') then raise exception 'Expected factual review or empty-output failure missing';end if;
 if allowance=100000 and (not(j.payload ? 'reviewModelCheckpoint')
  or not exists(select 1 from mission_assignments where mission_id=source_id and job_key='revision' and status='completed' and length(result->>'text')>0)) then raise exception 'Saved technical revision or criteria missing';end if;
 if allowance=120000 and (select count(*) from mission_assignments where mission_id=source_id and job_key in('trace_facts','trace_challenge') and status='completed' and length(result->>'text')>0)<>2 then raise exception 'Actual operational worker analyses missing';end if;
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
  coalesce(m.project_evidence,'{}')||jsonb_build_object('savedAuditCorrections',jsonb_build_object('sourceMissionId',source_id,'sourceLedgerActual',m.actual_tokens,'sourceLedgerReserved',m.reserved_tokens,'sourceCalls',m.calls,'sourceRoutingCalls',m.routing_calls,
   'reason',case when allowance=100000 then 'Correct only the latest three independently identified factual errors using hash-bound exact edits. Preserve all other candidate bytes and require fresh full independent comparison; reuse actual blind criteria.' else 'Reuse both completed operational trace analyses and prior draft/findings. Empty max-output responses now fail over immediately instead of paying for a larger empty retry. Execute only revision and independent review.' end,
   'requiredRuntimeRepair','exact-patch-empty-fallback-v3',
   'authorizedAdditionalTokenCeiling',allowance,'originalDeadlineRetained',true,'authorization','Owner authorized necessary fixes and recovery through production verification')),
  'Saved substantive work retained. Waiting for matching targeted-correction and empty-output-fallback runtime before the remaining revision/review can execute.');
 -- Technical: promote the saved revised candidate to the correction base and
 -- retain the latest actual rejection. Older completed artifacts remain in the
 -- linked source mission. Ops: reuse both real trace workers and prior draft.
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
 select new_id,
  case when allowance=100000 and job_key='revision' then 'compose' when allowance=100000 and job_key='review_again' then 'review' else job_key end,
  case when allowance=100000 and job_key='revision' then 'compose' else role end,
  agent_id,instruction,
  case when allowance=100000 and job_key='revision' then array(select job_key from mission_assignments where mission_id=source_id and role='work' and status='completed') when allowance=100000 and job_key='review_again' then array['compose'] else dependencies end,
  payload||jsonb_build_object('reusedFrom',jsonb_build_object('missionId',source_id,'assignmentId',id,'attempts',attempts,'resultHash',md5(coalesce(result::text,'')))),
  'completed',0,result,'Verbatim artifact reused; original observation, attempts and charges remain unchanged.'
 from mission_assignments where mission_id=source_id and status='completed'
  and (allowance=120000 or job_key not in('compose','review'));
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
 select new_id,'revision','revise',agent_id,
  case when allowance=100000 then 'Apply exact before/after corrections to the saved compose artifact for every latest independent factual finding. Preserve all other wording and immutable source references. Do not add new release claims or rewrite for style.' else instruction end,
  case when allowance=100000 then array['review'] else dependencies end,
  (payload-'operationalEvidenceSnapshot'-'reviewModelCheckpoint')||jsonb_build_object('continuedFrom',jsonb_build_object('missionId',source_id,'assignmentId',id,'attempts',attempts,'resultHash',md5(coalesce(result::text,''))))||
  case when allowance=100000 then jsonb_build_object('revisionPatchBaseHash',encode(sha256(convert_to(result->>'text','UTF8')),'hex')) else '{}'::jsonb end,
  'queued',0,null,'Only the unresolved correction executes; all previous results remain in their original records.'
 from mission_assignments where mission_id=source_id and job_key='revision';
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
 select new_id,'review_again','review',agent_id,instruction,array['revision'],
  (payload-'operationalEvidenceSnapshot')||jsonb_build_object('continuedFrom',jsonb_build_object('missionId',source_id,'assignmentId',id,'attempts',attempts,'resultHash',md5(coalesce(result::text,'')))),
  'queued',0,null,'Fresh full independent comparison required; actual unchanged blind criteria may be reused.'
 from mission_assignments where mission_id=source_id and job_key='review_again';
 if exists(select 1 from mission_assignments where mission_id=new_id and role='review' and result->>'verdict'='pass') then raise exception 'Review pass cannot be imported';end if;
 if exists(select 1 from mission_assignments a,unnest(a.dependencies) dep where a.mission_id=new_id and not exists(select 1 from mission_assignments b where b.mission_id=new_id and b.job_key=dep)) then raise exception 'Dependency evidence missing';end if;
 insert into executive_delegations(id,orchestrator_id,actor_id,chat_id,request_key,objective,success_criteria,capability,status,delegated_version,budget_tokens,deadline,mission_id)
 values(new_d,d.orchestrator_id,d.actor_id,d.chat_id,'exec-specialist-task-'||recovery_key||':'||source_id::text,d.objective,d.success_criteria,d.capability,'running',d.delegated_version,allowance,m.deadline,new_id);
 insert into executive_delegation_events(delegation_id,event,evidence) values(new_d,recovery_key,jsonb_build_object('sourceMissionId',source_id,'sourceDelegation',to_jsonb(d),'continuationMissionId',new_id,'sourceStateHash',md5(before_state::text),'additionalTokenCeiling',allowance,'originalDeadline',m.deadline,'freshReviewRequired',true,'priorParentPlan',parent.plan));
 update executive_management_requests set status='running',plan=jsonb_set(jsonb_set(plan,'{assignments}',(select jsonb_agg(case when a->>'missionId'=source_id::text then (a-'blocked')||jsonb_build_object('missionId',new_id,'previousContinuationMissionId',source_id) else a end) from jsonb_array_elements(plan->'assignments') a)),
 '{provision}',(select jsonb_agg(case when p->>'blocked'='Source workstreams have not passed independent review; synthesis was not started.' and p->'sourceSlugs' ? source_slug then p-'blocked' else p end) from jsonb_array_elements(plan->'provision') p)),
 detail='Completed audit artifacts are retained; remaining revision/reviews wait for matching targeted-correction and empty-output-fallback runtime. Both source reviews must pass before synthesis.',updated_at=now() where id=parent.id;
 select jsonb_build_object('mission',to_jsonb(s),'jobs',(select jsonb_agg(to_jsonb(a) order by id) from mission_assignments a where mission_id=source_id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=source_id))) into after_state from agent_missions s where id=source_id;
 if before_state is distinct from after_state then raise exception 'Source artifact, attempt or ledger changed';end if;
 end loop;
end $recovery$;
commit;


-- Migration may run before Vercel finishes building. Only the matching new
-- runtime invokes this service-only start gate; no queued work reaches old code.
create or replace function public.activate_saved_audit_corrections() returns integer
language plpgsql security invoker set search_path=public as $$
declare m agent_missions;d executive_delegations;n integer:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 for m in select * from agent_missions where status='draft' and project_id is null
  and project_evidence->'savedAuditCorrections'->>'requiredRuntimeRepair'='exact-patch-empty-fallback-v3'
  and project_evidence->'savedAuditCorrections'->>'sourceMissionId' in('3229be40-69ed-47c7-8057-d8c4e05394ef','f8734d8d-7c2c-4fce-84d9-b1a6ba0ecca7')
  and calls=0 and routing_calls=0 and actual_tokens=0 and reserved_tokens=0 and deadline>now()
  order by created_at for update
 loop
  select * into d from executive_delegations where mission_id=m.id and status='running' and deadline>now() for update;
  if not found or not exists(select 1 from executive_delegation_events where delegation_id=d.id and event='saved_audit_corrections_v3_20261024' and evidence->>'continuationMissionId'=m.id::text) then continue;end if;
  update agent_missions set status='running',detail='Matching corrected audit runtime verified by start gate. Executing only remaining saved stages with original deadline.',updated_at=now() where id=m.id;
  insert into executive_delegation_events(delegation_id,event,evidence) values(d.id,'runtime_started_saved_audit_corrections',jsonb_build_object('missionId',m.id,'runtimeRepair','exact-patch-empty-fallback-v3','deadline',m.deadline,'tokenAllowance',m.token_allowance));
  n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function public.activate_saved_audit_corrections() from public,anon,authenticated;
grant execute on function public.activate_saved_audit_corrections() to service_role;
