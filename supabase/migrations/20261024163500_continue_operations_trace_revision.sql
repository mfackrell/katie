-- Owner-authorized missing trace analysis after the #718 snapshot/timeout fix.
-- Merge only after #718 is verified serving. Original ledgers remain unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
do $recovery$
declare
 source_id uuid:='b50007ae-016a-435e-8835-9109405011d5';
 recovery_key text:='operations_trace_revision_20261024';
 m agent_missions;d executive_delegations;parent executive_management_requests;
 new_id uuid;new_d uuid;before_state jsonb;after_state jsonb;baseline jsonb;
 lead_id uuid;analyst_id uuid;old_review mission_assignments;old_revision mission_assignments;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if exists(select 1 from executive_delegation_events where event=recovery_key and evidence->>'sourceMissionId'=source_id::text) then return;end if;
 select * into m from agent_missions where id=source_id for update;
 if not found then return;end if;
 if m.status<>'blocked' or m.project_id is not null or m.repository_id is not null or m.deadline<=now()+interval '20 minutes'
  or m.actual_tokens<>73361 or m.reserved_tokens<>95966 or m.calls<>5 then raise exception 'Operations recovery state changed';end if;
 if to_regprocedure('public.checkpoint_mission_operational_evidence(uuid,uuid,jsonb)') is null then raise exception 'Snapshot repair missing';end if;
 if exists(select 1 from mission_assignments where mission_id=source_id and status='running' and lease_until>now()) then raise exception 'Active operation cannot be continued';end if;
 select * into d from executive_delegations where mission_id=source_id for update;
 if not found or d.status<>'cancelled' or not coalesce((select event='cancel' and evidence->>'reason'='Mission did not pass independent review' from executive_delegation_events where delegation_id=d.id order by created_at desc limit 1),false) then raise exception 'Only automatic failed-review cancellation may be continued';end if;
 select * into parent from executive_management_requests where id='3b81cc91-9a68-47dc-8442-dbf700431f15' for update;
 if not found or parent.status not in ('blocked','running') or parent.actor_id<>d.actor_id or parent.chat_id<>d.chat_id
  or not exists(select 1 from jsonb_array_elements(parent.plan->'assignments') a where a->>'slug'='operations' and a->>'missionId'=source_id::text) then raise exception 'Operations parent changed';end if;
 select * into old_review from mission_assignments where mission_id=source_id and job_key='review';
 select * into old_revision from mission_assignments where mission_id=source_id and job_key='revision';
 if old_review.status<>'completed' or old_review.result->>'verdict' is distinct from 'changes_requested'
  or old_revision.status<>'failed' or old_revision.result->>'admissionDenied' is distinct from 'true' then raise exception 'Saved substantive review/revision missing';end if;
 select (a->>'id')::uuid into lead_id from jsonb_array_elements(m.team) a where a->>'id'=(select agent_id::text from mission_assignments where mission_id=source_id and job_key='compose');
 select (a->>'id')::uuid into analyst_id from jsonb_array_elements(m.team) a where a->>'id'=old_review.agent_id::text;
 if lead_id is null or analyst_id is null or lead_id=analyst_id then raise exception 'Independent saved team unavailable';end if;
 select jsonb_build_object('mission',to_jsonb(m),'jobs',(select jsonb_agg(to_jsonb(a) order by id) from mission_assignments a where mission_id=source_id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=source_id))) into before_state;
 -- This is a new observation with its own time, never a reconstruction of the
 -- missing 16:01 composer snapshot. Keep old planning timestamps in the input.
 with scoped as(select id,mission_id,status,capability,created_at,updated_at from executive_delegations where actor_id=d.actor_id and chat_id=d.chat_id order by created_at desc limit 10),
 missions as(select id,status,calls,routing_calls,actual_tokens,reserved_tokens,token_allowance,detail,created_at,updated_at from agent_missions where id in(select mission_id from scoped)),
 jobs as(select id,mission_id,job_key,role,status,attempts,detail,created_at,updated_at from mission_assignments where mission_id in(select mission_id from scoped) order by created_at asc limit 30)
 select jsonb_build_object('kind','scoped_workflow_trace','observedAt',now(),'actorId',d.actor_id,'chatId',d.chat_id,
  'trace',jsonb_build_object('delegations',(select jsonb_agg(s) from scoped s),'missions',(select jsonb_agg(s) from missions s),'jobs',(select jsonb_agg(s) from jobs s)),
  'limitations',jsonb_build_array('One point-in-time observation of at most ten delegated missions and thirty earliest assignments in this Executive conversation. No provider timing split, complete state-transition history, conversation content, memory behavior or browser behavior is established. Created/updated timestamps do not establish active execution duration.')) into baseline;
 if length(baseline::text)>20000 then raise exception 'Scoped baseline exceeds bounded evidence';end if;
 new_id:=overlay(overlay(md5(recovery_key||':'||source_id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
 new_d:=overlay(overlay(md5(recovery_key||':delegation:'||d.id::text) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid;
 insert into agent_missions(id,objective,team,status,max_calls,token_allowance,max_minutes,deadline,project_evidence,detail)
 values(new_id,m.objective||E'\nRecovery scope: deliver the complete report in at most 1200 words. Two new saved workers must analyze the actual scoped traces before revision. Address every prior substantive review finding, treating the missing original composer snapshot as a provenance gap rather than reconstructing its state. Distinguish observed timestamps from active runtime, and deployed-version evidence from functional verification. Preserve unavailable coverage explicitly; do not infer absent memory, appropriate selection, routing cost ratios, or false completion from status labels alone. All effort and threshold recommendations are estimates/proposals, not observed facts.',m.team,'running',10,120000,m.max_minutes,m.deadline,
  jsonb_build_object('operationalBaseline',baseline,'continuation',jsonb_build_object('sourceMissionId',m.id,'sourceLedgerActual',m.actual_tokens,'sourceLedgerReserved',m.reserved_tokens,'sourceCalls',m.calls,'sourceRoutingCalls',m.routing_calls,
   'reason','Missing substantive worker analysis of the actual trace, followed by revision against the saved independent findings. Snapshot retention and expanded-output timeout repaired in PR718. The prior draft and all charges remain at the source; no review is waived.',
   'authorizedAdditionalTokenCeiling',120000,'originalDeadlineRetained',true,'authorization','Owner authorized necessary fixes and bounded recovery through production verification')),
  'Two trace workers, saved-draft revision and independent review. Prior charges and uncertainty retained; original deadline unchanged.');
 -- Copy only the real completed draft and the real changes-requested review.
 -- Their complete artifacts remain verbatim; a pass can never be copied here.
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status,attempts,result,detail)
 select new_id,job_key,role,agent_id,instruction,case when role='review' then array['compose'] else '{}'::text[] end,
  jsonb_build_object('reusedFrom',jsonb_build_object('missionId',source_id,'assignmentId',id,'attempts',attempts,'resultHash',md5(result::text))),'completed',0,result,
  'Verbatim prior artifact retained with provenance. The prior review requested changes; fresh independent review remains mandatory.'
 from mission_assignments where mission_id=source_id and job_key in('compose','review') and status='completed';
 if not found then raise exception 'No saved artifacts copied';end if;
 insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload,status) values
 (new_id,'trace_facts','work',analyst_id,'Analyze the actual operationalBaseline and operationalEvidence snapshots. In at most 350 words, cite exact mission/job IDs and timestamps for budget/execution/review stalls and lifecycle state. Distinguish elapsed created-to-updated spans from actual running duration. Identify every unavailable audit area explicitly. A completed legacy worker without trace analysis is not new trace analysis. Do not read the old draft as facts, invent root causes, or claim to have accessed other logs.','{}','{"capability":"analysis"}','queued'),
 (new_id,'trace_challenge','work',lead_id,'Independently challenge trace_facts against the complete supplied snapshots. In at most 350 words, verify chronology, explain which causal claims cannot be established, assess status-honesty limits, and propose prioritized evidence-grounded remedies with severity, impact, dependencies and effort explicitly estimated. Distinguish observations, risks and enhancements. Cite exact IDs. Do not infer behavior from missing evidence or claim that a deployment receipt verifies a fix.',array['trace_facts'],'{"capability":"analysis"}','queued'),
 (new_id,'revision','revise',lead_id,old_revision.instruction||E'\nUse both new trace workers and the saved snapshots. Correct the entire saved draft; keep the final report under its 1200-word cap. Earlier snapshot comparisons may be unresolvable because the composer snapshot was not retained; disclose that gap. Include actual coverage gaps, root-cause uncertainty and a concise resolution of the prior challenges, without claiming the new independent review already passed.',array['review','trace_facts','trace_challenge'],'{}','queued'),
 (new_id,'review_again','review',analyst_id,'Independently verify the revised operational report against the original scope, actual trace snapshots, both substantive worker analyses and every material prior finding. Enforce evidence integrity and explicitly limited coverage. No manual waiver or false completion.',array['revision'],'{}','queued');
 insert into executive_delegations(id,orchestrator_id,actor_id,chat_id,request_key,objective,success_criteria,capability,status,delegated_version,budget_tokens,deadline,mission_id)
 values(new_d,d.orchestrator_id,d.actor_id,d.chat_id,'exec-specialist-task-'||recovery_key,d.objective,d.success_criteria,d.capability,'running',d.delegated_version,120000,m.deadline,new_id);
 insert into executive_delegation_events(delegation_id,event,evidence) values(new_d,recovery_key,jsonb_build_object('sourceMissionId',source_id,'sourceDelegation',to_jsonb(d),'continuationMissionId',new_id,'sourceStateHash',md5(before_state::text),'additionalTokenCeiling',120000,'originalDeadline',m.deadline,'freshReviewRequired',true,'priorParentPlan',parent.plan));
 update executive_management_requests set status='running',
 plan=jsonb_set(jsonb_set(plan,'{assignments}',(select jsonb_agg(case when a->>'missionId'=source_id::text then (a-'blocked')||jsonb_build_object('missionId',new_id,'previousContinuationMissionId',source_id) else a end) from jsonb_array_elements(plan->'assignments') a)),
 '{provision}',(select jsonb_agg(case when p->>'blocked'='Source workstreams have not passed independent review; synthesis was not started.' and p->'sourceSlugs' ? 'operations' then p-'blocked' else p end) from jsonb_array_elements(plan->'provision') p)),
 detail='Operations now requires fresh trace analysis and revision against saved independent findings. Both source audits must pass before synthesis; no review is approved by this recovery.',updated_at=now() where id=parent.id;
 select jsonb_build_object('mission',to_jsonb(s),'jobs',(select jsonb_agg(to_jsonb(a) order by id) from mission_assignments a where mission_id=source_id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=source_id))) into after_state from agent_missions s where id=source_id;
 if before_state is distinct from after_state then raise exception 'Original work or charges changed';end if;
end $recovery$;
commit;
