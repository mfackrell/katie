-- A new child is created by the existing DO only after the authenticated owner
-- approved an immutable continuation. Failed missions/attempts remain untouched.
do $patch$
declare body text; anchor text;
begin
 select pg_get_functiondef('public.finish_work_project(uuid,uuid,text,jsonb)'::regprocedure) into body;
 if position('spec_cont benchmark_full_continuations' in body)>0 then return;end if;
 if position('declare spec_checkpoint_data jsonb;' in body)=0 then raise exception 'existing specification lifecycle required';end if;
 body:=replace(body,'declare spec_checkpoint_data jsonb;','declare spec_raw text; spec_feedback text; spec_source_id text; spec_cont benchmark_full_continuations; spec_checkpoint_data jsonb;');
 anchor:=' if action=''child'' and p.phase=''specification'' and payload->>''kind''=''specification'' then';
 if position(anchor in body)=0 then raise exception 'existing specification admission anchor missing';end if;
 body:=replace(body,anchor,$inject$
 if action='child' and payload->'evidence'->>'benchmarkContinuationId' is not null then
  select * into spec_cont from benchmark_full_continuations where id::text=payload->'evidence'->>'benchmarkContinuationId' and project_id=p.id;
  if not found or not benchmark_continuation_live(spec_cont.id,spec_cont.account_id,p.id) or
   spec_cont.plan_hash is distinct from payload->'evidence'->>'benchmarkContinuationPlanHash' or
   payload->>'kind' not in ('specification','development','assessment') then raise exception 'exact live continuation required';end if;
  if p.phase='specification' then
   if exists(select 1 from agent_missions where project_id=p.id and project_kind='specification' and project_evidence->>'benchmarkContinuationId'=spec_cont.id::text) then raise exception 'continuation specification already dispatched';end if;
   spec_required:=90000;spec_future:=180000;
   select coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0) into spec_spent from agent_missions where project_id=p.id;
   if p.token_allowance-spec_spent<270000 or (select count(*) from project_runs where project_id=p.id)+3>p.max_missions then raise exception 'continuation project headroom changed';end if;
   if p.team[2] is null or p.team[2]=p.team[1] then raise exception 'independent reviewer required';end if;
   payload:=jsonb_set(payload,'{evidence}',payload->'evidence'||jsonb_build_object('specificationBudget',jsonb_build_object('version',2,'missionTokens',90000,'futureTokens',180000,'continuationId',spec_cont.id)));
  end if;
 elsif action='child' and exists(select 1 from benchmark_full_continuations where project_id=p.id) then
  raise exception 'continuation project cannot dispatch without explicit continuation identity';
 end if;
 if action='child' and p.phase='specification' and payload->>'kind'='specification' and spec_cont.id is null then
$inject$);
 -- Existing compose/review child creation remains unchanged, including its
 -- independent reviewer and fresh verification requirement.
 anchor:=' if not ok then return false;end if;';
 if position(anchor in body)=0 then raise exception 'existing child completion anchor missing';end if;
 body:=replace(body,anchor,anchor||$inject$
 if action='child' and spec_cont.id is not null then
  update agent_missions set deadline=least(deadline,spec_cont.deadline),
    token_allowance=case project_kind when 'specification' then 90000 when 'development' then 120000 when 'assessment' then 60000 else token_allowance end
  where id=(select active_mission_id from work_projects where id=p.id)
   and project_evidence->>'benchmarkContinuationId'=spec_cont.id::text;
  if not found then raise exception 'continuation child provenance was not persisted';end if;
 end if;
$inject$);
 anchor:='   insert into project_events(project_id,event,data) values(p.id,''specification_recovery_dispatched'',';
 if position(anchor in body)=0 then raise exception 'specification child evidence anchor missing';end if;
 body:=replace(body,anchor,$inject$
   if spec_cont.id is not null then
    select d->>'candidate',d->>'validation_error',d->>'id' into spec_raw,spec_feedback,spec_source_id
     from jsonb_array_elements(coalesce(spec_cont.source_snapshot->'drafts','[]')) d
     where d->>'candidate' is not null order by d->>'created_at' desc,d->>'id' desc limit 1;
    if spec_raw is null then
     select j->'result'->>'rejectedSpecification',j->'result'->>'specificationValidationFeedback',j->>'id'
      into spec_raw,spec_feedback,spec_source_id from jsonb_array_elements(spec_cont.source_snapshot->'assignments') j
      where j->>'role' in ('compose','revise') and j->'result'->>'rejectedSpecification' is not null order by j->>'updated_at' desc,j->>'id' desc limit 1;
    end if;
    if spec_raw is not null then
     update mission_assignments set result=jsonb_build_object('rejectedSpecification',spec_raw,'specificationValidationFeedback',coalesce(spec_feedback,'Saved candidate requires fresh full validation and independent review'),'specificationCharacters',length(spec_raw),'sourceContinuationId',spec_cont.id,'sourceCandidateId',spec_source_id,'sourceCandidateHash',encode(sha256(convert_to(spec_raw,'UTF8')),'hex')) where mission_id=spec_mid and job_key='compose' and status='queued';
    end if;
   end if;
$inject$||anchor);
 execute body;
end $patch$;

create or replace function public.specification_call_capacity(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments; m agent_missions; capacity jsonb; stage_cap integer; spent bigint; version text;
begin
 capacity:=mission_call_capacity(p_id,p_lease);
 select * into j from mission_assignments where id=p_id;
 select * into m from agent_missions where id=j.mission_id;
 version:=m.project_evidence->'specificationBudget'->>'version';
 if capacity->>'authorized' is distinct from 'true' or m.project_kind is distinct from 'specification' or coalesce(version,'') not in ('1','2') then return null;end if;
 if version='2' then
  if not exists(select 1 from benchmark_full_continuations c where c.id::text=m.project_evidence->>'benchmarkContinuationId' and benchmark_continuation_live(c.id,c.account_id,m.project_id)) then return null;end if;
  stage_cap:=case when j.role='compose' then 30000 when j.role='revise' then 24000 when j.role='review' then 18000 else 0 end;
 else stage_cap:=case when j.role='compose' then 30000 when j.role='revise' then 40000 when j.role='review' then 24000 else 0 end;end if;
 select coalesce(sum(case when status='completed' and actual_tokens is not null then actual_tokens else greatest(reserved_tokens,coalesce(actual_tokens,0)) end),0)
 into spent from mission_calls where job_id=j.id;
 return capacity||jsonb_build_object('stageRemainingTokens',greatest(0,stage_cap-spent));
end $$;
