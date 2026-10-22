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
 charged bigint; goal text; planned jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 FOR p IN SELECT * FROM work_projects
  WHERE phase='approval' AND spec IS NOT NULL AND approval_hash IS NOT NULL
    AND deadline>now()+interval '30 minutes'
    AND estimate_rationale IS NOT NULL AND status NOT IN ('stopped','completed')
  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10
 LOOP
  BEGIN forecast:=p.estimate_rationale::jsonb;EXCEPTION WHEN others THEN CONTINUE; END;
  IF forecast->'specialistPlan'->>'independentlySubmitted' IS DISTINCT FROM 'false' THEN CONTINUE; END IF;
  planned:=forecast->'specialistPlan'->'assignments';
  IF jsonb_typeof(planned)<>'array' THEN CONTINUE; END IF;
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
   mid:=gen_random_uuid();
   PERFORM create_mission(mid,goal,p.team,30,null);
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
