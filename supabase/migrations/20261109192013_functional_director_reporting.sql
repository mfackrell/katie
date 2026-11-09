-- Correct the executive reporting boundary without modifying released M1 history.
-- Fail closed if an existing organization violates it; never silently reparent work.
do $$ begin
 if exists(select 1 from project_organization_nodes ch left join project_organization_nodes p on p.id=ch.parent_id
 where ch.kind<>'project_director' and (p.id is null or p.project_id<>ch.project_id or p.kind='worker' or ch.kind='worker' and p.kind<>'manager'))
 then raise exception 'Existing organization violates Functional Director reporting; explicit remediation required';end if;
end $$;
alter table project_organization_nodes add column completion_submission jsonb;

create function project_org_reporting_guard() returns trigger language plpgsql set search_path=public as $$
declare parent project_organization_nodes;begin
 if new.kind<>'project_director' then
 select * into parent from project_organization_nodes where id=new.parent_id;
 if parent.id is null or parent.project_id<>new.project_id or parent.kind='worker'
 or new.kind='worker' and parent.kind<>'manager' then
 raise exception 'Execution workers must report to a Functional Director; only management may report to Project Director';end if;
 end if;
 return new;
end $$;
create trigger project_org_reporting before insert or update on project_organization_nodes for each row execute function project_org_reporting_guard();

-- A component submission is separate from its superior's acceptance. It is tied
-- to the current leader, scope, head, contract and accepted subordinate evidence.
create function project_org_component_fingerprint(p_node uuid) returns text language sql stable security definer set search_path=public as $$
 with recursive subtree as (
 select id,parent_id,agent_id,kind,status,evidence,management_contract from project_organization_nodes where parent_id=p_node
 union all select x.id,x.parent_id,x.agent_id,x.kind,x.status,x.evidence,x.management_contract from project_organization_nodes x join subtree t on x.parent_id=t.id
 ) select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(subtree) order by id),'[]'::jsonb)::text,'UTF8')),'hex') from subtree
$$;
create function project_org_invalidate_submission() returns trigger language plpgsql set search_path=public as $$
begin
 if new.status='active' or new.parent_id is distinct from old.parent_id or new.agent_id is distinct from old.agent_id or new.scope_hash is distinct from old.scope_hash then new.completion_submission:=null;end if;
 return new;
end $$;
create trigger project_org_submission_invalidate before update of status,evidence,parent_id,agent_id,scope_hash on project_organization_nodes for each row execute function project_org_invalidate_submission();
revoke all on function project_org_reporting_guard(),project_org_component_fingerprint(uuid),project_org_invalidate_submission() from public,anon,authenticated,service_role;

create or replace function project_org_decide(p_job uuid,p_lease uuid,p_commands jsonb) returns boolean
language plpgsql security definer set search_path=public as $$
declare n project_organization_nodes; p work_projects; c jsonb; ch project_organization_nodes; a jsonb;
 allocated bigint; mid uuid; eid uuid; ev jsonb; did uuid; sibling uuid; evidence_id uuid;
begin
 n:=project_org_principal(p_job,p_lease);select * into p from work_projects where id=n.project_id;
 if jsonb_typeof(p_commands)<>'array' or jsonb_array_length(p_commands) not between 1 and 16 then raise exception 'Bounded management commands required';end if;
 insert into project_organization_decisions(project_id,node_id,assignment_id,decision) values(p.id,n.id,p_job,p_commands) returning id into did;
 for c in select value from jsonb_array_elements(p_commands) loop
 if n.kind='project_director' and ((c->>'action'='appoint' and c->>'kind' is distinct from 'manager') or c->>'action'='assign') then
 raise exception 'Project Director may commission only Functional Directors and cannot assign execution work';end if;
 if c->>'action'='plan' then
 if length(coalesce(c->>'purpose','')) not between 1 and 8000 or length(coalesce(c->>'direction','')) not between 1 and 8000
 or jsonb_typeof(c->'outcomes') is distinct from 'array' or jsonb_array_length(c->'outcomes')<1
 or jsonb_typeof(c->'milestones') is distinct from 'array' or jsonb_array_length(c->'milestones')<1
 or jsonb_typeof(c->'organizations') is distinct from 'array' or (n.kind='project_director' and jsonb_array_length(c->'organizations')<1)
 or exists(select 1 from jsonb_array_elements(c->'outcomes') o where length(coalesce(o->>'criterion',''))=0 or length(coalesce(o->>'verification',''))=0)
 or exists(select 1 from jsonb_array_elements_text(c->'organizations') x where length(coalesce(x,''))=0)
 or (select count(distinct x) from jsonb_array_elements_text(c->'organizations') x)<>jsonb_array_length(c->'organizations')
 or exists(select 1 from jsonb_array_elements(c->'milestones') x where length(coalesce(x->>'objective',''))=0)
 then raise exception 'Purpose, direction and measurable success criteria required';end if;
 insert into project_organization_plans values(n.id,encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex'),c->>'purpose',c->>'direction',c->'outcomes',c->'milestones',c->'organizations',now())
 on conflict(node_id) do update set objective_hash=excluded.objective_hash,purpose=excluded.purpose,direction=excluded.direction,outcomes=excluded.outcomes,milestones=excluded.milestones,organizations=excluded.organizations,updated_at=now();
 elsif c->>'action'='appoint' then
 if c->>'kind' is null or c->>'kind' not in ('manager','worker') or length(coalesce(c->>'name','')) not between 1 and 80 or length(coalesce(c->>'objective','')) not between 1 and 8000
 or jsonb_typeof(c->'acceptance') is distinct from 'array' or jsonb_array_length(c->'acceptance') not between 1 and 30
 or coalesce(c->>'tokens','')!~'^[1-9][0-9]{0,11}$' or jsonb_typeof(c->'tools') is distinct from 'array' or jsonb_typeof(c->'paths') is distinct from 'array'
 then raise exception 'Invalid appointment contract';end if;
 if (c->>'deadline')::timestamptz>least(n.deadline,p.deadline) or (c->>'deadline')::timestamptz<=now() or c->>'deadline' is null
 then raise exception 'Organizational or deadline limit exceeded';end if;
 select coalesce(sum(token_limit),0) into allocated from project_organization_nodes where parent_id=n.id;
 if allocated+(c->>'tokens')::bigint+(select coalesce(sum(greatest(call.reserved_tokens,coalesce(call.actual_tokens,0))),0) from mission_calls call join project_organization_assignments b on b.assignment_id=call.job_id where b.node_id=n.id)>n.token_limit then raise exception 'Child resources exceed parent';end if;
 if exists(select 1 from jsonb_array_elements_text(c->'tools') t where not t=any(n.tools))
 or exists(select 1 from jsonb_array_elements_text(c->'tools') t where t is null) or exists(select 1 from jsonb_array_elements_text(c->'paths') x where x is null or x~'(^|/)\.\.?(/|$)' or x~'^/')
 or exists(select 1 from jsonb_array_elements_text(c->'paths') x where not exists(select 1 from unnest(case when n.kind='project_director' then coalesce(array(select jsonb_array_elements_text(p.spec->'allowedPaths')),n.scope_paths) else coalesce((select g.paths from project_organization_scope_grants g where g.node_id=n.id and g.scope_hash=p.approved_hash),n.scope_paths) end) prefix where x=prefix or right(prefix,1)='/' and starts_with(x,prefix)))
 then raise exception 'Child authority exceeds parent';end if;
 if ((c->>'area'='quality_assurance') or exists(with recursive ancestors(id,parent_id,area) as(select n.id,n.parent_id,n.area union all select x.id,x.parent_id,x.area from project_organization_nodes x join ancestors a on x.id=a.parent_id) select 1 from ancestors where area='quality_assurance')) and (c->'tools')?'development' then raise exception 'Independent QA cannot inherit implementation authority';end if;

 if c->>'reuseAgentId' is not null then
 if c->>'kind'<>'worker' or not (c->>'reuseAgentId')::uuid=any(p.team) then raise exception 'Only existing execution team may be reused';end if;
 a:=jsonb_build_object('id',c->>'reuseAgentId');
 else
 a:=save_managed_agent(null,jsonb_build_object('name',c->>'name','instructions',c->>'objective','research',c->>'kind'='worker' and (c->'tools')?'research','development',c->>'kind'='worker' and (c->'tools')?'development','attachments',false,'reviewMode','always','maxActiveTasks',1,'maxInputChars',16000),false);
 end if;
 insert into project_organization_nodes(project_id,parent_id,agent_id,kind,name,objective,acceptance,scope_paths,tools,token_limit,deadline,depth,scope_hash,decision_needed,area,management_contract)
 values(p.id,n.id,(a->>'id')::uuid,c->>'kind',c->>'name',c->>'objective',c->'acceptance',array(select jsonb_array_elements_text(c->'paths')),array(select jsonb_array_elements_text(c->'tools')),(c->>'tokens')::bigint,(c->>'deadline')::timestamptz,n.depth+1,p.approved_hash,c->>'kind'='manager',coalesce(c->>'area',n.area),jsonb_build_object('purpose',coalesce(c->>'purpose',c->>'objective'),'objectives',jsonb_build_array(c->>'objective'),'deliverables',coalesce(c->'deliverables',c->'acceptance'),'acceptance',c->'acceptance','interfaces',coalesce(c->'interfaces','[]'::jsonb),'reporting',coalesce(c->>'reporting','Certify verified outcomes and escalate material exceptions to the immediate superior')));
 elsif c->>'action' in ('replace_leader','reorganize') then
 if length(coalesce(c->>'reason','')) not between 1 and 2000 then raise exception 'Management change requires a recorded reason';end if;
 perform project_org_restructure(n.id,c);
 elsif c->>'action'='reject' then
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id;
 if ch.id is null or length(coalesce(c->>'findings','')) not between 1 and 4000 then raise exception 'Rejection requires a direct component and objective findings';end if;
 update project_organization_nodes set status='active',evidence=null,decision_needed=(kind<>'worker') where id=ch.id;
 insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail) values(p.id,ch.id,case when ch.kind='worker' then n.id else ch.id end,'routine',c->>'findings');
 elsif c->>'action'='grant_scope' then
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id and project_id=p.id;
 if ch.id is null or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash or jsonb_typeof(c->'paths') is distinct from 'array' or jsonb_array_length(c->'paths')<1
 or exists(select 1 from jsonb_array_elements_text(c->'paths') path where path is null or path~'(^|/)\.\.?(/|$)' or not exists(select 1 from project_organization_scope_grants g,unnest(g.paths) prefix where g.node_id=n.id and g.scope_hash=p.approved_hash and (path=prefix or right(prefix,1)='/' and starts_with(path,prefix))))
 then raise exception 'Scope grant exceeds approved parent';end if;
 insert into project_organization_scope_grants values(ch.id,p.approved_hash,array(select jsonb_array_elements_text(c->'paths')),n.id);
 update project_organization_nodes set decision_needed=kind<>'worker',status='active',evidence=null where id=ch.id;
 elsif c->>'action'='assign' then
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id and kind='worker' and deadline>now();
 if ch.id is null or c->>'capability' is null or c->>'capability' not in ('analysis','research','writing','repository_review')
 or not (case when c->>'capability'='writing' then 'analysis' else c->>'capability' end)=any(ch.tools)
 then raise exception 'Worker assignment outside delegated authority';end if;
 if exists(select 1 from project_organization_work where node_id=ch.id and status in ('queued','running')) then raise exception 'Worker already has outstanding work';end if;
 insert into project_organization_work(project_id,node_id,decision_id,capability,instruction) values(p.id,ch.id,did,c->>'capability',c->>'instruction');
 update project_organization_nodes set status='active',evidence=null where id=ch.id;
 elsif c->>'action'='dependency' then
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id;
 select id into sibling from project_organization_nodes where id=(c->>'dependsOn')::uuid and parent_id=n.id;
 if ch.id is null or sibling is null or ch.id=sibling then raise exception 'Dependencies require direct sibling organizations';end if;
 if exists(with recursive edges(id) as (select sibling union select d.depends_on from project_organization_dependencies d join edges e on d.node_id=e.id) select 1 from edges where id=ch.id) then raise exception 'Circular dependency';end if;
 insert into project_organization_dependencies values(p.id,ch.id,sibling) on conflict do nothing;
 if project_org_dependencies_cyclic(p.id) then raise exception 'Circular inherited dependency';end if;
 elsif c->>'action'='exception' then
 -- Routine problems stay local. Escalation moves exactly one reporting level.
 insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail)
 values(p.id,n.id,case when c->>'reason'='routine' then n.id else coalesce(n.parent_id,n.id) end,c->>'reason',c->>'detail');
 if c->>'reason'<>'routine' and n.parent_id is not null then update project_organization_nodes set decision_needed=true where id=n.parent_id;end if;
 elsif c->>'action'='resolve' then
 if not exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id join project_organization_assignments b on b.assignment_id=j.id
 where j.id=(c->>'assignmentId')::uuid and j.status='completed' and m.status='completed' and m.project_id=p.id and j.result is not null and b.node_id in(with recursive tree(id) as(select n.id union all select x.id from project_organization_nodes x join tree t on x.parent_id=t.id) select id from tree)) then raise exception 'Exception resolution requires authenticated subordinate evidence';end if;
 update project_organization_exceptions set status='resolved',resolution=c->>'evidence' where id=(c->>'exceptionId')::uuid and owner_id=n.id and status='open' and length(coalesce(c->>'evidence','')) between 1 and 2000;
 if not found then raise exception 'Exception belongs to another manager or lacks evidence';end if;
 elsif c->>'action'='escalate' then
 update project_organization_exceptions set owner_id=coalesce(n.parent_id,n.id),status=case when n.parent_id is null then 'owner_required' else 'open' end
 where id=(c->>'exceptionId')::uuid and owner_id=n.id and status='open' and reason<>'routine';
 if not found then raise exception 'Escalation outside reporting line';end if;
 if n.parent_id is not null then update project_organization_nodes set decision_needed=true where id=n.parent_id;end if;
 elsif c->>'action' in ('certify','submit_component') then
 if c->>'action'='submit_component' then
 if n.kind<>'manager' or c->>'nodeId' is not null then raise exception 'Only the responsible Functional Director may submit its own component';end if;
 select * into ch from project_organization_nodes where id=n.id;
 else
 select * into ch from project_organization_nodes where id=(c->>'nodeId')::uuid and parent_id=n.id and project_id=p.id;
 end if;
 if ch.id is null or exists(select 1 from project_organization_nodes where parent_id=ch.id and status<>'accepted')
 or exists(select 1 from project_organization_dependencies d join project_organization_nodes x on x.id=d.depends_on where d.node_id=ch.id and x.status<>'accepted') then raise exception 'Component or dependency incomplete';end if;
 evidence_id:=(c->>'assignmentId')::uuid;
 select jsonb_build_object('assignmentId',j.id,'result',j.result,'scopeHash',p.approved_hash,'head',p.verified_sha) into ev
 from mission_assignments j join agent_missions m on m.id=j.mission_id
 join project_organization_assignments b on b.assignment_id=j.id
 where j.id=evidence_id and exists(select 1 from project_organization_nodes source where source.id=b.node_id and source.kind='worker') and j.status='completed' and m.project_id=p.id and m.status='completed'
 and b.node_id in (with recursive tree(id) as (select ch.id union all select x.id from project_organization_nodes x join tree on x.parent_id=tree.id) select id from tree) and (ch.kind<>'worker' or b.contract_hash=encode(sha256(convert_to(project_canonical(ch.acceptance),'UTF8')),'hex')) and j.result is not null and (p.approved_hash is null or exists(select 1 from project_runs r where r.mission_id=m.id and r.binding->>'scopeHash'=p.approved_hash and (p.verified_sha is null or r.outcome->>'head'=p.verified_sha or m.project_kind<>'development')) or (m.project_kind in ('organization_work','assessment') and m.project_evidence->>'approvedScopeHash'=p.approved_hash and (m.project_kind<>'assessment' or m.project_evidence->'preview'=p.preview)));
 if ev is null then raise exception 'Authenticated component evidence required';end if;
 if jsonb_typeof(c->'checks') is distinct from 'array' or jsonb_array_length(c->'checks')<>jsonb_array_length(ch.acceptance)
 or exists(select 1 from jsonb_array_elements_text(ch.acceptance) criterion where not exists(select 1 from jsonb_array_elements(c->'checks') check_item where check_item->>'criterion'=criterion and check_item->>'passed'='true' and check_item->>'assignmentId'=evidence_id::text and length(coalesce(check_item->>'evaluation',''))>0))
 then raise exception 'Every original delegated criterion requires an evidence-backed evaluation';end if;
 ev:=ev||jsonb_build_object('checks',c->'checks','contractHash',encode(sha256(convert_to(project_canonical(ch.management_contract),'UTF8')),'hex'));
 if c->>'action'='submit_component' then
 if not exists(select 1 from project_organization_nodes where parent_id=ch.id) then raise exception 'Directorate submission requires accepted subordinate deliverables';end if;
 update project_organization_nodes set completion_submission=ev||jsonb_build_object('leaderId',n.agent_id,'decisionId',did,'subtreeHash',project_org_component_fingerprint(ch.id)) where id=ch.id;
 update project_organization_nodes set decision_needed=true where id=n.parent_id;
 else
 if ch.kind='manager' and (ch.completion_submission is null
 or ch.completion_submission->>'leaderId' is distinct from ch.agent_id::text
 or ch.completion_submission->>'contractHash' is distinct from ev->>'contractHash'
 or ch.completion_submission->>'assignmentId' is distinct from evidence_id::text
 or ch.completion_submission->'result' is distinct from ev->'result'
 or ch.completion_submission->>'scopeHash' is distinct from p.approved_hash
 or ch.completion_submission->>'head' is distinct from p.verified_sha
 or ch.completion_submission->>'subtreeHash' is distinct from project_org_component_fingerprint(ch.id))
 then raise exception 'Current responsible director component submission required before superior acceptance';end if;
 if ch.kind='manager' then ev:=ev||jsonb_build_object('directorSubmission',ch.completion_submission);end if;
 update project_organization_nodes set status='accepted',evidence=ev,decision_needed=false where id=ch.id;
 end if;
 elsif c->>'action'='close' then
 if n.kind<>'project_director' or p.phase<>'assessment' or p.approved_hash is null or p.approved_hash is distinct from p.approval_hash or p.verified_sha is null then raise exception 'Only the Project Director may authorize closure';end if;
 if exists(select 1 from project_organization_nodes where project_id=p.id and parent_id is not null and status<>'accepted')
 or not exists(select 1 from project_organization_nodes where parent_id=n.id and kind='manager' and area='quality_assurance' and status='accepted')
 or exists(select 1 from project_organization_exceptions where project_id=p.id and status<>'resolved') then raise exception 'Organizations or exceptions remain incomplete';end if;
 select (m.project_evidence->>'previousMissionId')::uuid into mid from agent_missions m join mission_assignments j on j.mission_id=m.id where j.id=p_job;
 if not exists(select 1 from agent_missions m join mission_assignments j on j.mission_id=m.id
 where m.id=mid and m.project_id=p.id and m.project_kind='assessment' and m.status='completed'
 and m.project_evidence->>'approvedScopeHash'=p.approved_hash and m.project_evidence->'approvedFinalContract'=p.spec->'finalContract'
 and m.project_evidence->'preview'=p.preview and j.role='review' and j.status='completed' and j.result->>'verdict'='pass'
 and jsonb_array_length(j.result->'checks')=6 and (select count(distinct x->>'id') from jsonb_array_elements(j.result->'checks') x)=6 and not exists(select 1 from jsonb_array_elements(j.result->'checks') x where x->>'passed' is distinct from 'true')
 and exists(select 1 from project_organization_nodes qa where qa.parent_id=n.id and qa.area='quality_assurance' and qa.kind='manager' and qa.status='accepted'
 and qa.evidence->>'assignmentId'=j.id::text and qa.evidence->>'head'=p.verified_sha and qa.evidence->>'scopeHash'=p.approved_hash
 and exists(select 1 from project_organization_assignments b where b.assignment_id=j.id and b.node_id in(with recursive tree(id) as(select qa.id union all select x.id from project_organization_nodes x join tree t on x.parent_id=t.id) select id from tree)))
 and exists(select 1 from mission_assignments writer where writer.mission_id=m.id and writer.role='compose' and writer.agent_id<>j.agent_id and writer.status='completed'))
 then raise exception 'Independent original-requirement QA evidence required';end if;
 if exists(select 1 from mission_calls call join mission_assignments j on j.id=call.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id and (call.status<>'completed' or call.actual_tokens is null or call.organization_exposure_microusd is null)) then raise exception 'Unresolved project financial exposure';end if;
 if exists(select 1 from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id where a.developer_project_id=p.id and c.state<>'settled') then raise exception 'Unresolved native financial exposure';end if;
 if exists(select 1 from benchmark_budget_calls c join benchmark_budget_accounts a on a.id=c.account_id left join benchmark_dollar_exposures e on e.call_id=c.id where a.developer_project_id=p.id and e.call_id is null) then raise exception 'Missing financial exposure evidence';end if;
 insert into project_organization_closures(project_id,director_id,decision_id,scope_hash,head_sha,receipt)
 values(p.id,n.id,did,p.approved_hash,p.verified_sha,jsonb_build_object('assessmentMissionId',mid,'components',(select jsonb_agg(jsonb_build_object('nodeId',id,'evidence',evidence)) from project_organization_nodes where project_id=p.id and parent_id is not null),'missionTokens',(select coalesce(sum(c.actual_tokens),0) from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id),'settledMissionCostUpperBoundMicrousd',(select coalesce(sum(c.organization_exposure_microusd),0) from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=p.id),'nativeRecordedExposureMicrousd',(select coalesce(sum(e.exposure_microusd),0) from benchmark_dollar_exposures e join benchmark_budget_calls c on c.id=e.call_id join benchmark_budget_accounts a on a.id=e.account_id where a.developer_project_id=p.id and c.legacy_mission_call_id is null),'unsettledCalls',0,'costBasis','Mission amounts are conservative verified-price bounds, not supplier invoice amounts')) on conflict do nothing;
 elsif c->>'action'='ready' then
 if n.kind='project_director' and not project_org_plan_ready(n.id) then raise exception 'Director must establish its purpose and justified functional organizations';end if;
 else raise exception 'Unsupported management action';end if;
 end loop;
 update project_organization_nodes set decision_needed=(kind='project_director' and not project_org_plan_ready(n.id)) where id=n.id;
 if n.parent_id is not null and exists(select 1 from project_organization_nodes where parent_id=n.id) and not exists(select 1 from project_organization_nodes where parent_id=n.id and status<>'accepted') then
 update project_organization_nodes set decision_needed=true where id=n.parent_id;
 end if;
 select mission_id into mid from mission_assignments where id=p_job;
 update mission_assignments set status='completed',result=jsonb_build_object('decisionId',did,'output','Management decision recorded'),lease=null,lease_until=null where id=p_job;
 update agent_missions set status='completed',result='Management decisions committed' where id=mid;
 update work_projects set active_mission_id=(select (project_evidence->>'previousMissionId')::uuid from agent_missions where id=mid) where id=p.id;
 return true;
end $$;
