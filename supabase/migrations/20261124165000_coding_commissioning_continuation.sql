-- Preserve the existing authority validators and scheduler locks. A successful
-- worker appointment or scope grant is a prerequisite, not package completion.
-- Only the existing provider-controlled approved milestone path is affected.
-- Installing this migration performs no data writes, launch, or authorization.
BEGIN;
DO $patch$
DECLARE body text;anchor text;replacement text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=
     'public.project_org_decide_hierarchy(uuid,uuid,jsonb)'::regprocedure)
     IS DISTINCT FROM 'c14cf5ffe592fd3a866438ec2336495d'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=
     'public.project_org_schedule_hierarchy(uuid,uuid)'::regprocedure)
     IS DISTINCT FROM '7fb42e3d61be37f5ee6562f22ba11f6b'
 THEN RAISE EXCEPTION 'Unexpected installed commissioning hierarchy definitions'; END IF;

 body:=pg_get_functiondef('public.project_org_decide_hierarchy(uuid,uuid,jsonb)'::regprocedure);
 anchor:=$old$ update project_organization_nodes set decision_needed=(kind='project_director' and not project_org_plan_ready(n.id)) where id=n.id;$old$;
 replacement:=anchor||$new$
 -- A separate package command is required after hierarchy changes. Retain
 -- this manager's next decision only after real, accepted worker prework.
 IF project_provider_mode(p.id) AND p.phase='development'
  AND p.approved_hash IS NOT NULL AND p.approved_hash=p.approval_hash
  AND n.kind='manager' AND n.status='active' AND 'development'=ANY(n.tools)
  AND EXISTS(SELECT 1 FROM project_organization_scope_grants g
    WHERE g.node_id=n.id AND g.scope_hash=p.approved_hash AND cardinality(g.paths)>0)
  AND NOT EXISTS(SELECT 1 FROM project_work_packages w
    WHERE w.project_id=p.id AND w.milestone_index=p.milestone_index)
  AND EXISTS(SELECT 1 FROM project_organization_nodes x
    WHERE x.project_id=p.id AND x.parent_id=n.id AND x.kind='worker'
     AND x.status='active' AND 'development'=ANY(x.tools) AND x.deadline>now())
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_commands) cmd WHERE
    (cmd->>'action'='appoint' AND cmd->>'kind'='worker'
      AND ((cmd->'tools')?'development' OR (cmd->'tools')?'analysis'))
    OR (cmd->>'action'='grant_scope' AND EXISTS(
      SELECT 1 FROM project_organization_nodes x
      WHERE x.id::text=cmd->>'nodeId' AND x.project_id=p.id
        AND x.parent_id=n.id AND x.kind='worker' AND 'development'=ANY(x.tools))))
 THEN UPDATE project_organization_nodes SET decision_needed=true WHERE id=n.id; END IF;
$new$;
 IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
 THEN RAISE EXCEPTION 'Unexpected commissioning decision continuation anchor'; END IF;
 EXECUTE replace(body,anchor,replacement);

 body:=pg_get_functiondef('public.project_org_schedule_hierarchy(uuid,uuid)'::regprocedure);
 anchor:=$old$order by case when kind='project_director' and not project_org_plan_ready(id) then 0 else 1 end,case when p.phase='development'$old$;
 replacement:=$new$order by case when kind='project_director' and not project_org_plan_ready(id) then 0 else 1 end,
 -- Before the first/current package exists, service already-pending, scoped
 -- implementation management before QA of a candidate not yet built. Root
 -- prework retains priority. No decision flag, capacity, lease or retry rule
 -- is changed by selection; an unavailable manager is never synthesized.
 case when project_provider_mode(p.id) and p.phase='development'
   and p.approved_hash is not null and p.approved_hash=p.approval_hash
   and not exists(select 1 from project_work_packages pkg where pkg.project_id=p.id and pkg.milestone_index=p.milestone_index)
 then case when kind='project_director' then 0
   when kind='manager' and 'development'=any(tools)
    and exists(select 1 from project_organization_scope_grants g where g.node_id=project_organization_nodes.id and g.scope_hash=p.approved_hash and cardinality(g.paths)>0)
   then 1 else 2 end else 0 end,case when p.phase='development'$new$;
 IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
 THEN RAISE EXCEPTION 'Unexpected commissioning scheduler ordering anchor'; END IF;
 EXECUTE replace(body,anchor,replacement);
END
$patch$;
COMMIT;
