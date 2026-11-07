-- One exact, separately owner-consented replacement. No claim reset, budget,
-- accounting, project, specification, model or deadline amendment.
create unique index task4a_replacement_one on public.project_events(project_id,event)
 where event in ('task4a_replacement_authorized','task4a_replacement_claimed','task4a_replacement_submitted');

create function public.task4a_replacement_immutable() returns trigger
language plpgsql set search_path=public as $$
begin
 if old.event in ('task4a_replacement_authorized','task4a_replacement_claimed','task4a_replacement_submitted')
 then raise exception 'TASK4A_REPLACEMENT_IMMUTABLE';end if;
 return old;
end $$;
create trigger task4a_replacement_immutable before update or delete on public.project_events
 for each row execute function public.task4a_replacement_immutable();

create function public.task4a_replacement_proposal(p_release text,p_evidence jsonb)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare p public.work_projects;t public.agent_tasks;m public.agent_missions;j public.mission_assignments;
 a public.benchmark_native_spending_approvals;s public.project_continuation_authorizations;
 c public.project_events;h public.project_events;sent public.project_events;
 candidate jsonb;lim jsonb;
begin
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid;
 select * into t from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid;
 select * into m from public.agent_missions where id=p.active_mission_id;
 select * into j from public.mission_assignments where id=t.id;
 select * into a from public.benchmark_native_spending_approvals where id=(t.external->>'developerApprovalId')::uuid;
 select * into s from public.project_continuation_authorizations where id=public.task4a_current_continuation_id(p.id);
 select * into c from public.project_events where project_id=p.id and event='task4a_postpaid_dispatch_claimed';
 select * into h from public.project_events where project_id=p.id and event='task4a_postpaid_release_handoff_authorized';
 select * into sent from public.project_events where project_id=p.id and event='task4a_postpaid_dispatch_submitted';
 lim:=a.developer_authority->'limits';
 if not coalesce(
  p.id is not null and p.phase='development' and p.deadline>clock_timestamp()
  and p.approved_hash=p.approval_hash and p.approved_hash=a.developer_authority->>'scopeHash'
  and m.project_id=p.id and m.deadline=p.deadline and j.mission_id=m.id and j.role='development'
  and t.repository_full_name='mfackrell/katie' and t.external->>'issueNumber'='969'
  and t.external->'receipt'->>'run_id'='42395083318'
  and t.external->'receipt'->>'repository'='mfackrell/katie'
  and t.external->'receipt'->>'issue_number'='969'
  and t.external->'receipt'->>'outcome'='BLOCKED'
  and t.external->'receipt'->'pr_url'='null'::jsonb
  and a.id is not null and a.project_id=p.id and a.task_id=t.id
  and a.owner_id=public.task4a_original_owner_id(p.actor_id,p.chat_id)
  and a.revoked_at is null and a.consumed_at is null and a.deadline>clock_timestamp()
  and a.model='gpt-5.3-codex' and a.developer_authority->'task4aPostpaid'->>'version'='postpaid-same-task-v1'
  and a.developer_authority->>'task4aContinuationId'=s.id::text
  and a.developer_authority->'checkpoint'->>'digest'=p_evidence->>'checkpointDigest'
  and s.revoked_at is null and s.deadline>clock_timestamp()
  and s.assessment_reserve_tokens=60000 and s.completion_reserve_tokens=60000
  and s.assessment_reserve_calls=6 and s.completion_reserve_calls=6
  and lim='{"cumulativeTokens":289620,"developmentTokens":229620,"developmentCalls":16,"assessmentTokens":60000,"completionTokens":60000,"assessmentCalls":4,"completionCalls":4,"perCallMicrousd":1680000,"ceilingMicrousd":9000000,"durationSeconds":14400}'::jsonb
  and 'openai:gpt-5.3-codex'=any(s.allowed_models)
  and c.id is not null and c.data->>'approvalId'=a.id::text
  and c.id::text=t.external->>'task4aPostpaidDispatchClaimId'
  and c.id::text=p_evidence->>'consumedClaimId'
  and c.data->>'releaseSha'='25363d8cd0906e7915c4e0aa6443142a95a76c20'
  and c.data->>'releaseHandoffReceiptId'=h.id::text
  and sent.data->>'claimReceiptId'=c.id::text and sent.data->>'acceptedByGithubApi'='true'
  and public.task4a_postpaid_release_handoff_authentic('25363d8cd0906e7915c4e0aa6443142a95a76c20')
  and p_release ~ '^[a-f0-9]{40}$' and p_release<>'25363d8cd0906e7915c4e0aa6443142a95a76c20'
  and p_evidence->>'version'='task4a-failed-run-link-v1'
  and p_evidence->>'projectId'=p.id::text and p_evidence->>'taskId'=t.id::text
  and p_evidence->>'approvalId'=a.id::text
  and p_evidence->>'consumedClaimId'='f105fde0-1e35-4aaf-80c6-b80645701325'
  and p_evidence->>'failedRunId'='42395083318' and p_evidence->>'originalRunId'='42102615797'
  and p_evidence->>'failedReleaseSha'='25363d8cd0906e7915c4e0aa6443142a95a76c20'
  and p_evidence->>'originalReleaseSha'='d530aa94dd8d9c2bc442b43b324ace312d0d62b9'
  and p_evidence->>'checkpointSha'='8e53ce01693303fc50daf5da1567e93e725f9b2d'
  and p_evidence->>'hostSha256'='87555681d7546761b8014179b7a1e19258fc57ec84bed3b82eacf7e23bff3904'
  and p_evidence->>'buildLogSha256' ~ '^[a-f0-9]{64}$'
  and p_evidence->>'noProviderCalls'='true' and p_evidence->>'noSourceModifications'='true'
  and exists(select 1 from public.benchmark_budget_accounts b where b.id=a.account_id
   and b.developer_project_id=p.id and b.developer_task_id=t.id and b.frozen_at is null and b.spent_tokens=49620)
  and (select count(*) from public.benchmark_execution_grants where project_id=p.id)=1
  and (select count(*) from public.benchmark_budget_calls where account_id=a.account_id)=4
  and not exists(select 1 from public.benchmark_budget_calls where account_id=a.account_id
   and (state<>'settled' or actual_tokens is null or provider_request_id is null))
  and (select sum(actual_tokens) from public.benchmark_budget_calls where account_id=a.account_id)=49620
  and exists(select 1 from public.model_registry price where price.provider_name='openai'
   and price.model_id='gpt-5.3-codex' and price.is_active and price.pricing_status='verified'
   and price.pricing_verified_at between clock_timestamp()-interval '24 hours' and clock_timestamp()
   and price.pricing_input_per_1m=1.75 and price.pricing_output_per_1m=14
   and price.source_metadata->>'pricing_verification_source'='https://developers.openai.com/api/docs/models/gpt-5.3-codex')
 ,false) then return jsonb_build_object('ready',false,'reason','exact_failed_run_evidence_or_existing_authority_unavailable');end if;
 candidate:=jsonb_build_object('kind','task4a_replacement_v1','ownerId',a.owner_id,
  'projectId',p.id,'taskId',t.id,'issueNumber',969,'releaseSha',p_release,
  'approvalId',a.id,'continuationId',s.id,'deadline',least(p.deadline,a.deadline,s.deadline),
  'nativeLimits',lim,'evidence',p_evidence,'consumedClaimId',c.id,
  'originalPaidReceiptId',c.data->>'paidReceiptId','releaseHandoffReceiptId',h.id,
  'oneReplacementOnly',true,'noAdditionalBudget',true,'noDeadlineAmendment',true,
  'noProductionPublication',true);
 return jsonb_build_object('ready',true,'proposal',candidate,
  'digest',encode(sha256(convert_to(public.project_canonical(candidate),'UTF8')),'hex'));
end $$;

create function public.task4a_replacement_authorized(p_release text,p_evidence jsonb)
returns boolean language plpgsql stable security invoker set search_path=public as $$
declare e public.project_events;offer jsonb;
begin
 select * into e from public.project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid and event='task4a_replacement_authorized';
 offer:=public.task4a_replacement_proposal(p_release,p_evidence);
 return coalesce(e.id is not null and offer->>'ready'='true'
  and e.data->'proposal'=offer->'proposal' and e.data->>'consentDigest'=offer->>'digest'
  and e.data->>'ownerId'=offer->'proposal'->>'ownerId',false);
end $$;

create function public.task4a_replacement_authorize(p_owner uuid,p_digest text,p_release text,p_evidence jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare offer jsonb;receipt uuid;p public.work_projects;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 offer:=public.task4a_replacement_proposal(p_release,p_evidence);
 if p_owner is null or p_owner is distinct from public.task4a_original_owner_id(p.actor_id,p.chat_id)
  or offer->>'ready' is distinct from 'true' or offer->>'digest' is distinct from p_digest
  or p.status<>'blocked'
  or not exists(select 1 from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid and status='blocked')
  or not exists(select 1 from public.agent_missions where id=p.active_mission_id and status='blocked')
  or not exists(select 1 from public.mission_assignments where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid and mission_id=p.active_mission_id and status='failed')
  or exists(select 1 from public.project_events where project_id=p.id and event in ('task4a_replacement_authorized','task4a_replacement_claimed'))
 then raise exception 'TASK4A_REPLACEMENT_OWNER_CONSENT_DENIED';end if;
 insert into public.project_events(project_id,event,data) values(p.id,'task4a_replacement_authorized',
  jsonb_build_object('ownerId',p_owner,'consentDigest',p_digest,'proposal',offer->'proposal')) returning id into receipt;
 return jsonb_build_object('authorized',true,'receiptId',receipt,'dispatched',false,'newPaidCalls',0,'newFinancialAuthority',false);
end $$;

create function public.task4a_replacement_claim(p_release text)
returns boolean language plpgsql security invoker set search_path=public as $$
declare p public.work_projects;t public.agent_tasks;e public.project_events;claim uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects where id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid for update;
 select * into t from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid for update;
 select * into e from public.project_events where project_id=p.id and event='task4a_replacement_authorized';
 if not public.task4a_replacement_authorized(p_release,e.data->'proposal'->'evidence')
  or p.status<>'blocked' or t.status<>'blocked'
  or not exists(select 1 from public.agent_missions where id=p.active_mission_id and status='blocked')
  or not exists(select 1 from public.mission_assignments where id=t.id and mission_id=p.active_mission_id and status='failed')
  or exists(select 1 from public.project_events where project_id=p.id and event='task4a_replacement_claimed')
 then return false;end if;
 insert into public.project_events(project_id,event,data) values(p.id,'task4a_replacement_claimed',
  jsonb_build_object('authorizationId',e.id,'releaseSha',p_release,'approvalId',t.external->>'developerApprovalId',
   'consumedClaimId',t.external->>'task4aPostpaidDispatchClaimId','issueNumber',969)) returning id into claim;
 insert into public.project_events(project_id,event,data) values(p.id,'developer_native_dispatch_claimed',
  jsonb_build_object('approvalId',t.external->>'developerApprovalId','taskId',t.id,
   'releaseSha',p_release,'replacementClaimId',claim,'originalIssueNumber',969));
 update public.work_projects set status='running',lease=null,lease_until=null,impediment=null,
  progress_signature=null,progress_since=clock_timestamp(),error_signature=null,repeated_errors=0,
  updated_at=clock_timestamp() where id=p.id;
 update public.agent_missions set status='running',updated_at=clock_timestamp() where id=p.active_mission_id;
 update public.mission_assignments set status='waiting_external',lease=null,lease_until=null,
  available_at=clock_timestamp(),updated_at=clock_timestamp() where id=t.id;
 update public.agent_tasks set status='dispatching',external=external||jsonb_build_object(
  'developerReleaseSha',p_release,'developerDispatchSince',clock_timestamp(),'dispatchStartedAt',clock_timestamp(),
  'task4aReplacementAuthorizationId',e.id,'task4aReplacementClaimId',claim),updated_at=clock_timestamp() where id=t.id;
 return true;
end $$;

create function public.task4a_replacement_authentic(p_release text)
returns boolean language plpgsql stable security invoker set search_path=public as $$
declare t public.agent_tasks;e public.project_events;c public.project_events;
begin
 select * into t from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid;
 select * into e from public.project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid and event='task4a_replacement_authorized';
 select * into c from public.project_events where project_id=e.project_id and event='task4a_replacement_claimed';
 return coalesce(public.task4a_replacement_authorized(p_release,e.data->'proposal'->'evidence')
  and c.id is not null and c.data->>'authorizationId'=e.id::text
  and c.data->>'releaseSha'=p_release and t.external->>'developerReleaseSha'=p_release
  and c.data->>'approvalId'=t.external->>'developerApprovalId'
  and c.data->>'consumedClaimId'=t.external->>'task4aPostpaidDispatchClaimId'
  and t.external->>'task4aReplacementAuthorizationId'=e.id::text
  and t.external->>'task4aReplacementClaimId'=c.id::text
  and t.status in ('dispatching','submitted')
  and exists(select 1 from public.work_projects p join public.agent_missions m on m.id=p.active_mission_id
   join public.mission_assignments j on j.mission_id=m.id and j.id=t.id
   where p.id=e.project_id and p.status='running' and m.status='running' and j.status='waiting_external')
 ,false);
end $$;

-- Keep the old one-shot path intact, but once a replacement is authorized its
-- new claim is mandatory and bound to the freshly approved executor SHA.
alter function public.task4a_postpaid_grant_ready(uuid,text) rename to task4a_postpaid_grant_ready_before_replacement;
create function public.task4a_postpaid_grant_ready(p_approval uuid,p_release text)
returns boolean language plpgsql stable security invoker set search_path=public as $$
begin
 if exists(select 1 from public.project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid and event='task4a_replacement_authorized') then
  return p_approval::text=(select external->>'developerApprovalId' from public.agent_tasks where id='d0e41ff5-149e-4319-9e65-dcc605fb75da'::uuid)
   and public.task4a_replacement_authentic(p_release);
 end if;
 return public.task4a_postpaid_grant_ready_before_replacement(p_approval,p_release);
end $$;

create function public.task4a_replacement_record_submitted(p_release text)
returns boolean language plpgsql security invoker set search_path=public as $$
declare e public.project_events;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into e from public.project_events where project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid and event='task4a_replacement_claimed';
 if e.id is null or e.data->>'releaseSha' is distinct from p_release or
  exists(select 1 from public.project_events where project_id=e.project_id and event='task4a_replacement_submitted')
 then return false;end if;
 insert into public.project_events(project_id,event,data) values(e.project_id,'task4a_replacement_submitted',
  jsonb_build_object('claimId',e.id,'releaseSha',p_release,'acceptedByGithubApi',true,'runIdPending',true));
 return true;
end $$;

revoke all on function public.task4a_replacement_proposal(text,jsonb),public.task4a_replacement_authorized(text,jsonb),
 public.task4a_replacement_authorize(uuid,text,text,jsonb),public.task4a_replacement_claim(text),
 public.task4a_replacement_authentic(text),public.task4a_replacement_record_submitted(text),
 public.task4a_replacement_immutable(),public.task4a_postpaid_grant_ready(uuid,text)
 from public,anon,authenticated;
grant execute on function public.task4a_replacement_proposal(text,jsonb),public.task4a_replacement_authorized(text,jsonb),
 public.task4a_replacement_authorize(uuid,text,text,jsonb),public.task4a_replacement_claim(text),
 public.task4a_replacement_authentic(text),public.task4a_replacement_record_submitted(text),
 public.task4a_postpaid_grant_ready(uuid,text) to service_role;
