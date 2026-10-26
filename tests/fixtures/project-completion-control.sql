begin;
DO $$ declare p work_projects; original work_projects; l uuid; m uuid; ok boolean; contract jsonb; charges jsonb;begin
 select * into strict p from work_projects where id='44444444-4444-4444-8444-444444444444';
 original:=p;
 select jsonb_agg(jsonb_build_array(id,reserved_tokens,actual_tokens,calls) order by id) into charges from agent_missions where project_id=p.id;
 if p.completion_contract->>'ownerAgentId' is distinct from p.team[1]::text or p.completion_contract->>'outcome' is distinct from p.objective then raise exception 'Missing durable owner/outcome';end if;
 -- A model cannot add acceptance requirements while retaining owner approval.
 update work_projects set approved_hash=coalesce(approval_hash,repeat('a',64)) where id=p.id;
 begin
  update work_projects set spec=spec||'{"requirements":["Invented optional chart"]}'::jsonb where id=p.id;
  raise exception 'Expected frozen contract rejection';
 exception when others then if SQLERRM='Expected frozen contract rejection' then raise;end if;end;
 -- No completion from self-reported prose, wrong lease, or a delegated child.
 l:=gen_random_uuid();
 update work_projects set status='running',phase='research',active_mission_id=null,lease=l,lease_until=now()+interval '5 minutes',deadline=now()+interval '3 hours' where id=p.id;
 if finish_work_project(p.id,gen_random_uuid(),'wait') then raise exception 'Wrong lease accepted';end if;
 if finish_work_project(p.id,null,'wait') then raise exception 'Absent lease accepted';end if;
 begin
  perform finish_work_project(p.id,l,'complete','{"result":"I completed everything"}');
  raise exception 'Expected unverified completion rejection';
 exception when others then if SQLERRM='Expected unverified completion rejection' then raise;end if;end;
 begin
  perform finish_work_project(p.id,l,'retry','{"detail":"Also add a chart"}');
  raise exception 'Expected evidence-free repair rejection';
 exception when others then if SQLERRM='Expected evidence-free repair rejection' then raise;end if;end;
 if not finish_work_project(p.id,l,'wait') then raise exception 'Authorized wait failed';end if;
 select completion_contract into contract from work_projects where id=p.id;
 update work_projects set lease=l,lease_until=now()+interval '5 minutes',progress_since=now()-interval '46 minutes' where id=p.id;
 if not finish_work_project(p.id,l,'wait','{"detail":"Still thinking"}') then raise exception 'Progress check failed';end if;
 select * into strict p from work_projects where id=p.id;
 if p.status<>'blocked' or p.impediment->>'minimumAction' is null or jsonb_array_length(p.impediment->'attempted')=0 then raise exception 'Analysis/polling failed to terminate with an actionable blocker';end if;
 if p.completion_contract<>contract then raise exception 'Polling changed completion criteria';end if;
 -- Repeating an identical coordination failure does not masquerade as progress.
 update work_projects set status='running',lease=l,lease_until=now()+interval '5 minutes',progress_since=now(),error_signature=null,repeated_errors=0 where id=p.id;
 perform finish_work_project(p.id,l,'error','{"detail":"Invalid saved verification interface"}');
 if (select status from work_projects where id=p.id)<>'running' then raise exception 'First failure should allow bounded recovery';end if;
 update work_projects set lease=l,lease_until=now()+interval '5 minutes' where id=p.id;
 perform finish_work_project(p.id,l,'error','{"detail":"Invalid saved verification interface"}');
 select * into strict p from work_projects where id=p.id;
 if p.status<>'failed' or p.repeated_errors<>2 or p.impediment->>'kind'<>'failed' then raise exception 'Repeated unchanged failure did not terminate';end if;
 if not exists(select 1 from messages where chat_id=p.chat_id and content like '%katie-project-status:'||p.id||':failed%') then raise exception 'Failure was not delivered to original conversation';end if;
 if finish_work_project(p.id,l,'wait') then raise exception 'Terminal task restarted by polling';end if;
 if (select jsonb_agg(jsonb_build_array(id,reserved_tokens,actual_tokens,calls) order by id) from agent_missions where project_id=p.id) is distinct from charges then raise exception 'Closure altered charges or reservations';end if;
 if p.token_allowance<>original.token_allowance or p.cycles<>original.cycles then raise exception 'Completion controls reset resource bounds';end if;
 if p.completion_contract->>'ownerAgentId' is distinct from original.team[1]::text then raise exception 'Delegation discharged project ownership';end if;
 -- Material failures permit one targeted approach, never identical repeats.
 update work_projects set status='running',phase='development',lease=l,lease_until=now()+interval '5 minutes',cycles=0 where id=p.id;
 perform finish_work_project(p.id,l,'retry','{"detail":"Repair missing approved stock persistence","findings":["stock-persistence: missing saved state"]}');
 if (select status from work_projects where id=p.id)<>'running' then raise exception 'Necessary targeted repair rejected';end if;
 update work_projects set lease=l,lease_until=now()+interval '5 minutes' where id=p.id;
 perform finish_work_project(p.id,l,'retry','{"detail":"Repair missing approved stock persistence","findings":["stock-persistence: missing saved state"]}');
 if (select status from work_projects where id=p.id)<>'failed' then raise exception 'Identical failed repair restarted';end if;
 -- Seed trusted, explicitly synthetic acceptance receipts, then exercise actual
 -- publication and completion gates. No model/provider execution is claimed.
 m:=gen_random_uuid();perform create_mission(m,'Synthetic independently assessed outcome',p.team,20,null);
 update agent_missions set status='completed',result='Synthetic approved assessment; optional chart is outside scope.' where id=m;
 update project_runs set outcome=coalesce(outcome,'{}') where project_id=p.id and kind='development';
 update work_projects set status='running',phase='assessment',active_mission_id=m,lease=l,lease_until=now()+interval '5 minutes',verified_sha=repeat('c',40),
  preview=jsonb_build_object('immutable',true,'url','https://fixture.invalid/pilot','headSha',repeat('c',40),'deploymentId',1,'statusId',2,
   'browserAcceptance',jsonb_build_object('passed',true,'headSha',repeat('c',40),'deploymentId',1,'statusId',2)) where id=p.id;
 perform finish_work_project(p.id,l,'complete','{"result":"Done, but one more thing: add an optional chart; would you like me to continue?"}');
 select * into strict p from work_projects where id=p.id;
 if p.status<>'completed' or p.result not like '%Verified commit:%' or p.result like '%one more thing%' then raise exception 'Closure did not use verified evidence exclusively';end if;
 if not exists(select 1 from messages where chat_id=p.chat_id and content like '%katie-project-status:'||p.id||':completed%' and content like '%https://fixture.invalid/pilot%') then raise exception 'Verified closure did not reach originating conversation';end if;
 if finish_work_project(p.id,l,'child','{"kind":"research","objective":"Optional chart"}') then raise exception 'Completion started unsolicited work';end if;
end $$;
-- The private legacy entry point cannot bypass the new controls.
DO $$ begin
 begin perform finish_work_project_lifecycle('44444444-4444-4444-8444-444444444444',gen_random_uuid(),'wait');raise exception 'Legacy lifecycle bypass accessible';
 exception when insufficient_privilege then null;end;
end $$;
rollback;
