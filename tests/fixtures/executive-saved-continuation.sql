-- Disposable PostgreSQL fixture only; CI creates these tables in an empty database.
\set ON_ERROR_STOP on
create table agent_missions (
 id uuid primary key, objective text not null, team jsonb not null, status text not null,
 max_calls int not null default 12 check(max_calls between 2 and 20),
 token_allowance int not null default 60000 check(token_allowance between 10000 and 120000),
 reserved_tokens int not null default 0,actual_tokens int not null default 0,calls int not null default 0,
 routing_calls int not null default 0,max_minutes int not null default 20,deadline timestamptz,
 result text,detail text,repository_id uuid,project_id uuid,project_kind text,project_evidence jsonb,
 created_at timestamptz default now(),updated_at timestamptz default now()
);
create table mission_assignments (
 id uuid primary key default gen_random_uuid(),mission_id uuid references agent_missions(id),
 job_key text,role text,agent_id uuid,instruction text,dependencies text[] default '{}',payload jsonb default '{}',
 status text,attempts int default 0,result jsonb,detail text,lease uuid,lease_until timestamptz,
 created_at timestamptz default now(),updated_at timestamptz default now(),unique(mission_id,job_key)
);
create table mission_calls (id uuid primary key default gen_random_uuid(),job_id uuid references mission_assignments(id),status text,reserved_tokens int,actual_tokens int);
create table executive_management_requests (id uuid primary key,actor_id uuid,chat_id uuid,status text,plan jsonb,detail text,updated_at timestamptz default now());
create table executive_delegations (
 id uuid primary key,orchestrator_id uuid,actor_id uuid,chat_id uuid,request_key text unique,
 objective text,success_criteria jsonb,capability text,status text,delegated_version int,
 budget_tokens int check(budget_tokens between 0 and 120000),deadline timestamptz,mission_id uuid references agent_missions(id)
);
create table executive_delegation_events (id uuid primary key default gen_random_uuid(),delegation_id uuid references executive_delegations(id),event text,evidence jsonb);
create table executive_provisioning_requests (id uuid primary key,status text,evidence jsonb,capability text,updated_at timestamptz default now());
create table executive_provisioning_events (id uuid primary key default gen_random_uuid(),request_id uuid references executive_provisioning_requests(id),event text,evidence jsonb);

insert into agent_missions(id,objective,team,status,token_allowance,reserved_tokens,actual_tokens,calls,routing_calls,deadline)
select id::uuid,'Original scoped objective','[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]','blocked',120000,116884,107941,15,14,'2026-10-21 20:04:56+00'
from unnest(array['9ecb8f69-6a7a-4428-8b1b-206d013d44bc','7d866a71-1c66-4a7a-832c-765591f7741b','bf5b73b6-c265-4c2a-8125-435d78c3a450']) id;
insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,status,attempts,result,payload)
select id,'worker','work','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Retain exact evidence','completed',3,
'{"text":"Original artifact","inspection":{"commit":"5a77c2564af6d0e8bc9de58b861205a9a30e2c98"},"sources":[{"url":"https://www.irs.gov/"}]}','{"capability":"research"}' from agent_missions;
insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,status,attempts,result)
select id,'compose','compose','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Compose report',array['worker'],
case when id='7d866a71-1c66-4a7a-832c-765591f7741b' then 'failed' else 'completed' end,2,'{"text":"Saved draft, not reviewed"}' from agent_missions;
insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,status,attempts,result)
select id,'review','review','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Independent review',array['compose'],'failed',3,'{"detail":"Allowance exhausted"}' from agent_missions;
insert into mission_calls(job_id,status,reserved_tokens,actual_tokens) select id,'uncertain',8943,null from mission_assignments where role='review';
insert into executive_management_requests values('3b81cc91-9a68-47dc-8442-dbf700431f15','81c01658-6dc5-4544-b5f2-ea4c5423ca60','0f94a3e2-87d3-4e1e-9496-1a16505e4764','blocked',
'{"assignments":[{"slug":"software_development","missionId":"9ecb8f69-6a7a-4428-8b1b-206d013d44bc"},{"slug":"operations","missionId":"7d866a71-1c66-4a7a-832c-765591f7741b"}],"provision":[{"domain":"katie_audit_synthesis","started":true,"blocked":"old blocker","sourceSlugs":["software_development","operations"]}]}','Blocked',now());
insert into executive_delegations
select gen_random_uuid(),gen_random_uuid(),'81c01658-6dc5-4544-b5f2-ea4c5423ca60','0f94a3e2-87d3-4e1e-9496-1a16505e4764',id::text,objective,'["Independent review"]','operations_analysis','cancelled',1,120000,deadline,id from agent_missions where id<>'bf5b73b6-c265-4c2a-8125-435d78c3a450';
insert into executive_provisioning_requests values('14ded4d4-b1c3-460e-84f3-4a29cc12ef6e','blocked','{"acceptanceMissionId":"bf5b73b6-c265-4c2a-8125-435d78c3a450","reason":"Old failure"}','research_synthesis',now());
create table originals as select jsonb_build_object('missions',(select jsonb_agg(to_jsonb(m) order by id) from agent_missions m),'assignments',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c)) state;

\ir ../../supabase/migrations/20261024154500_continue_executive_saved_audit.sql
\ir ../../supabase/migrations/20261024154500_continue_executive_saved_audit.sql

do $$
declare old_ids uuid[]; after_state jsonb;
begin
 select array_agg((x->>'id')::uuid) into old_ids from originals,jsonb_array_elements(state->'missions') x;
 select jsonb_build_object('missions',(select jsonb_agg(to_jsonb(m) order by id) from agent_missions m where id=any(old_ids)),
 'assignments',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=any(old_ids)),
 'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c)) into after_state;
 if after_state is distinct from (select state from originals) then raise exception 'Original artifacts, attempts or charges changed';end if;
 if (select count(*) from agent_missions)<>6 or (select count(*) from executive_delegations)<>4 then raise exception 'Not idempotent';end if;
 if (select sum(token_allowance) from agent_missions where not(id=any(old_ids)))<>300000 then raise exception 'Wrong bounded ceiling';end if;
 if exists(select 1 from agent_missions where not(id=any(old_ids)) and (actual_tokens<>0 or reserved_tokens<>0 or status<>'running' or deadline<=now() or deadline>now()+interval '121 minutes')) then raise exception 'Invalid continuation capacity';end if;
 if exists(select 1 from mission_assignments n join mission_assignments o on o.id=(n.payload->'reusedFrom'->>'assignmentId')::uuid where n.result is distinct from o.result or n.status<>'completed' or n.attempts<>0 or n.dependencies<>o.dependencies) then raise exception 'Saved artifact changed';end if;
 if (select count(*) from mission_assignments where not(mission_id=any(old_ids)) and status='queued')<>4 then raise exception 'Only unfinished work should be queued';end if;
 if exists(select 1 from mission_assignments where not(mission_id=any(old_ids)) and role='review' and status<>'queued') then raise exception 'Review bypassed';end if;
 if (select status from executive_provisioning_requests)<>'configured' then raise exception 'Specialist activated without review';end if;
 if (select count(*) from executive_provisioning_events)<>1 then raise exception 'Duplicate recovery event';end if;
 if exists(select 1 from executive_management_requests,jsonb_array_elements(plan->'assignments') a where (a->>'missionId')::uuid=any(old_ids)) then raise exception 'Parent references stale missions';end if;
 if (select plan->'provision'->0->'sourceSlugs' from executive_management_requests)<>'["software_development","operations"]'::jsonb then raise exception 'Source dependencies changed';end if;
end $$;
select 'Recovery preserves artifacts, uncertain charges and independent review; idempotence passed.' as result;

-- Simulate the observed 53,146-character review failure without spending again.
alter table mission_assignments add column available_at timestamptz default now();
alter table executive_delegations add column updated_at timestamptz default now();
alter table executive_delegation_events add column created_at timestamptz default now();
do $$begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role;end if;
end $$;
\ir ../../supabase/migrations/20261024161000_resume_repository_review_context.sql
update agent_missions set status='blocked',objective='Audit the repository read-only.',repository_id=gen_random_uuid()
 where project_evidence->'continuation'->>'sourceMissionId'='9ecb8f69-6a7a-4428-8b1b-206d013d44bc';
update mission_assignments set status='failed',attempts=1,result='{"reviewContextOverflow":true,"reviewInputCharacters":53146,"candidateJobId":"saved-candidate"}'
 where role='review' and mission_id in(select id from agent_missions where project_evidence->'continuation'->>'sourceMissionId'='9ecb8f69-6a7a-4428-8b1b-206d013d44bc');
update executive_delegations set status='cancelled' where mission_id in(select id from agent_missions where project_evidence->'continuation'->>'sourceMissionId'='9ecb8f69-6a7a-4428-8b1b-206d013d44bc');
insert into executive_delegation_events(delegation_id,event,evidence) select id,'cancel','{"reason":"Mission did not pass independent review"}' from executive_delegations where mission_id in(select id from agent_missions where project_evidence->'continuation'->>'sourceMissionId'='9ecb8f69-6a7a-4428-8b1b-206d013d44bc');
create table capacity_before as select id,token_allowance,reserved_tokens,actual_tokens,calls,routing_calls,deadline from agent_missions;
do $$begin
 if resume_repository_review_context()<>1 then raise exception 'Expected one eligible review recovery';end if;
 if resume_repository_review_context()<>0 then raise exception 'Repeated context recovery';end if;
 if exists(select 1 from agent_missions m join capacity_before b using(id) where row(m.token_allowance,m.reserved_tokens,m.actual_tokens,m.calls,m.routing_calls,m.deadline) is distinct from row(b.token_allowance,b.reserved_tokens,b.actual_tokens,b.calls,b.routing_calls,b.deadline)) then raise exception 'Recovery changed capacity or usage';end if;
 if exists(select 1 from mission_assignments where payload ? 'reviewEnvelopeRecovery' and (status<>'queued' or attempts<>1 or result->>'candidateJobId'<>'saved-candidate')) then raise exception 'Prior attempts or evidence lost';end if;
 if (select count(*) from executive_delegation_events where event='repository_review_context_recovery')<>1 then raise exception 'Recovery evidence missing';end if;
end $$;

-- An owner cancellation, an exhausted allowance, and an expired deadline must
-- each prevent recovery, even when the review itself has a matching failure.
update agent_missions set status='blocked',objective='Audit read-only.',repository_id=gen_random_uuid()
 where project_evidence->'continuation'->>'sourceMissionId'='7d866a71-1c66-4a7a-832c-765591f7741b';
update mission_assignments set status='failed',attempts=1,result='{"reviewContextOverflow":true,"reviewInputCharacters":53146}'
 where role='review' and mission_id in(select id from agent_missions where project_evidence->'continuation'->>'sourceMissionId'='7d866a71-1c66-4a7a-832c-765591f7741b');
update executive_delegations set status='cancelled' where mission_id in(select id from agent_missions where project_evidence->'continuation'->>'sourceMissionId'='7d866a71-1c66-4a7a-832c-765591f7741b');
insert into executive_delegation_events(delegation_id,event,evidence) select id,'cancel','{"reason":"Owner stopped the assignment"}' from executive_delegations where mission_id in(select id from agent_missions where project_evidence->'continuation'->>'sourceMissionId'='7d866a71-1c66-4a7a-832c-765591f7741b');
do $$begin if resume_repository_review_context()<>0 then raise exception 'Owner cancellation bypassed';end if;end $$;
update executive_delegations set status='running' where mission_id in(select id from agent_missions where project_evidence->'continuation'->>'sourceMissionId'='7d866a71-1c66-4a7a-832c-765591f7741b');
update agent_missions set actual_tokens=token_allowance where project_evidence->'continuation'->>'sourceMissionId'='7d866a71-1c66-4a7a-832c-765591f7741b';
do $$begin if resume_repository_review_context()<>0 then raise exception 'Exhausted capacity bypassed';end if;end $$;
update agent_missions set actual_tokens=0,deadline=now()-interval '1 minute' where project_evidence->'continuation'->>'sourceMissionId'='7d866a71-1c66-4a7a-832c-765591f7741b';
do $$begin if resume_repository_review_context()<>0 then raise exception 'Expired deadline bypassed';end if;end $$;
select 'Context recovery preserves authority, source evidence and capacity; exclusion guards passed.' as result;

do $$
declare target mission_assignments;snapshot jsonb:='{"kind":"scoped_workflow_trace","observedAt":"2026-10-24T16:01:40Z","trace":{"status":"running"}}';
begin
 select * into target from mission_assignments where payload ? 'reviewEnvelopeRecovery';
 update mission_assignments set status='running',lease=gen_random_uuid(),lease_until=now()+interval '6 minutes' where id=target.id returning * into target;
 if checkpoint_mission_operational_evidence(target.id,gen_random_uuid(),snapshot) then raise exception 'Wrong lease accepted';end if;
 if not checkpoint_mission_operational_evidence(target.id,target.lease,snapshot) then raise exception 'Valid snapshot rejected';end if;
 if not checkpoint_mission_operational_evidence(target.id,target.lease,snapshot) then raise exception 'Idempotent snapshot rejected';end if;
 if checkpoint_mission_operational_evidence(target.id,target.lease,snapshot||'{"observedAt":"2026-10-24T16:05:40Z"}'::jsonb) then raise exception 'Historical snapshot overwritten';end if;
 if (select payload->'operationalEvidenceSnapshot' from mission_assignments where id=target.id) is distinct from snapshot then raise exception 'Snapshot changed';end if;
 if has_function_privilege('anon','checkpoint_mission_operational_evidence(uuid,uuid,jsonb)','execute') or has_function_privilege('authenticated','resume_repository_review_context()','execute') then raise exception 'Recovery permission widened';end if;
end $$;
select 'Operational snapshot identity and lease fencing passed.' as result;
