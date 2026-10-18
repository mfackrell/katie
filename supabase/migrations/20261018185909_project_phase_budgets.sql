-- New project phases may use up to 120k tokens within the unchanged aggregate project ceiling.
-- Existing phases, reservations, deadlines and ordinary mission defaults are unchanged.
create or replace function public.finish_work_project(p_id uuid,p_lease uuid,p_action text,p_data jsonb default '{}') returns boolean language plpgsql security invoker set search_path=public as $$ declare p work_projects;mid uuid;kind text;seq integer;contract jsonb;binding jsonb;dev uuid;lead uuid;reviewer uuid;goal text;scope_data jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'running' or p.lease is distinct from p_lease or p.lease_until<=now() or p.deadline<=now() then return false;end if;
 if p_action='child' then
  if p.active_mission_id is not null then raise exception 'A milestone is already bound';end if;
  seq:=(select count(*)+1 from project_runs where project_id=p.id);if seq>p.max_missions then update work_projects set status='blocked',detail='Project milestone allowance exhausted.' where id=p.id;else
   kind:=p_data->>'kind';goal:=p_data->>'objective';if kind is distinct from p.phase or kind not in ('research','specification','development','assessment') or length(goal) not between 1 and 12000 then raise exception 'Invalid project milestone';end if;
   if kind='development' and (p.approved_hash is distinct from p.approval_hash or p.approved_hash is null or p.cycles>=p.max_cycles or p.phase<>'development') then raise exception 'Approved coding allowance required';end if;
   mid:=gen_random_uuid();perform create_mission(mid,goal,p.team,120,case when kind='development' then p.repository_id else null end);
   if length(coalesce((p_data->'evidence')::text,''))>30000 then raise exception 'Project evidence exceeds bounded context; narrow the acceptance package without dropping original requirements';end if;
   update agent_missions set token_allowance=least(120000,p.token_allowance),project_id=p.id,project_kind=kind,project_evidence=p_data->'evidence' where id=mid;perform control_mission(mid,'start');
   if kind='development' then
    contract:=p.spec->'milestones'->p.milestone_index->'contract';if contract is null then raise exception 'Approved milestone contract missing';end if;
    binding:=jsonb_build_object('version',1,'projectId',p.id,'baseSha',coalesce(p.verified_sha,p.baseline_sha),'baselineSha',p.baseline_sha,'allowedPaths',p.spec->'allowedPaths','contractHash',encode(sha256(convert_to(project_canonical(contract),'UTF8')),'hex'),'contract',contract,'scopeHash',p.approved_hash);
    update agent_missions set deadline=p.deadline where id=mid;
    update mission_assignments set status='completed',result='{"output":"Server-owned approved project milestone; no planning inference was claimed."}' where mission_id=mid and job_key='plan';
    lead:=p.team[1];reviewer:=p.team[2];dev:=p.team[3];
    insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload) values(mid,'implement','development',dev,'Implement the approved milestone in the full mission objective. Preserve all previous verified work. Run focused checks and satisfy the approved browser contract. Deliver an isolated draft PR only.','{}','{"capability":"development"}'),(mid,'compose','compose',lead,'Report the actual verified milestone result, draft PR, immutable commit and browser checks concisely. Do not reconstruct code or invent actions.',array['implement'],'{}'),(mid,'review','review',reviewer,'Verify the actual approved milestone against its original scope and immutable external evidence.',array['compose'],'{}');
    update work_projects set cycles=cycles+1 where id=p.id;
   end if;
   insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index,binding) values(p.id,mid,kind,seq,p.milestone_index,binding);
   update work_projects set active_mission_id=mid,detail='Working on '||kind||' milestone.',updated_at=now() where id=p.id;
  end if;
 elsif p_action='spec' then
  if p.verified_sha is not null and p_data->>'baseline' is distinct from p.baseline_sha then raise exception 'Verified cumulative project baseline cannot be replaced by current main';end if;
  if p.phase<>'approval' and not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed') then raise exception 'Reviewed specification required';end if;
  if p.approved_hash is not null then raise exception 'Approved specification is immutable';end if;
  update project_runs set outcome=jsonb_build_object('specification_reviewed',true) where mission_id=p.active_mission_id and outcome is null;
  scope_data:=jsonb_build_object('objective',p.objective,'clarifications',p.clarifications,'spec',p_data->'spec','repository',p.repository_id,'repository_name',(select repository_full_name from repo_sync_runs where id=p.repository_id),'baseline',p_data->>'baseline','max_cycles',p.max_cycles,'max_missions',p.max_missions,'token_allowance',p.token_allowance,'deadline',p.deadline);
  update work_projects set spec=p_data->'spec',repository_full_name=(select repository_full_name from repo_sync_runs where id=p.repository_id),baseline_sha=p_data->>'baseline',approval_hash=encode(sha256(convert_to(project_canonical(scope_data),'UTF8')),'hex'),active_mission_id=null,status=case when repository_id is null then 'awaiting_input' else 'awaiting_approval' end,phase='approval',detail=p_data->>'detail' where id=p.id;
 elsif p_action='advance' then
  if not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed') then raise exception 'Reviewed milestone completion required';end if;
  update project_runs set outcome=p_data where mission_id=p.active_mission_id and outcome is null;
  if p.phase='development' then
   if p_data->>'head'!~'^[a-f0-9]{40}$' or not exists(
    select 1 from mission_assignments j join project_runs r on r.mission_id=j.mission_id where j.mission_id=p.active_mission_id and j.role='development' and j.status='completed'
    and r.binding->>'scopeHash'=p.approved_hash and j.result->'verification'->>'testedHeadSha'=p_data->>'head' and j.result->'verification'->>'reviewedHeadSha'=p_data->>'head'
    and j.result->'verification'->>'observedHeadSha'=p_data->>'head'
    and j.result->'verification'->'projectAcceptance'->>'passed'='true'
    and j.result->'verification'->'projectAcceptance'->>'headSha'=p_data->>'head'
    and j.result->'verification'->'projectAcceptance'->>'contractHash'=r.binding->>'contractHash'
    and j.result->'verification'->'projectAcceptance'->>'projectId'=p.id::text
   ) then raise exception 'Immutable reviewed head and approved browser evidence required';end if;
   update work_projects set verified_sha=p_data->>'head',milestone_index=milestone_index+1,phase=case when milestone_index+1>=jsonb_array_length(spec->'milestones') then 'delivery' else 'development' end,active_mission_id=null,detail='Verified coding increment saved.' where id=p.id;
  elsif p.phase='research' then update work_projects set phase='specification',active_mission_id=null,detail='Research reviewed. Developing the specification.' where id=p.id;
  else raise exception 'Unsupported milestone progression';end if;
 elsif p_action='preview' then
  if p.phase not in ('delivery','assessment') or p_data->>'immutable' is distinct from 'true' or p_data->>'headSha' is distinct from p.verified_sha or not exists(select 1 from project_runs r join agent_missions m on m.id=r.mission_id where r.project_id=p.id and r.kind='development' and m.status='completed' and r.outcome->>'head'=p.verified_sha) then raise exception 'Verified integrated preview required';end if;
  if p.active_mission_id is not null then update project_runs set outcome=jsonb_build_object('superseded',true,'reason','Deployment changed after assessment') where mission_id=p.active_mission_id and outcome is null;end if;
  update work_projects set preview=p_data,phase='browser_check',active_mission_id=null,detail='Same-head deployment found. Running the approved contract against the actual deployed application.' where id=p.id;
 elsif p_action='browser' then
  if p.phase<>'browser_check' or p.preview->>'immutable' is distinct from 'true' or p_data->>'passed' is distinct from 'true' or p_data->>'projectId' is distinct from p.id::text or p_data->>'headSha' is distinct from p.verified_sha or p_data->>'deploymentId' is distinct from p.preview->>'deploymentId' or p_data->>'statusId' is distinct from p.preview->>'statusId' or p_data->>'url' is distinct from p.preview->>'url' or p_data->>'contractHash' is distinct from encode(sha256(convert_to(project_canonical(p.spec->'finalContract'),'UTF8')),'hex') or jsonb_array_length(p_data->'checks') is distinct from jsonb_array_length(p.spec->'finalContract'->'scenarios') or exists(select 1 from jsonb_array_elements(p_data->'checks') with ordinality c(v,n) where c.v->>'passed' is distinct from 'true' or c.v->>'name' is distinct from p.spec->'finalContract'->'scenarios'->(c.n::int-1)->>'name') then raise exception 'Actual deployment-bound final browser acceptance required';end if;
  update work_projects set preview=preview||jsonb_build_object('browserAcceptance',p_data),phase='assessment',detail='Actual deployed browser contract passed. Performing independent whole-project assessment.' where id=p.id;
 elsif p_action='complete' then
  if p.phase<>'assessment' or p.preview->>'immutable' is distinct from 'true' or p.preview->'browserAcceptance'->>'passed' is distinct from 'true' or p.preview->'browserAcceptance'->>'headSha' is distinct from p.verified_sha or p.preview->'browserAcceptance'->>'deploymentId' is distinct from p.preview->>'deploymentId' or p.preview->'browserAcceptance'->>'statusId' is distinct from p.preview->>'statusId' or p.preview->>'headSha' is distinct from p.verified_sha or not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed' and length(result)>0) or exists(select 1 from project_runs r join agent_missions m on m.id=r.mission_id where r.project_id=p.id and r.kind='development' and r.outcome is null and m.status<>'blocked') then raise exception 'Independent integrated project assessment required';end if;
  update project_runs set outcome=p_data where mission_id=p.active_mission_id;update work_projects set status='completed',result=p_data->>'result',detail='Integrated result independently approved and delivered to the original chat.' where id=p.id;
 elsif p_action in ('block','input','retry','wait','error') then
  if p_action='retry' then
   if p.cycles>=p.max_cycles then update work_projects set status='blocked',detail='Project coding-cycle allowance exhausted.' where id=p.id;else
    update project_runs set outcome=p_data where mission_id=p.active_mission_id and outcome is null;
    update work_projects set phase='development',milestone_index=least(milestone_index,jsonb_array_length(spec->'milestones')-1),active_mission_id=null,detail=p_data->>'detail' where id=p.id;
   end if;
  elsif p_action='error' then update work_projects set failures=failures+1,status=case when failures>=2 then 'blocked' else status end,detail=p_data->>'detail' where id=p.id;
  elsif p_action='input' then update work_projects set status='awaiting_input',detail=p_data->>'detail' where id=p.id;
  elsif p_action='block' then update work_projects set status='blocked',detail=p_data->>'detail' where id=p.id;
  else update work_projects set detail=coalesce(p_data->>'detail',detail) where id=p.id;end if;
 else raise exception 'Unknown project outcome';end if;
 insert into project_events(project_id,event,data) values(p.id,p_action,p_data);
 update work_projects set lease=null,lease_until=null,failures=case when p_action='error' then failures else 0 end,updated_at=now() where id=p.id;
 select * into strict p from work_projects where id=p.id;
 if p.status='awaiting_approval' and p.spec is not null then perform project_publish(p.id,project_scope_proposal(p.id));elsif p_action<>'wait' or p.status<>'running' then perform project_publish(p.id,coalesce(p.result,p.detail,p.status));end if;
 return true;
end $$;
