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

-- Set up the real operations failure shape for its bounded missing-analysis
-- continuation. The source itself must remain bit-for-bit unchanged afterwards.
alter table executive_delegations add column created_at timestamptz default now();
update agent_missions set status='blocked',repository_id=null,actual_tokens=73361,reserved_tokens=95966,calls=5,deadline=now()+interval '60 minutes',
 team='[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","config":{"name":"Lead"}},{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","config":{"name":"Analysis"}}]'
 where id='b50007ae-016a-435e-8835-9109405011d5';
update mission_assignments set status='completed',result='{"verdict":"changes_requested","findings":["Workers did not analyze the supplied trace"],"checks":[]}' where mission_id='b50007ae-016a-435e-8835-9109405011d5' and job_key='review';
update mission_assignments set status='completed',result='{"text":"Saved unreviewed operations draft"}' where mission_id='b50007ae-016a-435e-8835-9109405011d5' and job_key='compose';
insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,status,result) values('b50007ae-016a-435e-8835-9109405011d5','revision','revise','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Resolve actual trace analysis and unsupported claims.','failed','{"admissionDenied":true}');
update executive_delegations set status='cancelled' where mission_id='b50007ae-016a-435e-8835-9109405011d5';
insert into executive_delegation_events(delegation_id,event,evidence,created_at) select id,'cancel','{"reason":"Mission did not pass independent review"}',now()+interval '1 second' from executive_delegations where mission_id='b50007ae-016a-435e-8835-9109405011d5';
create table operations_before as select jsonb_build_object('mission',to_jsonb(m),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=m.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=m.id))) state from agent_missions m where id='b50007ae-016a-435e-8835-9109405011d5';
\ir ../../supabase/migrations/20261024163500_continue_operations_trace_revision.sql
\ir ../../supabase/migrations/20261024163500_continue_operations_trace_revision.sql

do $$
declare after_state jsonb;new_m agent_missions;source agent_missions;
begin
 select * into source from agent_missions where id='b50007ae-016a-435e-8835-9109405011d5';
 select jsonb_build_object('mission',to_jsonb(source),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=source.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=source.id))) into after_state;
 if after_state is distinct from (select state from operations_before) then raise exception 'Operations source or charges changed';end if;
 select * into new_m from agent_missions where project_evidence->'continuation'->>'sourceMissionId'=source.id::text;
 if not found or new_m.deadline is distinct from source.deadline or new_m.token_allowance<>120000 or new_m.max_calls<>10 then raise exception 'Wrong continuation authority';end if;
 if (select count(*) from agent_missions where project_evidence->'continuation'->>'sourceMissionId'=source.id::text)<>1 then raise exception 'Duplicate operations continuation';end if;
 if (select count(*) from mission_assignments where mission_id=new_m.id and role='work' and status='queued')<>2 then raise exception 'Missing substantive trace workers';end if;
 if (select count(*) from mission_assignments where mission_id=new_m.id and status='completed')<>2 then raise exception 'Unexpected completed work invented';end if;
 if exists(select 1 from mission_assignments where mission_id=new_m.id and role='review' and result->>'verdict'='pass') then raise exception 'Review passed by recovery';end if;
 if (select dependencies from mission_assignments where mission_id=new_m.id and job_key='revision') is distinct from array['review','trace_facts','trace_challenge'] then raise exception 'Revision bypasses worker dependencies';end if;
 if (select result from mission_assignments where mission_id=new_m.id and job_key='compose') is distinct from (select result from mission_assignments where mission_id=source.id and job_key='compose') then raise exception 'Saved draft changed';end if;
 if not(new_m.project_evidence->'operationalBaseline' ? 'observedAt') then raise exception 'Actual baseline not retained';end if;
 if not exists(select 1 from executive_management_requests r,jsonb_array_elements(r.plan->'assignments') a where a->>'slug'='operations' and a->>'missionId'=new_m.id::text) then raise exception 'Parent did not follow continuation';end if;
end $$;
select 'Missing trace analysis continuation is bounded, idempotent and preserves saved draft, review and original charges.' as result;

-- Final comparison only: retain the revised artifact and reusable blind criteria.
update agent_missions set status='blocked',actual_tokens=115891,reserved_tokens=115891,calls=4 where id='e3139a58-27f7-4501-8045-ab969eded3fa';
update mission_assignments set status='completed',lease=null,lease_until=null,result='{"verdict":"changes_requested","findings":["Reclassify redaction artifact"],"checks":[]}' where mission_id='e3139a58-27f7-4501-8045-ab969eded3fa' and job_key='review';
insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,status,result,payload) values
 ('e3139a58-27f7-4501-8045-ab969eded3fa','revision','revise','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Resolve findings',array['review'],'completed','{"text":"Revised immutable source audit at 5a77c2564af6d0e8bc9de58b861205a9a30e2c98"}','{}'),
 ('e3139a58-27f7-4501-8045-ab969eded3fa','review_again','review','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Final independent review',array['revision'],'failed','{"admissionDenied":true}','{"reviewModelCheckpoint":{"hash":"saved","response":{"text":"Actual blind criteria"}},"operationalEvidenceSnapshot":{"kind":"scoped_workflow_trace","observedAt":"2026-10-24T16:31:40Z"}}');
update executive_delegations set status='cancelled' where mission_id='e3139a58-27f7-4501-8045-ab969eded3fa';
insert into executive_delegation_events(delegation_id,event,evidence,created_at) select id,'cancel','{"reason":"Mission did not pass independent review"}',now()+interval '2 seconds' from executive_delegations where mission_id='e3139a58-27f7-4501-8045-ab969eded3fa';
create table technical_before as select jsonb_build_object('mission',to_jsonb(m),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=m.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=m.id))) state from agent_missions m where id='e3139a58-27f7-4501-8045-ab969eded3fa';
-- Preserve newly completed operations worker analyses, then recover only finish stages.
update agent_missions set status='blocked',actual_tokens=108459,reserved_tokens=108459,calls=4 where id='6f48cceb-3657-4a56-8fdd-2b120012fc64';
update mission_assignments set status='completed',result=jsonb_build_object('text','Actual retained trace analysis '||job_key) where mission_id='6f48cceb-3657-4a56-8fdd-2b120012fc64' and role='work';
update mission_assignments set status='failed',result='{"admissionDenied":true}' where mission_id='6f48cceb-3657-4a56-8fdd-2b120012fc64' and job_key='revision';
update executive_delegations set status='cancelled' where mission_id='6f48cceb-3657-4a56-8fdd-2b120012fc64';
insert into executive_delegation_events(delegation_id,event,evidence,created_at) select id,'cancel','{"reason":"Mission did not pass independent review"}',now()+interval '3 seconds' from executive_delegations where mission_id='6f48cceb-3657-4a56-8fdd-2b120012fc64';
\ir ../../supabase/migrations/20261024164500_continue_saved_audit_completion.sql
\ir ../../supabase/migrations/20261024164500_continue_saved_audit_completion.sql

do $$
declare source agent_missions;new_m agent_missions;after_state jsonb;
begin
 select * into source from agent_missions where id='e3139a58-27f7-4501-8045-ab969eded3fa';
 select jsonb_build_object('mission',to_jsonb(source),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=source.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=source.id))) into after_state;
 if after_state is distinct from (select state from technical_before) then raise exception 'Technical source or charges changed';end if;
 select * into new_m from agent_missions where project_evidence->'savedAuditCompletion'->>'sourceMissionId'=source.id::text;
 if not found or new_m.deadline is distinct from source.deadline or new_m.token_allowance<>50000 or new_m.max_calls<>4 then raise exception 'Wrong final-review authority';end if;
 if (select count(*) from agent_missions where project_evidence->'savedAuditCompletion'->>'sourceMissionId'=source.id::text)<>1 then raise exception 'Duplicate review continuation';end if;
 if (select count(*) from mission_assignments where mission_id=new_m.id and status='queued' and job_key='review_again')<>1 or exists(select 1 from mission_assignments where mission_id=new_m.id and status<>'completed' and job_key<>'review_again') then raise exception 'Recovery buys repeated work';end if;
 if exists(select 1 from mission_assignments where mission_id=new_m.id and role='review' and result->>'verdict'='pass') then raise exception 'Review approved manually';end if;
 if (select result from mission_assignments where mission_id=new_m.id and job_key='revision') is distinct from (select result from mission_assignments where mission_id=source.id and job_key='revision') then raise exception 'Saved revision changed';end if;
 if (select payload->'reviewModelCheckpoint' from mission_assignments where mission_id=new_m.id and job_key='review_again') is distinct from (select payload->'reviewModelCheckpoint' from mission_assignments where mission_id=source.id and job_key='review_again') then raise exception 'Completed blind criteria lost';end if;
end $$;
select 'Final-review continuation retains all source work, charges, criteria and original deadline; only the remaining comparison is queued.' as result;

do $$
declare m agent_missions;
begin
 if (select count(*) from agent_missions where project_evidence ? 'savedAuditCompletion' and status='draft')<>2 then raise exception 'New work ran before matching runtime';end if;
 select * into m from agent_missions where project_evidence->'savedAuditCompletion'->>'sourceMissionId'='6f48cceb-3657-4a56-8fdd-2b120012fc64';
 if m.token_allowance<>80000 or m.max_calls<>6 or m.deadline is distinct from (select deadline from agent_missions where id='6f48cceb-3657-4a56-8fdd-2b120012fc64') then raise exception 'Operations finish authority changed';end if;
 if exists(select 1 from mission_assignments j join mission_assignments original on original.mission_id='6f48cceb-3657-4a56-8fdd-2b120012fc64' and original.job_key=j.job_key where j.mission_id=m.id and j.role='work' and (j.result is distinct from original.result or j.status<>'completed')) then raise exception 'Completed trace workers repeated or changed';end if;
 update executive_delegations set status='cancelled' where mission_id=m.id;
 if activate_saved_audit_completion()<>1 then raise exception 'Cancelled delegation resumed';end if;
 update executive_delegations set status='running' where mission_id=m.id;
 update agent_missions set deadline=now()-interval '1 minute' where id=m.id;
 if activate_saved_audit_completion()<>0 then raise exception 'Expired completion started';end if;
 update agent_missions set deadline=m.deadline where id=m.id;
 if activate_saved_audit_completion()<>1 or activate_saved_audit_completion()<>0 then raise exception 'Runtime start not idempotent';end if;
 if has_function_privilege('authenticated','activate_saved_audit_completion()','execute') then raise exception 'Runtime gate accessible to users';end if;
end $$;
select 'Matching runtime starts both saved audit completion stages exactly once.' as result;

-- Model-reviewed factual corrections and an exhausted empty response are distinct
-- failure shapes. Neither permits altering saved results or marking review passed.
update agent_missions set status='blocked',actual_tokens=43293,reserved_tokens=43293,calls=1 where id='3229be40-69ed-47c7-8057-d8c4e05394ef';
update mission_assignments set status='completed',result='{"verdict":"changes_requested","findings":["Correct three factual inaccuracies"],"checks":[]}' where mission_id='3229be40-69ed-47c7-8057-d8c4e05394ef' and job_key='review_again';
update agent_missions set status='blocked',actual_tokens=76456,reserved_tokens=76456,calls=2 where id='f8734d8d-7c2c-4fce-84d9-b1a6ba0ecca7';
update mission_assignments set status='failed',attempts=1,result='{"incompleteReason":"max_output_tokens","partialText":"","outputTokenLimit":12000}' where mission_id='f8734d8d-7c2c-4fce-84d9-b1a6ba0ecca7' and job_key='revision';
update executive_delegations set status='cancelled' where mission_id in('3229be40-69ed-47c7-8057-d8c4e05394ef','f8734d8d-7c2c-4fce-84d9-b1a6ba0ecca7');
insert into executive_delegation_events(delegation_id,event,evidence,created_at) select id,'cancel','{"reason":"Mission did not pass independent review"}',now()+interval '5 seconds' from executive_delegations where mission_id in('3229be40-69ed-47c7-8057-d8c4e05394ef','f8734d8d-7c2c-4fce-84d9-b1a6ba0ecca7');
create table correction_sources_before as select id,jsonb_build_object('mission',to_jsonb(m),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=m.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=m.id))) state from agent_missions m where id in('3229be40-69ed-47c7-8057-d8c4e05394ef','f8734d8d-7c2c-4fce-84d9-b1a6ba0ecca7');
\ir ../../supabase/migrations/20261024171000_continue_audit_factual_corrections.sql
\ir ../../supabase/migrations/20261024171000_continue_audit_factual_corrections.sql

do $$
declare source agent_missions;m agent_missions;after_state jsonb;candidate jsonb;
begin
 if (select count(*) from agent_missions where project_evidence ? 'savedAuditCorrections')<>2 then raise exception 'Duplicate corrective recovery';end if;
 for m in select * from agent_missions where project_evidence ? 'savedAuditCorrections' loop
  select * into source from agent_missions where id=(m.project_evidence->'savedAuditCorrections'->>'sourceMissionId')::uuid;
  select jsonb_build_object('mission',to_jsonb(source),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=source.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=source.id))) into after_state;
  if after_state is distinct from (select state from correction_sources_before where id=source.id) then raise exception 'Original source artifacts or charges mutated';end if;
  if m.status<>'draft' or m.deadline is distinct from source.deadline or m.calls<>0 or m.actual_tokens<>0 or m.reserved_tokens<>0 then raise exception 'Correction authority changed';end if;
  if exists(select 1 from mission_assignments where mission_id=m.id and role='review' and result->>'verdict'='pass') then raise exception 'Imported approval';end if;
  if (select count(*) from mission_assignments where mission_id=m.id and status='queued')<>2 then raise exception 'Repeated completed work';end if;
  if exists(select 1 from mission_assignments j join mission_assignments o on o.id=(j.payload->'reusedFrom'->>'assignmentId')::uuid where j.mission_id=m.id and j.result is distinct from o.result) then raise exception 'Reused artifact changed';end if;
  if source.id='3229be40-69ed-47c7-8057-d8c4e05394ef' then
   select result into candidate from mission_assignments where mission_id=source.id and job_key='revision';
   if (select result from mission_assignments where mission_id=m.id and job_key='compose') is distinct from candidate then raise exception 'Correction based on wrong draft';end if;
   if (select payload->>'revisionPatchBaseHash' from mission_assignments where mission_id=m.id and job_key='revision') is distinct from encode(sha256(convert_to(candidate->>'text','UTF8')),'hex') then raise exception 'Patch not bound to exact reviewed candidate';end if;
   if (select payload->'reviewModelCheckpoint' from mission_assignments where mission_id=m.id and job_key='review_again') is distinct from (select payload->'reviewModelCheckpoint' from mission_assignments where mission_id=source.id and job_key='review_again') then raise exception 'Blind criteria lost';end if;
  end if;
 end loop;
 if activate_saved_audit_completion()<>0 then raise exception 'Older runtime activated new work';end if;
 if activate_saved_audit_corrections()<>2 or activate_saved_audit_corrections()<>0 then raise exception 'Matching correction gate not idempotent';end if;
 if has_function_privilege('authenticated','activate_saved_audit_corrections()','execute') then raise exception 'Correction gate available to users';end if;
end $$;
select 'Targeted corrections preserve exact rejected candidate, real review, immutable work and all charges; empty-output recovery uses matching new runtime.' as result;

-- Latest live shapes: complete technical edits with truncated notes, and a real
-- operations rejection for measured length and causal overstatement.
update agent_missions set status='blocked',actual_tokens=94780,reserved_tokens=94780,calls=3 where id='d7050282-3f98-4809-86be-3811be11dff3';
update mission_assignments set status='failed',result=jsonb_build_object('incompleteReason','max_output_tokens','partialText','{"edits":[{"before":"Saved","after":"Corrected"}],"composerNotes":"'||repeat('notes',30)) where mission_id='d7050282-3f98-4809-86be-3811be11dff3' and job_key='revision';
update agent_missions set status='blocked',actual_tokens=104696,reserved_tokens=104696,calls=5 where id='f29d9d4c-583e-44dd-8a86-b173ede4407a';
update mission_assignments set status='completed',result='{"text":"Saved operations revision for narrow correction"}' where mission_id='f29d9d4c-583e-44dd-8a86-b173ede4407a' and job_key='revision';
update mission_assignments set status='completed',result='{"verdict":"changes_requested","findings":["1274 words exceeds 1200; recast causal certainty as hypotheses"]}' where mission_id='f29d9d4c-583e-44dd-8a86-b173ede4407a' and job_key='review_again';
update executive_delegations set status='cancelled' where mission_id in('d7050282-3f98-4809-86be-3811be11dff3','f29d9d4c-583e-44dd-8a86-b173ede4407a');
insert into executive_delegation_events(delegation_id,event,evidence,created_at) select id,'cancel','{"reason":"Mission did not pass independent review"}',now()+interval '7 seconds' from executive_delegations where mission_id in('d7050282-3f98-4809-86be-3811be11dff3','f29d9d4c-583e-44dd-8a86-b173ede4407a');
\ir ../../supabase/migrations/20261024174000_recover_complete_audit_edits.sql
\ir ../../supabase/migrations/20261024174000_recover_complete_audit_edits.sql

do $$declare m agent_missions;begin
 if (select count(*) from agent_missions where project_evidence ? 'savedAuditEffortRecovery')<>2 then raise exception 'Duplicate complete-edit recovery';end if;
 for m in select * from agent_missions where project_evidence ? 'savedAuditEffortRecovery' loop
  if m.status<>'draft' or m.deadline is distinct from (select deadline from agent_missions where id=(m.project_evidence->'savedAuditEffortRecovery'->>'sourceMissionId')::uuid) then raise exception 'Premature start or deadline change';end if;
  if exists(select 1 from mission_assignments a join mission_assignments o on o.id=(a.payload->'reusedFrom'->>'assignmentId')::uuid where a.mission_id=m.id and a.result is distinct from o.result) then raise exception 'Reused artifact changed';end if;
  if (select count(*) from mission_assignments where mission_id=m.id and status='queued')<>2 then raise exception 'Wrong recovery stages';end if;
  if m.token_allowance=50000 and (select result from mission_assignments where mission_id=m.id and job_key='revision') is distinct from (select result from mission_assignments where mission_id='d7050282-3f98-4809-86be-3811be11dff3' and job_key='revision') then raise exception 'Actual truncated response lost';end if;
 end loop;
 if activate_saved_audit_corrections()<>0 or activate_saved_audit_effort_recovery()<>2 or activate_saved_audit_effort_recovery()<>0 then raise exception 'Complete-edit runtime gate failed';end if;
 if has_function_privilege('authenticated','activate_saved_audit_effort_recovery()','execute') then raise exception 'Complete-edit gate exposed';end if;
end $$;
select 'Complete actual edits remain recoverable without inference; source artifacts, charges, deadlines and independent review retained.' as result;

-- Reproduce the exact next production failures. The source deadlines expired;
-- only a new bounded finishing mission may execute after the matching fixes.
update agent_missions set status='blocked',actual_tokens=41196,reserved_tokens=41196,calls=1,deadline=now()-interval '1 minute' where id='6e1d5b7e-e0cd-4158-86e4-2f53b72d934b';
update mission_assignments set status='completed',result='{"text":"Saved technically corrected report with immutable source SHA and current review findings"}' where mission_id='6e1d5b7e-e0cd-4158-86e4-2f53b72d934b' and job_key='revision';
update mission_assignments set status='completed',result='{"verdict":"changes_requested","findings":["Resolve effort label inconsistency and unsupported adjacency"]}' where mission_id='6e1d5b7e-e0cd-4158-86e4-2f53b72d934b' and job_key='review_again';
update agent_missions set status='blocked',actual_tokens=30503,reserved_tokens=30503,calls=3,deadline=now()-interval '1 minute' where id='c1d6ca76-dc21-4025-84bb-1d8a6a30e587';
update mission_assignments set status='completed',result='{"text":"Saved operations report with factual corrections but 1272 measured words"}' where mission_id='c1d6ca76-dc21-4025-84bb-1d8a6a30e587' and job_key='revision';
update mission_assignments set status='failed',attempts=2,result='{"reviewPhase":"assessment","detail":"Malformed JSON"}' where mission_id='c1d6ca76-dc21-4025-84bb-1d8a6a30e587' and job_key='review_again';
update executive_delegations set status='cancelled' where mission_id in('6e1d5b7e-e0cd-4158-86e4-2f53b72d934b','c1d6ca76-dc21-4025-84bb-1d8a6a30e587');
insert into executive_delegation_events(delegation_id,event,evidence,created_at) select id,'cancel','{"reason":"Mission did not pass independent review"}',now()+interval '9 seconds' from executive_delegations where mission_id in('6e1d5b7e-e0cd-4158-86e4-2f53b72d934b','c1d6ca76-dc21-4025-84bb-1d8a6a30e587');
create table contract_sources_before as select id,jsonb_build_object('mission',to_jsonb(m),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=m.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=m.id))) state from agent_missions m where id in('6e1d5b7e-e0cd-4158-86e4-2f53b72d934b','c1d6ca76-dc21-4025-84bb-1d8a6a30e587');
\ir ../../supabase/migrations/20261024181000_finish_audit_contract_repairs.sql
\ir ../../supabase/migrations/20261024181000_finish_audit_contract_repairs.sql

do $$declare m agent_missions;s agent_missions;after_state jsonb;begin
 if (select count(*) from agent_missions where project_evidence ? 'savedAuditContractRecovery')<>2 then raise exception 'Duplicate contract finishing mission';end if;
 if (select sum(token_allowance) from agent_missions where project_evidence ? 'savedAuditContractRecovery')<>130000 then raise exception 'Unbounded finishing capacity';end if;
 for m in select * from agent_missions where project_evidence ? 'savedAuditContractRecovery' loop
  select * into s from agent_missions where id=(m.project_evidence->'savedAuditContractRecovery'->>'sourceMissionId')::uuid;
  select jsonb_build_object('mission',to_jsonb(s),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=s.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=s.id))) into after_state;
  if after_state is distinct from (select state from contract_sources_before where id=s.id) then raise exception 'Expired source, artifacts or ledger changed';end if;
  if m.status<>'draft' or m.calls<>0 or m.actual_tokens<>0 or m.reserved_tokens<>0 or m.max_calls<>6 or m.deadline<=now() or m.deadline>now()+interval '61 minutes' then raise exception 'Finishing scope not bounded or premature execution';end if;
  if exists(select 1 from mission_assignments a join mission_assignments o on o.id=(a.payload->'reusedFrom'->>'assignmentId')::uuid where a.mission_id=m.id and a.result is distinct from o.result) then raise exception 'Saved artifact modified';end if;
  if (select result from mission_assignments where mission_id=m.id and job_key='compose') is distinct from (select result from mission_assignments where mission_id=s.id and job_key='revision') then raise exception 'Latest candidate not retained';end if;
  if (select count(*) from mission_assignments where mission_id=m.id and status='queued')<>2 or exists(select 1 from mission_assignments where mission_id=m.id and role='review' and result->>'verdict'='pass') then raise exception 'Review skipped or repeated work';end if;
  if (select payload->>'revisionPatchBaseHash' from mission_assignments where mission_id=m.id and job_key='revision') is distinct from (select encode(sha256(convert_to(result->>'text','UTF8')),'hex') from mission_assignments where mission_id=m.id and job_key='compose') then raise exception 'Wrong immutable patch base';end if;
 end loop;
 update executive_delegations set status='cancelled' where mission_id=m.id;
 if activate_saved_audit_contract_recovery()<>1 then raise exception 'Cancelled work started';end if;
 update executive_delegations set status='running' where mission_id=m.id;
 if activate_saved_audit_contract_recovery()<>1 or activate_saved_audit_contract_recovery()<>0 then raise exception 'Contract runtime gate not idempotent';end if;
 if has_function_privilege('authenticated','activate_saved_audit_contract_recovery()','execute') then raise exception 'Contract start gate exposed';end if;
end $$;
select 'Length/schema repair continuation preserves expired sources and charges, reuses latest actual candidates and requires fresh independent review.' as result;

-- Terminal technical review hit an uncertain long-running Pro request. The new
-- runtime excludes that synchronous transport mismatch and retains the hold.
update agent_missions set status='blocked',actual_tokens=27254,reserved_tokens=57491,calls=3,routing_calls=3 where id='07bb60f2-db69-4961-8ea6-20f7d883fa59';
update mission_assignments set id='a2d4c109-961e-4656-9164-5cde01651c8f',status='failed',attempts=1,result='{"admissionDenied":true}',payload=payload||'{"reviewModelCheckpoint":{"hash":"exact-current-contract","response":{"text":"Actual valid saved blind assessment","model":"claude-opus-5-5"}}}' where mission_id='07bb60f2-db69-4961-8ea6-20f7d883fa59' and job_key='review_again';
update mission_assignments set status='completed',result='{"text":"Final actual technical correction; source evidence unchanged"}' where mission_id='07bb60f2-db69-4961-8ea6-20f7d883fa59' and job_key='revision';
insert into mission_calls(id,job_id,status,reserved_tokens,actual_tokens) values('b32ede9b-c821-4074-bd2e-83f289e5174c','a2d4c109-961e-4656-9164-5cde01651c8f','uncertain',30237,null);
update agent_missions set status='blocked',actual_tokens=29052,reserved_tokens=29052,calls=2,routing_calls=1 where id='d0fde164-a838-4dea-843c-0b7a3c40614f';
update mission_assignments set id='a43dcd4c-96d2-40ab-908d-5ee8581f6f48',status='failed',attempts=1,result='{"incompleteReason":"max_output_tokens","partialText":"Changed partial response must NOT be resumed"}' where mission_id='d0fde164-a838-4dea-843c-0b7a3c40614f' and job_key='revision';
update executive_delegations set status='cancelled' where mission_id in('07bb60f2-db69-4961-8ea6-20f7d883fa59','d0fde164-a838-4dea-843c-0b7a3c40614f');
insert into executive_delegation_events(delegation_id,event,evidence,created_at) select id,'cancel','{"reason":"Mission did not pass independent review"}',now()+interval '11 seconds' from executive_delegations where mission_id in('07bb60f2-db69-4961-8ea6-20f7d883fa59','d0fde164-a838-4dea-843c-0b7a3c40614f');
create table terminal_sources_before as select id,jsonb_build_object('mission',to_jsonb(m),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=m.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=m.id))) state from agent_missions m where id in('07bb60f2-db69-4961-8ea6-20f7d883fa59','d0fde164-a838-4dea-843c-0b7a3c40614f');
\ir ../../supabase/migrations/20261024183000_resume_audit_partial_edits_and_review.sql
\ir ../../supabase/migrations/20261024183000_resume_audit_partial_edits_and_review.sql

do $$declare m agent_missions;s agent_missions;after_state jsonb;begin
 if (select count(*) from agent_missions where project_evidence ? 'savedAuditTerminalReview')<>1 then raise exception 'Duplicate terminal review';end if;
 select * into m from agent_missions where project_evidence ? 'savedAuditTerminalReview';
 if m.status<>'draft' or m.token_allowance<>50000 or m.max_calls<>3 or m.deadline is distinct from (select deadline from agent_missions where id='07bb60f2-db69-4961-8ea6-20f7d883fa59') then raise exception 'Terminal review authority changed';end if;
 if (select count(*) from mission_assignments where mission_id=m.id and status='queued')<>1 or (select status from mission_assignments where mission_id=m.id and job_key='revision')<>'completed' then raise exception 'Repeated completed correction';end if;
 if (select payload->'reviewModelCheckpoint' from mission_assignments where mission_id=m.id and job_key='review_again') is distinct from (select payload->'reviewModelCheckpoint' from mission_assignments where id='a2d4c109-961e-4656-9164-5cde01651c8f') then raise exception 'Completed blind criteria lost';end if;
 if resume_saved_partial_audit_edits()<>1 or resume_saved_partial_audit_edits()<>0 then raise exception 'Start gate accepted changed partial or repeated work';end if;
 for s in select * from agent_missions where id in('07bb60f2-db69-4961-8ea6-20f7d883fa59','d0fde164-a838-4dea-843c-0b7a3c40614f') loop
  select jsonb_build_object('mission',to_jsonb(s),'jobs',(select jsonb_agg(to_jsonb(j) order by id) from mission_assignments j where mission_id=s.id),'calls',(select jsonb_agg(to_jsonb(c) order by id) from mission_calls c where job_id in(select id from mission_assignments where mission_id=s.id))) into after_state;
  if after_state is distinct from (select state from terminal_sources_before where id=s.id) then raise exception 'Source artifacts, attempts, deadline or uncertain charge changed';end if;
 end loop;
 if has_function_privilege('authenticated','resume_saved_partial_audit_edits()','execute') then raise exception 'Partial recovery exposed';end if;
end $$;
select 'Only terminal comparison starts; uncertain charges and completed criteria remain exact, and a changed partial response cannot resume.' as result;

-- An approved sibling can release ONLY its unused allowance. The aggregate
-- ceiling, actual charges, historical holds, criteria and deadline are invariant.
alter table mission_assignments add column available_at timestamptz;
update agent_missions set status='completed',actual_tokens=40493,reserved_tokens=40493,calls=1,routing_calls=1 where id='e0d14a70-7499-4fa4-8b3a-886612aea2c1';
update mission_assignments set status='completed',result='{"verdict":"pass","findings":["Fixture independent review receipt"]}' where mission_id='e0d14a70-7499-4fa4-8b3a-886612aea2c1' and job_key='review_again';
update executive_delegations set status='verified' where mission_id='e0d14a70-7499-4fa4-8b3a-886612aea2c1';
update agent_missions set status='blocked',actual_tokens=49725,reserved_tokens=49725,calls=4,routing_calls=4 where id='d0fde164-a838-4dea-843c-0b7a3c40614f';
update mission_assignments set status='completed',result='{"text":"Actual saved short correction","revisionPatch":{"resultHash":"abab5e201c4e9d2904fe925972ea8a028a7660f5b3244e948983bb903479b16b"}}' where mission_id='d0fde164-a838-4dea-843c-0b7a3c40614f' and job_key='revision';
update mission_assignments set status='failed',attempts=1,result='{"admissionDenied":true}',payload=payload||'{"reviewModelCheckpoint":{"hash":"1066266dda95924c993a2c456a4b5ba4fb1be29ec8e9432ca4a4aaf58d9bba85","response":{"text":"Saved actual blind criteria"}}}' where mission_id='d0fde164-a838-4dea-843c-0b7a3c40614f' and job_key='review_again';
create table compact_before as select id,to_jsonb(m) state from agent_missions m where id in('e0d14a70-7499-4fa4-8b3a-886612aea2c1','d0fde164-a838-4dea-843c-0b7a3c40614f');
create table compact_jobs_before as select id,to_jsonb(j) state from mission_assignments j where mission_id in('e0d14a70-7499-4fa4-8b3a-886612aea2c1','d0fde164-a838-4dea-843c-0b7a3c40614f');
\ir ../../supabase/migrations/20261024185000_finish_audit_within_existing_ceiling.sql
do $$declare before_row record;after_row jsonb;begin
 update executive_delegations set status='verified' where mission_id='d0fde164-a838-4dea-843c-0b7a3c40614f';
 if resume_compact_audit_comparison()<>0 then raise exception 'Unexpected delegation resumed';end if;
 update executive_delegations set status='cancelled' where mission_id='d0fde164-a838-4dea-843c-0b7a3c40614f';
 if resume_compact_audit_comparison()<>1 or resume_compact_audit_comparison()<>0 then raise exception 'Bounded redistribution not idempotent';end if;
 if (select sum(token_allowance) from agent_missions where id in(select id from compact_before))<>120000 then raise exception 'Total budget increased';end if;
 if (select token_allowance from agent_missions where id='e0d14a70-7499-4fa4-8b3a-886612aea2c1')<>40493 or (select token_allowance from agent_missions where id='d0fde164-a838-4dea-843c-0b7a3c40614f')<>79507 then raise exception 'Wrong unused amount transferred';end if;
 for before_row in select * from compact_before loop
  select to_jsonb(m)-array['token_allowance','status','detail','updated_at'] into after_row from agent_missions m where id=before_row.id;
  if after_row is distinct from before_row.state-array['token_allowance','status','detail','updated_at'] then raise exception 'Deadline, accounting or saved mission output changed';end if;
 end loop;
 for before_row in select * from compact_jobs_before loop
  select to_jsonb(j)-array['status','available_at','detail','updated_at'] into after_row from mission_assignments j where id=before_row.id;
  if after_row is distinct from before_row.state-array['status','available_at','detail','updated_at'] then raise exception 'Attempts, criteria or artifact changed';end if;
 end loop;
 if (select status from mission_calls where id='b32ede9b-c821-4074-bd2e-83f289e5174c')<>'uncertain' then raise exception 'Prior uncertain charge altered';end if;
 if has_function_privilege('authenticated','resume_compact_audit_comparison()','execute') then raise exception 'Redistribution exposed';end if;
end $$;
select 'Unused sibling allowance is redistributed once, never increased; independent review remains mandatory and all charges and artifacts survive.' as result;
