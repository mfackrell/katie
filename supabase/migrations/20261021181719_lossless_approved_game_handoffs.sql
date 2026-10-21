-- Carry complete source and approved requirements alongside immutable receipts.
-- These are character limits only; native reservation and all spending caps remain unchanged.
create or replace function public.project_evidence_limit(p_profile text,p_phase text)
returns integer language sql immutable security invoker set search_path=public as $$
 select case when p_profile='game' and p_phase='specification' then 60000
  when p_profile='game' and p_phase in ('development','assessment') then 96000 else 30000 end;
$$;
revoke all on function public.project_evidence_limit(text,text) from public,anon,authenticated;
grant execute on function public.project_evidence_limit(text,text) to service_role;
