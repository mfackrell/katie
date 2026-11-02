-- Task 3C: enforce the assessed source binding at the actual atomic row
-- transition to completed. No pg_get_functiondef/string replacement: this
-- trigger remains effective if the lifecycle function is reformatted/replaced.
-- The original lease, review, authority, ledger and browser gates still execute.
create function public.project_assessment_completion_guard()
returns trigger language plpgsql security definer set search_path=public as $guard$
begin
 if new.status='completed' and old.status is distinct from 'completed' then
  if new.phase is distinct from 'assessment'
    or new.verified_sha is null or new.approved_hash is null or new.spec is null
    or new.active_mission_id is null
    or new.preview->'browserAcceptance'->>'passed' is distinct from 'true'
    or new.preview->'browserAcceptance'->>'headSha' is distinct from new.verified_sha
    or new.preview->'browserAcceptance'->>'contractHash' is distinct from
       encode(sha256(convert_to(project_canonical(new.spec->'finalContract'),'UTF8')),'hex')
    or jsonb_array_length(new.preview->'browserAcceptance'->'checks') is distinct from
       jsonb_array_length(new.spec->'finalContract'->'scenarios')
    or exists (
      select 1 from jsonb_array_elements(new.preview->'browserAcceptance'->'checks')
        with ordinality c(v,n)
      where c.v->>'passed' is distinct from 'true'
        or c.v->>'name' is distinct from
            new.spec->'finalContract'->'scenarios'->(c.n::integer-1)->>'name'
    )
    or not exists (
     select 1 from public.agent_missions m
     join public.project_runs r on r.project_id=new.id
       and r.kind='development' and r.outcome->>'head'=new.verified_sha
       and r.binding->>'scopeHash'=new.approved_hash
     join public.mission_assignments j on j.id::text=r.outcome->>'taskId'
       and j.mission_id=r.mission_id and j.role='development' and j.status='completed'
     where m.id=new.active_mission_id and m.project_id=new.id
       and m.project_kind='assessment' and m.status='completed'
       and m.project_evidence->>'approvedScopeHash'=new.approved_hash
       and m.project_evidence->'approvedFinalContract'=new.spec->'finalContract'
       and m.project_evidence->'preview'=new.preview
       and m.project_evidence#>>'{finalIntegratedEvidence,taskId}'=j.id::text
       and m.project_evidence#>>'{finalIntegratedEvidence,head}'=new.verified_sha
       and m.project_evidence#>>'{finalIntegratedEvidence,verification,observedHeadSha}'=new.verified_sha
       and m.project_evidence#>>'{finalIntegratedEvidence,verification,testedHeadSha}'=new.verified_sha
       and m.project_evidence#>>'{finalIntegratedEvidence,verification,reviewedHeadSha}'=new.verified_sha
       and r.outcome#>>'{verification,observedHeadSha}'=new.verified_sha
       and r.outcome#>>'{verification,testedHeadSha}'=new.verified_sha
       and r.outcome#>>'{verification,reviewedHeadSha}'=new.verified_sha
       and j.result#>>'{verification,observedHeadSha}'=new.verified_sha
       and j.result#>>'{verification,testedHeadSha}'=new.verified_sha
       and j.result#>>'{verification,reviewedHeadSha}'=new.verified_sha
       and j.result#>>'{verification,projectAcceptance,passed}'='true'
       and j.result#>>'{verification,projectAcceptance,headSha}'=new.verified_sha
    )
  then
   raise exception 'Final assessment is not bound to the accepted task, candidate and approved contract';
  end if;
 end if;
 return new;
end $guard$;
revoke all on function public.project_assessment_completion_guard()
 from public,anon,authenticated,service_role;
create trigger project_assessment_completion_guard
 before update of status on public.work_projects
 for each row when (old.status is distinct from new.status and new.status='completed')
 execute function public.project_assessment_completion_guard();
