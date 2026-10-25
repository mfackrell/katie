-- Execute only in a disposable database with PR #739 and #737 migrations installed.
-- All fixture records are rolled back; exercises both routing and execution.
BEGIN;
DO $$
DECLARE m uuid:=gen_random_uuid(); j uuid:=gen_random_uuid();
 lease_id uuid:=gen_random_uuid(); exp uuid:=gen_random_uuid(); acct uuid;
 r uuid; c1 uuid:=gen_random_uuid(); c2 uuid:=gen_random_uuid();
 agent uuid; denied uuid; collision boolean:=false;
BEGIN
 SELECT id INTO agent FROM public.managed_agents LIMIT 1;
 IF agent IS NULL THEN RAISE EXCEPTION 'missing managed-agent fixture'; END IF;
 INSERT INTO public.agent_missions(id,objective,team,status,deadline,max_calls,token_allowance)
 VALUES(m,'rollback-only benchmark fixture','[{}]'::jsonb,'running',now()+interval '30 minutes',4,60000);
 INSERT INTO public.mission_assignments(id,mission_id,job_key,role,agent_id,instruction,status,lease,lease_until)
 VALUES(j,m,'fixture','work',agent,'fixture only','running',lease_id,now()+interval '10 minutes');
 INSERT INTO public.benchmark_budget_accounts(experiment_id,arm,owner_actor_id,cap_tokens)
 VALUES(exp,'orchestrated',gen_random_uuid(),1000) RETURNING id INTO acct;
 INSERT INTO public.benchmark_mission_bindings(mission_id,account_id,experiment_id,baseline_sha)
 VALUES(m,acct,exp,repeat('a',40));
 r:=public.benchmark_reserve_mission_call(j,lease_id,c1,'fixture',100,true);
 IF r IS NULL THEN RAISE EXCEPTION 'routing admission rejected'; END IF;
 r:=public.benchmark_reserve_mission_call(j,lease_id,c2,'fixture',200,false);
 IF r IS NULL THEN RAISE EXCEPTION 'execution admission rejected'; END IF;
 PERFORM public.benchmark_finish_mission_call(c1,70);
 PERFORM public.benchmark_finish_mission_call(c2,120);
 IF (SELECT spent_tokens FROM public.benchmark_budget_accounts WHERE id=acct)<>190
 OR (SELECT actual_tokens FROM public.agent_missions WHERE id=m)<>190
 OR (SELECT routing_calls FROM public.agent_missions WHERE id=m)<>1
 OR (SELECT calls FROM public.agent_missions WHERE id=m)<>1
 THEN RAISE EXCEPTION 'projection mismatch'; END IF;
 PERFORM public.benchmark_finish_mission_call(c1,70);
 IF (SELECT spent_tokens FROM public.benchmark_budget_accounts WHERE id=acct)<>190
 THEN RAISE EXCEPTION 'replay double charged'; END IF;
 BEGIN PERFORM public.benchmark_finish_mission_call(c1,71);
 EXCEPTION WHEN OTHERS THEN collision:=true; END;
 IF NOT collision THEN RAISE EXCEPTION 'conflicting replay accepted'; END IF;
 c2:=gen_random_uuid();
 r:=public.benchmark_reserve_mission_call(j,lease_id,c2,'fixture',80,false);
 IF r IS NULL THEN RAISE EXCEPTION 'uncertain reserve rejected'; END IF;
 PERFORM public.benchmark_finish_mission_call(c2,NULL);
 IF (SELECT status FROM public.mission_calls WHERE id=c2)<>'uncertain' THEN
  RAISE EXCEPTION 'uncertain hold not preserved'; END IF;
 PERFORM public.benchmark_reconcile_uncertain_mission_call(c2,'fixture-provider','receipt-uncertain-1',55);
 PERFORM public.benchmark_reconcile_uncertain_mission_call(c2,'fixture-provider','receipt-uncertain-1',55);
 IF (SELECT spent_tokens FROM public.benchmark_budget_accounts WHERE id=acct)<>245
 OR (SELECT actual_tokens FROM public.agent_missions WHERE id=m)<>245 THEN
  RAISE EXCEPTION 'uncertain reconciliation mismatch'; END IF;
 collision:=false;
 BEGIN PERFORM public.benchmark_reconcile_uncertain_mission_call(c2,'fixture-provider','receipt-conflict',55);
 EXCEPTION WHEN OTHERS THEN collision:=true; END;
 IF NOT collision THEN RAISE EXCEPTION 'conflicting uncertain receipt accepted'; END IF;
 denied:=public.benchmark_reserve_mission_call(j,gen_random_uuid(),gen_random_uuid(),'fixture',10,true);
 IF denied IS NOT NULL THEN RAISE EXCEPTION 'stale lease allowed'; END IF;
END $$;
ROLLBACK;
