begin;

-- An approved scope grant starts at the Project Director. Before the first
-- package in a milestone, management must establish descending authority
-- (scope and capabilities) before the scheduler spends provider calls on
-- deeper supervisors who cannot yet commission authorized implementation.
-- After the first package is recorded, preserve the existing deepest-first
-- management/review/exception scheduling policy.
--
-- Preserve every lease, retry, authorization, scope and organization guard.
do $patch$
declare
 body text;
 original text := 'select * into n from project_organization_nodes where project_id=p.id and kind<>''worker'' and status=''active'' and decision_needed and deadline>now() and project_org_dependencies_ready(id) order by case when kind=''project_director'' and not project_org_plan_ready(id) then 0 else 1 end,depth desc,created_at,id limit 1;';
 replacement text := 'select * into n from project_organization_nodes where project_id=p.id and kind<>''worker'' and status=''active'' and decision_needed and deadline>now() and project_org_dependencies_ready(id) order by case when kind=''project_director'' and not project_org_plan_ready(id) then 0 else 1 end,case when p.phase=''development'' and p.approved_hash is not null and not exists(select 1 from project_work_packages pkg where pkg.project_id=p.id and pkg.milestone_index=p.milestone_index) then depth else -depth end,created_at,id limit 1;';
begin
 body := pg_get_functiondef('public.project_org_schedule_hierarchy(uuid,uuid)'::regprocedure);
 if (length(body)-length(replace(body,original,'')))/length(original)<>1 then
  raise exception 'Unexpected installed management selection contract';
 end if;
 execute replace(body,original,replacement);
end $patch$;

commit;
