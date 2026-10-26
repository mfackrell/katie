-- Execute after the proposed migrations within BEGIN/ROLLBACK.
DO $$
declare owner uuid:=gen_random_uuid(); exp uuid:=gen_random_uuid();
 t uuid; a uuid; g uuid; c uuid; denied boolean;
begin
 insert into public.benchmark_three_arm_trials(
 experiment_id,replicate,arm,owner_actor_id,contract_sha256,
 baseline_sha,model_policy_sha256,tool_profile_sha256,acceptance_sha256,runtime_sha256,state)
 values(exp,1,'native',owner,repeat('a',64),repeat('b',40),
 repeat('c',64),repeat('d',64),repeat('e',64),repeat('f',64),'running')
 returning id into t;
 insert into public.benchmark_budget_accounts(
 experiment_id,arm,owner_actor_id,cap_tokens,trial_id)
 values(exp,'native',owner,200,t) returning id into a;
 insert into public.benchmark_execution_grants(
 token_digest,trial_id,account_id,owner_actor_id,protocol_digest,
 repository,model,execution_epoch,deadline)
 values(repeat('9',64),t,a,owner,repeat('1',64),
 'mfackrell/katie','synthetic',1,now()+interval '1 hour')
 returning id into g;
 if not public.benchmark_gateway_execution_live(repeat('9',64),t,1)
 then raise exception 'new grant not live';end if;
 c:=public.benchmark_grant_reserve(repeat('9',64),t,1,'request-000001','synthetic',20);
 if c is null then raise exception 'admission did not create operation';end if;
 if public.benchmark_reconcile_receipt(c,'synthetic','provider-1',15)<>'settled'
 then raise exception 'receipt did not settle';end if;
 if public.benchmark_reconcile_receipt(c,'synthetic','provider-1',15)<>'settled'
 then raise exception 'idempotent receipt rejected';end if;
 if (select spent_tokens from public.benchmark_budget_accounts where id=a)<>15
 then raise exception 'receipt charged more than once';end if;
 denied:=false;
 begin perform public.benchmark_reconcile_receipt(c,'synthetic','provider-other',15);
 exception when others then denied:=true;end;
 if not denied then raise exception 'conflicting receipt accepted';end if;
 update public.benchmark_execution_grants set stopped_at=now() where id=g;
 if public.benchmark_gateway_execution_live(repeat('9',64),t,1)
 then raise exception 'stopped grant remained live';end if;
 denied:=false;
 begin perform public.benchmark_grant_reserve(repeat('9',64),t,1,'request-000002','synthetic',20);
 exception when others then denied:=true;end;
 if not denied then raise exception 'stopped grant admitted spending';end if;
 update public.benchmark_execution_grants set stopped_at=null,
 deadline=now()-interval '1 second' where id=g;
 denied:=false;
 begin perform public.benchmark_grant_reserve(repeat('9',64),t,1,'request-000003','synthetic',20);
 exception when others then denied:=true;end;
 if not denied then raise exception 'expired grant admitted spending';end if;
 raise notice 'CANONICAL_GATEWAY_REAL_POSTGRES_PASS';
end $$;
