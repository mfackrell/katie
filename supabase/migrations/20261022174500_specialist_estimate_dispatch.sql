-- One durable specialist estimate job per work package and reviewed scope.
CREATE TABLE IF NOT EXISTS public.project_specialist_dispatches (
 project_id uuid NOT NULL REFERENCES public.work_projects(id),
 scope_hash text NOT NULL,
 package_id text NOT NULL,
 specialist text NOT NULL,
 mission_id uuid UNIQUE REFERENCES public.agent_missions(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','completed','blocked')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,scope_hash,package_id)
);
ALTER TABLE public.project_specialist_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_specialist_dispatches FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.project_specialist_dispatches TO service_role;

CREATE OR REPLACE FUNCTION public.dispatch_specialist_resource_estimate()
RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
DECLARE p work_projects; package jsonb; forecast jsonb; ids text[]; k text; specialist_name text; mid uuid;
 charged bigint; goal text; planned jsonb; assigned_team uuid[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 FOR p IN SELECT * FROM work_projects
  WHERE status='awaiting_approval' AND phase='approval' AND spec IS NOT NULL AND approval_hash IS NOT NULL
    AND deadline>now()+interval '30 minutes'
    AND estimate_rationale IS NOT NULL
  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10
 LOOP
  BEGIN forecast:=p.estimate_rationale::jsonb;EXCEPTION WHEN others THEN CONTINUE; END;
  IF forecast->'specialistPlan'->>'independentlySubmitted' IS DISTINCT FROM 'false' THEN CONTINUE; END IF;
  planned:=forecast->'specialistPlan'->'assignments';
  IF jsonb_typeof(planned)<>'array' THEN CONTINUE; END IF;
  -- Do not spend on later estimates while an earlier reviewed specialist
  -- mission is blocked; preserve the blocker for an explicit recovery decision.
  IF EXISTS(SELECT 1 FROM project_specialist_dispatches
    WHERE project_id=p.id AND scope_hash=p.approval_hash AND status='blocked') THEN CONTINUE; END IF;
  SELECT coalesce(sum(greatest(coalesce(actual_tokens,0),coalesce(reserved_tokens,0))),0)
    INTO charged FROM agent_missions WHERE project_id=p.id;
  IF charged+12000>p.token_allowance THEN CONTINUE; END IF;
  FOR package IN SELECT value FROM jsonb_array_elements(planned) LOOP
   k:=package->>'packageId';specialist_name:=package->>'specialist';
   IF k IS NULL OR specialist_name IS NULL THEN CONTINUE; END IF;
   IF EXISTS(SELECT 1 FROM project_specialist_dispatches WHERE project_id=p.id
     AND scope_hash=p.approval_hash AND package_id=k) THEN CONTINUE; END IF;
   -- Do not spawn another specialist until the prior one has concluded.
   IF EXISTS(SELECT 1 FROM project_specialist_dispatches d JOIN agent_missions m ON m.id=d.mission_id
      WHERE d.project_id=p.id AND m.status NOT IN ('completed','blocked','stopped')) THEN CONTINUE; END IF;
   goal:='Independently estimate resources ONLY for work package '||k||
     '. Specialist: '||specialist_name||
     '. Reviewed scope summary: '||left(coalesce(p.spec->>'summary',''),1600)||
     '. Original package estimate: '||left(package::text,1700)||
     '. Return ONLY JSON with specialist, scopeHash, packages:[{packageId,lowerTokens,expectedTokens,upperTokens,basis,dependencies}]. '||
     'ScopeHash='||p.approval_hash||'. Investigate complexity and uncertainty; do not copy baseline numbers without evaluating them. '||
     'Do not code, change project scope, use paid tools, or treat estimates as spending approval.';
   -- Put the relevant saved specialist in the lead position, keeping the
   -- other two actors available for independent planning/review.
   IF cardinality(p.team)<>3 THEN CONTINUE; END IF;
   IF specialist_name IN ('backend','frontend') THEN
     assigned_team:=ARRAY[p.team[3],p.team[1],p.team[2]];
   ELSIF specialist_name IN ('quality_assurance','independent_review') THEN
     assigned_team:=ARRAY[p.team[2],p.team[1],p.team[3]];
   ELSE
     assigned_team:=p.team;
   END IF;
   mid:=gen_random_uuid();
   PERFORM create_mission(mid,goal,assigned_team,30,null);
   UPDATE agent_missions SET project_id=p.id,project_kind='resource_estimate',token_allowance=12000
    WHERE id=mid;
   INSERT INTO project_specialist_dispatches(project_id,scope_hash,package_id,specialist,mission_id,status)
    VALUES(p.id,p.approval_hash,k,specialist_name,mid,'dispatched');
   PERFORM control_mission(mid,'start');
   RETURN jsonb_build_object('projectId',p.id,'missionId',mid,'packageId',k,'specialist',specialist_name);
  END LOOP;
 END LOOP;
 RETURN null;
END $fn$;
REVOKE ALL ON FUNCTION public.dispatch_specialist_resource_estimate() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_specialist_resource_estimate() TO service_role;

-- Store the final executive consolidation separately from the legacy
-- 4,000-character estimate_rationale column; retain the original baseline.
CREATE TABLE IF NOT EXISTS public.project_specialist_consolidations (
 project_id uuid NOT NULL REFERENCES public.work_projects(id),
 scope_hash text NOT NULL,
 plan jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,scope_hash),
 CHECK (jsonb_typeof(plan)='object')
);
ALTER TABLE public.project_specialist_consolidations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_specialist_consolidations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.project_specialist_consolidations TO service_role;

CREATE OR REPLACE FUNCTION public.save_project_specialist_consolidation(
 p_project uuid,p_scope_hash text,p_plan jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path TO 'public' AS $save$
DECLARE p work_projects; package_count integer; recorded_count integer;
BEGIN
 SELECT * INTO p FROM work_projects WHERE id=p_project FOR UPDATE;
 IF NOT FOUND OR p.approval_hash IS DISTINCT FROM p_scope_hash
   OR p.estimate_rationale IS NULL
   OR p_plan->>'kind'<>'reconciled_specialist_resource_forecast'
   OR p_plan->>'independentlySubmitted'<>'true'
   OR jsonb_typeof(p_plan->'assignments')<>'array' THEN RETURN false; END IF;
 package_count:=jsonb_array_length((p.estimate_rationale::jsonb)->'workPackages');
 SELECT count(*) INTO recorded_count FROM project_specialist_estimates
  WHERE project_id=p_project AND scope_hash=p_scope_hash;
 IF package_count=0 OR package_count IS NULL
  OR recorded_count<>package_count
  OR jsonb_array_length(p_plan->'assignments')<>package_count THEN RETURN false; END IF;
 INSERT INTO project_specialist_consolidations(project_id,scope_hash,plan)
 VALUES(p_project,p_scope_hash,p_plan)
 ON CONFLICT(project_id,scope_hash) DO UPDATE
 SET plan=excluded.plan,updated_at=now();
 RETURN true;
END $save$;
REVOKE ALL ON FUNCTION public.save_project_specialist_consolidation(uuid,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_project_specialist_consolidation(uuid,text,jsonb)
 TO service_role;
