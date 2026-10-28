-- Append-only provider drafts: no result overwrite can erase generation evidence.
create table public.mission_specification_drafts (
 id uuid primary key default gen_random_uuid(),
 job_id uuid not null references public.mission_assignments(id),
 mission_id uuid not null references public.agent_missions(id),
 attempt integer not null check(attempt>0),
 raw_response text not null check(octet_length(raw_response)<=500000),
 candidate text check(candidate is null or octet_length(candidate)<=500000),
 validation_error text check(validation_error is null or length(validation_error)<=2000),
 response_hash text not null check(response_hash ~ '^[a-f0-9]{64}$'),
 record_hash text not null check(record_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 unique(job_id,attempt,record_hash)
);
alter table public.mission_specification_drafts enable row level security;
revoke all on public.mission_specification_drafts from public,anon,authenticated,service_role;
grant select,insert on public.mission_specification_drafts to service_role;
create function public.checkpoint_mission_specification_draft(p_id uuid,p_lease uuid,p_response text,p_validation text,p_candidate text) returns boolean
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments; m agent_missions; h text; rh text; saved mission_specification_drafts;
begin
 select * into j from mission_assignments where id=p_id for update;
 if not found or j.status<>'running' or j.lease is distinct from p_lease or p_lease is null then return false;end if;
 select * into m from agent_missions where id=j.mission_id;
 if m.project_kind<>'specification' or j.role not in ('compose','revise') or p_response is null then return false;end if;
 -- Evidence may be saved after a deadline; this grants no inference or completion authority.
 h:=encode(sha256(convert_to(p_response,'UTF8')),'hex');
 rh:=encode(sha256(convert_to(jsonb_build_array(p_response,p_candidate,p_validation)::text,'UTF8')),'hex');
 insert into mission_specification_drafts(job_id,mission_id,attempt,raw_response,candidate,validation_error,response_hash,record_hash)
 values(j.id,m.id,j.attempts,p_response,p_candidate,p_validation,h,rh)
 on conflict(job_id,attempt,record_hash) do nothing;
 select * into saved from mission_specification_drafts where job_id=j.id and attempt=j.attempts and record_hash=rh;
 if saved.raw_response is distinct from p_response or saved.candidate is distinct from p_candidate or saved.validation_error is distinct from p_validation then raise exception 'immutable specification draft conflict';end if;
 return true;
end $$;
revoke all on function public.checkpoint_mission_specification_draft(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.checkpoint_mission_specification_draft(uuid,uuid,text,text,text) to service_role;
