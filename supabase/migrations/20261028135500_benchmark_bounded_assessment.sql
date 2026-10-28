-- Allocate the existing Full account across stages; no authorization is added.
create function public.benchmark_project_assessment_cap(p_project uuid) returns integer
language sql stable security invoker set search_path=public as $$
 select case when exists(select 1 from benchmark_full_project_bindings b
 join benchmark_budget_accounts a on a.id=b.account_id
 join benchmark_production_qualifications q on q.experiment_id=a.experiment_id
 where b.project_id=p_project and q.issue=715 and a.arm='full' and a.cap_tokens=350000)
 then 60000 else 120000 end;
$$;
revoke all on function public.benchmark_project_assessment_cap(uuid) from public,anon,authenticated;
grant execute on function public.benchmark_project_assessment_cap(uuid) to service_role;
DO $patch$
declare body text;old text;addition text;
begin
 select pg_get_functiondef('public.finish_work_project(uuid,uuid,text,jsonb)'::regprocedure) into body;
 old:='spec_future:=(spec_milestones+1)*120000;';
 if position(old in body)=0 then raise exception 'Expected specification headroom gate missing';end if;
 body:=replace(body,old,'spec_future:=spec_milestones*120000+benchmark_project_assessment_cap(p.id);');
 addition:=$inject$
 if action='child' and p.phase='assessment' then
  update agent_missions set token_allowance=least(token_allowance,benchmark_project_assessment_cap(p.id))
  where id=(select active_mission_id from work_projects where id=p.id);
 end if;
$inject$;
 if position(' if not ok then return false;end if;' in body)=0 then raise exception 'Expected child completion gate missing';end if;
 body:=replace(body,' if not ok then return false;end if;',' if not ok then return false;end if;'||addition);
 execute body;
end $patch$;
