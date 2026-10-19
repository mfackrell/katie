DO $$ declare a uuid:='11111111-1111-4111-8111-111111111111'; c uuid:='22222222-2222-4222-8222-222222222222';r jsonb;v jsonb;spec jsonb;
begin
 begin
 spec:=jsonb_build_object('capability','financial_analysis','objective','Analyze a financial statement','successCriteria',jsonb_build_array('Explain financial findings'),'proposedSlug','finance_ops','proposedTitle','Finance Operations','proposedDescription','Financial reporting and analysis coordination','proposedCapabilities',jsonb_build_array('financial_analysis'));
 r:=propose_executive_provisioning(a,c,'finance-provision-001',spec,'configure');
 if r->>'status'<>'proposed' then raise exception 'No provisioning proposal';end if;
 v:=propose_executive_provisioning(a,c,'finance-provision-001',spec,'configure');
 if v->>'id'<>r->>'id' then raise exception 'Idempotency failed';end if;
 if transition_executive_provisioning((r->>'id')::uuid,a,c,'activate','{"independentReview":"pass"}') is not null then raise exception 'Unvalidated specialist activated';end if;
 if transition_executive_provisioning((r->>'id')::uuid,a,c,'configure','{"capabilityCatalogVerified":false}') is not null then raise exception 'Unverified capabilities configured';end if;
 if transition_executive_provisioning((r->>'id')::uuid,gen_random_uuid(),c,'configure','{"capabilityCatalogVerified":true}') is not null then raise exception 'Foreign actor configured a specialist';end if;
 v:=transition_executive_provisioning((r->>'id')::uuid,a,c,'configure','{"capabilityCatalogVerified":true}');
 if v->>'status'<>'configured' then raise exception 'Configuration failed';end if;
 if transition_executive_provisioning((r->>'id')::uuid,a,c,'validate','{"independentReview":"pass","acceptanceEvidence":[]}' ) is not null then raise exception 'Validation passed without tests';end if;
 v:=transition_executive_provisioning((r->>'id')::uuid,a,c,'validate','{"independentReview":"pass","acceptanceEvidence":["verified capability test"]}');
 if v->>'status'<>'validated' then raise exception 'Specialist independent validation failed';end if;
 v:=transition_executive_provisioning((r->>'id')::uuid,a,c,'activate','{"independentReview":"pass"}');
 if v->>'status'<>'activated' or not exists(select 1 from executive_orchestrators where id=(v->>'specialist_id')::uuid and status='active') then raise exception 'Activation failed';end if;
 if transition_executive_provisioning((r->>'id')::uuid,a,c,'activate','{"independentReview":"pass"}') is not null then raise exception 'Duplicate activation';end if;
 v:=propose_executive_provisioning(a,c,'finance-commission-001',spec,'commission');
 if v->>'status'<>'commission_pending' then raise exception 'Commission was not held for delegation';end if;
 if transition_executive_provisioning((v->>'id')::uuid,a,c,'validate','{"independentReview":"pass","acceptanceEvidence":["fake"]}') is not null then raise exception 'Commission bypassed implementation';end if;
 if (select count(*) from executive_provisioning_events where request_id=(r->>'id')::uuid)<>4 then raise exception 'Provisioning events missing';end if;
 raise exception using errcode='P2196',message='rollback executive provisioning fixture';
 exception when sqlstate 'P2196' then null;end;
end $$;