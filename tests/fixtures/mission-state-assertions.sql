do $test$
declare cfg jsonb:='{"name":"Mission worker","instructions":"Use evidence and verify calculations.","research":false,"attachments":false,"development":true,"reviewMode":"always","maxActiveTasks":4,"maxInputChars":8000}';a jsonb;b jsonb;m jsonb;j jsonb;x jsonb;y jsonb;c jsonb;old_lease uuid;ids uuid[];mid uuid;callid uuid:=gen_random_uuid();repo uuid:=gen_random_uuid();t jsonb;
begin
 assert not has_table_privilege('anon','agent_missions','SELECT');
 assert not has_table_privilege('authenticated','mission_assignments','INSERT');
 assert not has_table_privilege('service_role','mission_calls','DELETE');
 assert not has_function_privilege('anon','claim_mission_work()','EXECUTE');
 assert not has_function_privilege('authenticated','commit_mission_work(uuid,uuid,jsonb,jsonb,text,text,text)','EXECUTE');
 a:=save_managed_agent(null,cfg,false);b:=save_managed_agent(null,cfg,false);ids:=array[(a->>'id')::uuid,(b->>'id')::uuid];mid:=gen_random_uuid();
 m:=create_mission(mid,'Analyze a supplied service offer',ids);
 assert (create_mission(mid,'Analyze a supplied service offer',ids)->>'id')=mid::text;
 begin perform create_mission(mid,'Forged replacement',ids);raise exception 'Unexpected replacement';exception when others then if sqlerrm not like '%identity conflict%' then raise;end if;end;
 assert claim_mission_work() is null,'Draft cannot execute';
 perform control_mission(mid,'start');j:=claim_mission_work()->'job';assert j->>'role'='plan';
 assert reserve_mission_call((j->>'id')::uuid,(j->>'lease')::uuid,callid,'fixture',100);
 assert not reserve_mission_call((j->>'id')::uuid,(j->>'lease')::uuid,callid,'fixture',100),'Call identity cannot be reused';
 perform finish_mission_call(callid,12);perform finish_mission_call(callid,12);
 assert (select actual_tokens from agent_missions where id=mid)=12;
 assert (select reserved_tokens from agent_missions where id=mid)=12,'Known usage settles a reservation exactly once; unused headroom is released';
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{}',jsonb_build_array(
  jsonb_build_object('key','analysis','role','work','agent_id',a->>'id','instruction','Analyze economics','dependencies','[]'::jsonb),
  jsonb_build_object('key','research','role','work','agent_id',b->>'id','instruction','Research comparable offers','dependencies','[]'::jsonb),
  jsonb_build_object('key','compose','role','compose','agent_id',a->>'id','instruction','Deliver a recommendation','dependencies','["analysis","research"]'::jsonb),
  jsonb_build_object('key','review','role','review','agent_id',b->>'id','instruction','Verify independently','dependencies','["compose"]'::jsonb)));
 x:=claim_mission_work()->'job';y:=claim_mission_work()->'job';assert x->>'id'<>y->>'id';assert claim_mission_work() is null,'Dependent work cannot run early';
 old_lease:=(x->>'lease')::uuid;update mission_assignments set lease_until=now()-interval '1 second' where id=(x->>'id')::uuid;
 c:=claim_mission_work()->'job';assert c->>'id'=x->>'id';assert c->>'lease'<>x->>'lease';assert (c->>'attempts')::integer=2;
 assert not commit_mission_work((x->>'id')::uuid,old_lease,'{"text":"Late stale result"}');
 assert commit_mission_work((c->>'id')::uuid,(c->>'lease')::uuid,'{"text":"Recovered evidence"}');
 assert commit_mission_work((y->>'id')::uuid,(y->>'lease')::uuid,'{"text":"Other evidence"}');
 c:=claim_mission_work()->'job';assert c->>'role'='compose';
 begin perform commit_mission_work((c->>'id')::uuid,(c->>'lease')::uuid,'{"verdict":"pass"}','[]','completed','completed','Unverified draft');raise exception 'Unexpected false completion';exception when others then if sqlerrm not like '%Verified deliverable required%' then raise;end if;end;
 assert commit_mission_work((c->>'id')::uuid,(c->>'lease')::uuid,'{"text":"Verified candidate"}');
 c:=claim_mission_work()->'job';assert c->>'role'='review';
 assert commit_mission_work((c->>'id')::uuid,(c->>'lease')::uuid,'{"verdict":"pass"}','[]','completed','completed','Verified candidate');
 assert (select status from agent_missions where id=mid)='completed';assert claim_mission_work() is null;
 -- Stop fences a previously admitted worker and prevents subsequent dispatch.
 mid:=gen_random_uuid();perform create_mission(mid,'Stop probe',ids);perform control_mission(mid,'start');j:=claim_mission_work()->'job';perform control_mission(mid,'stop');
 assert not commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{"text":"Late"}');assert claim_mission_work() is null;
 -- Exhausting dispatch reservations blocks visibly before a provider call.
 mid:=gen_random_uuid();perform create_mission(mid,'Budget probe',ids);perform control_mission(mid,'start');j:=claim_mission_work()->'job';
 assert not reserve_mission_call((j->>'id')::uuid,(j->>'lease')::uuid,gen_random_uuid(),'fixture',60001);assert (select status from agent_missions where id=mid)='blocked';
 -- No expired mission silently succeeds or admits new work.
 mid:=gen_random_uuid();perform create_mission(mid,'Deadline probe',ids);perform control_mission(mid,'start');update agent_missions set deadline=now()-interval '1 second' where id=mid;
 assert claim_mission_work() is null;assert (select status from agent_missions where id=mid)='blocked';
 cfg:=cfg||'{"maxActiveTasks":1}'::jsonb;a:=save_managed_agent(null,cfg,false);b:=save_managed_agent(null,cfg,false);ids:=array[(a->>'id')::uuid,(b->>'id')::uuid];
 -- Approval bridge binds a coding task to the exact mission snapshot/input.
 insert into repo_sync_runs(id,repository_full_name) values(repo,'owner/repo');
 mid:=gen_random_uuid();perform create_mission(mid,'Development probe',ids,120,repo);perform control_mission(mid,'start');j:=claim_mission_work()->'job';
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{}',jsonb_build_array(jsonb_build_object('key','coding','role','development','agent_id',a->>'id','instruction','Make a draft-only documentation change','dependencies','[]'::jsonb),jsonb_build_object('key','parallel','role','work','agent_id',b->>'id','instruction','Independent analysis','dependencies','[]'::jsonb),jsonb_build_object('key','compose','role','compose','agent_id',a->>'id','instruction','Deliver the checked draft link','dependencies','["coding"]'::jsonb),jsonb_build_object('key','review','role','review','agent_id',b->>'id','instruction','Verify delivery','dependencies','["compose"]'::jsonb)));
 j:=claim_mission_work()->'job';
 begin perform mission_development_task((j->>'id')::uuid,(j->>'lease')::uuid);raise exception 'Unexpected unapproved development';exception when others then if sqlerrm not like '%approval unavailable%' then raise;end if;end;
 x:=claim_mission_work()->'job';assert x->>'job_key'='parallel';
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{}','[]','awaiting_approval');
 assert reserve_mission_call((x->>'id')::uuid,(x->>'lease')::uuid,gen_random_uuid(),'fixture',100),'Already admitted work can checkpoint through an approval wait';
 assert commit_mission_work((x->>'id')::uuid,(x->>'lease')::uuid,'{"text":"Independent analysis complete"}');
 assert (select status from agent_missions where id=mid)='awaiting_approval';assert claim_mission_work() is null;
 perform control_mission(mid,'approve',(j->>'id')::uuid);j:=claim_mission_work()->'job';
 t:=mission_development_task((j->>'id')::uuid,(j->>'lease')::uuid);assert t->>'status'='draft';assert t->'snapshot'=cfg;assert position('Make a draft-only documentation change' in (t->>'initial_input'))>0;assert position('Development probe' in (t->>'initial_input'))>0;
 assert (mission_development_task((j->>'id')::uuid,(j->>'lease')::uuid)->>'id')=t->>'id';
 perform transition_agent_task((t->>'id')::uuid,'start');
 assert active_managed_work((a->>'id')::uuid,null)=1,'External coding job and mission assignment count once';
 assert active_managed_work((a->>'id')::uuid,(j->>'id')::uuid)=0,'Polling does not count its own external job';
 update agent_tasks set status='submitted' where id=(t->>'id')::uuid;
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{}','[]','waiting_external');
 update mission_assignments set available_at=now() where id=(j->>'id')::uuid;
 j:=claim_mission_work()->'job';assert j is not null,'Submitted coding work remains reconcilable';
 update agent_tasks set status='ready' where id=(t->>'id')::uuid;
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{"output":"Verified draft-ready receipt"}');
 j:=claim_mission_work()->'job';assert j->>'role'='compose';assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{"text":"Draft link"}');
 j:=claim_mission_work()->'job';assert j->>'role'='review';assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{"verdict":"pass"}','[]','completed','completed','Draft link');
 assert (select status from agent_missions where id=mid)='completed','Limit-one coding mission must finish after reconciliation';
end $test$;

-- Ordinary tasks and missions share one capacity unit at a limit of one.
do $admission$
declare cfg jsonb:='{"name":"Single worker","instructions":"Use saved evidence.","research":false,"attachments":false,"development":true,"reviewMode":"always","maxActiveTasks":1,"maxInputChars":8000}';
 a jsonb; mid uuid; tid uuid; repo uuid:=gen_random_uuid(); j jsonb; t jsonb;
begin
 a:=save_managed_agent(null,cfg,false);mid:=gen_random_uuid();tid:=gen_random_uuid();
 perform create_mission(mid,'Shared capacity',array[(a->>'id')::uuid]);perform control_mission(mid,'start');
 perform create_agent_task(tid,(a->>'id')::uuid,'Ordinary task','general');
 j:=claim_mission_work()->'job';assert j->>'mission_id'=mid::text;
 begin perform transition_agent_task(tid,'start');raise exception 'Unexpected admission';exception when others then if sqlerrm not like '%Active task limit%' then raise;end if;end;
 perform control_mission(mid,'stop');
 perform transition_agent_task(tid,'start');
 mid:=gen_random_uuid();perform create_mission(mid,'Task first',array[(a->>'id')::uuid]);perform control_mission(mid,'start');
 assert claim_mission_work() is null,'An ordinary task blocks mission admission';
 update agent_tasks set status='completed' where id=tid;
 j:=claim_mission_work()->'job';assert j->>'mission_id'=mid::text;
 begin perform transition_agent_task(tid,'continue','Another turn',gen_random_uuid(),'agent:'||tid::text);raise exception 'Unexpected continuation';exception when others then if sqlerrm not like '%Active task limit%' then raise;end if;end;
 perform control_mission(mid,'stop');
 -- Approved coding dispatch and its reconciliation worker count as one slot.
 insert into repo_sync_runs(id,repository_full_name) values(repo,'owner/repo');
 mid:=gen_random_uuid();perform create_mission(mid,'Coding at limit one',array[(a->>'id')::uuid],20,repo);perform control_mission(mid,'start');j:=claim_mission_work()->'job';
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{}',jsonb_build_array(jsonb_build_object('key','coding','role','development','agent_id',a->>'id','instruction','Draft a documentation fix','dependencies','[]'::jsonb)));
 j:=claim_mission_work()->'job';assert j->>'role'='development';
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{}','[]','awaiting_approval');
 perform control_mission(mid,'approve',(j->>'id')::uuid);j:=claim_mission_work()->'job';
 t:=mission_development_task((j->>'id')::uuid,(j->>'lease')::uuid);
 t:=transition_agent_task((t->>'id')::uuid,'start');assert t->>'status'='dispatching';
 assert claim_agent_dispatch((t->>'id')::uuid);
 assert not claim_agent_dispatch((t->>'id')::uuid),'External dispatch remains at most once';
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{}','[]','waiting_external');
 update mission_assignments set available_at=now() where id=(j->>'id')::uuid;
 j:=claim_mission_work()->'job';assert j->>'id'=t->>'id','Uncertain dispatch can be reconciled at capacity';
 update agent_tasks set status='submitted' where id=(t->>'id')::uuid;
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{}','[]','waiting_external');
 update mission_assignments set available_at=now() where id=(j->>'id')::uuid;
 j:=claim_mission_work()->'job';assert j->>'id'=t->>'id','Submitted task can be reconciled at capacity';
 begin perform transition_agent_task(tid,'continue','Another turn',gen_random_uuid(),'agent:'||tid::text);raise exception 'Unexpected continuation';exception when others then if sqlerrm not like '%Active task limit%' then raise;end if;end;
 -- Simulate the ready status persisted by verified receipt reconciliation.
 update agent_tasks set status='ready' where id=(t->>'id')::uuid;
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{"output":"Verified draft ready"}');
 assert (select status from mission_assignments where id=(t->>'id')::uuid)='completed';
 perform transition_agent_task(tid,'continue','Capacity released',gen_random_uuid(),'agent:'||tid::text);
 update agent_tasks set status='completed' where id=tid;
 perform control_mission(mid,'stop');
end $admission$;

-- Separate approvals remain valid after the first one resumes a mission.
do $parallel_approval$
declare cfg jsonb:='{"name":"Coding worker","instructions":"Draft-only coding.","research":false,"attachments":false,"development":true,"reviewMode":"always","maxActiveTasks":1,"maxInputChars":8000}';a jsonb;b jsonb;mid uuid:=gen_random_uuid();repo uuid:=gen_random_uuid();j jsonb;x jsonb;y jsonb;t jsonb;
begin
 a:=save_managed_agent(null,cfg,false);b:=save_managed_agent(null,cfg,false);insert into repo_sync_runs values(repo,'owner/repo');
 perform create_mission(mid,'Two independent draft changes',array[(a->>'id')::uuid,(b->>'id')::uuid],120,repo);perform control_mission(mid,'start');j:=claim_mission_work()->'job';
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{}',jsonb_build_array(
 jsonb_build_object('key','coding_a','role','development','agent_id',a->>'id','instruction','Draft change A','dependencies','[]'::jsonb),
 jsonb_build_object('key','coding_b','role','development','agent_id',b->>'id','instruction','Draft change B','dependencies','[]'::jsonb),
 jsonb_build_object('key','compose','role','compose','agent_id',a->>'id','instruction','Deliver both links','dependencies','["coding_a","coding_b"]'::jsonb),
 jsonb_build_object('key','review','role','review','agent_id',b->>'id','instruction','Verify both links','dependencies','["compose"]'::jsonb)));
 x:=claim_mission_work()->'job';y:=claim_mission_work()->'job';assert x is not null and y is not null;
 assert commit_mission_work((x->>'id')::uuid,(x->>'lease')::uuid,'{}','[]','awaiting_approval');
 assert commit_mission_work((y->>'id')::uuid,(y->>'lease')::uuid,'{}','[]','awaiting_approval');
 perform control_mission(mid,'approve',(x->>'id')::uuid);assert (select status from agent_missions where id=mid)='running';
 perform control_mission(mid,'approve',(y->>'id')::uuid);perform control_mission(mid,'approve',(x->>'id')::uuid);
 assert (select count(*) from mission_assignments where mission_id=mid and role='development' and status='queued' and payload->>'approved'='true')=2;
 for i in 1..2 loop
  j:=claim_mission_work()->'job';assert j->>'role'='development';t:=mission_development_task((j->>'id')::uuid,(j->>'lease')::uuid);perform transition_agent_task((t->>'id')::uuid,'start');
  update agent_tasks set status='ready' where id=(t->>'id')::uuid;
  assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{"output":"Verified draft link"}');
 end loop;
 j:=claim_mission_work()->'job';assert j->>'role'='compose';assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{"text":"Both draft links delivered"}');
 j:=claim_mission_work()->'job';assert j->>'role'='review';assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{"verdict":"pass"}','[]','completed','completed','Both draft links delivered');
 assert (select status from agent_missions where id=mid)='completed';
end $parallel_approval$;

-- Dependency results are frozen before approval and forwarded without mutation.
do $coding_handoff$
declare cfg jsonb:='{"name":"Handoff worker","instructions":"Draft only from approved evidence.","research":false,"attachments":false,"development":true,"reviewMode":"always","maxActiveTasks":1,"maxInputChars":8000}';a jsonb;b jsonb;mid uuid:=gen_random_uuid();repo uuid:=gen_random_uuid();j jsonb;t jsonb;approved_input text;
begin
 a:=save_managed_agent(null,cfg,false);b:=save_managed_agent(null,cfg,false);insert into repo_sync_runs values(repo,'owner/repo');
 perform create_mission(mid,'Implement the original source-grounded objective',array[(a->>'id')::uuid,(b->>'id')::uuid],120,repo);perform control_mission(mid,'start');j:=claim_mission_work()->'job';
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{}',jsonb_build_array(
 jsonb_build_object('key','research','role','work','agent_id',b->>'id','instruction','Collect implementation evidence','dependencies','[]'::jsonb),
 jsonb_build_object('key','coding','role','development','agent_id',a->>'id','instruction','Implement using the collected evidence','dependencies','["research"]'::jsonb)));
 j:=claim_mission_work()->'job';assert j->>'job_key'='research';
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{"text":"handoff-sentinel: preserve this preceding finding","sources":[{"url":"https://example.com/verified-source"}]}');
 j:=claim_mission_work()->'job';assert j->>'job_key'='coding';
 assert commit_mission_work((j->>'id')::uuid,(j->>'lease')::uuid,'{}','[]','awaiting_approval');
 select payload->>'development_input' into approved_input from mission_assignments where id=(j->>'id')::uuid;
 assert position('original source-grounded objective' in approved_input)>0;assert position('handoff-sentinel' in approved_input)>0;assert position('https://example.com/verified-source' in approved_input)>0;
 perform control_mission(mid,'approve',(j->>'id')::uuid);j:=claim_mission_work()->'job';
 -- An unrelated pending approval does not revoke this already approved claim.
 update agent_missions set status='awaiting_approval' where id=mid;
 t:=mission_development_task((j->>'id')::uuid,(j->>'lease')::uuid);
 assert t->>'initial_input'=approved_input;assert t->>'input'=approved_input;
 update mission_assignments set result='{"text":"Changed after approval"}' where mission_id=mid and job_key='research';
 assert prepare_mission_development((j->>'id')::uuid,(j->>'lease')::uuid)=approved_input,'Frozen bytes are not rebuilt after approval';
 assert (mission_development_task((j->>'id')::uuid,(j->>'lease')::uuid)->>'input')=approved_input;
 perform control_mission(mid,'stop');
end $coding_handoff$;
