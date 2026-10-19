-- Executive registry integration; every transition is transactional and rolled back.
DO $$ declare o jsonb;d jsonb;v jsonb;aid uuid:='11111111-1111-4111-8111-111111111111';cid uuid:='22222222-2222-4222-8222-222222222222';expiry timestamptz:=date_trunc('second',now()+interval '1 day');
begin
 begin
  o:=register_executive_orchestrator(aid,'financial_reporting','Financial Reporting',
   'Produces finance reporting and executive analysis.',array['financial_analysis','management_reporting'],'mission');
  if o->>'slug'<>'financial_reporting' or o->>'status'<>'registered' then raise exception 'Registry rejected specialist';end if;
  v:=register_executive_orchestrator(aid,'financial_reporting','Financial Reporting',
   'Produces finance reporting and executive analysis.',array['financial_analysis','management_reporting'],'mission');
  if v->>'id'<>o->>'id' then raise exception 'Idempotent registry created a duplicate';end if;
  begin
   perform register_executive_orchestrator(aid,'financial_reporting','Different title',
    'Produces finance reporting and executive analysis.',array['financial_analysis'],'mission');
   raise exception 'Should reject identity conflict';
  exception when others then if SQLERRM='Should reject identity conflict' then raise;end if;end;
  d:=propose_executive_delegation(aid,cid,'financial_reporting','finance-report-001',
   'Produce a monthly management reporting assessment','management_reporting',
   '["A complete report","An independently checked financial interpretation"]',5000,expiry);
  if d->>'status'<>'proposed' or (d->>'delegated_version')::int<>1 then raise exception 'Delegation binding invalid';end if;
  v:=propose_executive_delegation(aid,cid,'financial_reporting','finance-report-001',
   'Produce a monthly management reporting assessment','management_reporting',
   '["A complete report","An independently checked financial interpretation"]',5000,expiry);
  if v->>'id'<>d->>'id' then raise exception 'Idempotent delegation was duplicated';end if;
  begin
   perform propose_executive_delegation(aid,cid,'financial_reporting','finance-report-001',
     'Change deliverable','management_reporting','["A complete report"]',5000,expiry);
   raise exception 'Changed existing contract accepted';
  exception when others then if SQLERRM='Changed existing contract accepted' then raise;end if;end;
  if transition_executive_delegation((d->>'id')::uuid,aid,cid,'verify','{"independentReview":"pass"}') is not null then
   raise exception 'Unsubmitted work was verified';end if;
  if transition_executive_delegation((d->>'id')::uuid,gen_random_uuid(),cid,'accept') is not null then
   raise exception 'Foreign actor changed executive assignment';end if;
  v:=transition_executive_delegation((d->>'id')::uuid,aid,cid,'accept');
  if v->>'status'<>'accepted' then raise exception 'Delegation acceptance failed';end if;
  v:=transition_executive_delegation((d->>'id')::uuid,aid,cid,'start');
  if v->>'status'<>'running' then raise exception 'Delegation start failed';end if;
  v:=transition_executive_delegation((d->>'id')::uuid,aid,cid,'submit','{"deliverable":"Monthly report, source linked and verifiable"}');
  if v->>'status'<>'submitted' then raise exception 'Specialist submission failed';end if;
  if transition_executive_delegation((d->>'id')::uuid,aid,cid,'verify','{"independentReview":"failure"}') is not null then
   raise exception 'Unapproved independent review allowed verification';end if;
  v:=transition_executive_delegation((d->>'id')::uuid,aid,cid,'verify','{"independentReview":"pass"}');
  if v->>'status'<>'verified' then raise exception 'Independent executive verification missing';end if;
  if (select count(*) from executive_delegation_events where delegation_id=(d->>'id')::uuid)<>5 then
   raise exception 'Executive delegation audit trail incomplete';end if;
  raise exception using errcode='P2197',message='rollback executive registry fixture';
 exception when sqlstate 'P2197' then null;end;
end $$;