-- Task 4A: prevent ordinary authorization of the original continuation-bound project.
-- No production rows are modified by this migration. Existing unbound decisions
-- remain immutable historical evidence and cannot be dispatched.
do $migration$
declare source text; anchor text;
begin
 source:=pg_get_functiondef('public.developer_initial_snapshot(uuid,uuid)'::regprocedure);
 anchor:=' s:=developer_task_binding(p_owner,p_task);';
 if source is null or strpos(source,anchor)=0 or strpos(source,'TASK4A_ORDINARY_OWNER_ADMISSION_DENIED')>0
 then raise exception 'Unexpected ordinary Developer initial authority source';end if;
 source:=replace(source,anchor,anchor||E'\n if s->\'project\'->>\'id\'=\'6d1c29f1-b31e-47a5-aabb-cbcf1326f388\' then\n  raise exception \'TASK4A_ORDINARY_OWNER_ADMISSION_DENIED\';\n end if;');
 execute source;
 source:=pg_get_functiondef('public.developer_claim_dispatch(uuid,text)'::regprocedure);
 anchor:=' s:=developer_task_binding(a.owner_id,a.task_id);';
 if source is null or strpos(source,anchor)=0 or strpos(source,'TASK4A_NATIVE_OWNER_GATE')>0
 then raise exception 'Unexpected ordinary Developer dispatch admission source';end if;
 source:=replace(source,anchor,
  E' if a.project_id=\'6d1c29f1-b31e-47a5-aabb-cbcf1326f388\'::uuid then\n'||
  E'  -- TASK4A_NATIVE_OWNER_GATE: refuse invalid historical native handoffs.\n'||
  E'  if a.developer_authority->>\'task4aContinuationId\' is distinct from\n'||
  E'    (select id::text from public.project_continuation_authorizations\n'||
  E'     where project_id=a.project_id and revoked_at is null\n'||
  E'       and deadline>clock_timestamp())\n'||
  E'   or not public.task4a_native_authority_ready(a.project_id,a.task_id,\n'||
  E'      (a.developer_authority->>\'task4aContinuationId\')::uuid)\n'||
  E'  then return false;end if;\n end if;\n'||anchor);
 execute source;
end $migration$;

-- Second fence: even other legitimate database callers cannot create another
-- unbound ordinary Task 4A authorization. The previously issued incorrect grant
-- stays intact as historical evidence; this trigger does not reclassify it.
create or replace function public.task4a_reject_unbound_native_approval()
returns trigger language plpgsql set search_path=public as $guard$
begin
 if new.project_id='6d1c29f1-b31e-47a5-aabb-cbcf1326f388'::uuid
  and new.developer_authority is not null
  and (coalesce(new.developer_authority->>'task4aContinuationId','')='' or
   not exists(select 1 from public.project_continuation_authorizations a
    where a.id::text=new.developer_authority->>'task4aContinuationId'
      and a.project_id=new.project_id and a.revoked_at is null
      and a.deadline>clock_timestamp()))
 then raise exception 'TASK4A_CONTINUATION_BOUND_APPROVAL_REQUIRED';end if;
 return new;
end $guard$;
drop trigger if exists task4a_unbound_ordinary_approval_denied on public.benchmark_native_spending_approvals;
create trigger task4a_unbound_ordinary_approval_denied before insert on public.benchmark_native_spending_approvals
for each row execute function public.task4a_reject_unbound_native_approval();
revoke all on function public.task4a_reject_unbound_native_approval() from public,anon,authenticated;
