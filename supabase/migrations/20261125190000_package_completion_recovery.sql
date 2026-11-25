-- Mission108: exact browser assertions are fixed in the trusted parser.
-- Mission109: preserve definitive paid responses before any manager decision.
-- A new owner receipt, NOT this migration or the prior standing consent,
-- is required to purchase the one missing-response replacement inference.
create table public.project_package_paid_responses(
 request_id uuid primary key references public.project_provider_requests(id),
 project_id uuid not null references public.work_projects(id),
 mission_id uuid not null references public.agent_missions(id),
 assignment_id uuid not null references public.mission_assignments(id),
 execution_attempt text not null,
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 provider_receipt text not null unique,
 response jsonb not null,
 response_hash text not null check(response_hash ~ '^[a-f0-9]{64}$'),
 captured_at timestamptz not null default clock_timestamp()
);
alter table public.project_package_paid_responses enable row level security;
revoke all on public.project_package_paid_responses from public,anon,authenticated,service_role;
create trigger package_paid_response_immutable before update or delete on public.project_package_paid_responses
 for each row execute function public.project_org_change_immutable();

create table public.project_package_completion_receipts(
 project_id uuid primary key references public.work_projects(id),
 authorization_id uuid not null unique,
 root_authorization_id uuid not null references public.project_package_corrective_receipts(receipt_id),
 prior_release_receipt_id uuid not null references public.project_package_corrective_receipts(receipt_id),
 package_id uuid not null references public.project_work_packages(id),
 owner_id uuid not null,
 failed_mission_id uuid not null references public.agent_missions(id),
 failed_assignment_id uuid not null references public.mission_assignments(id),
 prior_request_id uuid not null references public.project_provider_requests(id),
 release_sha text not null check(release_sha ~ '^[a-f0-9]{40}$'),
 release_generation bigint not null,
 deployment_id text not null check(deployment_id ~ '^dpl_[A-Za-z0-9]+$'),
 cutoff timestamptz not null,
 terms jsonb not null,
 original_terms jsonb not null,
 checkpoint jsonb not null,
 state_hash text not null,
 authorization_txid bigint not null default txid_current(),
 authorized_at timestamptz not null default clock_timestamp()
);
alter table public.project_package_completion_receipts enable row level security;
revoke all on public.project_package_completion_receipts from public,anon,authenticated,service_role;
create trigger package_completion_receipt_immutable before update or delete on public.project_package_completion_receipts
 for each row execute function public.project_org_change_immutable();

create function public.project_org_package_completion_terms() returns jsonb
language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('maxMissions',118,'developmentAttempts',5,'codingDispatches',5,'managerMissions',9,
  'nativeInferencePerDispatch',12,'nativeInferenceLimit',60,'compositionLimit',5,'reviewLimit',5,'paidInferenceLimit',80,
  'additionalPaidRetries',1,'automaticRetries',0,'nativeAutomaticRepairs',0,'tokenAllowance',600000,'additionalTokens',0,
  'spendMode','provider-account','dollarCeilingMicrousd',null,'stopAt','package-acceptance')
$$;

-- All historical package contracts and SMART admissions remain unchanged.
-- A supplemental signed receipt supplies only the larger cumulative limits.
create function public.project_org_package_completion_limit(p_project uuid,p_key text,p_original integer) returns integer
language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce((select (s.terms->>p_key)::int
  from project_package_completion_receipts s
  join project_package_execution_receipts r on r.project_id=s.project_id
  join project_package_corrective_receipts root on root.receipt_id=s.root_authorization_id and root.ordinal=0
  where s.project_id=p_project and s.package_id=r.package_id and s.owner_id=r.owner_id
   and s.cutoff=r.cutoff and s.original_terms=r.terms and s.terms=project_org_package_completion_terms()
   and root.project_id=s.project_id and root.package_id=r.package_id and root.owner_id=r.owner_id
   and root.terms=r.terms and root.corrective_terms=project_org_package_corrective_terms()
   and s.cutoff>clock_timestamp()),p_original)
$$;

-- This is a release-only, drained checkpoint, not spend authorization.
-- It specifically recognizes the historical lost, settled Mission109 result.
create function public.project_org_package_completion_checkpoint(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p work_projects; r project_package_execution_receipts; root project_package_corrective_receipts;
 last_receipt project_package_corrective_receipts; w project_work_packages; m agent_missions; j mission_assignments;
 q project_provider_requests; prev agent_missions; dev mission_assignments; task agent_tasks; cp jsonb;
begin
 select * into p from work_projects where id=p_project;
 select * into r from project_package_execution_receipts where project_id=p.id;
 select * into root from project_package_corrective_receipts where project_id=p.id and ordinal=0;
 select * into last_receipt from project_package_corrective_receipts where project_id=p.id order by ordinal desc limit 1;
 select * into w from project_work_packages where id=r.package_id and project_id=p.id;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id;
 select * into j from mission_assignments where mission_id=m.id and role='work';
 select * into q from project_provider_requests where assignment_id=j.id and operation='inference';
 select * into prev from agent_missions where id::text=m.project_evidence->>'previousMissionId' and project_id=p.id;
 select * into dev from mission_assignments where mission_id=prev.id and role='development';
 select * into task from agent_tasks where id=dev.id;
 if p.id is distinct from 'fe9d2658-41e3-44c1-ae8e-a0cba98371fe'::uuid
 or w.id is distinct from 'f88d4d10-dfe4-479e-a2cf-41b3e8209e47'::uuid
 or m.id is distinct from 'd7e48722-01a0-47ed-81ef-d045a5b09c89'::uuid
 or j.id is distinct from 'ed9182b7-7e95-4678-afb2-b75832c5aeea'::uuid
 or prev.id is distinct from 'a1ceb6af-6588-40e4-95c7-ca422f4701f0'::uuid
 or dev.id is distinct from '316179b0-5dcf-4a05-aad1-9a040b270d58'::uuid
 or root.project_id is null or root.package_id is distinct from w.id or root.owner_id is distinct from r.owner_id
 or root.cutoff is distinct from r.cutoff or root.terms is distinct from r.terms
 or root.corrective_terms is distinct from project_org_package_corrective_terms()
 or last_receipt.ordinal not between 1 and 5
 or exists(select 1 from project_package_completion_receipts where project_id=p.id)
 or p.status is distinct from 'blocked' or p.detail is distinct from 'Package management failed; no automatic retry'
 or p.phase is distinct from 'development' or p.organization_version<>1 or p.milestone_index<>0
 or p.lease is not null or p.lease_until is not null or p.max_missions<>112 or p.max_cycles<>3 or p.cycles<>2
 or p.token_allowance<>600000 or p.deadline is distinct from r.cutoff or w.deadline is distinct from r.cutoff
 or r.cutoff<=clock_timestamp()+interval '5 minutes'
 or p.approved_hash is distinct from r.scope_hash or p.approval_hash is distinct from r.scope_hash
 or not project_provider_continued(p.id)
 or w.status is distinct from 'review' or w.max_attempts<>3 or project_org_package_execution_fingerprint(w.id) is distinct from r.contract_fingerprint
 or (select count(*) from project_work_packages where project_id=p.id)<>1
 or (select count(*) from agent_missions where project_id=p.id)<>109
 or (select count(*) from agent_missions x where x.project_id=p.id and x.id=any(r.historical_mission_ids))<>104
 or (select count(*) from project_work_package_attempts where package_id=w.id)<>2
 or not exists(select 1 from project_work_package_attempts a where a.package_id=w.id and a.attempt=2 and a.mission_id=prev.id)
 or prev.status is distinct from 'blocked' or dev.status is distinct from 'failed' or task.status is distinct from 'blocked'
 or task.external->'receipt'->>'outcome' is distinct from 'BLOCKED' or task.external->'receipt'->'checks'->>'build' is distinct from 'failure'
 or task.external->'receipt'->>'pr_url' is not null
 or exists(select 1 from project_provider_requests where mission_id=prev.id)
 or exists(select 1 from project_provider_dispatches where task_id=dev.id)
 or m.status is distinct from 'blocked' or m.project_kind is distinct from 'management' or m.calls<>1
 or m.project_evidence->>'packageExecutionAuthorizationId' is distinct from r.authorization_id::text
 or m.project_evidence->>'organizationNodeId' is distinct from w.manager_id::text
 or j.status is distinct from 'failed' or j.attempts<>1 or j.detail not like '%Exact package manager lease and settled inference required%'
 or j.result->>'detail' is distinct from j.detail
 or j.payload->>'organizationNodeId' is distinct from w.manager_id::text or not project_provider_continued_assignment(j.id)
 or q.id is null or q.resolved_at is null or q.provider_receipt is null
 or (select count(*) from project_provider_requests where assignment_id=j.id)<>2
 or (select count(*) from project_provider_requests x where x.project_id=p.id and not x.mission_id=any(r.historical_mission_ids) and x.operation='inference')<>3
 or exists(select 1 from project_package_paid_responses where request_id=q.id)
 or exists(select 1 from project_organization_decisions where assignment_id=j.id)
 or project_provider_request_pending(p.id)
 or exists(select 1 from agent_missions x where x.project_id=p.id and x.status in('running','awaiting_approval'))
 or exists(select 1 from mission_assignments x join agent_missions y on y.id=x.mission_id where y.project_id=p.id and (x.lease is not null or x.lease_until is not null))
 or exists(select 1 from agent_tasks t join mission_assignments x on x.id=t.id join agent_missions y on y.id=x.mission_id where y.project_id=p.id and t.status in('dispatching','submitted'))
 then return null;end if;
 cp:=jsonb_build_object('mode','authorized-paid-retry','missionId',m.id,'assignmentId',j.id,'priorAttempts',j.attempts,
  'usedMissions',109,'usedAttempts',2,'paidInferences',3,'priorRequestId',q.id,'priorProviderReceipt',q.provider_receipt,
  'correctiveReleasesUsed',last_receipt.ordinal+1,'assignmentResult',to_jsonb(j),
  'priorRequest',to_jsonb(q),'priorDevelopmentReceipt',task.external->'receipt');
 return cp||jsonb_build_object('stateHash',encode(sha256(convert_to(project_canonical(jsonb_build_object(
  'checkpoint',cp,'projectState',project_org_coding_capacity_state(p.id),'package',to_jsonb(w),
  'originalReceipt',to_jsonb(r),'priorReleaseReceipt',to_jsonb(last_receipt),'standingRoot',to_jsonb(root)
 )),'UTF8')),'hex'));
end $$;

create function public.project_org_package_completion_offer(p_owner uuid,p_project uuid,p_release text) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p work_projects; r project_package_execution_receipts; root project_package_corrective_receipts;
 last_receipt project_package_corrective_receipts; w project_work_packages; g project_retest_production_release_gate; cp jsonb;
begin
 select * into p from work_projects where id=p_project;
 select * into r from project_package_execution_receipts where project_id=p.id;
 select * into w from project_work_packages where id=r.package_id;
 select * into root from project_package_corrective_receipts where project_id=p.id and ordinal=0;
 select * into last_receipt from project_package_corrective_receipts where project_id=p.id order by ordinal desc limit 1;
 select * into g from project_retest_production_release_gate where project_id=p.id;
 cp:=project_org_package_completion_checkpoint(p_project);
 if cp is null or p_owner is null or p_owner is distinct from r.owner_id
 or standalone_verify_scope(p_owner,p.actor_id,p.chat_id) is distinct from true
 or g.state is distinct from 'active' or g.alias_name is distinct from 'katie-mu.vercel.app'
 or g.release_sha is distinct from p_release or g.release_sha=last_receipt.release_sha
 or g.deployment_id=last_receipt.deployment_id or g.generation is distinct from last_receipt.release_generation+2
 then raise exception 'Exact qualified completion release and original authenticated owner required';end if;
 return jsonb_build_object('stage','authorize','projectId',p.id,'packageId',w.id,'priorAuthorizationId',last_receipt.receipt_id,
 'releaseSha',g.release_sha,'releaseGeneration',g.generation,'deploymentId',g.deployment_id,'scopeHash',r.scope_hash,'cutoff',r.cutoff,
 'stateHash',cp->>'stateHash','contractFingerprint',r.contract_fingerprint,'managerId',w.manager_id,'coderId',w.worker_id,'writerId',w.writer_id,'reviewerId',w.reviewer_id,
 'paths',w.paths,'developmentPaths',(select c.contract->'paths' from project_worker_contracts c where c.package_id=w.id and c.role='development'),
 'terms',r.terms,'correctiveTerms',root.corrective_terms,'completionTerms',project_org_package_completion_terms(),
 'completionCheckpoint',cp-'stateHash'-'assignmentResult'-'priorRequest'-'priorDevelopmentReceipt'-'mode'-'priorAttempts');
end $$;

create function public.project_org_package_completion_authorize(p_owner uuid,p_project uuid,p_package uuid,p_release text,p_generation bigint,p_deployment text,
 p_authorization uuid,p_state_hash text,p_terms jsonb,p_corrective_terms jsonb,p_context_hash text,p_context_chars integer,p_completion_terms jsonb,p_consent boolean) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare o jsonb; cp jsonb; r project_package_execution_receipts; root project_package_corrective_receipts; last_receipt project_package_corrective_receipts;
 mid uuid; jid uuid; stamp timestamptz:=clock_timestamp();
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 perform 1 from work_projects where id=p_project for update;
 perform 1 from project_retest_production_release_gate where project_id=p_project for update;
 perform 1 from project_work_packages where id=p_package and project_id=p_project for update;
 perform 1 from project_worker_contracts where package_id=p_package order by id for update;
 perform 1 from project_organization_nodes where project_id=p_project order by id for update;
 o:=project_org_package_completion_offer(p_owner,p_project,p_release);
 cp:=project_org_package_completion_checkpoint(p_project);
 select * into r from project_package_execution_receipts where project_id=p_project;
 select * into root from project_package_corrective_receipts where project_id=p_project and ordinal=0;
 select * into last_receipt from project_package_corrective_receipts where project_id=p_project order by ordinal desc limit 1;
 mid:=(cp->>'missionId')::uuid;jid:=(cp->>'assignmentId')::uuid;
 if p_consent is distinct from true or p_authorization is null or p_package is distinct from r.package_id
 or p_generation is distinct from (o->>'releaseGeneration')::bigint or p_deployment is distinct from o->>'deploymentId'
 or p_state_hash is distinct from o->>'stateHash' or cp->>'stateHash' is distinct from p_state_hash
 or p_terms is distinct from o->'terms' or p_corrective_terms is distinct from o->'correctiveTerms'
 or p_completion_terms is distinct from o->'completionTerms'
 or p_context_hash is null or p_context_hash !~ '^[a-f0-9]{64}$' or p_context_chars not between 1 and 96000 or p_context_chars is null
 or exists(select 1 from project_package_corrective_receipts where receipt_id=p_authorization)
 or exists(select 1 from project_package_execution_receipts where authorization_id=p_authorization)
 or exists(select 1 from project_package_execution_release_receipts where authorization_id=p_authorization)
 then raise exception 'Exact fresh consolidated completion consent required';end if;
 insert into project_package_completion_receipts(project_id,authorization_id,root_authorization_id,prior_release_receipt_id,package_id,owner_id,
 failed_mission_id,failed_assignment_id,prior_request_id,release_sha,release_generation,deployment_id,cutoff,terms,original_terms,checkpoint,state_hash)
 values(p_project,p_authorization,root.receipt_id,last_receipt.receipt_id,r.package_id,p_owner,mid,jid,(cp->>'priorRequestId')::uuid,
 p_release,p_generation,p_deployment,r.cutoff,p_completion_terms,r.terms,cp,p_state_hash);
 insert into project_package_corrective_receipts(project_id,ordinal,receipt_id,root_authorization_id,prior_receipt_id,package_id,owner_id,
 release_sha,release_generation,deployment_id,cutoff,terms,corrective_terms,checkpoint,state_hash,qualification)
 values(p_project,last_receipt.ordinal+1,p_authorization,root.receipt_id,last_receipt.receipt_id,r.package_id,p_owner,
 p_release,p_generation,p_deployment,r.cutoff,r.terms,root.corrective_terms,cp,p_state_hash,
 jsonb_build_object('kind','authenticated-owner-completion','completionTerms',p_completion_terms,'contextHash',p_context_hash,'contextChars',p_context_chars));
 update mission_assignments set status='queued',available_at=now(),updated_at=stamp where id=jid and mission_id=mid and status='failed' and attempts=1 and lease is null and lease_until is null;
 if not found then raise exception 'Saved failed manager assignment changed';end if;
 update agent_missions set status='running',updated_at=stamp where id=mid and project_id=p_project and status='blocked' and calls=1;
 if not found then raise exception 'Saved paid mission changed';end if;
 update work_projects set status='running',max_missions=(p_completion_terms->>'maxMissions')::int,max_cycles=(p_completion_terms->>'developmentAttempts')::int,
 progress_since=stamp,progress_signature=null,error_signature=null,repeated_errors=0,impediment=null,updated_at=stamp,
 detail='Authenticated bounded completion authority recorded; resume the same saved manager assignment'
 where id=p_project and active_mission_id=mid and status='blocked' and max_missions=112 and max_cycles=3 and lease is null and lease_until is null;
 if not found then raise exception 'Saved completion checkpoint changed';end if;
 if not project_org_package_execution_live(p_project) or not project_org_retest_claim_release_authorized_epoch(p_project,p_release,p_generation,p_deployment)
 then raise exception 'Native completion assignment not eligible';end if;
 insert into project_events(project_id,event,data) values(p_project,'package_completion_authorized',o||jsonb_build_object('authorizationId',p_authorization,'contextHash',p_context_hash,'contextChars',p_context_chars));
 return o||jsonb_build_object('stage','authorized','authorizationId',p_authorization);
end $$;

-- Exact admitted response, bound to the provider request, lease and request
-- digest; raw output is retained even if JSON/command validation later fails.
-- Atomic capture + canonical settlement prevents a settled-but-lost response.
create function public.project_org_package_capture_response(p_job uuid,p_attempt text,p_request uuid,p_hash text,p_receipt text,p_response jsonb) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare q project_provider_requests; j mission_assignments; m agent_missions; existing project_package_paid_responses;
 h text;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into q from project_provider_requests where id=p_request for update;
 select * into j from mission_assignments where id=p_job;
 select * into m from agent_missions where id=j.mission_id;
 if q.id is null or q.assignment_id is distinct from p_job or q.mission_id is distinct from m.id or q.project_id is distinct from m.project_id
 or q.worker_id is distinct from j.agent_id or q.execution_attempt is distinct from p_attempt or q.request_hash is distinct from p_hash
 or q.operation<>'inference' or j.role not in('work','compose','review')
 or p_receipt is null or length(p_receipt) not between 1 and 256
 or jsonb_typeof(p_response) is distinct from 'object' or octet_length(p_response::text)>1000000
 or jsonb_typeof(p_response->'text') is distinct from 'string' or jsonb_typeof(p_response->'model') is distinct from 'string'
 or p_response->>'status' not in('completed','incomplete') or jsonb_typeof(p_response->'output') is distinct from 'array'
 then return false;end if;
 h:=encode(sha256(convert_to(project_canonical(p_response),'UTF8')),'hex');
 select * into existing from project_package_paid_responses where request_id=q.id;
 if found then return existing.response_hash=h and existing.response=p_response and existing.provider_receipt=p_receipt
  and q.resolved_at is not null and q.provider_receipt=p_receipt;end if;
 if q.resolved_at is not null or not project_org_package_execution_assignment(j.id)
 or j.status<>'running' or j.lease::text is distinct from p_attempt or j.lease_until<=clock_timestamp()
 then return false;end if;
 insert into project_package_paid_responses(request_id,project_id,mission_id,assignment_id,execution_attempt,request_hash,provider_receipt,response,response_hash)
 values(q.id,q.project_id,q.mission_id,j.id,p_attempt,p_hash,p_receipt,p_response,h);
 if not project_provider_request(p_job,p_attempt,p_request,'inference',p_hash,null,p_receipt)
 then raise exception 'Paid response retained only with exact canonical provider settlement';end if;
 return true;
end $$;

create function public.project_org_package_durable_response_id(p_job uuid) returns uuid
language sql stable security definer set search_path=public,pg_temp as $$
 select q.id from project_provider_requests q join project_package_paid_responses d on d.request_id=q.id
 where q.assignment_id=p_job and q.operation='inference' and q.resolved_at is not null
 and d.assignment_id=q.assignment_id and d.project_id=q.project_id and d.mission_id=q.mission_id
 and d.execution_attempt=q.execution_attempt and d.request_hash=q.request_hash and d.provider_receipt=q.provider_receipt
 and d.response_hash=encode(sha256(convert_to(project_canonical(d.response),'UTF8')),'hex')
 and q.id=(select x.id from project_provider_requests x where x.assignment_id=p_job and x.operation='inference' order by x.started_at desc,x.id desc limit 1)
$$;

-- A replay uses the exact original paid output, not a new model request.
create function public.project_org_package_saved_response(p_job uuid,p_lease uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare j mission_assignments; m agent_missions; qid uuid; d project_package_paid_responses;
 latest project_package_corrective_receipts;
begin
 select * into j from mission_assignments where id=p_job;
 select * into m from agent_missions where id=j.mission_id;
 if j.role is distinct from 'work' or m.project_kind is distinct from 'management'
 or p_lease is null or j.lease is distinct from p_lease or j.status<>'running' or j.lease_until<=clock_timestamp()
 or not project_org_package_execution_assignment(j.id) or project_provider_request_pending(m.project_id)
 then raise exception 'Live exact package manager lease required to read paid response';end if;
 qid:=project_org_package_durable_response_id(j.id);
 if qid is null then return null;end if;
 select * into d from project_package_paid_responses where request_id=qid;
 select * into latest from project_package_corrective_receipts where project_id=m.project_id order by ordinal desc limit 1;
 if d.execution_attempt is distinct from p_lease::text
 and not (latest.checkpoint->>'mode'='saved-response-replay' and latest.checkpoint->>'assignmentId'=j.id::text
  and latest.checkpoint->>'missionId'=m.id::text and latest.checkpoint->>'savedRequestId'=qid::text
  and j.attempts=(latest.checkpoint->>'priorAttempts')::int+1)
 then raise exception 'Paid response belongs to a different unapproved attempt';end if;
 return d.response;
end $$;

create function public.project_org_package_response_commands(p_job uuid,p_lease uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare saved jsonb; commands jsonb; body text;
begin
 saved:=project_org_package_saved_response(p_job,p_lease);
 if saved is null or saved->>'status'<>'completed' then raise exception 'Complete durable paid management response required';end if;
 body:=regexp_replace(btrim(saved->>'text'),'^\x60\x60\x60(json)?[[:space:]]*','');
 body:=regexp_replace(body,'[[:space:]]*\x60\x60\x60$','');
 begin commands:=body::jsonb;exception when others then raise exception 'Durable management response is not a JSON command batch';end;
 return commands;
end $$;

create function public.project_org_package_paid_retry_allowed(p_job uuid,p_attempt text,p_operation text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_package_completion_receipts s
 join mission_assignments j on j.id=s.failed_assignment_id
 join project_provider_requests q on q.id=s.prior_request_id
 join lateral(select x.* from project_package_corrective_receipts x where x.project_id=s.project_id order by ordinal desc limit 1) latest on true
 where j.id=p_job and j.mission_id=s.failed_mission_id and j.attempts=2 and j.status='running'
 and j.lease::text=p_attempt and j.lease_until>clock_timestamp()
 and latest.receipt_id=s.authorization_id and latest.checkpoint->>'mode'='authorized-paid-retry'
 and q.assignment_id=j.id and q.operation='inference' and q.resolved_at is not null and q.execution_attempt<>p_attempt
 and s.cutoff>clock_timestamp() and s.terms=project_org_package_completion_terms()
 and p_operation in('model-list','inference')
 and not exists(select 1 from project_provider_requests x where x.assignment_id=j.id and x.operation=p_operation and x.execution_attempt=p_attempt)
 and (select count(*) from project_provider_requests x where x.assignment_id=j.id and x.operation=p_operation)=1
 and not exists(select 1 from project_package_paid_responses where assignment_id=j.id))
$$;

create function public.project_org_package_management_retake(p_job uuid,p_release text,p_generation bigint,p_deployment text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
 join work_projects p on p.id=m.project_id and p.active_mission_id=m.id
 join lateral(select x.* from project_package_corrective_receipts x where x.project_id=p.id order by ordinal desc limit 1) latest on true
 left join project_package_completion_receipts s on s.project_id=p.id
 where j.id=p_job and j.role='work' and m.project_kind='management'
 and j.status='queued' and j.lease is null and j.lease_until is null
 and latest.release_sha=p_release and latest.release_generation=p_generation and latest.deployment_id=p_deployment
 and latest.checkpoint->>'missionId'=m.id::text and latest.checkpoint->>'assignmentId'=j.id::text
 and j.attempts=(latest.checkpoint->>'priorAttempts')::int and latest.cutoff>clock_timestamp()
 and not project_provider_request_pending(p.id)
 and not exists(select 1 from project_organization_decisions where assignment_id=j.id)
 and not exists(select 1 from agent_tasks where id=j.id)
 and not exists(select 1 from project_provider_dispatches where task_id=j.id)
 and ((latest.checkpoint->>'mode'='authorized-paid-retry' and latest.receipt_id=s.authorization_id
  and s.failed_assignment_id=j.id and s.failed_mission_id=m.id and j.attempts=1 and m.calls=1
  and exists(select 1 from project_provider_requests q where q.id=s.prior_request_id and q.assignment_id=j.id and q.resolved_at is not null)
  and not exists(select 1 from project_package_paid_responses where assignment_id=j.id)
  and (select count(*) from project_provider_requests q where q.assignment_id=j.id and q.operation='inference')=1)
 or (latest.checkpoint->>'mode'='saved-response-replay' and latest.checkpoint->>'savedRequestId'=project_org_package_durable_response_id(j.id)::text)))
$$;

-- A paid response may be recovered only if its saved text was a valid command
-- array. Invalid model output remains retained and blocked; no implicit retry.
create function public.project_org_package_replayable_response(p_job uuid) returns uuid
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare qid uuid; d project_package_paid_responses; c jsonb; body text;
begin
 qid:=project_org_package_durable_response_id(p_job);
 select * into d from project_package_paid_responses where request_id=qid;
 if d.request_id is null or d.response->>'status'<>'completed' then return null;end if;
 body:=regexp_replace(btrim(d.response->>'text'),'^\x60\x60\x60(json)?[[:space:]]*','');
 body:=regexp_replace(body,'[[:space:]]*\x60\x60\x60$','');
 begin c:=body::jsonb;exception when others then return null;end;
 if jsonb_typeof(c) is distinct from 'array' or jsonb_array_length(c) not between 1 and 2 then return null;end if;
 return qid;
end $$;

-- Separately diagnose lease, response shape and settled evidence. The old
-- single error conflated these and lost the provider's actual command batch.
create or replace function public.project_org_package_execution_commands(p_job uuid,p_lease uuid,p_commands jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare w project_work_packages; r project_package_execution_receipts; m agent_missions; j mission_assignments;
 expected_action text; saved jsonb; inference_count int;
begin
 select * into j from mission_assignments where id=p_job;
 select * into m from agent_missions where id=j.mission_id;
 select * into r from project_package_execution_receipts where project_id=m.project_id;
 select * into w from project_work_packages where id=r.package_id;
 if not project_org_package_execution_assignment(p_job) or j.role<>'work' or m.project_kind<>'management'
 or p_lease is null or j.lease is distinct from p_lease or j.lease_until<=clock_timestamp() or j.status<>'running'
 then raise exception 'Exact live package manager lease required';end if;
 if jsonb_typeof(p_commands) is distinct from 'array' or jsonb_array_length(p_commands) not between 1 and 2
 then raise exception 'Package decision requires one applicable command and at most one ready';end if;
 select count(*) into inference_count from project_provider_requests q where q.assignment_id=j.id and q.operation='inference' and q.resolved_at is not null and q.provider_receipt is not null;
 if project_provider_request_pending(r.project_id) or inference_count<>m.calls or inference_count<1 or inference_count>2
 or (inference_count=2 and not exists(select 1 from project_package_completion_receipts s where s.project_id=r.project_id and s.failed_assignment_id=j.id and s.failed_mission_id=m.id))
 then raise exception 'Exact settled package inference count required';end if;
 saved:=project_org_package_response_commands(p_job,p_lease);
 if p_commands is distinct from saved then raise exception 'Decision must equal the immutable captured provider command batch';end if;
 expected_action:=case w.status when 'review' then 'evaluate_package' when 'rejected' then 'repair_package' end;
 if expected_action is null or (select count(*) from jsonb_array_elements(p_commands) c where c->>'action'=expected_action)<>1
 or exists(select 1 from jsonb_array_elements(p_commands) c where c->>'action' is distinct from 'ready' and (c->>'action' is distinct from expected_action or c->>'packageId' is distinct from w.id::text))
 or (expected_action='repair_package' and (select count(*) from project_work_package_attempts where package_id=w.id)>=project_org_package_completion_limit(r.project_id,'developmentAttempts',3))
 then raise exception 'Only evaluation or bounded correction of the existing package is authorized';end if;
end $$;

-- Preserve the existing canonical scheduler and all original safeguards;
-- only the authenticated supplemental receipt supplies increased capacity.
DO $patch$
declare d text; target text; a text; b text; edit record;
begin
 for target in select distinct signature from (values
 ('public.project_org_package_corrective_gate_allowed(uuid,text,text,text,bigint)'),
 ('public.project_org_package_execution_live(uuid)'),
 ('public.project_org_package_execution_assignment(uuid)'),
 ('public.project_org_package_coding_authorized(uuid,uuid)'),
 ('public.project_org_package_execution_request(uuid,text,text,text)'),
 ('public.project_org_package_execution_schedule(uuid,uuid)'),
 ('public.project_org_package_corrective_checkpoint(uuid)'),
 ('public.project_org_package_corrective_resume(uuid,jsonb)'),
 ('public.project_org_package_corrective_continue(uuid,text,bigint,text,text,jsonb)'),
 ('public.project_org_package_corrective_retake(uuid,text,bigint,text)'),
 ('public.project_org_coding_capacity_resource_guard()'),
 ('public.finish_work_project_lifecycle(uuid,uuid,text,jsonb)'),
 ('public.project_package_command(uuid,uuid,jsonb)'),
 ('public.project_smart_admit(uuid,bigint)'),
 ('public.project_provider_request(uuid,text,uuid,text,text,text,text)')
 ) signatures(signature) loop
 d:=pg_get_functiondef(target::regprocedure);
 for edit in select * from (values
 ('public.project_org_package_corrective_gate_allowed(uuid,text,text,text,bigint)',$a$if project_org_package_corrective_checkpoint(p_project) is null then return false;end if;$a$,$b$if project_org_package_corrective_checkpoint(p_project) is null and project_org_package_completion_checkpoint(p_project) is null then return false;end if;$b$,1),
 ('public.project_org_package_execution_live(uuid)',$a$p.max_missions=112 and p.max_cycles=3$a$,$b$p.max_missions=project_org_package_completion_limit(p.id,'maxMissions',112) and p.max_cycles=project_org_package_completion_limit(p.id,'developmentAttempts',3)$b$,1),
 ('public.project_org_package_execution_live(uuid)',$a$where project_id=p.id)<=112$a$,$b$where project_id=p.id)<=project_org_package_completion_limit(p.id,'maxMissions',112)$b$,1),
 ('public.project_org_package_execution_live(uuid)',$a$where package_id=w.id)<=3)$a$,$b$where package_id=w.id)<=project_org_package_completion_limit(p.id,'developmentAttempts',3))$b$,1),
 ('public.project_org_package_execution_assignment(uuid)',$a$pa.attempt between 1 and 3$a$,$b$pa.attempt between 1 and project_org_package_completion_limit(p.id,'developmentAttempts',3)$b$,1),
 ('public.project_org_package_coding_authorized(uuid,uuid)',$a$pa.attempt between 1 and 3$a$,$b$pa.attempt between 1 and project_org_package_completion_limit(p.id,'developmentAttempts',3)$b$,1),
 ('public.project_org_package_execution_request(uuid,text,text,text)',$a$not q.mission_id=any(r.historical_mission_ids))>=47$a$,$b$not q.mission_id=any(r.historical_mission_ids))>=project_org_package_completion_limit(r.project_id,'paidInferenceLimit',47)$b$,1),
 ('public.project_org_package_execution_request(uuid,text,text,text)',$a$or exists(select 1 from project_provider_requests q where q.assignment_id=j.id and q.operation=p_operation)$a$,$b$or (exists(select 1 from project_provider_requests q where q.assignment_id=j.id and q.operation=p_operation) and not project_org_package_paid_retry_allowed(j.id,p_attempt,p_operation))$b$,1),
 ('public.project_org_package_execution_schedule(uuid,uuid)',$a$attempts<3 and (select count(*) from agent_missions where project_id=p.id)<112$a$,$b$attempts<project_org_package_completion_limit(p.id,'developmentAttempts',3) and (select count(*) from agent_missions where project_id=p.id)<p.max_missions$b$,1),
 ('public.project_org_package_execution_schedule(uuid,uuid)',$a$attempts>=3 then$a$,$b$attempts>=project_org_package_completion_limit(p.id,'developmentAttempts',3) then$b$,1),
 ('public.project_org_package_execution_schedule(uuid,uuid)',$a$mgmt>=5 or (select count(*) from agent_missions where project_id=p.id)>=112$a$,$b$mgmt>=project_org_package_completion_limit(p.id,'managerMissions',5) or (select count(*) from agent_missions where project_id=p.id)>=p.max_missions$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$p.max_missions is distinct from 112 or p.max_cycles is distinct from 3$a$,$b$p.max_missions is distinct from project_org_package_completion_limit(p.id,'maxMissions',112) or p.max_cycles is distinct from project_org_package_completion_limit(p.id,'developmentAttempts',3)$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$p.cycles not between 1 and 3$a$,$b$p.cycles not between 1 and p.max_cycles$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$mission_count not between 106 and 112 or attempt_count not between 1 and 3 or paid_count>=47$a$,$b$mission_count not between 106 and p.max_missions or attempt_count not between 1 and p.max_cycles or paid_count>project_org_package_completion_limit(p.id,'paidInferenceLimit',47)$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$if mode is null and root.project_id is not null and m.project_kind='development'$a$,$b$if mode is null and root.project_id is not null and m.project_kind='management'
  and m.status in('blocked','failed') and j.role='work' and j.status='failed' and j.attempts between 1 and 7
  and n.id=w.manager_id and n.agent_id=j.agent_id and n.status='active' and n.deadline>clock_timestamp()
  and w.status in('review','rejected') and project_provider_continued_assignment(j.id)
  and m.project_evidence->>'organizationNodeId'=w.manager_id::text
  and j.payload->>'organizationNodeId'=w.manager_id::text
  and not exists(select 1 from project_organization_decisions where assignment_id=j.id)
  and not exists(select 1 from agent_tasks where id=j.id)
  and not exists(select 1 from project_provider_dispatches where task_id=j.id)
  and project_org_package_replayable_response(j.id) is not null
 then mode:='saved-response-replay';end if;
 if mode is null and root.project_id is not null and m.project_kind='development'$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$and mission_count<112$a$,$b$and mission_count<p.max_missions$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$case when mode='pre-provider-retest' then$a$,$b$case when mode in('pre-provider-retest','saved-response-replay') then$b$,3),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$'remainingMissions',112-mission_count$a$,$b$'remainingMissions',p.max_missions-mission_count$b$,1),
 ('public.project_org_package_corrective_checkpoint(uuid)',$a$'remainingAttempts',3-attempt_count$a$,$b$'remainingAttempts',p.max_cycles-attempt_count,'savedRequestId',case when mode='saved-response-replay' then project_org_package_durable_response_id(j.id) else null end$b$,1),
 ('public.project_org_package_corrective_resume(uuid,jsonb)',$a$if p_checkpoint->>'mode'='pre-provider-retest' then$a$,$b$if p_checkpoint->>'mode' in('pre-provider-retest','saved-response-replay') then$b$,1),
 ('public.project_org_package_corrective_resume(uuid,jsonb)',$a$and max_missions=112;$a$,$b$and max_missions=project_org_package_completion_limit(p_project,'maxMissions',112);$b$,1),
 ('public.project_org_package_corrective_continue(uuid,text,bigint,text,text,jsonb)',$a$if cp->>'mode'='pre-provider-retest' and not$a$,$b$if cp->>'mode' in('pre-provider-retest','saved-response-replay') and not$b$,1),
 ('public.project_org_package_corrective_retake(uuid,text,bigint,text)',$a$and not exists(select 1 from project_provider_dispatches d where d.task_id=j.id))$a$,$b$and not exists(select 1 from project_provider_dispatches d where d.task_id=j.id))
 or project_org_package_management_retake(p_job,p_release,p_generation,p_deployment)$b$,1),
 ('public.project_org_coding_capacity_resource_guard()',$a$ THEN RAISE EXCEPTION 'Original commissioning resources require the exact one-time owner receipt';$a$,$b$ AND NOT (OLD.status='blocked' AND OLD.max_missions=112 AND NEW.max_missions=118 AND OLD.max_cycles=3 AND NEW.max_cycles=5
 AND NEW.token_allowance=OLD.token_allowance AND NEW.deadline=OLD.deadline
 AND EXISTS(select 1 from project_package_completion_receipts s where s.project_id=OLD.id and s.authorization_txid=txid_current()
  and s.failed_mission_id=OLD.active_mission_id and s.terms=project_org_package_completion_terms()))
 THEN RAISE EXCEPTION 'Original commissioning resources require the exact one-time owner receipt';$b$,1),
 ('public.finish_work_project_lifecycle(uuid,uuid,text,jsonb)',$a$where project_id=p.id)>=112$a$,$b$where project_id=p.id)>=p.max_missions$b$,1),
 ('public.finish_work_project_lifecycle(uuid,uuid,text,jsonb)',$a$where package_id=ww.id)<3)$a$,$b$where package_id=ww.id)<project_org_package_completion_limit(p.id,'developmentAttempts',3))$b$,1),
 ('public.project_package_command(uuid,uuid,jsonb)',$a$where package_id=w.id)>=w.max_attempts$a$,$b$where package_id=w.id)>=project_org_package_completion_limit(p.id,'developmentAttempts',w.max_attempts)$b$,1),
 ('public.project_smart_admit(uuid,bigint)',$a$where contract_id=c.id)>=c.max_assignments$a$,$b$where contract_id=c.id)>=case when c.package_id=(select s.package_id from project_package_completion_receipts s where s.project_id=p.id) then project_org_package_completion_limit(p.id,'developmentAttempts',c.max_assignments) else c.max_assignments end$b$,1),
 ('public.project_provider_request(uuid,text,uuid,text,text,text,text)',$a$ IF p_receipt IS NULL AND EXISTS(SELECT 1 FROM project_package_execution_receipts$a$,$b$ IF p_receipt IS NOT NULL AND p_operation='inference' AND p_scope IS NULL
 AND EXISTS(SELECT 1 FROM project_package_execution_receipts x JOIN agent_missions m ON m.project_id=x.project_id JOIN mission_assignments j ON j.mission_id=m.id WHERE j.id=p_job)
 AND NOT EXISTS(SELECT 1 FROM project_package_paid_responses d WHERE d.request_id=p_request AND d.assignment_id=p_job AND d.execution_attempt=p_attempt AND d.request_hash=p_hash AND d.provider_receipt=p_receipt)
 THEN RETURN false; END IF;
 IF p_receipt IS NULL AND EXISTS(SELECT 1 FROM project_package_execution_receipts$b$,1)
 ) edits(signature,anchor,replacement,expected) where signature=target loop
  a:=edit.anchor;b:=edit.replacement;
  if (length(d)-length(replace(d,a,'')))/length(a)<>edit.expected then raise exception 'Unexpected package completion predecessor: % / %',target,a;end if;
  d:=replace(d,a,b);
 end loop;
 execute d;
 end loop;
end $patch$;

revoke all on function public.project_org_package_completion_terms() from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_completion_limit(uuid,text,integer) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_completion_checkpoint(uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_completion_offer(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_completion_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,jsonb,text,integer,jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_capture_response(uuid,text,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_durable_response_id(uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_saved_response(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_response_commands(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_paid_retry_allowed(uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_management_retake(uuid,text,bigint,text) from public,anon,authenticated,service_role;
revoke all on function public.project_org_package_replayable_response(uuid) from public,anon,authenticated,service_role;
grant execute on function public.project_org_package_completion_limit(uuid,text,integer) to service_role;
grant execute on function public.project_org_package_completion_offer(uuid,uuid,text) to service_role;
grant execute on function public.project_org_package_completion_authorize(uuid,uuid,uuid,text,bigint,text,uuid,text,jsonb,jsonb,text,integer,jsonb,boolean) to service_role;
grant execute on function public.project_org_package_capture_response(uuid,text,uuid,text,text,jsonb) to service_role;
grant execute on function public.project_org_package_saved_response(uuid,uuid) to service_role;
