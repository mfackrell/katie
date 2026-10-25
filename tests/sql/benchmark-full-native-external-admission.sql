-- Run after the proposed combined migrations inside BEGIN/ROLLBACK only.
DO $$
declare agent uuid;
 owner uuid; chat uuid; proj uuid:=gen_random_uuid(); mission uuid:=gen_random_uuid();
 job uuid:=gen_random_uuid(); trial uuid; acc uuid; grant_id uuid;
 exp uuid:=gen_random_uuid(); key uuid:=gen_random_uuid(); receipt uuid;
 blocked boolean;
begin
 select id,actor_id into chat,owner from public.chats limit 1;
 if not found then raise exception 'fixture requires existing actor/chat';end if;
 select id into agent from public.managed_agents limit 1;
 if agent is null then raise exception 'fixture requires managed agent';end if;
 insert into public.work_projects(id,request_id,actor_id,chat_id,objective,team,
 status,phase,deadline,approved_hash,approval_hash)
 values(proj,gen_random_uuid()::text,owner,chat,'isolated native accounting fixture',
 ARRAY[agent],'running','development',now()+interval '1 hour',
 repeat('a',64),repeat('a',64));
 insert into public.agent_missions(id,project_id,objective,team,status,deadline,max_calls,token_allowance)
 values(mission,proj,'isolated native accounting fixture','[{}]'::jsonb,'running',
 now()+interval '45 minutes',2,10000);
 update public.work_projects set active_mission_id=mission where id=proj;
 insert into public.mission_assignments(id,mission_id,job_key,role,agent_id,instruction,status)
 values(job,mission,'native-test','development',agent,'nonbillable','waiting_external');
 insert into public.benchmark_three_arm_trials(
 experiment_id,replicate,arm,owner_actor_id,contract_sha256,baseline_sha,
 model_policy_sha256,tool_profile_sha256,acceptance_sha256,runtime_sha256,state)
 values(exp,1,'full',owner,repeat('a',64),repeat('b',40),repeat('c',64),
 repeat('d',64),repeat('e',64),repeat('f',64),'running') returning id into trial;
 insert into public.benchmark_budget_accounts(experiment_id,arm,owner_actor_id,cap_tokens,trial_id)
 values(exp,'full',owner,1000,trial) returning id into acc;
 insert into public.benchmark_mission_bindings(mission_id,account_id,experiment_id,baseline_sha)
 values(mission,acc,exp,repeat('b',40));
 insert into public.benchmark_execution_grants(token_digest,trial_id,account_id,
 owner_actor_id,protocol_digest,repository,model,execution_epoch,deadline,project_id,mission_assignment_id)
 values(repeat('8',64),trial,acc,owner,repeat('1',64),
 'mfackrell/katie','synthetic',1,now()+interval '30 minutes',proj,job)
 returning id into grant_id;
 receipt:=public.benchmark_full_native_reserve(repeat('8',64),trial,1,key::text,'synthetic',20);
 if receipt is null or
 (select legacy_mission_call_id from public.benchmark_budget_calls where id=receipt)<>key
 or (select calls from public.agent_missions where id=mission)<>1
 then raise exception 'full admission failed to link mission and trial';end if;
 perform public.benchmark_reconcile_linked_receipt(key,'fixture','resp-1',15);
 perform public.benchmark_reconcile_linked_receipt(key,'fixture','resp-1',15);
 if (select spent_tokens from public.benchmark_budget_accounts where id=acc)<>15 or
 (select actual_tokens from public.agent_missions where id=mission)<>15
 then raise exception 'full operation charged twice or projection diverged';end if;
 update public.work_projects set status='stopped' where id=proj;
 blocked:=false;
 begin
 perform public.benchmark_full_native_reserve(repeat('8',64),trial,1,
 gen_random_uuid()::text,'synthetic',20);
 exception when others then blocked:=true;end;
 if not blocked then raise exception 'stopped parent admitted more requests';end if;
 if (select calls from public.agent_missions where id=mission)<>1 or
 (select spent_tokens from public.benchmark_budget_accounts where id=acc)<>15
 then raise exception 'denied request mutated accounting';end if;
 raise notice 'FULL_EXTERNAL_MISSION_ATOMIC_PASS';
end $$;
