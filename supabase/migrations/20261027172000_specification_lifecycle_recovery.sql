-- Extend the existing completion gate in place. No historical project is resumed,
-- no authorization/accounting record is reset, and no benchmark runtime is changed.
DO $patch$
DECLARE body text; before_child text; after_lifecycle text;
BEGIN
 SELECT pg_get_functiondef('public.finish_work_project(uuid,uuid,text,jsonb)'::regprocedure) INTO body;
 IF position('specification_recovery_dispatched' IN body)>0 THEN RETURN; END IF;
 IF position('declare p work_projects;' IN body)=0 OR position(' if action=''child'' then' IN body)=0
    OR position(' if not ok then return false;end if;' IN body)=0 THEN
   RAISE EXCEPTION 'Specification lifecycle migration requires the existing completion gate';
 END IF;
 body:=replace(body,'declare p work_projects;','declare spec_checkpoint_data jsonb; spec_source mission_assignments; spec_spent bigint; spec_required integer; spec_future integer; spec_milestones integer; spec_hash text; spec_recovery_key text; spec_block text; spec_mid uuid; p work_projects;');
 before_child:=$inject$
 if action='child' and p.phase='specification' and payload->>'kind'='specification' then
  spec_required:=120000; spec_milestones:=1;
  spec_checkpoint_data:=payload->'evidence'->'savedSpecificationCheckpoint';
  if spec_checkpoint_data is not null then
   select j.* into spec_source from mission_assignments j join agent_missions m on m.id=j.mission_id
    where j.id::text=spec_checkpoint_data->>'sourceJobId'
      and m.project_id=p.id and m.project_kind='specification' and j.status='completed'
      and j.role in ('compose','revise')
      and (not (spec_checkpoint_data ? 'text') or j.result->>'text'=spec_checkpoint_data->>'text');
   if not found then raise exception 'Saved specification checkpoint does not belong to this project lineage';end if;
   spec_hash:=encode(sha256(convert_to(project_canonical((spec_source.result->>'text')::jsonb),'UTF8')),'hex');
   if spec_hash is distinct from spec_checkpoint_data->>'fullSpecificationHash' then raise exception 'Saved specification checkpoint hash changed';end if;
   spec_milestones:=jsonb_array_length((spec_source.result->>'text')::jsonb->'milestones');
   if spec_milestones not between 1 and 6 then raise exception 'Saved specification milestone count invalid';end if;
   spec_required:=90000; -- review 24K + revision 40K + final review 24K + routing 2K
   -- Derive equivalence from locked authoritative state, never caller evidence.
   spec_recovery_key:=encode(sha256(convert_to(project_canonical(jsonb_build_object('sourceHash',spec_hash,'objective',p.objective,'clarifications',coalesce(p.clarifications,''))),'UTF8')),'hex');
   if exists(select 1 from project_events where project_id=p.id and event='specification_recovery_dispatched' and data->>'recoveryKey'=spec_recovery_key) then
    spec_block:='This exact saved specification and authoritative requirements already had a recovery attempt. No equivalent work was launched; prior artifacts and charges remain recorded.';
   end if;
  elsif exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id
    where m.project_id=p.id and m.project_kind='specification' and (j.result->>'text' is not null or j.result->>'rejectedSpecification' is not null) and j.role in ('compose','revise')) then
   spec_block:='Saved specification artifacts must be recovered or explicitly diagnosed; blank regeneration is not authorized.';
  end if;
  select coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0) into spec_spent from agent_missions where project_id=p.id;
  spec_future:=(spec_milestones+1)*120000; -- existing child ceiling: development + whole-project assessment
  if spec_block is null and p.token_allowance-spec_spent<spec_required+spec_future then
   spec_block:=format('Mandatory specification stages require %s tokens and remaining development/assessment headroom requires %s; %s remain of %s after %s charged. Owner resource approval is required; no mission was launched.',spec_required,spec_future,greatest(0,p.token_allowance-spec_spent),p.token_allowance,spec_spent);
  end if;
  if spec_block is null and (select count(*) from project_runs where project_id=p.id)+spec_milestones+2>p.max_missions then
   spec_block:='Mandatory specification, development and final assessment require additional mission slots. Owner resource approval is required; no mission was launched.';
  end if;
  if spec_block is not null then
   action:='block';payload:=jsonb_build_object('detail',spec_block,'impediment',jsonb_build_object('kind','blocked','step','specification','impediment',spec_block,
    'attempted',jsonb_build_array('Inspected saved specification lineage, prior attempts and aggregate max(actual,reserved) charges.'),
    'minimumAction','Resolve the recorded artifact/resource blocker and obtain any required owner authorization. Existing scope, charges and deadlines are unchanged.'));
  else
   if p.team[2] is null or p.team[2]=p.team[1] then raise exception 'Independent specification reviewer required';end if;
   payload:=jsonb_set(payload,'{evidence}',coalesce(payload->'evidence','{}')||jsonb_build_object('specificationBudget',jsonb_build_object('version',1,'missionTokens',spec_required,'futureTokens',spec_future,'sourceHash',spec_hash,'recoveryKey',spec_recovery_key)));
  end if;
 end if;
$inject$;
 body:=replace(body,' if action=''child'' then',before_child||E'\n if action=''child'' then');
 after_lifecycle:=$inject$
 if action='child' and p.phase='specification' then
  select active_mission_id into spec_mid from work_projects where id=p.id;
  if spec_mid is not null then
   update agent_missions set token_allowance=spec_required,deadline=least(deadline,p.deadline) where id=spec_mid;
   -- The phase contract is already known. Reuse the normal compose/review/revise
   -- lifecycle without paying another model to invent a task plan or research.
   update mission_assignments set status='completed',result=jsonb_build_object('output','Server-owned specification phase; no planning inference claimed.') where mission_id=spec_mid and job_key='plan';
   insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload) values
    (spec_mid,'compose','compose',p.team[1],'Produce the assigned specification. Reuse the saved checkpoint verbatim when present; preserve the original requirements.','{}','{}'),
    (spec_mid,'review','review',p.team[2],'Independently verify the complete specification against the original requirements, reviewed research and saved findings.',array['compose'],'{}');
   insert into project_events(project_id,event,data) values(p.id,'specification_recovery_dispatched',jsonb_build_object('sourceHash',spec_hash,'recoveryKey',spec_recovery_key,'missionId',spec_mid,'missionTokens',spec_required,'futureTokens',spec_future));
  end if;
 end if;
$inject$;
 body:=replace(body,' if not ok then return false;end if;',' if not ok then return false;end if;'||after_lifecycle);
 EXECUTE body;
END $patch$;

-- Read-only stage accounting includes routing, retries, and uncertain calls.
-- It adds no charge and does not modify the existing authoritative reservation RPCs.
CREATE FUNCTION public.specification_call_capacity(p_id uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j mission_assignments; m agent_missions; capacity jsonb; stage_cap integer; spent bigint;
BEGIN
 capacity:=mission_call_capacity(p_id,p_lease);
 SELECT * INTO j FROM mission_assignments WHERE id=p_id;
 SELECT * INTO m FROM agent_missions WHERE id=j.mission_id;
 IF capacity->>'authorized' IS DISTINCT FROM 'true' OR m.project_kind IS DISTINCT FROM 'specification'
  OR m.project_evidence->'specificationBudget'->>'version' IS DISTINCT FROM '1' THEN RETURN NULL; END IF;
 stage_cap:=CASE WHEN j.role='compose' THEN 30000 WHEN j.role='revise' THEN 40000 WHEN j.role='review' THEN 24000 ELSE 0 END;
 SELECT coalesce(sum(CASE WHEN status='completed' AND actual_tokens IS NOT NULL THEN actual_tokens ELSE greatest(reserved_tokens,coalesce(actual_tokens,0)) END),0)
 INTO spent FROM mission_calls WHERE job_id=j.id;
 RETURN capacity||jsonb_build_object('stageRemainingTokens',greatest(0,stage_cap-spent));
END $$;
REVOKE ALL ON FUNCTION public.specification_call_capacity(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.specification_call_capacity(uuid,uuid) TO service_role;
