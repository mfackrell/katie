begin;

alter table public.project_director_recoveries add column prior_cutoff timestamptz
 check (prior_cutoff < admitted_at);

create function public.project_admit_expired_director_recovery(
 p_owner uuid,p_project uuid,p_release text,p_prior_cutoff timestamptz,p_cutoff timestamptz
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p work_projects; a project_provider_execution; r project_director_recoveries;
 checked_at timestamptz; admission jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 if a.owner_id is null or a.owner_id is distinct from p_owner or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 then raise exception 'Authenticated trial owner required';end if;
 if p_prior_cutoff is null or not isfinite(p_prior_cutoff) or p_cutoff is null or not isfinite(p_cutoff)
 then raise exception 'Exact prior and new cutoffs required';end if;
 select * into r from project_director_recoveries where project_id=p_project;
 if found then
  if r.prior_cutoff is distinct from p_prior_cutoff
  then raise exception 'One-shot Director recovery already admitted';end if;
  return project_admit_director_recovery(p_owner,p_project,p_release,p_cutoff);
 end if;
 checked_at:=clock_timestamp();
 if p.deadline is distinct from p_prior_cutoff or a.deadline is distinct from p_prior_cutoff
 or p_prior_cutoff>=checked_at or p_cutoff<=checked_at or p_cutoff>checked_at+interval '2 hours'
 then raise exception 'Exact expired cutoff and a future recovery cutoff within two hours required';end if;

 -- The deployed scope trigger compares the project deadline with the locked
 -- provider authority. Both changes roll back unless original admission passes.
 update project_provider_execution set deadline=p_cutoff where project_id=p_project;
 update work_projects set deadline=p_cutoff where id=p_project;
 admission:=project_admit_director_recovery(p_owner,p_project,p_release,p_cutoff);
 update project_director_recoveries set prior_cutoff=p_prior_cutoff where project_id=p_project;
 return admission;
end $$;

revoke all on function public.project_admit_expired_director_recovery(uuid,uuid,text,timestamptz,timestamptz)
 from public,anon,authenticated;
grant execute on function public.project_admit_expired_director_recovery(uuid,uuid,text,timestamptz,timestamptz)
 to service_role;

commit;
