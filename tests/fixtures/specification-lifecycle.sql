-- Caller wraps this fixture in a transaction and supplies the actual saved
-- specification through SET LOCAL katie.test.saved_spec. Always roll back.
DO $test$
DECLARE actor uuid:=gen_random_uuid(); chat uuid:=gen_random_uuid(); pid uuid:=gen_random_uuid();
 mid uuid:=gen_random_uuid(); source_job uuid:=gen_random_uuid(); l uuid:=gen_random_uuid();
 candidate text:=current_setting('katie.test.saved_spec'); source_hash text; payload jsonb; p work_projects;
 child agent_missions; review_job mission_assignments; cap jsonb; call_id uuid; job_count integer; repo uuid;
BEGIN
 INSERT INTO actors(id,name,system_prompt) VALUES(actor,'Specification fixture','Controlled offline fixture');
 INSERT INTO chats(id,actor_id,title) VALUES(chat,actor,'Specification lifecycle fixture');
 SELECT id INTO repo FROM repo_sync_runs WHERE repository_full_name='owner/repo' LIMIT 1;
 PERFORM create_game_work_project(pid,'spec-lifecycle-'||pid,actor,chat,'Controlled original specification recovery fixture',repo);
 SELECT * INTO STRICT p FROM work_projects WHERE id=pid;
 PERFORM create_mission(mid,p.objective,p.team,120,null);
 UPDATE agent_missions SET project_id=pid,project_kind='specification',status='blocked',actual_tokens=10000,reserved_tokens=15000 WHERE id=mid;
 INSERT INTO mission_assignments(id,mission_id,job_key,role,agent_id,instruction,status,result)
 VALUES(source_job,mid,'revision','revise',p.team[1],'Saved specification repair','completed',jsonb_build_object('text',candidate));
 INSERT INTO project_runs(project_id,mission_id,kind,ordinal,milestone_index) VALUES(pid,mid,'specification',1,0);
 source_hash:=encode(sha256(convert_to(project_canonical(candidate::jsonb),'UTF8')),'hex');
 payload:=jsonb_build_object('kind','specification','objective',p.objective,'evidence',jsonb_build_object('projectProfile','game',
  'savedSpecificationCheckpoint',jsonb_build_object('sourceJobId',source_job,'sourceMissionId',mid,'fullSpecificationHash',source_hash,'status','unreviewed')));
 UPDATE work_projects SET phase='specification',status='running',active_mission_id=null,deadline=now()+interval '3 hours',lease=l,lease_until=now()+interval '5 minutes',token_allowance=60000,max_missions=12 WHERE id=pid;
 IF finish_work_project(pid,gen_random_uuid(),'child',payload) THEN RAISE EXCEPTION 'Wrong lease launched';END IF;
 IF NOT finish_work_project(pid,l,'child',payload) THEN RAISE EXCEPTION 'Resource blocker not recorded';END IF;
 SELECT * INTO p FROM work_projects WHERE id=pid;
 IF p.status<>'blocked' OR p.active_mission_id IS NOT NULL OR p.detail NOT LIKE '%15000 charged%' OR p.token_allowance<>60000 THEN RAISE EXCEPTION 'Incorrect accounting/resource blocker';END IF;
 IF (SELECT count(*) FROM project_runs WHERE project_id=pid)<>1 THEN RAISE EXCEPTION 'Doomed mission launched';END IF;
 UPDATE work_projects SET status='running',lease=l,lease_until=now()+interval '5 minutes',token_allowance=600000,max_missions=2 WHERE id=pid;
 PERFORM finish_work_project(pid,l,'child',payload);
 IF (SELECT detail FROM work_projects WHERE id=pid) NOT LIKE '%mission slots%' THEN RAISE EXCEPTION 'Mandatory future mission slots not protected';END IF;
 UPDATE work_projects SET status='running',lease=l,lease_until=now()+interval '5 minutes',max_missions=12 WHERE id=pid;
 BEGIN
  PERFORM finish_work_project(pid,l,'child',jsonb_set(payload,'{evidence,savedSpecificationCheckpoint,sourceJobId}',to_jsonb(gen_random_uuid())));
  RAISE EXCEPTION 'Foreign checkpoint accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='Foreign checkpoint accepted' OR SQLERRM NOT LIKE '%does not belong%' THEN RAISE;END IF;END;
 IF NOT finish_work_project(pid,l,'child',payload) THEN RAISE EXCEPTION 'Funded saved recovery failed';END IF;
 SELECT m.* INTO child FROM agent_missions m JOIN work_projects w ON w.active_mission_id=m.id WHERE w.id=pid;
 IF child.token_allowance<>90000 OR child.project_evidence->'specificationBudget'->>'futureTokens'<>'240000' THEN RAISE EXCEPTION 'Wrong mandatory-stage allowance';END IF;
 IF (SELECT status FROM mission_assignments WHERE mission_id=child.id AND job_key='plan')<>'completed' THEN RAISE EXCEPTION 'Planning inference was not skipped';END IF;
 IF (SELECT count(*) FROM mission_assignments WHERE mission_id=child.id AND role IN ('compose','review'))<>2 THEN RAISE EXCEPTION 'Normal independent specification lifecycle missing';END IF;
 IF (SELECT actual_tokens FROM agent_missions WHERE id=mid)<>10000 OR (SELECT reserved_tokens FROM agent_missions WHERE id=mid)<>15000 THEN RAISE EXCEPTION 'Historical charges changed';END IF;
 SELECT * INTO review_job FROM mission_assignments WHERE mission_id=child.id AND job_key='review';
 UPDATE mission_assignments SET status='running',lease=l,lease_until=now()+interval '5 minutes' WHERE id=review_job.id;
 call_id:=gen_random_uuid();
 IF NOT reserve_mission_routing_call(review_job.id,l,call_id,'routing:fixture',9000) THEN RAISE EXCEPTION 'Routing fixture not admitted';END IF;
 PERFORM finish_mission_call(call_id,6000);
 call_id:=gen_random_uuid();
 IF NOT reserve_mission_call(review_job.id,l,call_id,'execution:fixture',4000) THEN RAISE EXCEPTION 'Execution fixture not admitted';END IF;
 PERFORM finish_mission_call(call_id,null);
 cap:=specification_call_capacity(review_job.id,l);
 IF cap->>'stageRemainingTokens'<>'14000' THEN RAISE EXCEPTION 'Routing/uncertain spending escaped stage accounting: %',cap;END IF;
 -- Reusing an identical artifact under any job ID cannot open another mission.
 UPDATE work_projects SET active_mission_id=null,status='running',lease=l,lease_until=now()+interval '5 minutes' WHERE id=pid;
 PERFORM finish_work_project(pid,l,'child',payload);
 IF (SELECT detail FROM work_projects WHERE id=pid) NOT LIKE '%exact saved specification%' OR (SELECT count(*) FROM project_runs WHERE project_id=pid)<>2 THEN RAISE EXCEPTION 'Equivalent recovery repeated';END IF;
 UPDATE work_projects SET active_mission_id=child.id,status='running',lease=l,lease_until=now()+interval '5 minutes' WHERE id=pid;
 BEGIN
  PERFORM finish_work_project(pid,l,'spec',jsonb_build_object('spec',candidate::jsonb,'baseline',repeat('a',40),'detail','Unreviewed fixture'));
  RAISE EXCEPTION 'Unreviewed specification approved';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='Unreviewed specification approved' OR SQLERRM NOT LIKE '%Reviewed specification required%' THEN RAISE;END IF;END;
 UPDATE agent_missions SET status='completed',result=candidate WHERE id=child.id;
 PERFORM finish_work_project(pid,l,'spec',jsonb_build_object('spec',candidate::jsonb,'baseline',repeat('a',40),'detail','Controlled independent-review fixture passed'));
 SELECT * INTO p FROM work_projects WHERE id=pid;
 IF p.phase<>'approval' OR p.approved_hash IS NOT NULL OR p.approval_hash IS NULL THEN RAISE EXCEPTION 'Specification did not stop at exact scope approval';END IF;
 IF repo IS NOT NULL THEN
  PERFORM control_work_project(pid,actor,chat,'approve',p.approval_hash);
  SELECT * INTO p FROM work_projects WHERE id=pid;
  IF p.phase<>'development' OR p.status<>'running' OR p.approved_hash IS DISTINCT FROM p.approval_hash THEN RAISE EXCEPTION 'Approved scope did not advance to existing development lifecycle';END IF;
 END IF;
 IF p.token_allowance<>600000 THEN RAISE EXCEPTION 'Approval changed authorization';END IF;
END $test$;
