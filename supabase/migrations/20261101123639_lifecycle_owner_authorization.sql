-- Task 2B. Proposals/decisions extend the existing owner authorization system;
-- balances, reservations, receipts and execution grants remain in existing tables.
create table benchmark_lifecycle_proposals(
 id text primary key check(id ~ '^[a-f0-9]{64}$'),
 owner_id uuid not null, task_id uuid not null references agent_tasks(id),
 project_id uuid not null references work_projects(id),
 snapshot_hash text not null, fingerprint text not null, proposal jsonb not null,
 checkpoint jsonb not null, created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 check(expires_at>created_at)
);
create table benchmark_lifecycle_decisions(
 proposal_id text primary key references benchmark_lifecycle_proposals(id),
 owner_id uuid not null, decision text not null check(decision in ('approved','rejected')),
 continuation_id uuid unique references benchmark_full_continuations(id),
 created_at timestamptz not null default now(),
 check((decision='approved')=(continuation_id is not null))
);
alter table benchmark_lifecycle_proposals enable row level security;
alter table benchmark_lifecycle_decisions enable row level security;
revoke all on benchmark_lifecycle_proposals,benchmark_lifecycle_decisions from public,anon,authenticated,service_role;
grant select on benchmark_lifecycle_proposals,benchmark_lifecycle_decisions to service_role;
create trigger lifecycle_proposal_immutable before update or delete on benchmark_lifecycle_proposals
 for each row execute function benchmark_continuation_immutable();
create trigger lifecycle_decision_immutable before update or delete on benchmark_lifecycle_decisions
 for each row execute function benchmark_continuation_immutable();

-- A locked snapshot remains available after expiry. It reports historical
-- authority; it NEVER returns permission to spend or releases uncertain exposure.
create function benchmark_lifecycle_snapshot(p_task uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t agent_tasks;j mission_assignments;m agent_missions;p work_projects;
 a benchmark_native_spending_approvals;c benchmark_full_continuations;acct benchmark_budget_accounts;
 am benchmark_development_resource_amendments;q benchmark_production_qualifications;latest_grant benchmark_execution_grants;
 binding jsonb;pricing jsonb;snap jsonb;position jsonb;calls jsonb;exposures jsonb;grants jsonb;
 held bigint;committed numeric;outstanding numeric;dev_calls integer;dev_limit bigint;call_limit integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into t from agent_tasks where id=p_task for update;
 select * into j from mission_assignments where id=t.id for update;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into p from work_projects where id=m.project_id for update;
 select * into c from benchmark_full_continuations x where x.project_id=p.id
  and not exists(select 1 from benchmark_full_continuations n where n.previous_continuation_id=x.id);
 select * into a from benchmark_native_spending_approvals where task_id=t.id and continuation_id=c.id order by created_at desc,id desc limit 1 for update;
 select * into acct from benchmark_budget_accounts where id=a.account_id for update;
 select * into q from benchmark_production_qualifications where experiment_id=acct.experiment_id;
 select r.binding into binding from project_runs r where r.mission_id=m.id and r.project_id=p.id;
 if t.id is null or a.id is null or c.id is null or acct.id is null or q.owner_id is distinct from a.owner_id
  or p.actor_id is distinct from a.actor_id or q.actor_id is distinct from p.actor_id or acct.owner_actor_id is distinct from p.actor_id
  or a.project_id is distinct from p.id or a.mission_assignment_id is distinct from t.id or j.role<>'development'
  or p.active_mission_id is distinct from m.id or p.phase<>'development' or m.project_kind<>'development'
  or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash
  or binding->>'scopeHash' is distinct from p.approved_hash or c.plan->>'version' not in ('5','6','7')
  or c.owner_id is distinct from a.owner_id or c.account_id is distinct from acct.id
  or not benchmark_full_task_provenance(t.id,p.id)
 then raise exception 'Lifecycle task binding unavailable';end if;
 select * into am from benchmark_development_resource_amendments where continuation_id=c.id;
 if am.id is null or am.plan_hash is distinct from c.plan_hash then raise exception 'Lifecycle amendment history unavailable';end if;
 select * into latest_grant from benchmark_execution_grants where continuation_id=c.id and mission_assignment_id=t.id order by execution_epoch desc limit 1;
 dev_limit:=am.development_limit;call_limit:=am.call_limit;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into calls from benchmark_budget_calls x where account_id=acct.id;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.call_id),'[]') into exposures from benchmark_dollar_exposures x where account_id=acct.id;
 select coalesce(jsonb_agg(to_jsonb(x)-'token_digest' order by x.id),'[]') into grants from benchmark_execution_grants x where account_id=acct.id;
 if jsonb_array_length(calls)>2000 or jsonb_array_length(exposures)<>jsonb_array_length(calls)
  or exists(select 1 from benchmark_budget_calls bc left join benchmark_dollar_exposures e on e.call_id=bc.id and e.account_id=bc.account_id where bc.account_id=acct.id and e.call_id is null)
  or exists(select 1 from benchmark_budget_calls where account_id=acct.id and state='settled' and actual_tokens is null)
 then raise exception 'Lifecycle accounting evidence incomplete';end if;
 select coalesce(sum(reserved_tokens),0) into held from benchmark_budget_calls where account_id=acct.id and state in ('reserved','unresolved');
 select coalesce(sum(e.exposure_microusd) filter(where bc.state='settled'),0),
  coalesce(sum(e.exposure_microusd) filter(where bc.state<>'settled'),0) into committed,outstanding
 from benchmark_dollar_exposures e join benchmark_budget_calls bc on bc.id=e.call_id where e.account_id=acct.id;
 select count(*) into dev_calls from mission_calls mc join mission_assignments mj on mj.id=mc.job_id where mj.mission_id=m.id;
 if dev_calls<>m.calls+m.routing_calls or acct.spent_tokens<>(select coalesce(sum(actual_tokens),0) from benchmark_budget_calls where account_id=acct.id and state='settled')
 then raise exception 'Lifecycle accounting counters inconsistent';end if;
 position:=jsonb_build_object('cumulativeTokens',(c.plan->>'cumulativeTokenCap')::bigint,
  'developmentTokens',dev_limit,'developmentCalls',call_limit,'assessmentCalls',null,'assessmentConsumedCalls',null,
  'completionTokens',(c.plan->>'developmentClosureTokens')::bigint,'completionCalls',(c.plan->>'developmentClosureCalls')::integer,
  'assessmentTokens',(c.plan->>'assessmentTokens')::bigint,'accountEncumberedTokens',acct.spent_tokens+held,
  'developmentEncumberedTokens',greatest(m.actual_tokens,m.reserved_tokens),'developmentConsumedCalls',dev_calls,
  'committedMicrousd',committed::text,'outstandingMicrousd',outstanding::text,'ceilingMicrousd',c.plan->>'dollarCeilingMicrousd',
  'expiresAt',floor(extract(epoch from least(a.deadline,c.deadline,p.deadline,latest_grant.deadline))*1000)::bigint);
 select jsonb_build_object('status',pricing_status,'source','verified_model_registry','serviceTier',c.plan->>'serviceTier',
  'verifiedAt',floor(extract(epoch from pricing_verified_at)*1000)::bigint,'inputUsdPerMillion',pricing_input_per_1m::text,'outputUsdPerMillion',pricing_output_per_1m::text)
  into pricing from model_registry where provider_name='openai' and model_id=a.model;
 snap:=jsonb_build_object('pricing',pricing,'taskId',t.id,'projectId',p.id,'scopeHash',p.approved_hash,'binding',binding,
  'scope',jsonb_build_object('specification',p.spec,'completionContract',p.completion_contract),'receipt',t.external->'receipt','issueNumber',t.external->'issueNumber','projectStatus',p.status,'taskStatus',t.status,
  'missionStatus',m.status,'assignmentStatus',j.status,'position',position,'approval',to_jsonb(a),
  'continuation',to_jsonb(c)-'source_snapshot','accountFrozen',acct.frozen_at,'qualificationRevoked',q.revoked_at,
  'calls',calls,'exposures',exposures,'grants',grants,'missionId',m.id);
 return jsonb_build_object('snapshotHash',encode(sha256(convert_to(project_canonical(snap),'UTF8')),'hex'),
  'snapshot',snap,'position',position,'ownerId',a.owner_id,'actorId',p.actor_id,'chatId',p.chat_id,
  'binding',jsonb_build_object('taskId',t.id,'projectId',p.id,'scopeHash',p.approved_hash,'baselineSha',binding->>'baselineSha','contractHash',binding->>'contractHash'),
  'scope',jsonb_build_object('specification',p.spec,'completionContract',p.completion_contract),'acceptance',binding->'contract','originalWindowSeconds',(c.plan->>'durationSeconds')::integer,
  'revoked',a.revoked_at is not null or q.revoked_at is not null or latest_grant.revoked_at is not null,'frozen',acct.frozen_at is not null,
  'grantRenewable',true,'continuationId',c.id,'approvalId',a.id,'missionId',m.id,'accountId',acct.id,
  'model',a.model,'pricing',pricing,'exposureMicrousd',(committed+outstanding)::text,'deadline',least(a.deadline,c.deadline,p.deadline,latest_grant.deadline));
end $$;

-- Only the trusted server/host may persist a forecast. Authenticated browser
-- clients can neither write a proposal nor pass resource amounts to decision RPC.
create function benchmark_lifecycle_offer(p_task uuid,p_proposal jsonb,p_checkpoint jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s jsonb;existing benchmark_lifecycle_proposals;hash text;v_fingerprint text;expires timestamptz;
begin
 s:=benchmark_lifecycle_snapshot(p_task);
 if (s->>'revoked')::boolean or (s->>'frozen')::boolean then raise exception 'Existing authority denied';end if;
 if p_proposal->>'version' is distinct from 'lifecycle-owner-proposal-v1' or p_proposal->>'kind' is distinct from 'proposal_not_authorization'
  or p_proposal->'binding' is distinct from s->'binding' or p_proposal->'current' is distinct from s->'position'
  or p_proposal->>'snapshotHash' is distinct from s->>'snapshotHash'
  or p_proposal->'scope' is distinct from s->'scope' or p_proposal->'acceptance' is distinct from s->'acceptance'
  or jsonb_array_length(p_proposal->'shortages')=0
  or p_checkpoint->>'taskId' is distinct from p_task::text or p_checkpoint->>'checkpointSha' is distinct from p_proposal->>'checkpointSha'
  or p_checkpoint->>'scopeHash' is distinct from s->'binding'->>'scopeHash'
 then raise exception 'Proposal differs from authoritative snapshot';end if;
 v_fingerprint:=encode(sha256(convert_to(project_canonical(jsonb_build_object('snapshot',s->>'snapshotHash','checkpoint',p_checkpoint,
  'proposed',p_proposal->'proposed','remaining',p_proposal->'remaining','shortages',p_proposal->'shortages')),'UTF8')),'hex');
 select * into existing from benchmark_lifecycle_proposals o where task_id=p_task and o.fingerprint=v_fingerprint
  and (expires_at>clock_timestamp() or exists(select 1 from benchmark_lifecycle_decisions d where d.proposal_id=o.id and d.decision='rejected'))
  order by created_at desc limit 1;
 if found then return to_jsonb(existing);end if;
 expires:=to_timestamp((p_proposal->>'expiresAt')::numeric/1000);
 if expires<=clock_timestamp() or expires>clock_timestamp()+interval '24 hours' then raise exception 'Proposal expiration invalid';end if;
 hash:=encode(sha256(convert_to(project_canonical(p_proposal-'id'),'UTF8')),'hex');
 insert into benchmark_lifecycle_proposals(id,owner_id,task_id,project_id,snapshot_hash,fingerprint,proposal,checkpoint,expires_at)
 values(hash,(s->>'ownerId')::uuid,p_task,(s->'binding'->>'projectId')::uuid,s->>'snapshotHash',v_fingerprint,
  (p_proposal-'id')||jsonb_build_object('id',hash),p_checkpoint,expires) returning * into existing;
 insert into project_events(project_id,event,data) values(existing.project_id,'lifecycle_owner_approval_requested',jsonb_build_object('proposalId',hash,'taskId',p_task));
 return to_jsonb(existing);
end $$;

-- Version 7 is a parameterized extension of the existing append-only authority.
alter table benchmark_development_resource_amendments add column lifecycle_proposal_id text unique references benchmark_lifecycle_proposals(id);
alter table benchmark_development_resource_amendments alter column successor_id drop not null;
alter table benchmark_development_resource_amendments alter column old_grant_id drop not null;
drop index benchmark_one_capacity_renewal;
drop index benchmark_original_resource_amendment;
create unique index benchmark_one_capacity_renewal on benchmark_development_resource_amendments(project_id) where capacity_renewal and lifecycle_proposal_id is null;
create unique index benchmark_original_resource_amendment on benchmark_development_resource_amendments(project_id) where not capacity_renewal and lifecycle_proposal_id is null;
alter table benchmark_development_resource_amendments drop constraint benchmark_amendment_limits;
alter table benchmark_development_resource_amendments add constraint benchmark_amendment_limits check(
 (lifecycle_proposal_id is null and successor_id is not null and old_grant_id is not null and
 ((capacity_renewal and development_limit=448279 and call_limit=32) or (not capacity_renewal and development_limit in (170000,373279) and call_limit=24)))
 or (lifecycle_proposal_id is not null and development_limit>0 and call_limit>0));
do $$ declare r record;def text;begin
 for r in select conname,pg_get_constraintdef(oid) d from pg_constraint where conrelid='benchmark_full_continuations'::regclass
  and conname in ('benchmark_continuation_bounded_plan','benchmark_full_continuations_check','benchmark_full_continuations_check1') loop
  def:='CHECK ((('||substring(r.d from 8 for length(r.d)-8)||') AND plan->>''version'' IS DISTINCT FROM ''7'') OR
   ((plan->>''version''=''7'' AND plan->>''kind''=''development-renewal'' AND plan->>''resourceAmendment''=''true''
    AND previous_continuation_id IS NOT NULL AND plan->>''lifecycleProposalId'' ~ ''^[a-f0-9]{64}$''
    AND additional_token_cap>0 AND spent_at_approval+additional_token_cap<=(plan->>''cumulativeTokenCap'')::bigint
    AND deadline>created_at AND deadline=(plan->>''deadline'')::timestamptz
    AND (plan->>''developmentClosureCalls'')::integer>=4 AND (plan->>''developmentClosureTokens'')::bigint>=60000
    AND (plan->>''assessmentTokens'')::bigint>=60000) IS TRUE))';
  execute format('alter table benchmark_full_continuations drop constraint %I',r.conname);
  execute format('alter table benchmark_full_continuations add constraint %I %s',r.conname,def);
 end loop;
end $$;

create function benchmark_lifecycle_decide(p_owner uuid,p_task uuid,p_proposal text,p_decision text,p_release text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare offer benchmark_lifecycle_proposals;dec benchmark_lifecycle_decisions;s jsonb;n jsonb;old benchmark_native_spending_approvals;
 prior benchmark_full_continuations;c benchmark_full_continuations;fresh benchmark_native_spending_approvals;
 r benchmark_development_renewals;am benchmark_development_resource_amendments;t agent_tasks;
 plan jsonb;deadline timestamptz;remaining bigint;hash text;gid uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into offer from benchmark_lifecycle_proposals where id=p_proposal for update;
 if p_owner is null or offer.id is null or offer.owner_id is distinct from p_owner or offer.task_id is distinct from p_task
  or p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Owner/task/proposal authorization denied';end if;
 select * into dec from benchmark_lifecycle_decisions where proposal_id=offer.id;
 if found then
  if dec.owner_id is distinct from p_owner or dec.decision<>p_decision then raise exception 'Proposal already decided';end if;
  return jsonb_build_object('state',dec.decision,'continuationId',dec.continuation_id,'proposalId',offer.id);
 end if;
 if offer.expires_at<=clock_timestamp() then raise exception 'Proposal expired';end if;
 s:=benchmark_lifecycle_snapshot(p_task);
 if (s->>'revoked')::boolean or (s->>'frozen')::boolean or s->>'snapshotHash' is distinct from offer.snapshot_hash
 then raise exception 'Proposal stale or authority revoked';end if;
 if p_decision='rejected' then
  insert into benchmark_lifecycle_decisions values(offer.id,p_owner,'rejected',null,now());
  insert into project_events(project_id,event,data) values(offer.project_id,'lifecycle_owner_rejected',jsonb_build_object('proposalId',offer.id,'taskId',p_task));
  return jsonb_build_object('state','rejected','proposalId',offer.id);
 end if;
 select * into t from agent_tasks where id=p_task;
 if t.status<>'blocked' or t.external->'receipt'->>'outcome' is distinct from 'BLOCKED'
  or t.external->'receipt'->>'run_id' is distinct from offer.checkpoint->>'runId'
  or coalesce(p_release,'')!~'^[a-f0-9]{40}$'
  or exists(select 1 from benchmark_budget_calls where account_id=(s->>'accountId')::uuid and state in ('reserved','unresolved','overrun'))
 then raise exception 'Terminal checkpoint or reconciled provider accounting required';end if;
 select * into old from benchmark_native_spending_approvals where id=(s->>'approvalId')::uuid;
 select * into prior from benchmark_full_continuations where id=old.continuation_id;
 n:=offer.proposal->'proposed';
 if (n->>'cumulativeTokens')::bigint<(s->'position'->>'cumulativeTokens')::bigint
  or (n->>'developmentTokens')::bigint<(s->'position'->>'developmentTokens')::bigint
  or (n->>'developmentCalls')::integer<(s->'position'->>'developmentCalls')::integer
  or (n->>'ceilingMicrousd')::numeric<(s->'position'->>'ceilingMicrousd')::numeric
  or (n->>'completionTokens')::bigint<(s->'position'->>'completionTokens')::bigint
  or (n->>'completionCalls')::integer<(s->'position'->>'completionCalls')::integer
  or (n->>'assessmentTokens')::bigint<(s->'position'->>'assessmentTokens')::bigint
 then raise exception 'Proposal reduces protected authority';end if;
 deadline:=case when n->>'windowStartsAt'='authenticated_commit' then now()+make_interval(secs=>(n->>'durationSeconds')::integer)
  else to_timestamp((n->>'expiresAt')::numeric/1000) end;
 if deadline<=now() then raise exception 'Continuation window expired';end if;
 -- Account maximum and stage sublimits need not all be simultaneously funded.
 -- Additional continuation allowance is the exact remaining account authority.
 remaining:=(n->>'cumulativeTokens')::bigint-(s->'position'->>'accountEncumberedTokens')::bigint;
 plan:=jsonb_build_object('version',7,'kind','development-renewal','resourceAmendment',true,'lifecycleProposalId',offer.id,
  'projectId',offer.project_id,'taskId',p_task,'scopeHash',s->'binding'->>'scopeHash','baselineSha',s->'binding'->>'baselineSha',
  'contractHash',s->'binding'->>'contractHash','serviceTier',prior.plan->>'serviceTier','monetaryControl','atomic-exposure-v1',
  'cumulativeTokenCap',(n->>'cumulativeTokens')::bigint,'dollarCeilingMicrousd',(n->>'ceilingMicrousd')::numeric,
  'developmentTokens',(n->>'developmentTokens')::bigint,'maxCalls',(n->>'developmentCalls')::integer,
  'developmentClosureTokens',(n->>'completionTokens')::bigint,'developmentClosureCalls',(n->>'completionCalls')::integer,
  'assessmentTokens',(n->>'assessmentTokens')::bigint,'specificationTokens',0,'additionalTokenCap',remaining,
  'developmentSpentTokens',(s->'position'->>'developmentEncumberedTokens')::bigint,
  'developmentRemainingTokens',(n->>'developmentTokens')::bigint-(s->'position'->>'developmentEncumberedTokens')::bigint,
  'deadline',deadline,'durationSeconds',extract(epoch from deadline-now())::integer,'sourceSnapshotHash',offer.snapshot_hash,
  'frozenRequirements',true,'repeatResearch',false,'regenerateSpecification',false);
 hash:=encode(sha256(convert_to(project_canonical(plan),'UTF8')),'hex');
 insert into benchmark_full_continuations(owner_id,project_id,trial_id,account_id,source_mission_id,source_snapshot,source_snapshot_hash,plan,plan_hash,spent_at_approval,additional_token_cap,deadline,previous_continuation_id)
 values(p_owner,offer.project_id,old.trial_id,old.account_id,(s->>'missionId')::uuid,prior.source_snapshot||jsonb_build_object('lifecycleSnapshot',s->'snapshot'),offer.snapshot_hash,plan,hash,(s->'position'->>'accountEncumberedTokens')::bigint,remaining,deadline,prior.id) returning * into c;
 insert into benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,continuation_id)
 values(p_owner,old.actor_id,old.chat_id,old.trial_id,old.account_id,old.repository,old.model,old.protocol_digest,(n->>'cumulativeTokens')::bigint,deadline,offer.project_id,p_task,p_task,c.id) returning * into fresh;
 insert into benchmark_development_renewals(continuation_id,approval_id,previous_approval_id,task_id,mission_id,scope_hash,prior_run,receipt)
 values(c.id,fresh.id,old.id,p_task,(s->>'missionId')::uuid,s->'binding'->>'scopeHash',(offer.checkpoint->>'runId')::bigint,t.external->'receipt') returning * into r;
 select id into gid from benchmark_execution_grants where continuation_id=prior.id and mission_assignment_id=p_task order by execution_epoch desc limit 1;
 insert into benchmark_development_resource_amendments(project_id,task_id,mission_id,successor_id,old_grant_id,renewal_id,approval_id,continuation_id,failed_run,receipt,release_sha,runtime_version,development_limit,call_limit,deadline,plan_hash,source_snapshot,source_snapshot_hash,lifecycle_proposal_id)
 values(offer.project_id,p_task,r.mission_id,null,gid,r.id,fresh.id,c.id,r.prior_run,r.receipt,p_release,'provider-input-count-v1',(n->>'developmentTokens')::bigint,(n->>'developmentCalls')::integer,deadline,hash,
  jsonb_build_object('approval',to_jsonb(old),'previousContinuation',to_jsonb(prior)-'source_snapshot','lifecycleSnapshot',s->'snapshot','checkpoint',offer.checkpoint),offer.snapshot_hash,offer.id) returning * into am;
 insert into benchmark_lifecycle_decisions values(offer.id,p_owner,'approved',c.id,now());
 update benchmark_execution_grants set stopped_at=coalesce(stopped_at,now()) where account_id=old.account_id and stopped_at is null;
 update agent_tasks set status='dispatching',external=(external-'ownerSuccessorConsentId'-'resourceAmendmentSince'-'resourceAmendmentRelease')||jsonb_build_object('resourceAmendmentId',am.id,'developmentRenewalId',r.id,'lifecycleProposalId',offer.id),updated_at=now() where id=p_task;
 update mission_assignments set status='waiting_external',lease=null,lease_until=null,available_at=now(),updated_at=now() where id=p_task;
 update agent_missions set status='running',updated_at=now() where id=r.mission_id;
 update work_projects set status='running',deadline=greatest(work_projects.deadline,c.deadline),lease=null,lease_until=null,impediment=null,detail='Owner amendment committed; same-task continuation awaiting verified dispatch.',updated_at=now() where id=offer.project_id;
 insert into project_events(project_id,event,data) values(offer.project_id,'lifecycle_amendment_authorized',jsonb_build_object('proposalId',offer.id,'amendmentId',am.id,'taskId',p_task,'continuationId',c.id));
 return jsonb_build_object('state','approved','proposalId',offer.id,'continuationId',c.id,'deadline',c.deadline);
end $$;

revoke all on function benchmark_lifecycle_snapshot(uuid),benchmark_lifecycle_offer(uuid,jsonb,jsonb),benchmark_lifecycle_decide(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function benchmark_lifecycle_snapshot(uuid),benchmark_lifecycle_offer(uuid,jsonb,jsonb),benchmark_lifecycle_decide(uuid,uuid,text,text,text) to service_role;

create function benchmark_lifecycle_authorized(p_continuation uuid)
returns boolean language sql stable security invoker set search_path=public as $$
 select exists(select 1 from benchmark_full_continuations c
 join benchmark_development_resource_amendments am on am.continuation_id=c.id
 join benchmark_lifecycle_proposals o on o.id=am.lifecycle_proposal_id
 join benchmark_lifecycle_decisions d on d.proposal_id=o.id and d.continuation_id=c.id and d.decision='approved'
 join benchmark_native_spending_approvals a on a.id=am.approval_id
 join work_projects p on p.id=c.project_id
 join benchmark_budget_accounts acct on acct.id=c.account_id
 join benchmark_production_qualifications q on q.experiment_id=acct.experiment_id
 where c.id=p_continuation and c.plan->>'version'='7' and c.plan->>'lifecycleProposalId'=o.id
 and c.owner_id=o.owner_id and d.owner_id=o.owner_id and a.owner_id=o.owner_id and q.owner_id=o.owner_id
 and q.revoked_at is null and a.revoked_at is null and acct.frozen_at is null
 and a.project_id=p.id and a.task_id=o.task_id and am.task_id=o.task_id and a.continuation_id=c.id
 and am.plan_hash=c.plan_hash and am.deadline=c.deadline and a.deadline=c.deadline
 and am.development_limit=(o.proposal->'proposed'->>'developmentTokens')::bigint
 and am.call_limit=(o.proposal->'proposed'->>'developmentCalls')::integer
 and a.max_tokens=(o.proposal->'proposed'->>'cumulativeTokens')::bigint
 and c.plan->'cumulativeTokenCap'=o.proposal->'proposed'->'cumulativeTokens'
 and (c.plan->>'dollarCeilingMicrousd')::numeric=(o.proposal->'proposed'->>'ceilingMicrousd')::numeric
 and c.plan->'developmentClosureTokens'=o.proposal->'proposed'->'completionTokens'
 and c.plan->'developmentClosureCalls'=o.proposal->'proposed'->'completionCalls'
 and c.plan->'assessmentTokens'=o.proposal->'proposed'->'assessmentTokens'
 and p.approved_hash=o.proposal->'binding'->>'scopeHash' and p.approval_hash=p.approved_hash
 and jsonb_build_object('specification',p.spec,'completionContract',p.completion_contract)=o.proposal->'scope'
 and exists(select 1 from project_runs r where r.mission_id=am.mission_id and r.project_id=p.id
  and r.binding->>'scopeHash'=o.proposal->'binding'->>'scopeHash'
  and r.binding->>'baselineSha'=o.proposal->'binding'->>'baselineSha'
  and r.binding->>'contractHash'=o.proposal->'binding'->>'contractHash'
  and r.binding->'contract'=o.proposal->'acceptance')
 and c.deadline>clock_timestamp() and not exists(select 1 from benchmark_full_continuations n where n.previous_continuation_id=c.id));
$$;
revoke all on function benchmark_lifecycle_authorized(uuid) from public,anon,authenticated;
grant execute on function benchmark_lifecycle_authorized(uuid) to service_role;

-- Keep legacy branches byte-for-byte; v7 additionally requires the decision link.
do $$ declare body text;anchor text;begin
 select pg_get_functiondef('benchmark_continuation_live(uuid,uuid,uuid)'::regprocedure) into body;
 anchor:='and a.arm=';
 if position(anchor in body)=0 then raise exception 'Continuation integration anchor missing';end if;
 body:=replace(body,anchor,$p$and (c.plan->>'version' is distinct from '7' or benchmark_lifecycle_authorized(c.id)) and a.arm=$p$);
 execute body;
end $$;
alter function benchmark_effective_account_cap(uuid) rename to benchmark_effective_account_cap_legacy;
create function benchmark_effective_account_cap(p_account uuid) returns bigint language sql stable security invoker set search_path=public as $$
 select coalesce((select (c.plan->>'cumulativeTokenCap')::bigint from benchmark_full_continuations c
  where c.account_id=p_account and c.plan->>'version'='7' and benchmark_lifecycle_authorized(c.id)),benchmark_effective_account_cap_legacy(p_account));
$$;
create function benchmark_effective_dollar_ceiling(p_account uuid,p_continuation uuid) returns numeric language sql stable security invoker set search_path=public as $$
 select case when c.plan->>'version'='7' then case when benchmark_lifecycle_authorized(c.id) then (c.plan->>'dollarCeilingMicrousd')::numeric else 0 end else 10000000 end
 from (select 1) x left join benchmark_full_continuations c on c.id=p_continuation and c.account_id=p_account;
$$;
revoke all on function benchmark_effective_account_cap(uuid),benchmark_effective_account_cap_legacy(uuid),benchmark_effective_dollar_ceiling(uuid,uuid) from public,anon,authenticated;
grant execute on function benchmark_effective_account_cap(uuid),benchmark_effective_account_cap_legacy(uuid),benchmark_effective_dollar_ceiling(uuid,uuid) to service_role;

do $$ declare body text;begin
 select pg_get_functiondef('benchmark_full_monetary_control(uuid,uuid)'::regprocedure) into body;
 if position($s$c.plan->>'version' in ('5','6')$s$ in body)=0 then raise exception 'Monetary version anchor missing';end if;
 body:=replace(body,$s$c.plan->>'version' in ('5','6')$s$,$s$c.plan->>'version' in ('5','6','7')$s$);
 body:=replace(body,$s$'dollarCeilingMicrousd',10000000$s$,$s$'dollarCeilingMicrousd',benchmark_effective_dollar_ceiling(a.id,c.id)$s$);execute body;
 select pg_get_functiondef('benchmark_dollar_admission()'::regprocedure) into body;
 if position('used+ceil(new.reserved_tokens*rate)>10000000' in body)=0 then raise exception 'Dollar admission anchor missing';end if;
 body:=replace(body,'used+ceil(new.reserved_tokens*rate)>10000000','used+ceil(new.reserved_tokens*rate)>benchmark_effective_dollar_ceiling(a.id,new.continuation_id)');execute body;
 select pg_get_functiondef('benchmark_production_call_guard()'::regprocedure) into body;
 if position('if phase_cap=0' in body)=0 then raise exception 'Protected account reserve anchor missing';end if;
 body:=replace(body,'if phase_cap=0',$s$select coalesce(sum(reserved_tokens),0) into held from benchmark_budget_calls where account_id=a.id and state='reserved';
  if c.plan->>'version'='7' and m.project_kind='development' and
   a.spent_tokens+held+new.reserved_tokens+(c.plan->>'assessmentTokens')::bigint+
   (case when new.model='gpt-5.3-codex' then (c.plan->>'developmentClosureTokens')::bigint else 0 end)
   >benchmark_effective_account_cap(a.id)
   then raise exception 'Protected lifecycle account reserves';end if;
  if phase_cap=0$s$);
 body:=replace(body,$s$c.plan->>'version' in ('5','6')$s$,$s$c.plan->>'version' in ('5','6','7')$s$);execute body;
 select pg_get_functiondef('benchmark_full_native_reserve(text,uuid,bigint,text,text,bigint)'::regprocedure) into body;
 if position('benchmark_effective_mission_call_limit(m.id,g.continuation_id)-4' in body)=0 or position('benchmark_effective_mission_allowance(m.id,g.continuation_id)-60000' in body)=0 then raise exception 'Completion reserve anchor missing';end if;
 body:=replace(body,$s$c.plan->>'version' in ('5','6')$s$,$s$c.plan->>'version' in ('5','6','7')$s$);
 body:=replace(body,'benchmark_effective_mission_call_limit(m.id,g.continuation_id)-4',
  $s$benchmark_effective_mission_call_limit(m.id,g.continuation_id)-(select (plan->>'developmentClosureCalls')::integer from benchmark_full_continuations where id=g.continuation_id)$s$);
 body:=replace(body,'benchmark_effective_mission_allowance(m.id,g.continuation_id)-60000',
  $s$benchmark_effective_mission_allowance(m.id,g.continuation_id)-(select (plan->>'developmentClosureTokens')::bigint from benchmark_full_continuations where id=g.continuation_id)$s$);
 execute body;
end $$;

alter function benchmark_development_amendment_ready(uuid,text) rename to benchmark_development_amendment_ready_legacy;
create function benchmark_development_amendment_ready(p_amendment uuid,p_release text)
returns boolean language plpgsql stable security invoker set search_path=public as $$
declare am benchmark_development_resource_amendments;begin
 select * into am from benchmark_development_resource_amendments where id=p_amendment;
 if am.lifecycle_proposal_id is null then return benchmark_development_amendment_ready_legacy(p_amendment,p_release);end if;
 return exists(select 1 from benchmark_native_spending_approvals a
 join agent_tasks t on t.id=a.task_id join mission_assignments j on j.id=t.id
 join agent_missions m on m.id=j.mission_id join work_projects p on p.id=m.project_id
 join benchmark_budget_accounts acct on acct.id=a.account_id
 where a.id=am.approval_id and a.consumed_at is null and a.revoked_at is null
 and am.release_sha=p_release and am.runtime_version='provider-input-count-v1'
 and benchmark_lifecycle_authorized(am.continuation_id) and benchmark_development_renewal_matches(m.id,am.continuation_id)
 and t.id=am.task_id and t.status in ('dispatching','submitted') and t.external->>'resourceAmendmentId'=am.id::text
 and t.external->'receipt'=am.receipt and m.id=am.mission_id and p.id=am.project_id
 and j.status='waiting_external' and m.status='running' and p.status='running'
 and m.calls+m.routing_calls=(am.source_snapshot->'lifecycleSnapshot'->'position'->>'developmentConsumedCalls')::integer
 and greatest(m.actual_tokens,m.reserved_tokens)=(am.source_snapshot->'lifecycleSnapshot'->'position'->>'developmentEncumberedTokens')::bigint
 and acct.spent_tokens=(am.source_snapshot->'lifecycleSnapshot'->'position'->>'accountEncumberedTokens')::bigint
 and not exists(select 1 from benchmark_budget_calls where account_id=acct.id and state<>'settled')
 and not exists(select 1 from benchmark_execution_grants where account_id=acct.id and stopped_at is null and revoked_at is null and deadline>clock_timestamp())
 and exists(select 1 from model_registry where provider_name='openai' and model_id=a.model and pricing_status='verified'
  and pricing_verified_at>clock_timestamp()-interval '24 hours' and pricing_verified_at<=clock_timestamp()
  and pricing_input_per_1m between 0.000001 and 14 and pricing_output_per_1m between 0.000001 and 14));
end $$;
revoke all on function benchmark_development_amendment_ready(uuid,text),benchmark_development_amendment_ready_legacy(uuid,text) from public,anon,authenticated;
grant execute on function benchmark_development_amendment_ready(uuid,text),benchmark_development_amendment_ready_legacy(uuid,text) to service_role;
