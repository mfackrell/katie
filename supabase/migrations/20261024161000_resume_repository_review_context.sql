-- The new worker calls this only after its matching 96K audit input support is
-- deployed. Migration alone does not resume a job on the older runtime.
create or replace function public.resume_repository_review_context() returns integer
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments;m agent_missions;d executive_delegations;n integer:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 for j in
  select a.* from mission_assignments a join agent_missions b on b.id=a.mission_id
  where a.role='review' and a.status='failed' and a.attempts=1
   and a.result->>'reviewContextOverflow'='true'
   and (a.result->>'reviewInputCharacters')::integer between 48001 and 96000
   and not(a.payload ? 'reviewEnvelopeRecovery')
   and b.status='blocked' and b.project_id is null and b.repository_id is not null
   and b.objective ~* '(read[- ]only|do not modify|without (changing|modifying))'
   and b.deadline>now() and b.calls<b.max_calls
   and greatest(b.actual_tokens,b.reserved_tokens)<b.token_allowance
   and not exists(select 1 from mission_assignments active where active.mission_id=b.id and active.status='running' and active.lease_until>now())
  order by a.updated_at limit 3 for update of a
 loop
  select * into m from agent_missions where id=j.mission_id for update;
  select * into d from executive_delegations where mission_id=m.id and deadline>now() for update;
  if not found then continue;end if;
  -- Restore only running delegations or a terminal state written by the
  -- automatic failed-review reconciler. Never undo an owner's cancellation.
  if d.status<>'running' and not(d.status='cancelled' and
   coalesce((select event='cancel' and evidence->>'reason'='Mission did not pass independent review'
    from executive_delegation_events where delegation_id=d.id order by created_at desc limit 1),false)) then continue;end if;
  insert into executive_delegation_events(delegation_id,event,evidence)
   values(d.id,'repository_review_context_recovery',jsonb_build_object('missionId',m.id,'jobId',j.id,
    'priorJob',to_jsonb(j),'priorDelegationStatus',d.status,'inputCharacterLimit',96000,
    'tokenAllowance',m.token_allowance,'reservedTokens',m.reserved_tokens,'actualTokens',m.actual_tokens,
    'calls',m.calls,'routingCalls',m.routing_calls,'deadline',m.deadline,'freshReviewRequired',true));
  update mission_assignments set status='queued',lease=null,lease_until=null,available_at=now(),
   payload=payload||jsonb_build_object('reviewEnvelopeRecovery',jsonb_build_object('inputCharacterLimit',96000,'priorFailure',j.result,'priorAttempts',j.attempts)),
   detail='Complete immutable audit evidence fits the corrected review envelope; retrying once with unchanged budget and deadline.',updated_at=now() where id=j.id;
  update agent_missions set status='running',detail='Resuming saved independent repository review after input-envelope repair. Budget, charges, attempts and deadline are unchanged.',updated_at=now() where id=m.id;
  update executive_delegations set status='running',updated_at=now() where id=d.id;
  update executive_management_requests r set status='running',updated_at=now(),
   plan=jsonb_set(r.plan,'{provision}',coalesce((select jsonb_agg(case
    when p->>'blocked'='Source workstreams have not passed independent review; synthesis was not started.'
     and exists(select 1 from jsonb_array_elements(r.plan->'assignments') a where a->>'missionId'=m.id::text and p->'sourceSlugs' ? (a->>'slug'))
    then p-'blocked' else p end) from jsonb_array_elements(r.plan->'provision') p),'[]'::jsonb)),
   detail='Saved source review is resuming after a runtime envelope fix; final acceptance remains pending.'
  where r.actor_id=d.actor_id and r.chat_id=d.chat_id and r.status in ('running','blocked')
   and exists(select 1 from jsonb_array_elements(r.plan->'assignments') a where a->>'missionId'=m.id::text);
  n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function public.resume_repository_review_context() from public,anon,authenticated;
grant execute on function public.resume_repository_review_context() to service_role;

create or replace function public.checkpoint_mission_operational_evidence(p_id uuid,p_lease uuid,p_evidence jsonb) returns boolean
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments;m agent_missions;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id for update;
 if not found then return false;end if;
 select * into m from agent_missions where id=j.mission_id for update;
 if j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now()
  or m.status<>'running' or m.deadline<=now() then return false;end if;
 if jsonb_typeof(p_evidence)<>'object' or p_evidence->>'kind' is distinct from 'scoped_workflow_trace'
  or length(p_evidence::text)>20000 or p_evidence->>'observedAt' is null then return false;end if;
 if j.payload ? 'operationalEvidenceSnapshot' then return j.payload->'operationalEvidenceSnapshot'=p_evidence;end if;
 update mission_assignments set payload=payload||jsonb_build_object('operationalEvidenceSnapshot',p_evidence),updated_at=now() where id=j.id;
 return true;
end $$;
revoke all on function public.checkpoint_mission_operational_evidence(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.checkpoint_mission_operational_evidence(uuid,uuid,jsonb) to service_role;
