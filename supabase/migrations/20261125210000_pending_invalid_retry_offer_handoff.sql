-- The generation-65 authorization offer was never accepted. Its original
-- conversation UI suppressed the offer. Permit exactly one corrective release
-- handoff of an unchanged, drained, unsigned invalid-response checkpoint.
-- This is release coordination only: it does not create a retry authorization,
-- reserve a retry slot, resume a mission, or consume any paid capacity.
create table public.project_package_pending_retry_release_handoffs(
 project_id uuid primary key references public.work_projects(id),
 prior_receipt_id uuid not null references public.project_package_corrective_receipts(receipt_id),
 superseded_generation bigint not null,
 superseded_sha text not null check(superseded_sha ~ '^[a-f0-9]{40}$'),
 superseded_deployment text not null check(superseded_deployment ~ '^dpl_[A-Za-z0-9]+$'),
 checkpoint jsonb not null,
 original_state_hash text not null check(original_state_hash ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz not null default clock_timestamp()
);
alter table public.project_package_pending_retry_release_handoffs enable row level security;
revoke all on public.project_package_pending_retry_release_handoffs from public,anon,authenticated,service_role;
create trigger pending_retry_release_handoff_immutable before update or delete on public.project_package_pending_retry_release_handoffs
 for each row execute function public.project_org_change_immutable();

create function public.project_org_package_pending_retry_handoff_allowed(p_project uuid,p_action text,p_release text,p_deployment text,p_generation bigint) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare g project_retest_production_release_gate; prior project_package_corrective_receipts;
 cp jsonb; h project_package_pending_retry_release_handoffs;
begin
 cp:=project_org_package_invalid_retry_checkpoint(p_project);
 if cp is null then return false;end if;
 select * into g from project_retest_production_release_gate where project_id=p_project;
 select * into prior from project_package_corrective_receipts where project_id=p_project order by ordinal desc limit 1;
 select * into h from project_package_pending_retry_release_handoffs where project_id=p_project;
 if prior.project_id is null or prior.ordinal>=6 or g.project_id is null
 or g.alias_name is distinct from 'katie-mu.vercel.app' or g.generation is distinct from p_generation
 or p_release is null or p_release !~ '^[a-f0-9]{40}$'
 or p_deployment is null or p_deployment !~ '^dpl_[A-Za-z0-9]+$'
 or exists(select 1 from project_package_invalid_retry_authorizations a where a.project_id=p_project)
 then return false;end if;
 if p_action='closed' then
  return h.project_id is null and g.state='active' and g.generation=prior.release_generation+2
   and p_release=g.release_sha and p_deployment=g.deployment_id
   and g.release_sha<>prior.release_sha and g.deployment_id<>prior.deployment_id;
 end if;
 if h.project_id is null or h.prior_receipt_id is distinct from prior.receipt_id
 or h.superseded_generation is distinct from prior.release_generation+2
 or h.checkpoint is distinct from cp-'stateHash'
 or p_release in (h.superseded_sha,prior.release_sha)
 or p_deployment in (h.superseded_deployment,prior.deployment_id)
 or exists(select 1 from project_package_corrective_receipts x where x.project_id=p_project and (x.release_sha=p_release or x.deployment_id=p_deployment))
 then return false;end if;
 if p_action='active' then
  return g.state='closed' and g.generation=h.superseded_generation+1
   and g.release_sha=h.superseded_sha and g.deployment_id=h.superseded_deployment;
 elsif p_action='offer' then
  return g.state='active' and g.generation=h.superseded_generation+2
   and g.release_sha=p_release and g.deployment_id=p_deployment;
 end if;
 return false;
end $$;

-- The existing operator RPC holds both advisory locks and the project/gate
-- row locks; preserve the original drain checks before recording a handoff.
create function public.project_org_package_record_pending_retry_handoff(p_project uuid,p_release text,p_deployment text,p_generation bigint) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare cp jsonb; prior project_package_corrective_receipts;
begin
 if not project_org_package_pending_retry_handoff_allowed(p_project,'closed',p_release,p_deployment,p_generation) then return;end if;
 cp:=project_org_package_invalid_retry_checkpoint(p_project);
 select * into prior from project_package_corrective_receipts where project_id=p_project order by ordinal desc limit 1;
 insert into project_package_pending_retry_release_handoffs(project_id,prior_receipt_id,superseded_generation,superseded_sha,superseded_deployment,checkpoint,original_state_hash)
 values(p_project,prior.receipt_id,p_generation,p_release,p_deployment,cp-'stateHash',cp->>'stateHash');
end $$;

DO $patch$
declare edit record; d text;
begin
 for edit in select * from (values
 ('public.project_org_package_corrective_gate_allowed(uuid,text,text,text,bigint)',$a$ if project_org_package_corrective_checkpoint(p_project) is null$a$,$b$ if project_org_package_pending_retry_handoff_allowed(p_project,p_action,p_release,p_deployment,p_generation) then return true;end if;
 if project_org_package_corrective_checkpoint(p_project) is null$b$),
 ('public.project_org_retest_set_release_gate(uuid,text,text,text,bigint)',$a$ stamp:=clock_timestamp();$a$,$b$ if p_action='closed' then perform project_org_package_record_pending_retry_handoff(p_project,p_release,p_deployment,p_expected_generation);end if;
 stamp:=clock_timestamp();$b$),
 ('public.project_org_package_invalid_retry_offer(uuid,uuid,text)',$a$ or g.generation is distinct from prior.release_generation+2 then raise exception$a$,$b$ or (g.generation is distinct from prior.release_generation+2 and not project_org_package_pending_retry_handoff_allowed(p_project,'offer',p_release,g.deployment_id,g.generation)) then raise exception$b$)
 ) edits(signature,anchor,replacement) loop
  d:=pg_get_functiondef(edit.signature::regprocedure);
  if (length(d)-length(replace(d,edit.anchor,'')))/length(edit.anchor)<>1 then raise exception 'Unexpected pending-offer predecessor: %',edit.signature;end if;
  execute replace(d,edit.anchor,edit.replacement);
 end loop;
end $patch$;

revoke all on function public.project_org_package_pending_retry_handoff_allowed(uuid,text,text,text,bigint),
 public.project_org_package_record_pending_retry_handoff(uuid,text,text,bigint) from public,anon,authenticated,service_role;
