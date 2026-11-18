-- Reusable actor-specific operating instructions. Only service_role can read/write
-- this catalog; chat joins it through the EXISTING actors lookup (no extra call).
alter table public.actors
  add column if not exists operating_instruction_mode text not null default 'legacy'
    check (operating_instruction_mode in ('legacy', 'modular'));

create table if not exists public.operating_instruction_modules (
  id text primary key,
  title text not null,
  content text not null,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.actor_operating_instruction_assignments (
  actor_id uuid not null references public.actors(id) on delete cascade,
  module_id text not null references public.operating_instruction_modules(id) on delete restrict,
  position integer not null check (position >= 1),
  primary key (actor_id, module_id),
  unique (actor_id, position)
);
create index if not exists actor_operating_instruction_assignments_module_idx
  on public.actor_operating_instruction_assignments(module_id);

alter table public.operating_instruction_modules enable row level security;
alter table public.actor_operating_instruction_assignments enable row level security;
revoke all on public.operating_instruction_modules from public, anon, authenticated;
revoke all on public.actor_operating_instruction_assignments from public, anon, authenticated;
grant select, insert, update, delete on public.operating_instruction_modules to service_role;
grant select, insert, update, delete on public.actor_operating_instruction_assignments to service_role;

-- Content copied verbatim from pre-migration deliverable-standard.ts.
insert into public.operating_instruction_modules(id, title, content, sort_order) values
  ($module$task-stance$module$, $module$Task-specific comparative judgment$module$, $module$Choose the reasoning stance appropriate to the task: a FIT ASSESSMENT balances supported qualifications, material gaps and practical implications; an APPLICATION RESPONSE or PROPOSAL advocates the strongest truthful value for the intended reader through relevant capabilities and outcomes, rather than a career chronology or a qualification-gap inventory; a FINANCIAL REPORT presents neutral analysis with reconciled quantities, assumptions and uncertainty; TECHNICAL WORK prioritizes diagnosis, causal evidence, reproducible verification and honest implementation status. Other tasks take their stance from the user's purpose. Do not carry the stance of an earlier task into a different requested deliverable.$module$, 10),
  ($module$application-completion$module$, $module$Application completion$module$, $module$APPLICATION COMPLETION: When the active task is completing an application, your job is to help the user complete it successfully. Use the substantial verified experience already available to produce the strongest truthful answer to the specific application question. Do not reopen qualification assessments, request optional background information, or introduce unrelated considerations. Ask only when a missing user-owned fact genuinely prevents completing that answer truthfully; otherwise make the editorial decisions independently and move the application forward. An explicit request for a qualification assessment is a different task and should still receive balanced evaluation.$module$, 20),
  ($module$professional-evidence$module$, $module$Evidence-based professional capability reasoning$module$, $module$EVIDENCE-BASED CAPABILITY REASONING: Understand evidence by its substance, not merely its terminology. When evaluating experience, capabilities, accomplishments or comparable claims in any domain, consider what the requested activity actually involves and what the complete evidence collectively demonstrates. Work performed within broader responsibilities or under different names may substantively demonstrate an activity even if no source uses its exact label. Distinguish directly documented performance, substantively demonstrated underlying work, transferable capability and unsupported claims. Missing documentation is not evidence an activity was never performed; conversely, related work does not establish completion of every component of a broader process. Draw the strongest defensible conclusion supported by the whole record, synthesize its significance instead of inventorying labels, and do not invent additional actions, responsibilities or outcomes. Apply this when relevant rather than as a mandatory checklist or visible reasoning transcript.$module$, 30),
  ($module$professional-communication$module$, $module$Evidence-supported professional communication$module$, $module$Communicate the selected evidence in the most effective task-appropriate manner while maintaining factual accuracy. Necessary limitations prevent misleading claims; optional caveats and peripheral anecdotes should not displace the central supported message. Do not inflate experience, manufacture facts, hide material risks, or apply persuasive advocacy to objective analysis. A role title or completed project does not establish current employment, full functional ownership, particular process steps or additional outcomes: include those only when the sources establish them. Do not invent sender identities or commitments to make a draft look finished. Test each claim about past work against a specific supplied fact; plausible professional practices are not proof that the user performed them. Explain relevance or proposed next steps as such, rather than converting them into claimed experience.$module$, 40),
  ($module$technical-stance$module$, $module$Technical diagnosis and verification$module$, $module$TECHNICAL WORK prioritizes diagnosis, causal evidence, reproducible verification and honest implementation status.$module$, 50),
  ($module$financial-stance$module$, $module$Financial-report analysis$module$, $module$FINANCIAL REPORT presents neutral analysis with reconciled quantities, assumptions and uncertainty$module$, 60)
on conflict (id) do nothing;

-- Exact ID assignments established in docs/actor-operating-instruction-ownership.md.
-- Do NOT assign modules by name; hundreds of guest actors have the name Katie.
insert into public.actor_operating_instruction_assignments(actor_id,module_id,position) values
  ('d36824aa-7fcd-4a7a-978a-73f073ccc789','task-stance',1),
  ('d36824aa-7fcd-4a7a-978a-73f073ccc789','application-completion',2),
  ('d36824aa-7fcd-4a7a-978a-73f073ccc789','professional-evidence',3),
  ('d36824aa-7fcd-4a7a-978a-73f073ccc789','professional-communication',4),
  ('6c178d99-6d19-49e6-83ac-a2d7eff3d458','technical-stance',1)
on conflict (actor_id,module_id) do nothing;

update public.actors set operating_instruction_mode='modular'
where id in (
  'f94eeb41-9bcd-4eb8-9896-bb92e5e3b5c0',
  'd36824aa-7fcd-4a7a-978a-73f073ccc789',
  '6c178d99-6d19-49e6-83ac-a2d7eff3d458'
);

-- Called only from the existing authenticated /api/actors PATCH path.
-- SECURITY INVOKER, service_role-only EXECUTE, one transaction for assignments.
create or replace function public.set_actor_operating_instruction_modules(
  p_actor_id uuid, p_mode text, p_module_ids text[]
) returns void
language plpgsql security invoker set search_path = public
as $$
declare expected integer;
begin
  if p_actor_id is null or p_mode is null or p_mode not in ('legacy','modular')
     or p_module_ids is null or cardinality(p_module_ids)>16
     or (p_mode='legacy' and cardinality(p_module_ids)>0) then
    raise exception 'Invalid operating instruction configuration';
  end if;
  select count(*) into expected from unnest(p_module_ids) as x(id);
  if expected <> (select count(distinct id) from unnest(p_module_ids) as x(id))
     or expected <> (select count(*) from public.operating_instruction_modules where id = any(p_module_ids)) then
    raise exception 'Unknown or duplicate instruction module';
  end if;
  perform 1 from public.actors where id=p_actor_id for update;
  if not found then raise exception 'Actor not found'; end if;
  delete from public.actor_operating_instruction_assignments where actor_id=p_actor_id;
  insert into public.actor_operating_instruction_assignments(actor_id,module_id,position)
    select p_actor_id, id, ordinal::integer from unnest(p_module_ids) with ordinality as x(id,ordinal);
  update public.actors set operating_instruction_mode=p_mode,updated_at=now()
    where id=p_actor_id;
end;
$$;
revoke all on function public.set_actor_operating_instruction_modules(uuid,text,text[]) from public, anon, authenticated;
grant execute on function public.set_actor_operating_instruction_modules(uuid,text,text[]) to service_role;
