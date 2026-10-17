DO $$ declare p jsonb;q jsonb;c jsonb;m uuid;j uuid;l uuid;ph text;h text;ok boolean;begin
 insert into actors(id,name) values('11111111-1111-4111-8111-111111111111','Project owner');
 insert into chats(id,actor_id,title) values('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Project fixture');
 insert into repo_sync_runs(id,repository_full_name) values('33333333-3333-4333-8333-333333333333','owner/repo');
 p:=create_work_project('44444444-4444-4444-8444-444444444444','request-one','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','Build a working browser game.','33333333-3333-4333-8333-333333333333');
 q:=create_work_project('44444444-4444-4444-8444-444444444444','request-one','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','Build a working browser game.','33333333-3333-4333-8333-333333333333');
 if p->>'id'<>q->>'id' or(select count(*) from managed_agents)<>3 then raise exception 'Creation retry duplicated project or agents';end if;
 begin perform create_work_project('44444444-4444-4444-8444-444444444444','request-one','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','Changed objective','33333333-3333-4333-8333-333333333333');raise exception 'Expected identity rejection';exception when others then if SQLERRM='Expected identity rejection' then raise;end if;end;
 p:=claim_work_project();if claim_work_project() is not null then raise exception 'Concurrent controller claim was duplicated';end if;
 ok:=finish_work_project((p->>'id')::uuid,(p->>'lease')::uuid,'child','{"kind":"research","objective":"Research the original rules and cite sources."}');if not ok then raise exception 'Child creation failed';end if;
 if finish_work_project((p->>'id')::uuid,(p->>'lease')::uuid,'child','{"kind":"research","objective":"Duplicate"}') then raise exception 'Late controller committed twice';end if;
 select active_mission_id into m from work_projects where id=(p->>'id')::uuid;
 c:=claim_mission_work();if c->'mission'->>'id'<>m::text then raise exception 'Project work was not claimable';end if;j:=(c->'job'->>'id')::uuid;l:=(c->'job'->>'lease')::uuid;
 if not reserve_mission_call(j,l,'55555555-5555-4555-8555-555555555555','fixture',30000) then raise exception 'Reservation failed';end if;
 perform control_work_project((p->>'id')::uuid,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','pause');
 if commit_mission_work(j,l,'{"text":"STALE_PROJECT_SENTINEL"}') or reserve_mission_call(j,l,gen_random_uuid(),'fixture',1) or claim_mission_work() is not null then raise exception 'Paused project admitted or committed work';end if;
 perform control_work_project((p->>'id')::uuid,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','resume');
 -- State fixtures simulate independently verified provider outcomes; no live claim.
 update agent_missions set status='completed',result='Fixture reviewed primary research' where id=m;
 p:=claim_work_project();perform finish_work_project((p->>'id')::uuid,(p->>'lease')::uuid,'advance','{"result":"Fixture research"}');
 p:=claim_work_project();perform finish_work_project((p->>'id')::uuid,(p->>'lease')::uuid,'child','{"kind":"specification","objective":"Produce the complete approved architecture and browser cases."}');
 select active_mission_id into m from work_projects where id=(p->>'id')::uuid;update agent_missions set status='completed',result='Fixture reviewed JSON specification' where id=m;
 update messages set created_at=now()-interval '1 hour' where chat_id='22222222-2222-4222-8222-222222222222';
 p:=claim_work_project();perform finish_work_project((p->>'id')::uuid,(p->>'lease')::uuid,'spec',jsonb_build_object('baseline',repeat('a',40),'spec',jsonb_build_object('name','Token game','summary','Working game','requirements',jsonb_build_array('Moving a token must update the board'),'allowedPaths',jsonb_build_array('app/pilot/'),'milestones',jsonb_build_array(jsonb_build_object('title','Board','instruction','Build the board','contract',jsonb_build_object('path','/pilot','scenarios',jsonb_build_array(jsonb_build_object('name','move','steps',jsonb_build_array(jsonb_build_object('action','expectText','selector','#state','value','Moved'))))))),'finalContract',jsonb_build_object('path','/pilot','scenarios',jsonb_build_array(jsonb_build_object('name','move','steps',jsonb_build_array(jsonb_build_object('action','expectText','selector','#state','value','Moved'))))))));
 select approval_hash into h from work_projects where id=(p->>'id')::uuid;
 if not exists(select 1 from messages where chat_id='22222222-2222-4222-8222-222222222222' and created_at>=now() and content like '%approve project '||left(h,12)||'%') then raise exception 'Scope proposal was not delivered atomically';end if;
 begin perform control_work_project((p->>'id')::uuid,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','approve','',repeat('b',64));raise exception 'Expected stale approval rejection';exception when others then if SQLERRM='Expected stale approval rejection' then raise;end if;end;
 perform control_work_project((p->>'id')::uuid,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','approve','',h);
 if not exists(select 1 from messages where content like '%katie-project-approval:'||h||'%') then raise exception 'Accepted scope disappeared from chat history';end if;
 p:=claim_work_project();perform finish_work_project((p->>'id')::uuid,(p->>'lease')::uuid,'child','{"kind":"development","objective":"Build the approved token game."}');
 select active_mission_id into m from work_projects where id=(p->>'id')::uuid;
 if not exists(select 1 from project_runs where mission_id=m and binding->>'baseSha'=repeat('a',40) and binding->>'scopeHash'=h) then raise exception 'Coding lineage or scope binding missing';end if;
 if not exists(select 1 from mission_assignments where mission_id=m and job_key='plan' and status='completed') then raise exception 'Approved coding was replanned';end if;
 p:=claim_work_project();
 begin perform finish_work_project((p->>'id')::uuid,(p->>'lease')::uuid,'complete','{"result":"Fabricated completion"}');raise exception 'Expected incomplete project rejection';exception when others then if SQLERRM='Expected incomplete project rejection' then raise;end if;end;
 -- Leave one active project and 30,000 prior charged tokens for concurrency tests.
 update work_projects set token_allowance=60000,lease=null,lease_until=null where id=(p->>'id')::uuid;
 c:=claim_mission_work();j:=(c->'job'->>'id')::uuid;l:=(c->'job'->>'lease')::uuid;
 -- Exercise the actual external-dispatch admission path after pause/expiry.
 perform create_agent_task(j,(select agent_id from mission_assignments where id=j),'Approved fixture development','development','33333333-3333-4333-8333-333333333333');
 update agent_tasks set status='dispatching' where id=j;
 if claim_agent_dispatch(j) or claim_project_dispatch(j,gen_random_uuid(),h) then raise exception 'Unfenced project dispatch admitted';end if;
 perform control_work_project((p->>'id')::uuid,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','pause');
 if claim_project_dispatch(j,l,h) then raise exception 'Paused dispatch admitted';end if;
 perform control_work_project((p->>'id')::uuid,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','resume');
 if claim_project_dispatch(j,l,h) then raise exception 'Stale lease admitted after resume';end if;
 c:=claim_mission_work();j:=(c->'job'->>'id')::uuid;l:=(c->'job'->>'lease')::uuid;
 update mission_assignments set lease_until=now()-interval '1 second' where id=j;
 if claim_project_dispatch(j,l,h) then raise exception 'Expired assignment admitted';end if;
 update mission_assignments set lease_until=now()+interval '3 minutes' where id=j;
 if not claim_project_dispatch(j,l,h) or claim_project_dispatch(j,l,h) then raise exception 'Dispatch is not exactly once';end if;
 -- A rolled-back amendment fixture checks preservation without disturbing the reservation race below.
 begin
  update work_projects set verified_sha=repeat('c',40) where id=(p->>'id')::uuid;
  q:=control_work_project((p->>'id')::uuid,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','amend','The game also requires keyboard movement.');
  if q->>'objective'<>'Build a working browser game.' or q->>'clarifications' not like '%keyboard movement%' or q->>'phase'<>'research' or q->>'approved_hash' is not null or q->>'spec' is not null or q->>'verified_sha'<>repeat('c',40) or (q->>'cycles')::int<>1 then raise exception 'Amendment lost scope, work or allowance';end if;
  if commit_mission_work(j,l,'{"text":"STALE_AMENDMENT"}') then raise exception 'Superseded worker committed';end if;
  if (select sum(reserved_tokens) from agent_missions)<>30000 then raise exception 'Amendment reset prior usage';end if;
  raise exception 'ROLLBACK_AMENDMENT_FIXTURE';
 exception when others then if SQLERRM<>'ROLLBACK_AMENDMENT_FIXTURE' then raise;end if;end;
 -- The coding claim is retained for concurrent reservations in the host test.
 if j is null then raise exception 'Coding assignment not claimed';end if;
end $$;
