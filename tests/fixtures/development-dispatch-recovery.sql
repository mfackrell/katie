DO $test$
#variable_conflict use_variable
DECLARE actor uuid:=gen_random_uuid(); chat uuid:=gen_random_uuid(); pid uuid:=gen_random_uuid(); repo uuid;
 p work_projects; mid uuid; jid uuid; lease uuid:=gen_random_uuid(); task jsonb; call_id uuid:=gen_random_uuid();
 clone_actor uuid; clone_chat uuid; clone_pid uuid; clone_mid uuid; clone_jid uuid; idx integer;
 before_charges jsonb; claim jsonb; original_request text; variant text; events_before integer;
BEGIN
 INSERT INTO actors(id,name,system_prompt) VALUES(actor,'Dispatch recovery fixture','Controlled offline fixture');
 INSERT INTO chats(id,actor_id,title) VALUES(chat,actor,'Dispatch recovery fixture');
 SELECT id INTO repo FROM repo_sync_runs WHERE repository_full_name='owner/repo' LIMIT 1;
 IF repo IS NULL THEN RAISE EXCEPTION 'Registered isolated repository fixture required';END IF;
 PERFORM create_game_work_project(pid,'dispatch-recovery-'||pid,actor,chat,'Recover the original approved Take Eleven development task',repo);
 UPDATE work_projects SET status='running',phase='development',spec=current_setting('katie.test.saved_spec')::jsonb,
 repository_full_name='owner/repo',baseline_sha=repeat('a',40),approval_hash=repeat('b',64),approved_hash=repeat('b',64),
 token_allowance=600000,max_missions=14,deadline=now()+interval '3 hours',lease=lease,lease_until=now()+interval '5 minutes' WHERE id=pid;
 SELECT * INTO p FROM work_projects WHERE id=pid;
 IF NOT finish_work_project(pid,lease,'child',jsonb_build_object('kind','development','objective',p.objective,'evidence','{}'::jsonb)) THEN RAISE EXCEPTION 'Approved development fixture failed';END IF;
 SELECT active_mission_id INTO mid FROM work_projects WHERE id=pid;
 SELECT id INTO jid FROM mission_assignments WHERE mission_id=mid AND role='development';
 UPDATE mission_assignments SET status='running',lease=lease,lease_until=now()+interval '5 minutes',attempts=2,
 payload=payload||jsonb_build_object('approved',true,'development_input','Implement the original approved Take Eleven scope and browser contract.') WHERE id=jid;
 task:=mission_development_task(jid,lease); original_request:=task->>'request_id';
 UPDATE agent_tasks SET status='dispatching' WHERE id=jid;
 IF NOT reserve_mission_call(jid,lease,call_id,'fixture:uncertain-provider-charge',4000) THEN RAISE EXCEPTION 'Uncertain call not admitted';END IF;
 PERFORM finish_mission_call(call_id,null);
 SELECT jsonb_build_object('missions',(SELECT jsonb_agg(jsonb_build_array(id,actual_tokens,reserved_tokens,calls) ORDER BY id) FROM agent_missions WHERE project_id=pid),'calls',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM mission_calls c WHERE job_id=jid)) INTO before_charges;
 IF recover_project_development_dispatch(jid) THEN RAISE EXCEPTION 'Live worker preempted';END IF;
 -- Simulate a lost worker at its persisted pre-POST task, retaining two old attempts.
 UPDATE mission_assignments SET lease_until=now()-interval '1 second' WHERE id=jid;
 -- Twenty older permanent blockers must not starve this new stranded task.
 FOR idx IN 1..20 LOOP
  clone_actor:=gen_random_uuid();clone_chat:=gen_random_uuid();clone_pid:=gen_random_uuid();
  INSERT INTO actors(id,name,system_prompt) VALUES(clone_actor,'Dispatch blocked fixture','Offline permanent blocker');
  INSERT INTO chats(id,actor_id,title) VALUES(clone_chat,clone_actor,'Dispatch blocked fixture');
  PERFORM create_game_work_project(clone_pid,'blocked-dispatch-'||clone_pid,clone_actor,clone_chat,'Controlled permanent dispatch failure',repo);
  UPDATE work_projects SET status='running',phase='development',spec=p.spec,repository_full_name='owner/repo',baseline_sha=repeat('a',40),approval_hash=repeat('b',64),approved_hash=repeat('b',64),deadline=now()+interval '3 hours',lease=lease,lease_until=now()+interval '5 minutes' WHERE id=clone_pid;
  PERFORM finish_work_project(clone_pid,lease,'child',jsonb_build_object('kind','development','objective','Controlled permanent dispatch failure','evidence','{}'::jsonb));
  SELECT active_mission_id INTO clone_mid FROM work_projects WHERE id=clone_pid;
  SELECT id INTO clone_jid FROM mission_assignments WHERE mission_id=clone_mid AND role='development';
  UPDATE mission_assignments SET status='failed',result='{"detail":"Permanent invalid development identity"}'::jsonb,payload=payload||jsonb_build_object('approved',true,'development_input','Controlled permanent dispatch failure'),updated_at=now()-interval '1 hour' WHERE id=clone_jid;
  UPDATE agent_missions SET status='blocked' WHERE id=clone_mid;
  UPDATE work_projects SET status='blocked' WHERE id=clone_pid;
 END LOOP;
 PERFORM project_dispatch_recovery_candidates();
 IF (SELECT status FROM mission_assignments WHERE id=jid)<>'running' THEN RAISE EXCEPTION 'Bounded scan did not inspect the twenty older blockers first';END IF;
 PERFORM project_dispatch_recovery_candidates();
 IF (SELECT status FROM mission_assignments WHERE id=jid)<>'waiting_external' OR (SELECT active_mission_id FROM work_projects WHERE id=pid)<>mid THEN RAISE EXCEPTION 'Existing cron did not recover the original assignment';END IF;
 IF recover_project_development_dispatch(jid) THEN RAISE EXCEPTION 'Concurrent recovery duplicated';END IF;
 IF (SELECT status FROM mission_assignments WHERE id=jid)<>'waiting_external' OR (SELECT status FROM work_projects WHERE id=pid)<>'running' THEN RAISE EXCEPTION 'Duplicate maintenance cancelled the queued recovery';END IF;
 IF (SELECT attempts FROM mission_assignments WHERE id=jid)<>2 OR (SELECT request_id FROM agent_tasks WHERE id=jid)<>original_request THEN RAISE EXCEPTION 'Recovery reset attempts or identity';END IF;
 -- Reacquire the original job through the real worker claim (other fixtures are
 -- paused by the caller inside its rollback transaction).
 claim:=claim_mission_work();
 IF claim->'job'->>'id' IS DISTINCT FROM jid::text THEN RAISE EXCEPTION 'Recovered assignment not claimable: %',claim;END IF;
 IF claim->'job'->>'lease'=lease::text THEN RAISE EXCEPTION 'Expired lease reused';END IF;
 IF save_project_development_dispatch(jid,lease,'submitted','Stale worker','{}')<>'false'::jsonb OR claim_project_dispatch(jid,lease,p.approved_hash) THEN RAISE EXCEPTION 'Stale worker mutated or dispatched';END IF;
 lease:=(claim->'job'->>'lease')::uuid;
 FOREACH variant IN ARRAY ARRAY['binding','input'] LOOP
  BEGIN
   IF variant='binding' THEN UPDATE work_projects SET approval_hash=repeat('c',64),approved_hash=repeat('c',64) WHERE id=pid;
   ELSE UPDATE mission_assignments SET payload=jsonb_set(payload,'{development_input}','"Conflicting frozen input"') WHERE id=jid;END IF;
   IF save_project_development_dispatch(jid,lease,'submitted','Wrong saved scope','{}') IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'Mismatched % observation persisted',variant;END IF;
   RAISE EXCEPTION 'Rollback observation variant';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Rollback observation variant' THEN RAISE;END IF;END;
 END LOOP;
 IF NOT claim_project_dispatch(jid,lease,p.approved_hash) OR claim_project_dispatch(jid,lease,p.approved_hash) THEN RAISE EXCEPTION 'POST claim not exactly once';END IF;
 task:=mission_development_task(jid,lease);
 IF (task->'external'->>'attempted') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Durable attempted checkpoint missing';END IF;
 -- Missing acknowledgment after POST is reconciliation-only, never resubmission.
 UPDATE mission_assignments SET status='failed',lease=null,lease_until=null,result='{"detail":"500 connection lost after POST"}' WHERE id=jid;
 UPDATE agent_missions SET status='blocked' WHERE id=mid;
 UPDATE work_projects SET status='blocked' WHERE id=pid;
 IF NOT recover_project_development_dispatch(jid) THEN RAISE EXCEPTION 'Uncertain accepted dispatch not reconciled';END IF;
 claim:=claim_mission_work();lease:=(claim->'job'->>'lease')::uuid;
 IF claim->'job'->>'id' IS DISTINCT FROM jid::text OR claim_project_dispatch(jid,lease,p.approved_hash) THEN RAISE EXCEPTION 'Uncertain dispatch could submit twice';END IF;
 -- Controlled READY observation advances the same assignment to its compose
 -- dependency without claiming any real engineering or browser success.
 task:=mission_development_task(jid,lease);
 task:=save_project_development_dispatch(jid,lease,'ready','Controlled verified checkpoint',task->'external'||'{"issueNumber":7}'::jsonb);
 IF NOT commit_mission_work(jid,lease,'{"output":"Controlled saved checkpoint passed"}') THEN RAISE EXCEPTION 'Parent assignment did not advance';END IF;
 IF (SELECT status FROM mission_assignments WHERE id=jid)<>'completed' OR (SELECT status FROM mission_assignments WHERE mission_id=mid AND job_key='compose')<>'queued' THEN RAISE EXCEPTION 'Next parent lifecycle stage unavailable';END IF;
 IF before_charges IS DISTINCT FROM jsonb_build_object('missions',(SELECT jsonb_agg(jsonb_build_array(id,actual_tokens,reserved_tokens,calls) ORDER BY id) FROM agent_missions WHERE project_id=pid),'calls',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM mission_calls c WHERE job_id=jid)) THEN RAISE EXCEPTION 'Recovery changed uncertain charges';END IF;
 -- Each unsafe variant starts from this same saved task and rolls back locally.
 FOREACH variant IN ARRAY ARRAY['deadline','scope','budget','permanent','duplicate','paused'] LOOP
  BEGIN
   UPDATE mission_assignments SET status='failed',lease=null,lease_until=null,result='{"detail":"500 connection lost after POST"}' WHERE id=jid;
   UPDATE agent_missions SET status='blocked' WHERE id=mid;
   UPDATE work_projects SET status='blocked' WHERE id=pid;
   UPDATE agent_tasks SET status='dispatching' WHERE id=jid;
   IF variant='deadline' THEN UPDATE work_projects SET deadline=now()-interval '1 second' WHERE id=pid;
   ELSIF variant='scope' THEN UPDATE work_projects SET approval_hash=repeat('c',64) WHERE id=pid;
   ELSIF variant='budget' THEN UPDATE agent_missions SET token_allowance=10000 WHERE id=mid;
   ELSIF variant='permanent' THEN UPDATE agent_tasks SET external=external||'{"receipt":{"outcome":"BLOCKED"}}'::jsonb,details='Permanent independent review failure' WHERE id=jid;
   ELSIF variant='paused' THEN UPDATE work_projects SET status='paused' WHERE id=pid;END IF;
   IF recover_project_development_dispatch(jid) THEN RAISE EXCEPTION 'Unsafe % recovery admitted',variant;END IF;
   IF variant<>'paused' AND (SELECT available_at FROM mission_assignments WHERE id=jid)<=now() THEN RAISE EXCEPTION 'Permanent blocker can starve a bounded scan';END IF;
   IF variant<>'paused' AND coalesce((SELECT impediment->>'minimumAction' FROM work_projects WHERE id=pid),'')='' THEN RAISE EXCEPTION 'Precise blocker missing for %',variant;END IF;
   SELECT count(*) INTO events_before FROM project_events WHERE project_id=pid;
   PERFORM recover_project_development_dispatch(jid);
   IF (SELECT count(*) FROM project_events WHERE project_id=pid)<>events_before THEN RAISE EXCEPTION 'Equivalent blocker repeated';END IF;
   RAISE EXCEPTION 'Rollback unsafe variant';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Rollback unsafe variant' THEN RAISE;END IF;END;
 END LOOP;
 IF (SELECT count(*) FROM project_runs WHERE project_id=pid)<>1 OR (SELECT cycles FROM work_projects WHERE id=pid)<>1 OR (SELECT token_allowance FROM work_projects WHERE id=pid)<>600000 THEN RAISE EXCEPTION 'Recovery created a mission/cycle or authorization';END IF;
END $test$;
