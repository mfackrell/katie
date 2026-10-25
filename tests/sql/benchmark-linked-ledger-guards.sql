-- Run only after combined ordered migrations, inside rollback.
DO $$
declare m uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); lease_id uuid:=gen_random_uuid();
 exp uuid:=gen_random_uuid(); account uuid; call_id uuid:=gen_random_uuid(); ledger_id uuid;
 agent uuid; rejected boolean; raw_count int;
begin
 select id into agent from public.managed_agents limit 1;
 insert into public.agent_missions(id,objective,team,status,deadline,max_calls,token_allowance)
 values(m,'rollback-only accounting proof','[{}]'::jsonb,'running',now()+interval '20 minutes',4,60000);
 insert into public.mission_assignments(id,mission_id,job_key,role,agent_id,instruction,status,lease,lease_until)
 values(j,m,'fixture','work',agent,'fixture','running',lease_id,now()+interval '10 minutes');
 insert into public.benchmark_budget_accounts(experiment_id,arm,owner_actor_id,cap_tokens)
 values(exp,'orchestrated',gen_random_uuid(),1000) returning id into account;
 insert into public.benchmark_mission_bindings(mission_id,account_id,experiment_id,baseline_sha)
 values(m,account,exp,repeat('a',40));
 ledger_id:=public.benchmark_reserve_mission_call(j,lease_id,call_id,'synthetic',20,false);
 if ledger_id is null then raise exception 'admission rejected';end if;
 if (select legacy_mission_call_id from public.benchmark_budget_calls where id=ledger_id) is distinct from call_id
 then raise exception 'canonical projection not linked';end if;
 rejected:=false;
 begin perform public.benchmark_settle_call(ledger_id,15);exception when others then rejected:=true;end;
 if not rejected then raise exception 'generic settlement mutated linked ledger';end if;
 rejected:=false;
 begin perform public.benchmark_record_overrun(ledger_id,30);exception when others then rejected:=true;end;
 if not rejected then raise exception 'generic overrun mutated linked ledger';end if;
 rejected:=false;
 begin perform public.benchmark_reconcile_receipt(ledger_id,'synthetic','receipt1',15);
 exception when others then rejected:=true;end;
 if not rejected then raise exception 'generic receipt mutated linked ledger';end if;
 perform public.benchmark_finish_mission_call(call_id,15);
 perform public.benchmark_reconcile_linked_receipt(call_id,'fixture','receipt-1',15);
 perform public.benchmark_reconcile_linked_receipt(call_id,'fixture','receipt-1',15);
 if (select spent_tokens from public.benchmark_budget_accounts where id=account)<>15
 or (select actual_tokens from public.agent_missions where id=m)<>15
 then raise exception 'atomic settlement mismatch';end if;
 perform public.benchmark_finish_mission_call(call_id,15);
 if (select spent_tokens from public.benchmark_budget_accounts where id=account)<>15
 then raise exception 'replay double charged';end if;
 rejected:=false;
 begin perform public.benchmark_reconcile_linked_receipt(call_id,'fixture','receipt-2',15);
 exception when others then rejected:=true;end;
 if not rejected then raise exception 'conflicting linked receipt accepted';end if;
 raise notice 'linked guards, atomic settlement, receipt and replay passed';
end $$;