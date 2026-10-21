-- One-shot, actor/chat-scoped review recovery for exact saved game draft.
-- Never restores an expired mission, resets charges, or waives coding approval.
create or replace function public.resume_incomplete_game_review(p_id uuid, p_actor uuid, p_chat uuid)
returns boolean language plpgsql set search_path to 'public' as $$
declare p public.work_projects; m public.agent_missions; j public.mission_assignments; charged bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from public.work_projects
  where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if not found or p.status<>'blocked' or p.phase<>'specification' or p.profile<>'game'
   or p.spec is not null or p.approved_hash is not null or p.approval_hash is not null
   or p.active_mission_id is null or p.deadline<=now()+interval '10 minutes'
 then return false; end if;
 select * into m from public.agent_missions
  where id=p.active_mission_id and project_id=p.id for update;
 if not found or m.status<>'blocked' or m.project_kind<>'specification'
   or m.deadline<=now()+interval '5 minutes'
   or m.calls>=m.max_calls or m.routing_calls>=m.max_calls*3
   or m.token_allowance-greatest(m.actual_tokens,m.reserved_tokens)<10000
 then return false; end if;
 select * into j from public.mission_assignments
  where mission_id=m.id and role='review' and status='failed'
    and (detail='Model output incomplete: incomplete'
         or result->>'detail'='Model output incomplete: incomplete')
  order by updated_at desc limit 1 for update;
 if not found then return false; end if;
 if not exists(select 1 from public.mission_assignments
   where mission_id=m.id and job_key='compose' and status='completed'
     and length(coalesce(result->>'text',''))>0)
 then return false; end if;
 if exists(select 1 from public.mission_assignments a
   join public.agent_missions x on x.id=a.mission_id
   where x.project_id=p.id and a.status='running' and a.lease_until>now())
 then return false;end if;
 if exists(select 1 from public.project_events
   where project_id=p.id and event='incomplete_game_review_resumed'
     and data->>'reviewJobId'=j.id::text)
 then return false;end if;
 select coalesce(sum(greatest(actual_tokens,reserved_tokens)),0) into charged
   from public.agent_missions where project_id=p.id;
 if p.token_allowance-charged<10000 then return false;end if;
 update public.mission_assignments set status='queued',lease=null,lease_until=null,
  available_at=now(),detail='Resume the identical saved draft for independent review with eligible provider fallback.',
  updated_at=now() where id=j.id;
 update public.agent_missions set status='running',
  detail='Recovered only failed independent review; original draft, charges, attempts and deadline retained.',
  updated_at=now() where id=m.id;
 update public.work_projects set status='running',lease=null,lease_until=null,
  detail='Exact saved specification returned to independent review, within original limits. Coding remains unapproved.',
  updated_at=now() where id=p.id;
 insert into public.project_events(project_id,event,data) values
  (p.id,'incomplete_game_review_resumed',jsonb_build_object(
   'missionId',m.id,'reviewJobId',j.id,'chargedTokens',charged,
   'remainingTokens',p.token_allowance-charged,'previousAttempts',j.attempts,
   'savedCandidateUnchanged',true,'codingApproved',false));
 perform public.project_publish(p.id,'Saved specification independent review resumed under original budgets and authorization.');
 return true;
end;$$;
