-- Durable projects extend existing missions; all execution remains private.
create table public.work_projects (
 id uuid primary key, request_id text not null unique, actor_id uuid not null references actors(id),chat_id uuid not null references chats(id),
 objective text not null check(length(objective) between 1 and 8000),clarifications text not null default '',repository_id uuid references repo_sync_runs(id),
 team uuid[] not null, status text not null default 'running' check(status in ('running','awaiting_input','awaiting_approval','paused','blocked','stopped','completed')),
 phase text not null default 'research',repository_full_name text,spec jsonb,approval_hash text,approved_hash text,baseline_sha text,verified_sha text,preview jsonb,
 milestone_index integer not null default 0,cycles integer not null default 0,max_cycles integer not null default 8 check(max_cycles between 1 and 8),
 max_missions integer not null default 12 check(max_missions between 1 and 16),token_allowance integer not null default 600000 check(token_allowance between 60000 and 600000),
 active_mission_id uuid references agent_missions(id),lease uuid,lease_until timestamptz,failures integer not null default 0,
 deadline timestamptz not null default(now()+interval '72 hours'),detail text,result text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),foreign key(chat_id,actor_id) references chats(id,actor_id)
);
create unique index work_projects_active_chat on work_projects(chat_id) where status not in ('completed','stopped');
create table public.project_agents(actor_id uuid not null references actors(id),role text not null,agent_id uuid not null references managed_agents(id),primary key(actor_id,role));
create table public.project_runs(id uuid primary key default gen_random_uuid(),project_id uuid not null references work_projects(id),mission_id uuid not null unique references agent_missions(id),kind text not null,ordinal integer not null,milestone_index integer not null,binding jsonb,outcome jsonb,created_at timestamptz not null default now(),unique(project_id,ordinal));
create table public.project_events(id uuid primary key default gen_random_uuid(),project_id uuid not null references work_projects(id),event text not null,data jsonb not null,created_at timestamptz not null default now());
alter table public.agent_missions add column project_id uuid references work_projects(id),add column project_kind text,add column project_evidence jsonb;
create index project_mission_budget on agent_missions(project_id);
create index project_claim on work_projects(status,lease_until,updated_at);
create index project_history on project_events(project_id,created_at);
alter table work_projects enable row level security;alter table project_agents enable row level security;alter table project_runs enable row level security;alter table project_events enable row level security;
revoke all on work_projects,project_agents,project_runs,project_events from public,anon,authenticated,service_role;
grant select,insert,update on work_projects,project_agents,project_runs to service_role;grant select,insert on project_events to service_role;

create function public.project_canonical(v jsonb) returns text language plpgsql immutable strict security invoker set search_path=public as $$ declare t text;begin
 if jsonb_typeof(v)='object' then select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||project_canonical(value),',' order by key),'')||'}' into t from jsonb_each(v);return t;
 elsif jsonb_typeof(v)='array' then select '['||coalesce(string_agg(project_canonical(value),',' order by n),'')||']' into t from jsonb_array_elements(v) with ordinality e(value,n);return t;end if;return v::text;end $$;
create function public.project_publish(p_id uuid,p_text text) returns void language plpgsql security invoker set search_path=public as $$ declare p work_projects;mid uuid;begin
 select * into strict p from work_projects where id=p_id;mid:=md5(p.id::text||case when p_text like '<!-- katie-project-approval:%' then ':project-scope:'||p.approval_hash else ':project-progress' end)::uuid;
 insert into messages(id,actor_id,chat_id,role,content,created_at) values(mid,p.actor_id,p.chat_id,'assistant','<!-- katie-project-status:'||p.id||':'||p.status||' -->'||E'\n\n'||p_text,now())
 on conflict(id) do update set content=excluded.content,created_at=excluded.created_at;
 update chats set updated_at=now() where id=p.chat_id;
end $$;
create function public.create_work_project(p_id uuid,p_request text,p_actor uuid,p_chat uuid,p_objective text,p_repository uuid default null) returns jsonb language plpgsql security invoker set search_path=public as $$ declare p work_projects;role_name text;config jsonb;a jsonb;ids uuid[]:='{}';aid uuid;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 if not exists(select 1 from chats where id=p_chat and actor_id=p_actor) or exists(select 1 from managed_agents where actor_id=p_actor) then raise exception 'Project chat association denied';end if;
 select * into p from work_projects where id=p_id or request_id=p_request;
 if found then if p.id<>p_id or p.actor_id<>p_actor or p.chat_id<>p_chat or p.objective<>p_objective or p.repository_id is distinct from p_repository then raise exception 'Project request identity conflict';end if;return to_jsonb(p);end if;
 if p_repository is not null and not exists(select 1 from repo_sync_runs where id=p_repository) then raise exception 'Connected repository unavailable';end if;
 foreach role_name in array array['lead','research','development'] loop
  select agent_id into aid from project_agents where actor_id=p_actor and role=role_name;
  if aid is null then
   config:=jsonb_build_object('name','Project '||initcap(role_name),'instructions',case role_name when 'research' then 'Research primary evidence, distinguish facts and gaps, independently challenge unsupported conclusions. Do not invent findings or actions.' when 'development' then 'Implement approved project increments on isolated branches through existing independent testing and review. Preserve prior verified work. Run focused tests and actual approved browser acceptance. Never merge, deploy to production, modify secrets or expand approved scope.' else 'Manage the original user outcome. Preserve acceptance requirements across milestones. Deliver only evidence-backed integrated results; a plan or partial milestone is not project completion.' end,'research',role_name='research','development',role_name='development','attachments',false,'reviewMode','always','maxActiveTasks',1,'maxInputChars',16000);
   a:=save_managed_agent(null,config,false);aid:=(a->>'id')::uuid;insert into project_agents values(p_actor,role_name,aid);
  end if;
  if not exists(select 1 from managed_agents where id=aid and not archived) then raise exception 'A saved project agent was disabled; restore or replace it explicitly';end if;ids:=array_append(ids,aid);
 end loop;
 insert into work_projects(id,request_id,actor_id,chat_id,objective,repository_id,team,detail) values(p_id,p_request,p_actor,p_chat,p_objective,p_repository,ids,'Researching the requested outcome. No coding or production changes authorized yet.') returning * into p;
 insert into project_events(project_id,event,data) values(p.id,'created',jsonb_build_object('objective',p.objective,'repository',p.repository_id));return to_jsonb(p);
end $$;
create function public.control_work_project(p_id uuid,p_actor uuid,p_chat uuid,p_action text,p_text text default '',p_hash text default null,p_repository uuid default null) returns jsonb language plpgsql security invoker set search_path=public as $$ declare p work_projects;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));select * into strict p from work_projects where id=p_id and actor_id=p_actor and chat_id=p_chat for update;
 if p_action='status' then return to_jsonb(p);end if;
 if p_action='amend' and p.status not in ('completed','stopped') then
  if length(trim(p_text)) not between 1 and 4000 or length(p.clarifications)+length(p_text)>8000 then raise exception 'Clarification exceeds project context limit';end if;
  if p.active_mission_id is not null then
   perform control_mission(p.active_mission_id,'stop');
   update project_runs set outcome=jsonb_build_object('superseded',true,'reason','Explicit user clarification requires revised scope approval') where mission_id=p.active_mission_id and outcome is null;
  end if;
  update work_projects set clarifications=clarifications||E'\nUSER AMENDMENT: '||p_text,approved_hash=null,approval_hash=null,spec=null,phase='research',status='running',active_mission_id=null,lease=null,lease_until=null,milestone_index=0,detail='Your project clarification is saved. I will revise research/specification and request a new scope approval; prior work and charges are preserved.',updated_at=now() where id=p.id;
 elsif p_action in ('pause','stop') and p.status not in ('completed','stopped') then
  update work_projects set status=case when p_action='pause' then 'paused' else 'stopped' end,lease=null,lease_until=null,detail='Project '||p_action||'d. An already admitted external dispatch may still finish; no new work will be authorized.',updated_at=now() where id=p.id;
  update mission_assignments set status=case when role='development' and exists(select 1 from agent_tasks where id=mission_assignments.id) then 'waiting_external' else 'queued' end,lease=null,lease_until=null where mission_id=p.active_mission_id and status='running';
 elsif p_action='resume' and p.status in ('paused','blocked') and p.deadline>now() then
  if p.active_mission_id is not null and exists(select 1 from agent_missions where id=p.active_mission_id and (status in ('blocked','stopped') or deadline<=now())) then raise exception 'This milestone is blocked or expired. Explain the blocker before asking for a revised project scope; budgets are not reset by resume';end if;
  update work_projects set status='running',failures=0,detail='Resuming the saved project and its existing budgets.',updated_at=now() where id=p.id;
 elsif p_action='approve' and p.status='awaiting_approval' and p_hash=p.approval_hash and p.repository_id is not null and p.baseline_sha~'^[a-f0-9]{40}$' and p.deadline>now() then
  update work_projects set approved_hash=approval_hash,status='running',phase='development',milestone_index=0,active_mission_id=null,detail='Approved scoped project. Successive isolated draft increments and preview verification are authorized; production merge is not.',updated_at=now() where id=p.id;
 elsif p_action='answer' and p.status in ('awaiting_input','awaiting_approval') and p.approved_hash is null then
  if length(trim(p_text)) not between 1 and 4000 or length(p.clarifications)+length(p_text)>8000 then raise exception 'Clarification exceeds project context limit';end if;
  if p_repository is not null and not exists(select 1 from repo_sync_runs where id=p_repository) then raise exception 'Connected repository unavailable';end if;
  update work_projects set clarifications=clarifications||E'\nUSER CLARIFICATION: '||p_text,repository_id=coalesce(p_repository,repository_id),status='running',phase=case when spec is not null and p_repository is not null and trim(p_text)=(select repository_full_name from repo_sync_runs where id=p_repository) then 'approval' when spec is not null then 'specification' else 'research' end,active_mission_id=null,approval_hash=null,lease=null,lease_until=null,detail='Incorporating your clarification before scope approval.',updated_at=now() where id=p.id;
 else raise exception 'Project action is unavailable or approval is stale';end if;
 insert into project_events(project_id,event,data) values(p.id,p_action,jsonb_build_object('text',p_text,'approval_hash',p_hash,'previous_status',p.status));
 select * into strict p from work_projects where id=p.id;perform project_publish(p.id,coalesce(p.detail,p.status));return to_jsonb(p);
end $$;
create function public.claim_work_project() returns jsonb language plpgsql security invoker set search_path=public as $$ declare p work_projects;expired uuid;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 for expired in update work_projects set status='blocked',detail='Project deadline reached; partial work and charges are preserved.',lease=null,lease_until=null where status='running' and deadline<=now() returning id loop perform project_publish(expired,'The project deadline was reached. Partial work is saved; this project is not complete.');end loop;
 select * into p from work_projects where status='running' and (lease_until is null or lease_until<=now()) order by updated_at limit 1 for update skip locked;
 if not found then return null;end if;
 update work_projects set lease=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now() where id=p.id returning * into p;return to_jsonb(p);
end $$;
create function public.finish_work_project(p_id uuid,p_lease uuid,p_action text,p_data jsonb default '{}') returns boolean language plpgsql security invoker set search_path=public as $$ declare p work_projects;mid uuid;kind text;seq integer;contract jsonb;binding jsonb;dev uuid;lead uuid;reviewer uuid;goal text;scope_data jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));select * into p from work_projects where id=p_id for update;
 if not found or p.status<>'running' or p.lease is distinct from p_lease or p.lease_until<=now() or p.deadline<=now() then return false;end if;
 if p_action='child' then
  if p.active_mission_id is not null then raise exception 'A milestone is already bound';end if;
  seq:=(select count(*)+1 from project_runs where project_id=p.id);if seq>p.max_missions then update work_projects set status='blocked',detail='Project milestone allowance exhausted.' where id=p.id;else
   kind:=p_data->>'kind';goal:=p_data->>'objective';if kind is distinct from p.phase or kind not in ('research','specification','development','assessment') or length(goal) not between 1 and 12000 then raise exception 'Invalid project milestone';end if;
   if kind='development' and (p.approved_hash is distinct from p.approval_hash or p.approved_hash is null or p.cycles>=p.max_cycles or p.phase<>'development') then raise exception 'Approved coding allowance required';end if;
   mid:=gen_random_uuid();perform create_mission(mid,goal,p.team,120,case when kind='development' then p.repository_id else null end);
   if length(coalesce((p_data->'evidence')::text,''))>30000 then raise exception 'Project evidence exceeds bounded context; narrow the acceptance package without dropping original requirements';end if;
   update agent_missions set project_id=p.id,project_kind=kind,project_evidence=p_data->'evidence' where id=mid;perform control_mission(mid,'start');
   if kind='development' then
    contract:=p.spec->'milestones'->p.milestone_index->'contract';if contract is null then raise exception 'Approved milestone contract missing';end if;
    binding:=jsonb_build_object('version',1,'projectId',p.id,'baseSha',coalesce(p.verified_sha,p.baseline_sha),'baselineSha',p.baseline_sha,'allowedPaths',p.spec->'allowedPaths','contractHash',encode(sha256(convert_to(project_canonical(contract),'UTF8')),'hex'),'contract',contract,'scopeHash',p.approved_hash);
    update agent_missions set deadline=p.deadline where id=mid;
    update mission_assignments set status='completed',result='{"output":"Server-owned approved project milestone; no planning inference was claimed."}' where mission_id=mid and job_key='plan';
    lead:=p.team[1];reviewer:=p.team[2];dev:=p.team[3];
    insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload) values(mid,'implement','development',dev,'Implement the approved milestone in the full mission objective. Preserve all previous verified work. Run focused checks and satisfy the approved browser contract. Deliver an isolated draft PR only.','{}','{"capability":"development"}'),(mid,'compose','compose',lead,'Report the actual verified milestone result, draft PR, immutable commit and browser checks concisely. Do not reconstruct code or invent actions.',array['implement'],'{}'),(mid,'review','review',reviewer,'Verify the actual approved milestone against its original scope and immutable external evidence.',array['compose'],'{}');
    update work_projects set cycles=cycles+1 where id=p.id;
   end if;
   insert into project_runs(project_id,mission_id,kind,ordinal,milestone_index,binding) values(p.id,mid,kind,seq,p.milestone_index,binding);
   update work_projects set active_mission_id=mid,detail='Working on '||kind||' milestone.',updated_at=now() where id=p.id;
  end if;
 elsif p_action='spec' then
  if p.phase<>'approval' and not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed') then raise exception 'Reviewed specification required';end if;
  if p.approved_hash is not null then raise exception 'Approved specification is immutable';end if;
  update project_runs set outcome=jsonb_build_object('specification_reviewed',true) where mission_id=p.active_mission_id and outcome is null;
  scope_data:=jsonb_build_object('objective',p.objective,'clarifications',p.clarifications,'spec',p_data->'spec','repository',p.repository_id,'repository_name',(select repository_full_name from repo_sync_runs where id=p.repository_id),'baseline',p_data->>'baseline','max_cycles',p.max_cycles,'max_missions',p.max_missions,'token_allowance',p.token_allowance,'deadline',p.deadline);
  update work_projects set spec=p_data->'spec',repository_full_name=(select repository_full_name from repo_sync_runs where id=p.repository_id),baseline_sha=p_data->>'baseline',approval_hash=encode(sha256(convert_to(project_canonical(scope_data),'UTF8')),'hex'),active_mission_id=null,status=case when repository_id is null then 'awaiting_input' else 'awaiting_approval' end,phase='approval',detail=p_data->>'detail' where id=p.id;
 elsif p_action='advance' then
  if not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed') then raise exception 'Reviewed milestone completion required';end if;
  update project_runs set outcome=p_data where mission_id=p.active_mission_id and outcome is null;
  if p.phase='development' then
   if p_data->>'head'!~'^[a-f0-9]{40}$' or not exists(
    select 1 from mission_assignments j join project_runs r on r.mission_id=j.mission_id where j.mission_id=p.active_mission_id and j.role='development' and j.status='completed'
    and r.binding->>'scopeHash'=p.approved_hash and j.result->'verification'->>'testedHeadSha'=p_data->>'head' and j.result->'verification'->>'reviewedHeadSha'=p_data->>'head'
    and j.result->'verification'->>'observedHeadSha'=p_data->>'head'
    and j.result->'verification'->'projectAcceptance'->>'passed'='true'
    and j.result->'verification'->'projectAcceptance'->>'headSha'=p_data->>'head'
    and j.result->'verification'->'projectAcceptance'->>'contractHash'=r.binding->>'contractHash'
    and j.result->'verification'->'projectAcceptance'->>'projectId'=p.id::text
   ) then raise exception 'Immutable reviewed head and approved browser evidence required';end if;
   update work_projects set verified_sha=p_data->>'head',milestone_index=milestone_index+1,phase=case when milestone_index+1>=jsonb_array_length(spec->'milestones') then 'delivery' else 'development' end,active_mission_id=null,detail='Verified coding increment saved.' where id=p.id;
  elsif p.phase='research' then update work_projects set phase='specification',active_mission_id=null,detail='Research reviewed. Developing the specification.' where id=p.id;
  else raise exception 'Unsupported milestone progression';end if;
 elsif p_action='preview' then
  if p.phase<>'delivery' or p_data->>'headSha' is distinct from p.verified_sha or not exists(select 1 from project_runs r join agent_missions m on m.id=r.mission_id where r.project_id=p.id and r.kind='development' and m.status='completed' and r.outcome->>'head'=p.verified_sha) then raise exception 'Verified integrated preview required';end if;
  update work_projects set preview=p_data,phase='assessment',detail='Preview verified. Performing whole-project assessment.' where id=p.id;
 elsif p_action='complete' then
  if p.phase<>'assessment' or p.preview->>'headSha' is distinct from p.verified_sha or not exists(select 1 from agent_missions where id=p.active_mission_id and status='completed' and length(result)>0) or exists(select 1 from project_runs r join agent_missions m on m.id=r.mission_id where r.project_id=p.id and r.kind='development' and r.outcome is null and m.status<>'blocked') then raise exception 'Independent integrated project assessment required';end if;
  update project_runs set outcome=p_data where mission_id=p.active_mission_id;update work_projects set status='completed',result=p_data->>'result',detail='Integrated result independently approved and delivered to the original chat.' where id=p.id;
 elsif p_action in ('block','input','retry','wait','error') then
  if p_action='retry' then
   if p.cycles>=p.max_cycles then update work_projects set status='blocked',detail='Project coding-cycle allowance exhausted.' where id=p.id;else
    update project_runs set outcome=p_data where mission_id=p.active_mission_id and outcome is null;
    update work_projects set phase='development',milestone_index=least(milestone_index,jsonb_array_length(spec->'milestones')-1),active_mission_id=null,detail=p_data->>'detail' where id=p.id;
   end if;
  elsif p_action='error' then update work_projects set failures=failures+1,status=case when failures>=2 then 'blocked' else status end,detail=p_data->>'detail' where id=p.id;
  elsif p_action='input' then update work_projects set status='awaiting_input',detail=p_data->>'detail' where id=p.id;
  elsif p_action='block' then update work_projects set status='blocked',detail=p_data->>'detail' where id=p.id;
  else update work_projects set detail=coalesce(p_data->>'detail',detail) where id=p.id;end if;
 else raise exception 'Unknown project outcome';end if;
 insert into project_events(project_id,event,data) values(p.id,p_action,p_data);
 update work_projects set lease=null,lease_until=null,failures=case when p_action='error' then failures else 0 end,updated_at=now() where id=p.id;
 select * into strict p from work_projects where id=p.id;
 if p.status='awaiting_approval' and p.spec is not null then perform project_publish(p.id,project_scope_proposal(p.id));elsif p_action<>'wait' or p.status<>'running' then perform project_publish(p.id,coalesce(p.result,p.detail,p.status));end if;
 return true;
end $$;
revoke all on function project_canonical(jsonb),project_publish(uuid,text),create_work_project(uuid,text,uuid,uuid,text,uuid),control_work_project(uuid,uuid,uuid,text,text,text,uuid),claim_work_project(),finish_work_project(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function project_canonical(jsonb),project_publish(uuid,text),create_work_project(uuid,text,uuid,uuid,text,uuid),control_work_project(uuid,uuid,uuid,text,text,text,uuid),claim_work_project(),finish_work_project(uuid,uuid,text,jsonb) to service_role;

create or replace function public.claim_mission_work() returns jsonb
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments;m agent_missions;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 -- One bounded global claim lock; no overlapping cron can exceed three workers.
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.claim',0));
 update agent_missions set status='blocked',detail='Mission deadline reached. Inspect partial results; no new work will start.',updated_at=now() where status in ('running','awaiting_approval') and deadline<=now();
 update mission_assignments j0 set status=case when attempts<2 then 'queued' else 'failed' end,lease=null,lease_until=null,detail='Worker lease expired; prior model-call reservation remains charged.',updated_at=now()
 where j0.status='running' and lease_until<=now();
 update agent_missions m0 set status='blocked',detail='An assignment exhausted recovery attempts.',updated_at=now() where m0.status='running' and exists(select 1 from mission_assignments a where a.mission_id=m0.id and a.status='failed');
 if (select count(*) from mission_assignments a join agent_missions b on b.id=a.mission_id where a.status='running' and a.lease_until>now() and b.status in ('running','awaiting_approval'))>=3 then return null; end if;
 select a.* into j from mission_assignments a join agent_missions b on b.id=a.mission_id
 where b.status='running' and (b.project_id is null or exists(select 1 from work_projects p where p.id=b.project_id and p.status='running' and p.active_mission_id=b.id and p.deadline>now())) and a.status in ('queued','waiting_external') and a.available_at<=now()
 and active_managed_work(a.agent_id,a.id) < least((select (v->'config'->>'maxActiveTasks')::integer from jsonb_array_elements(b.team) v where v->>'id'=a.agent_id::text),(select (config->>'maxActiveTasks')::integer from managed_agents where id=a.agent_id))
 and not exists(select 1 from unnest(a.dependencies) dep where not exists(select 1 from mission_assignments d where d.mission_id=a.mission_id and d.job_key=dep and d.status='completed'))
 order by a.created_at,a.job_key limit 1 for update of a skip locked;
 if not found then return null; end if;
 select * into m from agent_missions where id=j.mission_id for update;
 if m.status<>'running' or m.deadline<=now() then return null; end if;
 perform 1 from managed_agents where id=j.agent_id for update;
 if active_managed_work(j.agent_id,j.id)>=least((select (v->'config'->>'maxActiveTasks')::integer from jsonb_array_elements(m.team) v where v->>'id'=j.agent_id::text),(select (config->>'maxActiveTasks')::integer from managed_agents where id=j.agent_id)) then return null; end if;
 update mission_assignments set status='running',attempts=case when status='waiting_external' then attempts else attempts+1 end,lease=gen_random_uuid(),lease_until=now()+interval '6 minutes',heartbeat_at=now(),updated_at=now() where id=j.id returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'mission',to_jsonb(m));
end $$;

create or replace function public.reserve_mission_call(p_id uuid,p_lease uuid,p_call uuid,p_model text,p_tokens integer) returns boolean
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments;m agent_missions;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id;
 if not found then return false; end if;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into j from mission_assignments where id=p_id for update;
 if m.project_id is not null and not exists(select 1 from work_projects p where p.id=m.project_id and p.status='running' and p.active_mission_id=m.id and p.deadline>now()) then return false;end if;
 if m.status not in ('running','awaiting_approval') or m.deadline<=now() or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then return false; end if;
 if p_tokens not between 1 and 120000 or exists(select 1 from mission_calls where id=p_call) then return false; end if;
 if m.calls>=m.max_calls or greatest(m.reserved_tokens,m.actual_tokens)+p_tokens>m.token_allowance then
  update agent_missions set status='blocked',detail='Model-call or reserved token allowance exhausted. Inspect partial results.',updated_at=now() where id=m.id;
  return false;
 end if;
 if m.project_id is not null and (select coalesce(sum(greatest(reserved_tokens,actual_tokens)),0) from agent_missions where project_id=m.project_id)+p_tokens>(select token_allowance from work_projects where id=m.project_id) then update work_projects set status='blocked',detail='Total project model-token allowance exhausted; previous usage remains charged.' where id=m.project_id;perform project_publish(m.project_id,'The project model-token allowance is exhausted. Partial work and charges are preserved; this project is not complete.');return false;end if;
 insert into mission_calls(id,job_id,lease,model,reserved_tokens) values(p_call,j.id,p_lease,p_model,p_tokens);
 update agent_missions set calls=calls+1,reserved_tokens=reserved_tokens+p_tokens,updated_at=now() where id=m.id;
 update mission_assignments set heartbeat_at=now(),lease_until=now()+interval '6 minutes' where id=j.id;
 return true;
end $$;

create or replace function public.commit_mission_work(p_id uuid,p_lease uuid,p_result jsonb,p_children jsonb default '[]',p_status text default 'completed',p_mission_status text default null,p_final text default null) returns boolean
language plpgsql security invoker set search_path=public as $$
declare j mission_assignments;m agent_missions;c jsonb; n integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id;
 if not found then return false; end if;
 select * into m from agent_missions where id=j.mission_id for update;
 select * into j from mission_assignments where id=p_id for update;
 if m.project_id is not null and not exists(select 1 from work_projects p where p.id=m.project_id and p.status='running' and p.active_mission_id=m.id and p.deadline>now()) then return false;end if;
 if m.status not in ('running','awaiting_approval') or m.deadline<=now() or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() then return false; end if;
 if p_status not in ('completed','waiting_external','awaiting_approval','failed','queued') or (p_mission_status is not null and p_mission_status not in ('completed','blocked','awaiting_approval')) then raise exception 'Invalid outcome'; end if;
 if jsonb_typeof(p_children)<>'array' or jsonb_array_length(p_children)>6 then raise exception 'Invalid children'; end if;
 n:=(select count(*) from mission_assignments where mission_id=m.id and role<>'plan');
 if n+jsonb_array_length(p_children)>6 then raise exception 'Assignment limit reached'; end if;
 for c in select value from jsonb_array_elements(p_children) loop
  if not exists(select 1 from jsonb_array_elements(m.team) a where a->>'id'=c->>'agent_id') then raise exception 'Agent outside saved team'; end if;
  insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,dependencies,payload)
  values(m.id,c->>'key',c->>'role',(c->>'agent_id')::uuid,c->>'instruction',array(select jsonb_array_elements_text(coalesce(c->'dependencies','[]'))),coalesce(c->'payload','{}'));
 end loop;
 -- Every dependency must be in this mission. Planner validates acyclicity too.
 if exists(select 1 from mission_assignments a,unnest(a.dependencies) d where a.mission_id=m.id and (d=a.job_key or not exists(select 1 from mission_assignments b where b.mission_id=m.id and b.job_key=d))) then raise exception 'Invalid dependency'; end if;
 if p_status='awaiting_approval' then perform public.prepare_mission_development(j.id,p_lease);p_mission_status:='awaiting_approval'; end if;
 update mission_assignments set status=p_status,result=p_result,detail=p_result->>'detail',lease=null,lease_until=null,available_at=now()+interval '1 minute',updated_at=now() where id=j.id;
 if p_status='failed' then p_mission_status:='blocked'; end if;
 if p_mission_status='completed' and (j.role<>'review' or p_result->>'verdict' is distinct from 'pass' or p_status<>'completed' or coalesce(length(p_final),0)=0 or exists(select 1 from mission_assignments where mission_id=m.id and status<>'completed')) then raise exception 'Verified deliverable required'; end if;
 update agent_missions set status=coalesce(p_mission_status,status),result=coalesce(p_final,result),detail=coalesce(p_result->>'detail',detail),updated_at=now() where id=m.id;
 return true;
end $$;

-- The full proposal is delivered in the same transaction as the approval state.
-- A crash between specification commit and UI publication cannot strand a scope.
create function public.project_scope_proposal(p_id uuid) returns text language plpgsql security invoker set search_path=public as $$ declare p work_projects;begin
 select * into strict p from work_projects where id=p_id;
 return '<!-- katie-project-approval:'||p.approval_hash||' -->'||E'\n\n**'||(p.spec->>'name')||E'**\n'||(p.spec->>'summary')||E'\n\nOriginal outcome: '||p.objective||E'\n'||p.clarifications||E'\n\n**Exact project specification and browser contracts**\n```json\n'||jsonb_pretty(p.spec)||E'\n```\n\nRepository: '||coalesce(p.repository_full_name,'No target selected')||E'\nRepository snapshot: '||coalesce(p.baseline_sha,'No target selected')||E'\nLimits: '||p.max_cycles||' coding jobs; '||p.max_missions||' milestones; '||p.token_allowance||' aggregate project-model tokens; deadline '||p.deadline||E'.\nGitHub coding usage is additional under its existing per-job time and repair limits. Approval permits scoped isolated draft changes and existing private Preview delivery. No production merge, purchases, new services, credentials, or dependency/deployment configuration changes are authorized.\n\nReply **approve project '||left(p.approval_hash,12)||'** to authorize this saved scope once.';
end $$;
revoke all on function project_scope_proposal(uuid) from public,anon,authenticated;
grant execute on function project_scope_proposal(uuid) to service_role;

-- Linearize project dispatch admission with stop/pause, scope and lease checks.
-- Once admitted, an in-flight request can finish; no stale worker can admit one.
create function public.claim_project_dispatch(p_id uuid,p_lease uuid,p_hash text) returns boolean language plpgsql security invoker set search_path=public as $$ declare j mission_assignments;m agent_missions;p work_projects;t agent_tasks;r project_runs;begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into j from mission_assignments where id=p_id for update;if not found then return false;end if;
 select * into m from agent_missions where id=j.mission_id;select * into p from work_projects where id=m.project_id for update;select * into r from project_runs where mission_id=m.id;
 if p.id is null or p.status<>'running' or p.active_mission_id<>m.id or p.deadline<=now() or m.status<>'running' or m.deadline<=now() or j.role<>'development' or j.status<>'running' or j.lease is distinct from p_lease or j.lease_until<=now() or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash or p.approved_hash is distinct from p_hash or r.binding->>'scopeHash' is distinct from p_hash then return false;end if;
 select * into t from agent_tasks where id=p_id for update;
 if not found or t.kind<>'development' or t.status<>'dispatching' or t.external ? 'attempted' or t.repository_id is distinct from p.repository_id or t.repository_full_name is distinct from p.repository_full_name then return false;end if;
 if not exists(select 1 from managed_agents a where a.id=t.agent_id and not archived and (a.config->>'development')::boolean) then return false;end if;
 update agent_tasks set external=jsonb_build_object('attempted',true,'projectId',p.id),updated_at=now() where id=p_id;
 insert into project_events(project_id,event,data) values(p.id,'dispatch_admitted',jsonb_build_object('task',p_id,'lease',p_lease,'scope',p_hash));return true;
end $$;
revoke all on function claim_project_dispatch(uuid,uuid,text) from public,anon,authenticated;
grant execute on function claim_project_dispatch(uuid,uuid,text) to service_role;

create or replace function public.claim_agent_dispatch(p_id uuid) returns boolean
language plpgsql security invoker set search_path=public as $$
declare t agent_tasks;
begin
 if exists(select 1 from mission_assignments j join project_runs r on r.mission_id=j.mission_id where j.id=p_id) then return false;end if;
 select * into t from agent_tasks where id=p_id for update;
 if not found or t.kind<>'development' or t.status<>'dispatching' or t.external ? 'attempted' then return false; end if;
 perform 1 from chats c join managed_agents a on a.id=t.agent_id where c.id=t.chat_id and c.actor_id=t.actor_id and a.actor_id=t.actor_id;
 if not found then raise exception 'Task association invalid'; end if;
 update agent_tasks set external=jsonb_build_object('attempted',true),updated_at=now() where id=p_id;
 return true;
end $$;

-- Read-only bounded recovery cannot preempt ordinary mission scheduling.
create function public.project_dispatch_recovery_candidates() returns jsonb language sql stable security invoker set search_path=public as $$
 select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from (select id,external from agent_tasks where status in ('submitted','dispatching') and external ? 'projectId' order by updated_at limit 20) t;
$$;
revoke all on function project_dispatch_recovery_candidates() from public,anon,authenticated;
grant execute on function project_dispatch_recovery_candidates() to service_role;
