-- A distinct verified zero-call infrastructure failure can consume the next
-- capability, without changing the owner approval or the prior recovery record.
alter table public.benchmark_startup_recoveries
 drop constraint benchmark_startup_recoveries_approval_id_key,
 drop constraint benchmark_startup_recoveries_task_id_key,
 add column previous_recovery_id uuid references public.benchmark_startup_recoveries(id),
 add constraint benchmark_startup_recovery_task_release_key unique(task_id,release_sha),
 add constraint benchmark_startup_recovery_task_run_key unique(task_id,prior_run);
create index benchmark_startup_recoveries_latest on public.benchmark_startup_recoveries(task_id,created_at desc);

-- Preserve the deployed admission function and all spending/scope checks. This
-- replaces only the former one-recovery-per-approval bound with a linked bound.
do $patch$
declare body text;
begin
 select pg_get_functiondef('public.benchmark_prepare_startup_recovery(uuid,bigint,jsonb,text)'::regprocedure) into body;
 if position('exists(select 1 from benchmark_startup_recoveries where approval_id=a.id)' in body)=0 then
  raise exception 'Startup recovery admission changed; refusing an unverified patch';
 end if;
 body:=replace(body,'r benchmark_startup_recoveries;', 'r benchmark_startup_recoveries; prev benchmark_startup_recoveries;');
 body:=replace(body,'if t.id is null or j.id is null',
  'select * into prev from benchmark_startup_recoveries where task_id=p_task order by created_at desc,id desc limit 1;
 if t.id is null or j.id is null');
 body:=replace(body,'exists(select 1 from benchmark_startup_recoveries where approval_id=a.id)',
  'exists(select 1 from benchmark_startup_recoveries where old_grant_id=g.id or (task_id=t.id and (release_sha=p_release or prior_run=p_run))) or
   (prev.id is null and t.external->>''startupRecoveryId'' is not null) or
   (prev.id is not null and (prev.approval_id<>a.id or prev.release_sha=p_release or p_run<=prev.prior_run or
     t.external->>''startupRecoveryId'' is distinct from prev.id::text or
     not exists(select 1 from benchmark_startup_recovery_grants where recovery_id=prev.id and grant_id=g.id)))');
 body:=replace(body,'old_grant_id,prior_run,release_sha,scope_hash,evidence)', 'old_grant_id,prior_run,release_sha,scope_hash,evidence,previous_recovery_id)');
 body:=replace(body,'''receipt'',p_receipt)) returning * into r;', '''receipt'',p_receipt),prev.id) returning * into r;');
 if position('prev benchmark_startup_recoveries' in body)=0 or position('prev.id) returning * into r' in body)=0 then
  raise exception 'Startup recovery chain patch did not match its deployed structure';
 end if;
 execute body;
end $patch$;
