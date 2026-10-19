-- Live GitHub Actions acceptance against an isolated REAL PostgreSQL
-- database. Finance is the example, never a production customer record.
DO $$ DECLARE a uuid:='11111111-1111-4111-8111-111111111111'; c uuid:='22222222-2222-4222-8222-222222222222'; spec jsonb; p jsonb; r jsonb; d jsonb; v jsonb; count_before integer;
BEGIN
 BEGIN
  spec:=jsonb_build_object('capability','financial_analysis','objective','Establish a Finance Orchestrator to analyze financial statements and prepare CFO recommendations',
   'successCriteria',jsonb_build_array('Produces correct financial analysis','Passes independent executive validation'),
   'proposedSlug','finance_acceptance','proposedTitle','Finance Orchestrator',
   'proposedDescription','Finance and CFO reporting specialist managed through executive delegation',
   'proposedCapabilities',jsonb_build_array('financial_analysis'));
  SELECT count(*) INTO count_before FROM executive_orchestrators;
  p:=propose_executive_provisioning(a,c,'finance-live-acceptance-001',spec,'commission');
  IF p->>'status'<>'commission_pending' THEN RAISE EXCEPTION 'Missing capability did not commission';END IF;
  IF (SELECT count(*) FROM executive_orchestrators)<>count_before THEN RAISE EXCEPTION 'A specialist was falsely created during commissioning';END IF;
  IF transition_executive_provisioning((p->>'id')::uuid,a,c,'activate','{"independentReview":"pass"}') IS NOT NULL THEN RAISE EXCEPTION 'Unimplemented specialist was activated';END IF;
  IF transition_executive_provisioning((p->>'id')::uuid,a,c,'validate','{"independentReview":"pass","acceptanceEvidence":["fabricated"]}') IS NOT NULL THEN RAISE EXCEPTION 'Unbuilt specialist was validated';END IF;
  v:=propose_executive_provisioning(a,c,'finance-live-acceptance-001',spec,'commission');
  IF v->>'id'<>p->>'id' THEN RAISE EXCEPTION 'Retry duplicated commission';END IF;
  -- Simulate independently verified capabilities already provided by an active
  -- mission specialist. This does not manufacture a new external tool.
  v:=register_executive_orchestrator(a,'verified_finance_source','Existing Finance Capability',
    'A test-only finance specialist exposing an existing mission capability.',
    array['financial_analysis'],'mission');
  UPDATE executive_orchestrators SET status='active' WHERE id=(v->>'id')::uuid;
  p:=propose_executive_provisioning(a,c,'finance-live-configure-001',spec,'configure');
  v:=transition_executive_provisioning((p->>'id')::uuid,a,c,'configure','{"capabilityCatalogVerified":true}');
  IF v->>'status'<>'configured' THEN RAISE EXCEPTION 'Finance capability configuration failed';END IF;
  IF (SELECT status FROM executive_orchestrators WHERE id=(v->>'specialist_id')::uuid)<>'registered' THEN RAISE EXCEPTION 'Configured Finance was prematurely activated';END IF;
  IF transition_executive_provisioning((p->>'id')::uuid,a,c,'validate','{"independentReview":"fail","acceptanceEvidence":["test"]}') IS NOT NULL THEN RAISE EXCEPTION 'Failed independent review accepted';END IF;
  v:=transition_executive_provisioning((p->>'id')::uuid,a,c,'validate','{"independentReview":"pass","acceptanceEvidence":["CFO analysis assessment passed"]}');
  IF v->>'status'<>'validated' THEN RAISE EXCEPTION 'Finance validation failed';END IF;
  v:=transition_executive_provisioning((p->>'id')::uuid,a,c,'activate','{"independentReview":"pass"}');
  IF v->>'status'<>'activated' THEN RAISE EXCEPTION 'Finance activation failed';END IF;
  d:=propose_executive_delegation(a,c,'finance_acceptance','finance-task-001',
   'Analyze sample company performance and provide CFO recommendations','financial_analysis',
   '["Correct calculations","Traceable conclusions"]'::jsonb,5000,now()+interval '2 days');
  IF d->>'status'<>'proposed' THEN RAISE EXCEPTION 'Cannot delegate objective';END IF;
  v:=transition_executive_delegation((d->>'id')::uuid,a,c,'accept');
  v:=transition_executive_delegation((d->>'id')::uuid,a,c,'start');
  v:=transition_executive_delegation((d->>'id')::uuid,a,c,'submit','{"deliverable":"Verified finance sample result"}');
  IF transition_executive_delegation((d->>'id')::uuid,a,c,'verify','{"independentReview":"fail"}') IS NOT NULL THEN RAISE EXCEPTION 'False executive approval';END IF;
  v:=transition_executive_delegation((d->>'id')::uuid,a,c,'verify','{"independentReview":"pass"}');
  IF v->>'status'<>'verified' THEN RAISE EXCEPTION 'Finance delegation was not independently accepted';END IF;
  IF (SELECT count(*) FROM executive_provisioning_events WHERE request_id=(p->>'id')::uuid)<>4 THEN RAISE EXCEPTION 'Incomplete Finance provisioning audit';END IF;
  RAISE EXCEPTION USING ERRCODE='P2195', MESSAGE='finance live acceptance fixture rolled back';
 EXCEPTION WHEN SQLSTATE 'P2195' THEN NULL;END;
END $$;