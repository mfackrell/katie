-- Guarded same-project recovery with original usage and approval gates.
CREATE OR REPLACE FUNCTION public.resume_expired_game_specification(p_id uuid, p_actor uuid, p_chat uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare p work_projects;m agent_missions;spent bigint;run_count int;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status<>'paused' or p.profile<>'game' or p.phase<>'specification'
 or p.spec is not null or p.approved_hash is not null or p.active_mission_id is null
 or p.deadline<=now()+interval '30 minutes' then return false; end if;
 select * into m from agent_missions where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.project_kind<>'specification' or m.deadline>now()
 or m.status not in ('blocked','stopped') then return false;end if;
 if not exists(select 1 from project_runs r join agent_missions a on a.id=r.mission_id
 where r.project_id=p.id and r.kind='research' and a.status='completed'
 and r.outcome is not null and coalesce((r.outcome->>'superseded')::boolean,false)=false)
 then return false;end if;
 if exists(select 1 from project_events where project_id=p.id and event='expired_game_specification_resumed') then return false;end if;
 select count(*) into run_count from project_runs where project_id=p.id;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into spent from agent_missions where project_id=p.id;
 if run_count>=p.max_missions or p.token_allowance-spent<120000 then return false;end if;
 update project_runs set outcome=coalesce(outcome,'{}'::jsonb)||
 jsonb_build_object('superseded',true,'reason','Expired blocked specification; source and review preserved for resumed stage')
 where mission_id=m.id and outcome is null;
 update work_projects set status='running',phase='specification',active_mission_id=null,
 lease=null,lease_until=null,failures=0,
 detail='Resuming specification after expired mission with preserved reviewed research, prior drafts, review evidence, and token charges; code scope still requires approval.',
 updated_at=now() where id=p.id;
 insert into project_events(project_id,event,data) values(p.id,'expired_game_specification_resumed',
 jsonb_build_object('expiredMissionId',m.id,'chargedTokens',spent,'remainingTokens',p.token_allowance-spent,
 'reviewedResearchRetained',true,'approvalRequired',true));
 perform project_publish(p.id,'Saved game specification resumed under remaining limits. Coding remains unapproved.');
 return true;
end $function$
;
revoke all on function public.resume_expired_game_specification(uuid,uuid,uuid) from public,anon,authenticated;
