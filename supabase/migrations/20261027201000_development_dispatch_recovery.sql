-- Recover the existing assignment/task only. No new project, approval, grant,
-- coding cycle or accounting entry is created by this maintenance operation.
CREATE FUNCTION public.recover_project_development_dispatch(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j mission_assignments; m agent_missions; p work_projects; t agent_tasks; r project_runs;
 a managed_agents; frozen jsonb; reason text; action_needed text; used bigint; recovery_key text;
 attempted boolean; native_bound boolean:=false; source_failure jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 SELECT * INTO j FROM mission_assignments WHERE id=p_id;
 IF NOT FOUND OR j.role<>'development' THEN RETURN false; END IF;
 SELECT * INTO m FROM agent_missions WHERE id=j.mission_id FOR UPDATE;
 SELECT * INTO j FROM mission_assignments WHERE id=p_id FOR UPDATE;
 SELECT * INTO p FROM work_projects WHERE id=m.project_id FOR UPDATE;
 IF NOT FOUND OR p.phase<>'development' OR p.active_mission_id IS DISTINCT FROM m.id OR
   p.status NOT IN ('running','blocked') OR m.status NOT IN ('running','blocked') OR
   (j.status='running' AND j.lease_until>now()) OR j.status NOT IN ('running','failed','queued','waiting_external') THEN RETURN false; END IF;
 SELECT * INTO t FROM agent_tasks WHERE id=j.id FOR UPDATE;
 IF j.status IN ('queued','waiting_external') AND p.status='running' AND m.status='running' AND
   (t.id IS NULL OR t.status IN ('draft','submitted') OR (t.status='dispatching' AND t.external ? 'attempted')) THEN RETURN false; END IF;
 -- Benchmark/native grant recovery belongs to its existing bound dispatcher.
 -- Never convert a possibly admitted native task into a GitHub issue dispatch.
 IF to_regclass('public.benchmark_development_dispatches') IS NOT NULL THEN
  EXECUTE 'select exists(select 1 from public.benchmark_development_dispatches where task_id=$1)' INTO native_bound USING j.id;
  IF native_bound THEN RETURN false; END IF;
 END IF;
 SELECT * INTO r FROM project_runs WHERE mission_id=m.id;
 SELECT * INTO a FROM managed_agents WHERE id=j.agent_id;
 SELECT v INTO frozen FROM jsonb_array_elements(m.team) v WHERE v->>'id'=j.agent_id::text;
 attempted:=coalesce((t.external->>'attempted')::boolean,false);
 source_failure:=coalesce(j.result->'dispatchRecoveryBlocker'->'sourceFailure',jsonb_build_object('detail',j.result->>'detail'));
 recovery_key:=encode(sha256(convert_to(project_canonical(jsonb_build_object('task',j.id,'scope',p.approved_hash,
   'request',t.request_id,'attempted',attempted,'issue',t.external->'issueNumber','receipt',t.external->'receipt',
   'failure',coalesce(t.external->'dispatchFailure',source_failure))),'UTF8')),'hex');
 IF j.status IN ('queued','waiting_external') AND p.status='running' AND m.status='running' AND EXISTS(SELECT 1 FROM project_events WHERE project_id=p.id AND event='development_dispatch_recovered' AND data->>'key'=recovery_key AND created_at=j.updated_at) THEN RETURN false;END IF;
 IF p.deadline<=now() OR m.deadline<=now() THEN reason:='The original project or mission authorization deadline expired.';action_needed:='Obtain an explicit owner deadline authorization for this saved scope; no deadline was extended.';
 ELSIF p.approved_hash IS NULL OR p.approved_hash IS DISTINCT FROM p.approval_hash OR r.binding->>'scopeHash' IS DISTINCT FROM p.approved_hash OR j.payload->>'approved' IS DISTINCT FROM 'true' THEN reason:='The saved scope or development approval is no longer valid.';action_needed:='Obtain approval for the current authoritative scope; the prior approval was not reissued.';
 ELSIF a.id IS NULL OR a.archived OR a.config IS DISTINCT FROM frozen->'config' OR a.version IS DISTINCT FROM (frozen->>'version')::integer OR coalesce((a.config->>'development')::boolean,false)=false THEN reason:='The saved development agent identity or permissions changed.';action_needed:='Restore the approved agent definition or obtain a new explicit scope approval.';
 ELSIF coalesce(length(j.payload->>'development_input'),0)=0 OR m.repository_id IS DISTINCT FROM p.repository_id OR (t.id IS NOT NULL AND (t.kind<>'development' OR t.agent_id<>j.agent_id OR t.snapshot IS DISTINCT FROM frozen->'config' OR t.definition_version IS DISTINCT FROM (frozen->>'version')::integer OR t.initial_input IS DISTINCT FROM j.payload->>'development_input' OR t.input IS DISTINCT FROM t.initial_input OR t.repository_id IS DISTINCT FROM p.repository_id OR t.repository_full_name IS DISTINCT FROM p.repository_full_name)) THEN reason:='The saved task identity, repository or frozen approved input does not match its parent.';action_needed:='Reconcile the conflicting saved task/binding before any execution.';
 ELSIF t.external->'receipt'->>'outcome'='BLOCKED' OR (t.external->'dispatchFailure'->>'kind'='permanent' AND (NOT attempted OR t.external->'dispatchFailure'->>'phase'='reconciliation')) THEN reason:=coalesce(t.details,'The trusted execution receipt records a permanent failure.');action_needed:='Resolve the recorded integration or independent verification failure against the saved checkpoint; another coding dispatch is not authorized.';
 ELSIF EXISTS(SELECT 1 FROM mission_assignments WHERE mission_id=m.id AND id<>j.id AND status='failed') THEN reason:='Another mandatory assignment in this mission remains failed.';action_needed:='Resolve that saved assignment failure before resuming this mission.';
 ELSE
  SELECT coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) INTO used FROM agent_missions WHERE project_id=p.id;
  IF p.token_allowance-used<8000 OR m.token_allowance-greatest(m.actual_tokens,m.reserved_tokens)<8000 OR m.calls>=m.max_calls THEN reason:=format('Insufficient authorized coordination capacity: project %s tokens remain after %s charged; mission %s tokens remain. Uncertain reservations remain charged.',greatest(0,p.token_allowance-used),used,greatest(0,m.token_allowance-greatest(m.actual_tokens,m.reserved_tokens)));action_needed:='Obtain explicit additional resources for this saved scope; no spending records were reset.';
  ELSIF EXISTS(SELECT 1 FROM project_events WHERE project_id=p.id AND event='development_dispatch_recovered' AND data->>'key'=recovery_key) OR (SELECT count(*) FROM project_events WHERE project_id=p.id AND event='development_dispatch_recovered' AND data->>'task'=j.id::text)>=2 THEN reason:='Equivalent dispatch recovery was already attempted or its two-recovery bound is exhausted.';action_needed:='Reconcile the saved execution/checkpoint and precise last failure before authorizing further recovery.';
  ELSIF NOT attempted AND (j.status='failed' OR t.status IN ('blocked','failed')) AND t.external->'dispatchFailure'->>'kind' IS DISTINCT FROM 'transient' AND coalesce(j.result->>'detail',j.detail,'')!~*'timeout|timed out|connection|fetch failed|worker lease expired|429|500|502|503|504' THEN reason:=coalesce(t.details,j.detail,'No evidence supports a safe transient dispatch recovery.');action_needed:='Resolve the recorded failure; automatic repetition of an unclassified failure is not authorized.';
  END IF;
 END IF;
 IF reason IS NOT NULL THEN
  IF j.result->'dispatchRecoveryBlocker'->>'key'=recovery_key THEN UPDATE mission_assignments SET available_at=now()+interval '15 minutes' WHERE id=j.id;RETURN false; END IF;
  UPDATE mission_assignments SET status='failed',lease=null,lease_until=null,available_at=now()+interval '15 minutes',
   result=coalesce(result,'{}')||jsonb_build_object('detail',reason,'dispatchRecoveryBlocker',jsonb_build_object('key',recovery_key,'minimumAction',action_needed,'sourceFailure',source_failure)),detail=reason,updated_at=now() WHERE id=j.id;
  UPDATE agent_missions SET status='blocked',detail=reason,updated_at=now() WHERE id=m.id;
  UPDATE work_projects SET status='blocked',detail=reason,impediment=jsonb_build_object('kind','blocked','step','development','impediment',reason,'attempted',jsonb_build_array('Inspected the saved task, scope, leases, checkpoints and max(actual,reserved) charges.'),'minimumAction',action_needed),lease=null,lease_until=null,updated_at=now() WHERE id=p.id;
  INSERT INTO project_events(project_id,event,data) VALUES(p.id,'development_dispatch_recovery_blocked',jsonb_build_object('task',j.id,'key',recovery_key,'reason',reason,'minimumAction',action_needed));
  RETURN false;
 END IF;
 -- Keep attempts, task/request IDs, approved payload, source receipts, execution
 -- marker and all calls/reservations intact. A fresh fenced worker only polls
 -- after attempted=true; it cannot submit a second issue.
 IF t.id IS NOT NULL THEN UPDATE agent_tasks SET status=CASE WHEN status='ready' THEN 'ready' WHEN attempted THEN 'dispatching' WHEN status='draft' THEN 'draft' ELSE 'dispatching' END,updated_at=now() WHERE id=t.id; END IF;
 UPDATE mission_assignments SET status='waiting_external',lease=null,lease_until=null,available_at=now(),updated_at=now() WHERE id=j.id;
 UPDATE agent_missions SET status='running',updated_at=now() WHERE id=m.id;
 UPDATE work_projects SET status='running',lease=null,lease_until=null,impediment=null,detail='Resuming the same approved development task from saved dispatch evidence; prior charges remain recorded.',updated_at=now() WHERE id=p.id;
 INSERT INTO project_events(project_id,event,data) VALUES(p.id,'development_dispatch_recovered',jsonb_build_object('task',j.id,'key',recovery_key,'reconcileOnly',attempted,'mission',m.id,'scope',p.approved_hash));
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.recover_project_development_dispatch(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.recover_project_development_dispatch(uuid) TO service_role;

-- The existing cron already calls this bounded maintenance RPC. Recover first,
-- then let claim_mission_work acquire a fresh lease through its normal limits.
CREATE OR REPLACE FUNCTION public.project_dispatch_recovery_candidates() RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE row record;
BEGIN
 FOR row IN SELECT j.id FROM mission_assignments j JOIN agent_missions m ON m.id=j.mission_id
 JOIN work_projects p ON p.id=m.project_id LEFT JOIN agent_tasks t ON t.id=j.id
 WHERE j.role='development' AND j.available_at<=now() AND p.phase='development' AND p.active_mission_id=m.id
 AND p.status IN ('running','blocked') AND (j.status='failed' OR (j.status='running' AND j.lease_until<=now()) OR
   (j.status IN ('queued','waiting_external') AND (m.status='blocked' OR p.status='blocked' OR t.status IN ('blocked','ready') OR (t.status='dispatching' AND NOT (t.external ? 'attempted')))))
 ORDER BY j.updated_at LIMIT 20 LOOP
  PERFORM recover_project_development_dispatch(row.id);
 END LOOP;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM
  (SELECT id,external FROM agent_tasks WHERE status IN ('submitted','dispatching') AND external ? 'projectId' ORDER BY updated_at LIMIT 20) t);
END $$;

-- Strengthen the existing generic final POST admission in place. This is not a
-- new grant and does not alter benchmark/native admission or settlement.
DO $patch$
DECLARE body text;
BEGIN
 SELECT pg_get_functiondef('public.claim_project_dispatch(uuid,uuid,text)'::regprocedure) INTO body;
 body:=replace(body,'update agent_tasks set external=jsonb_build_object(''attempted'',true,''projectId'',p.id)',
  'if m.calls>=m.max_calls or greatest(m.actual_tokens,m.reserved_tokens)+8000>m.token_allowance or (select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) from agent_missions where project_id=p.id)+8000>p.token_allowance then return false;end if;
 update agent_tasks set external=external||jsonb_build_object(''attempted'',true,''projectId'',p.id,''dispatchStartedAt'',now())');
 IF position('dispatchStartedAt' IN body)=0 OR position('m.calls>=m.max_calls' IN body)=0 THEN RAISE EXCEPTION 'Generic dispatch admission patch did not match the existing durable interface';END IF;
 EXECUTE body;
END $patch$;

-- Persist a mission worker's external observation only while its exact lease is
-- live. A lost worker cannot overwrite a newer task/checkpoint after recovery.
CREATE FUNCTION public.save_project_development_dispatch(p_id uuid,p_lease uuid,p_status text,p_detail text,p_external jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j mission_assignments; m agent_missions; p work_projects; t agent_tasks;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 SELECT * INTO j FROM mission_assignments WHERE id=p_id;
 SELECT * INTO m FROM agent_missions WHERE id=j.mission_id FOR UPDATE;
 SELECT * INTO j FROM mission_assignments WHERE id=p_id FOR UPDATE;
 SELECT * INTO p FROM work_projects WHERE id=m.project_id FOR UPDATE;
 SELECT * INTO t FROM agent_tasks WHERE id=p_id FOR UPDATE;
 IF j.id IS NULL OR t.id IS NULL OR j.role<>'development' OR j.status<>'running' OR j.lease IS DISTINCT FROM p_lease OR j.lease_until<=now()
 OR m.status<>'running' OR m.deadline<=now() OR p.status<>'running' OR p.active_mission_id IS DISTINCT FROM m.id OR p.deadline<=now()
 OR p.approved_hash IS NULL OR p.approved_hash IS DISTINCT FROM p.approval_hash
 OR NOT EXISTS(SELECT 1 FROM project_runs WHERE mission_id=m.id AND binding->>'scopeHash'=p.approved_hash)
 OR j.payload->>'approved' IS DISTINCT FROM 'true' OR t.kind<>'development' OR t.agent_id<>j.agent_id
 OR t.initial_input IS DISTINCT FROM j.payload->>'development_input' OR t.input IS DISTINCT FROM t.initial_input
 OR t.repository_id IS DISTINCT FROM p.repository_id OR t.repository_full_name IS DISTINCT FROM p.repository_full_name
 OR t.snapshot IS DISTINCT FROM (SELECT v->'config' FROM jsonb_array_elements(m.team) v WHERE v->>'id'=j.agent_id::text) THEN RETURN 'false'::jsonb; END IF;
 IF p_status NOT IN ('dispatching','submitted','ready','blocked') OR jsonb_typeof(p_external)<>'object' THEN RAISE EXCEPTION 'Invalid dispatch observation'; END IF;
 -- The POST marker can be added only by existing claim_project_dispatch.
 IF t.external->'attempted' IS DISTINCT FROM p_external->'attempted' THEN RAISE EXCEPTION 'Dispatch attempt marker is immutable'; END IF;
 IF t.external ? 'issueNumber' AND t.external->'issueNumber' IS DISTINCT FROM p_external->'issueNumber' THEN RAISE EXCEPTION 'Accepted issue identity is immutable'; END IF;
 UPDATE agent_tasks SET status=p_status,details=p_detail,external=p_external,updated_at=now() WHERE id=t.id RETURNING * INTO t;
 RETURN to_jsonb(t);
END $$;
REVOKE ALL ON FUNCTION public.save_project_development_dispatch(uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_project_development_dispatch(uuid,uuid,text,text,jsonb) TO service_role;
