-- No rows are provisioned by migration. Only the authenticated owner workflow
-- may invoke these service-only transactions; model/chat calls have no access.
create table public.benchmark_production_transfer_claims (
 issue integer primary key check(issue=715),
 experiment_id uuid not null unique,
 owner_id uuid not null,
 receipt jsonb not null,
 created_at timestamptz not null default now()
);
create table public.benchmark_production_qualifications (
 issue integer primary key check(issue=715),
 experiment_id uuid not null unique,
 owner_id uuid not null,
 actor_id uuid not null references public.actors(id),
 transfer jsonb not null,
 protocol jsonb not null,
 owner_run_id text not null,
 commit_sha text not null check(commit_sha ~ '^[0-9a-f]{40}$'),
 deadline timestamptz not null,
 revoked_at timestamptz,
 created_at timestamptz not null default now()
);
alter table public.benchmark_production_transfer_claims enable row level security;
alter table public.benchmark_production_qualifications enable row level security;
revoke all on public.benchmark_production_transfer_claims,public.benchmark_production_qualifications from public,anon,authenticated;
grant select,insert,update on public.benchmark_production_transfer_claims,public.benchmark_production_qualifications to service_role;

-- Serializes against transfer: a staged paid bootstrap cannot create its
-- replicate after the same authorization has been claimed for production.
create function public.benchmark_fence_transferred_trial() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if exists(select 1 from public.benchmark_production_transfer_claims c where
    new.baseline_sha='0015bcdb8ac9ad94b7c74d1a4cd76737903b1319' or
    new.experiment_id=c.experiment_id or (tg_op='UPDATE' and old.experiment_id=c.experiment_id)) then
  raise exception 'Benchmark 715 paid authorization transferred to production';
 end if;
 if exists(select 1 from public.benchmark_production_qualifications q where
    (new.experiment_id=q.experiment_id or (tg_op='UPDATE' and old.experiment_id=q.experiment_id) or
     new.baseline_sha='0015bcdb8ac9ad94b7c74d1a4cd76737903b1319') and
    (new.experiment_id<>q.experiment_id or new.replicate<>2 or new.owner_actor_id<>q.actor_id or
     new.baseline_sha<>q.protocol->>'baselineSha' or new.contract_sha256<>q.protocol->>'contract_sha256' or
     new.acceptance_sha256<>q.protocol->>'acceptance_sha256' or new.model_policy_sha256<>q.protocol->>'model_policy_sha256' or
     new.tool_profile_sha256<>q.protocol->>'tool_profile_sha256' or new.runtime_sha256<>q.protocol->>'runtime_sha256')) then
  raise exception 'Production authorization cannot create replacement trials';
 end if;
 return new;
end $$;
create trigger benchmark_fence_transferred_trial before insert or update of experiment_id,replicate,owner_actor_id,baseline_sha,contract_sha256,acceptance_sha256,model_policy_sha256,tool_profile_sha256,runtime_sha256 on public.benchmark_three_arm_trials
for each row execute function public.benchmark_fence_transferred_trial();
revoke all on function public.benchmark_fence_transferred_trial() from public,anon,authenticated;

create function public.benchmark_claim_production_transfer(
 p_owner uuid,p_run text,p_sha text,p_authorization_sha text,p_protocol jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare t public.benchmark_three_arm_trials; receipt jsonb; exp uuid; cnt integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if p_owner is null or p_run is null or p_run !~ '^[0-9]+$' or
    p_sha is null or p_sha !~ '^[0-9a-f]{40}$' or
    p_authorization_sha is distinct from 'e0b257a0e3045d649c6ac64b982c993585bea727b741f4b2ccea365cbbb60214' or
    p_protocol is distinct from '{"baselineSha": "0015bcdb8ac9ad94b7c74d1a4cd76737903b1319", "contract_sha256": "24b651ad3cd732adb12f870002b180e3aa3dcaf365f49bb1d98a4566638211e6", "acceptance_sha256": "fd8617b33401b6d0361b5d7b92db0c3a212e3dfd8e9ff64fdf5cc56a596701b0", "model_policy_sha256": "1e538a292ce934ddc688e0c50e1b7b3a8e639904508812e9c49e3ffb8a0078ca", "tool_profile_sha256": "45eb9a35b7570b137febcc0535f367b46b3501127ff50043453e473e3aa091fb", "runtime_sha256": "5466fa42c7a2f3e62efa09a23b7cabd83ef60f249ab38e51916ffc637ae4d5be", "contract": {"sourceIssue": 650, "baselineSha": "0015bcdb8ac9ad94b7c74d1a4cd76737903b1319", "initialStones": 11, "firstPlayer": "A", "legalMoves": [1, 2, 3], "lastMoveWins": true, "invalidActionPreservesState": true, "persistentReload": true, "resetPersists": true, "directory": "app/project-pilots/take-eleven/", "tests": "tests/game-development/take-eleven.test.mjs", "productionPublication": false}, "acceptance": ["initial-state", "legal-moves", "alternating-turns", "invalid-unchanged", "a-wins", "b-wins", "reload-in-progress", "reload-finished", "reset-and-reload", "accessible-controls", "private-preview", "independent-review"]}'::jsonb then
  raise exception 'Owner production transfer evidence mismatch';
 end if;
 select c.receipt into receipt from public.benchmark_production_transfer_claims c
  where c.issue=715 and c.owner_id=p_owner;
 if found then return receipt; end if;
 if exists(select 1 from public.benchmark_production_transfer_claims) or
    exists(select 1 from public.benchmark_production_qualifications) then
  raise exception 'Conflicting benchmark authorization';
 end if;
 select * into t from public.benchmark_three_arm_trials where arm='native' and replicate=1;
 if not found then raise exception 'Staging qualification missing';end if;
 exp:=t.experiment_id;
 -- Admission locks accounts, so lock them before reading any usage receipts.
 perform 1 from public.benchmark_budget_accounts order by id for update;
 select count(*) into cnt from public.benchmark_three_arm_trials;
 if cnt<>3 or exists(select 1 from public.benchmark_three_arm_trials x where
  x.experiment_id<>exp or x.replicate<>1 or x.owner_actor_id<>t.owner_actor_id or
  x.baseline_sha<>p_protocol->>'baselineSha' or x.contract_sha256<>p_protocol->>'contract_sha256' or
  x.acceptance_sha256<>p_protocol->>'acceptance_sha256' or x.model_policy_sha256<>p_protocol->>'model_policy_sha256' or
  x.tool_profile_sha256<>p_protocol->>'tool_profile_sha256' or x.runtime_sha256<>p_protocol->>'runtime_sha256' or
  x.state<>(case when x.arm='full' then 'planned' else 'running' end)) then
  raise exception 'Staging paid trial or protocol conflict';
 end if;
 select count(*) into cnt from public.benchmark_budget_accounts;
 if cnt<>3 or exists(select 1 from public.benchmark_budget_accounts a where
  a.experiment_id<>exp or a.cap_tokens<>350000 or a.frozen_at is not null or
  a.spent_tokens<>(case when a.arm='full' then 0 else 20 end) or
  not exists(select 1 from public.benchmark_three_arm_trials x where x.id=a.trial_id and x.arm=a.arm)) then
  raise exception 'Staging paid account or spending conflict';
 end if;
 select count(*) into cnt from public.benchmark_budget_calls;
 if cnt<>8 or exists(select 1 from public.benchmark_budget_calls c where
  c.state<>'settled' or c.provider_namespace is distinct from 'nonbillable-synthetic-fixture' or c.actual_tokens is distinct from 5) then
  raise exception 'Staging paid or uncertain provider receipts';
 end if;
 select count(*) into cnt from public.benchmark_native_spending_approvals;
 if cnt<>2 or exists(select 1 from public.benchmark_native_spending_approvals a where
  a.owner_id<>p_owner or a.actor_id<>t.owner_actor_id or a.consumed_at is null or a.revoked_at is not null) or
  exists(select 1 from public.benchmark_execution_grants where deadline>now() and revoked_at is null and stopped_at is null) then
  raise exception 'Staging owner authority or live grant conflict';
 end if;
 receipt:=jsonb_build_object('issue',715,'experimentId',exp,'ownerGithubId',203683423,
  'authorizationCommentId',6424150566,'authorizationBodySha256',p_authorization_sha,
  'sourceDatabase','https://iytvavgbaainnsrecmcx.supabase.co',
  'destinationDatabase','https://barclcqataqyvifoeyop.supabase.co',
  'ownerRunId',p_run,'commitSha',p_sha,'protocol',p_protocol,
  'claimedAt',now(),'deadline',now()+interval '4 hours');
 insert into public.benchmark_production_transfer_claims(issue,experiment_id,owner_id,receipt)
 values(715,exp,p_owner,receipt);
 update public.benchmark_budget_accounts set frozen_at=now() where experiment_id=exp;
 return receipt;
end $$;
revoke all on function public.benchmark_claim_production_transfer(uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.benchmark_claim_production_transfer(uuid,text,text,text,jsonb) to service_role;

create function public.benchmark_qualify_production_owner(
 p_owner uuid,p_actor uuid,p_run text,p_sha text,p_transfer jsonb,p_protocol jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare q public.benchmark_production_qualifications; exp uuid; arm_name text; tid uuid;
 result jsonb; price public.model_registry; expires timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if p_owner is null or p_actor is null or not exists(select 1 from public.actors where id=p_actor) or
    p_run is null or p_run !~ '^[0-9]+$' or p_sha is null or p_sha !~ '^[0-9a-f]{40}$' or
    p_protocol is distinct from '{"baselineSha": "0015bcdb8ac9ad94b7c74d1a4cd76737903b1319", "contract_sha256": "24b651ad3cd732adb12f870002b180e3aa3dcaf365f49bb1d98a4566638211e6", "acceptance_sha256": "fd8617b33401b6d0361b5d7b92db0c3a212e3dfd8e9ff64fdf5cc56a596701b0", "model_policy_sha256": "1e538a292ce934ddc688e0c50e1b7b3a8e639904508812e9c49e3ffb8a0078ca", "tool_profile_sha256": "45eb9a35b7570b137febcc0535f367b46b3501127ff50043453e473e3aa091fb", "runtime_sha256": "5466fa42c7a2f3e62efa09a23b7cabd83ef60f249ab38e51916ffc637ae4d5be", "contract": {"sourceIssue": 650, "baselineSha": "0015bcdb8ac9ad94b7c74d1a4cd76737903b1319", "initialStones": 11, "firstPlayer": "A", "legalMoves": [1, 2, 3], "lastMoveWins": true, "invalidActionPreservesState": true, "persistentReload": true, "resetPersists": true, "directory": "app/project-pilots/take-eleven/", "tests": "tests/game-development/take-eleven.test.mjs", "productionPublication": false}, "acceptance": ["initial-state", "legal-moves", "alternating-turns", "invalid-unchanged", "a-wins", "b-wins", "reload-in-progress", "reload-finished", "reset-and-reload", "accessible-controls", "private-preview", "independent-review"]}'::jsonb or
    p_transfer->'protocol' is distinct from p_protocol or
    p_transfer->>'authorizationBodySha256' is distinct from 'e0b257a0e3045d649c6ac64b982c993585bea727b741f4b2ccea365cbbb60214' or
    p_transfer->>'authorizationCommentId' is distinct from '6424150566' or
    p_transfer->>'ownerGithubId' is distinct from '203683423' or
    p_transfer->>'issue' is distinct from '715' or
    p_transfer->>'sourceDatabase' is distinct from 'https://iytvavgbaainnsrecmcx.supabase.co' or
    p_transfer->>'destinationDatabase' is distinct from 'https://barclcqataqyvifoeyop.supabase.co' then
  raise exception 'Production owner qualification evidence mismatch';
 end if;
 exp:=(p_transfer->>'experimentId')::uuid;
 expires:=(p_transfer->>'deadline')::timestamptz;
 if exp is null or expires is null then raise exception 'Transfer identity missing';end if;
 select * into q from public.benchmark_production_qualifications where issue=715;
 if found then
  if q.experiment_id<>exp or q.owner_id<>p_owner or q.actor_id<>p_actor or q.transfer<>p_transfer then
   raise exception 'Production qualification already belongs to another authority';
  end if;
 else
  if exists(select 1 from public.benchmark_three_arm_trials) or
     exists(select 1 from public.benchmark_budget_accounts) or
     exists(select 1 from public.benchmark_production_transfer_claims) or
     expires<=now() or expires>now()+interval '4 hours' then
   raise exception 'Production allowance already exists or expired';
  end if;
  select * into price from public.model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
  if not found or price.pricing_status<>'verified' or price.pricing_verified_at is null or
     price.pricing_verified_at<now()-interval '24 hours' or
     price.pricing_input_per_1m is null or price.pricing_output_per_1m is null or
     price.pricing_input_per_1m<=0 or price.pricing_output_per_1m<=0 or
     price.pricing_input_per_1m>28 or price.pricing_output_per_1m>28 then
   raise exception 'Production conservative dollar bound unavailable';
  end if;
  insert into public.benchmark_production_qualifications(issue,experiment_id,owner_id,actor_id,
   transfer,protocol,owner_run_id,commit_sha,deadline)
  values(715,exp,p_owner,p_actor,p_transfer,p_protocol,p_run,p_sha,expires);
  foreach arm_name in array array['native','thin','full'] loop
   insert into public.benchmark_three_arm_trials(experiment_id,replicate,arm,owner_actor_id,
    baseline_sha,contract_sha256,acceptance_sha256,model_policy_sha256,tool_profile_sha256,runtime_sha256,state)
   values(exp,2,arm_name,p_actor,p_protocol->>'baselineSha',p_protocol->>'contract_sha256',
    p_protocol->>'acceptance_sha256',p_protocol->>'model_policy_sha256',p_protocol->>'tool_profile_sha256',
    p_protocol->>'runtime_sha256','qualified') returning id into tid;
   insert into public.benchmark_budget_accounts(experiment_id,trial_id,arm,owner_actor_id,cap_tokens,spent_tokens)
   values(exp,tid,arm_name,p_actor,350000,0);
  end loop;
 end if;
 select jsonb_build_object('issue',715,'experimentId',exp,'replicate',2,
  'ownerRunId',x.owner_run_id,'commitSha',x.commit_sha,'deadline',x.deadline,
  'actorId',x.actor_id,'tokenCapPerArm',350000,'usdCapPerArm',10,'totalUsdCap',30,
  'productionPublicationAllowed',false,'taskApprovalGranted',false,
  'arms',(select jsonb_agg(jsonb_build_object('arm',t.arm,'trialId',t.id,'accountId',a.id,
   'spentTokens',a.spent_tokens,'state',t.state) order by t.arm)
    from public.benchmark_three_arm_trials t join public.benchmark_budget_accounts a on a.trial_id=t.id
    where t.experiment_id=exp and t.replicate=2)) into result
 from public.benchmark_production_qualifications x where x.issue=715;
 return result;
end $$;
revoke all on function public.benchmark_qualify_production_owner(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.benchmark_qualify_production_owner(uuid,uuid,text,text,jsonb,jsonb) to service_role;

-- Additional limits only for production-qualified accounts. Existing staging
-- qualification and all unrelated production account behavior stay unchanged.
create function public.benchmark_production_account_guard() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 if exists(select 1 from public.benchmark_production_transfer_claims where experiment_id=new.experiment_id) and
    (tg_op='INSERT' or new.frozen_at is null or new.cap_tokens<>old.cap_tokens or new.spent_tokens<>old.spent_tokens) then
  raise exception 'Transferred staging account is immutable';
 end if;
 if exists(select 1 from public.benchmark_production_qualifications where experiment_id=new.experiment_id) and
   (new.cap_tokens<>350000 or new.arm not in ('native','thin','full') or new.spent_tokens<0) then
  raise exception 'Production benchmark cap is immutable';
 end if;
 return new;
end $$;
create trigger benchmark_production_account_guard before insert or update on public.benchmark_budget_accounts
for each row execute function public.benchmark_production_account_guard();
revoke all on function public.benchmark_production_account_guard() from public,anon,authenticated;

create function public.benchmark_production_call_guard() returns trigger
language plpgsql security invoker set search_path=public as $$
declare a public.benchmark_budget_accounts; q public.benchmark_production_qualifications;
 price public.model_registry; held bigint;
begin
 select * into a from public.benchmark_budget_accounts where id=new.account_id for update;
 if exists(select 1 from public.benchmark_production_transfer_claims where experiment_id=a.experiment_id) then
  raise exception 'Staging allowance has transferred';
 end if;
 select * into q from public.benchmark_production_qualifications where experiment_id=a.experiment_id;
 if not found then return new;end if;
 select * into price from public.model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 if q.revoked_at is not null or q.deadline<=now() or a.frozen_at is not null or a.cap_tokens<>350000 or
    new.model not in ('gpt-5.3-codex','openai:gpt-5.3-codex') or
    new.reserved_tokens is null or new.reserved_tokens<=0 or
    price.model_id is null or price.pricing_status<>'verified' or price.pricing_verified_at is null or
    price.pricing_verified_at<now()-interval '24 hours' or
    price.pricing_input_per_1m is null or price.pricing_output_per_1m is null or
    price.pricing_input_per_1m<=0 or price.pricing_output_per_1m<=0 or
    price.pricing_input_per_1m>28 or price.pricing_output_per_1m>28 or
    exists(select 1 from public.benchmark_budget_calls where account_id=a.id and state in ('unresolved','overrun')) then
  raise exception 'Production benchmark admission denied';
 end if;
 select coalesce(sum(reserved_tokens),0) into held from public.benchmark_budget_calls
 where account_id=a.id and state='reserved';
 if a.spent_tokens+held+new.reserved_tokens>350000 then
  raise exception 'Production benchmark budget exhausted';
 end if;
 return new;
end $$;
create trigger benchmark_production_call_guard before insert on public.benchmark_budget_calls
for each row execute function public.benchmark_production_call_guard();
revoke all on function public.benchmark_production_call_guard() from public,anon,authenticated;

-- Read-only prepare used before the source transfer starts its fixed deadline.
create function public.benchmark_prepare_production_owner(p_owner uuid,p_actor uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
declare price public.model_registry;
begin
 if p_owner is null or p_actor is null or not exists(select 1 from public.actors where id=p_actor) or
    exists(select 1 from public.benchmark_production_transfer_claims) or
    exists(select 1 from public.benchmark_production_qualifications where owner_id<>p_owner or actor_id<>p_actor) or
    (not exists(select 1 from public.benchmark_production_qualifications) and
     (exists(select 1 from public.benchmark_budget_accounts) or exists(select 1 from public.benchmark_three_arm_trials))) then
  raise exception 'Production identity or ledger preflight refused';
 end if;
 select * into price from public.model_registry where provider_name='openai' and model_id='gpt-5.3-codex';
 if not found or price.pricing_status<>'verified' or price.pricing_verified_at is null or
    price.pricing_verified_at<now()-interval '24 hours' or
    price.pricing_input_per_1m is null or price.pricing_output_per_1m is null or
    price.pricing_input_per_1m<=0 or price.pricing_output_per_1m<=0 or
    price.pricing_input_per_1m>28 or price.pricing_output_per_1m>28 then
  raise exception 'Production conservative dollar bound unavailable';
 end if;
 return true;
end $$;
revoke all on function public.benchmark_prepare_production_owner(uuid,uuid) from public,anon,authenticated;
grant execute on function public.benchmark_prepare_production_owner(uuid,uuid) to service_role;
