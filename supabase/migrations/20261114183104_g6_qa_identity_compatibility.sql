begin;

-- Preserve both established QA identities. Change only the designation tests:
-- appointment ancestry, accepted direct QA, and the source-bound QA reviewer.
-- Do not rename nodes or relax reporting, evidence, scope or closure predicates.
do $patch$
declare
 body text; anchor text; replacement text;
begin
 body:=pg_get_functiondef('public.project_org_decide_hierarchy(uuid,uuid,jsonb)'::regprocedure);
 for anchor,replacement in values
  ('c->>''area''=''quality_assurance''','c->>''area'' in (''quality_assurance'',''independent_qa'')'),
  ('select 1 from ancestors where area=''quality_assurance''',
   'select 1 from ancestors where area in (''quality_assurance'',''independent_qa'')'),
  ('and area=''quality_assurance'' and status=''accepted''',
   'and area in (''quality_assurance'',''independent_qa'') and status=''accepted'''),
  ('and qa.area=''quality_assurance'' and qa.kind=''manager''',
   'and qa.area in (''quality_assurance'',''independent_qa'') and qa.kind=''manager''')
 loop
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
   raise exception 'Unexpected installed G6 QA identity predicate: %',anchor;
  end if;
  body:=replace(body,anchor,replacement);
 end loop;
 execute body;
end $patch$;

commit;
