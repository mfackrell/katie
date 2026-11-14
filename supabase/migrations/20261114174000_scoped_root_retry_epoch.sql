begin;

-- Only owner-ratified development creates a new management decision epoch.
-- Preserve every historical failure, but count the retries for the approved
-- objective from its immutable ratification, not from earlier pre-scope runs.
-- No changes to worker, provider, spending, leasing or reporting permissions.
do $patch$
declare
 body text;
 original text := 'if (select count(*) from agent_missions where project_id=p.id and project_kind=''management'' and project_evidence->>''organizationNodeId''=n.id::text and status in (''blocked'',''stopped''))>=2 then';
 replacement text := 'if (select count(*) from agent_missions where project_id=p.id and project_kind=''management'' and project_evidence->>''organizationNodeId''=n.id::text and status in (''blocked'',''stopped'') and (not project_provider_mode(p.id) or p.phase<>''development'' or p.approved_hash is null or created_at>=coalesce((select max(s.approved_at) from project_scope_ratification_approvals s where s.project_id=p.id and s.scope_hash=p.approved_hash),''-infinity''::timestamptz)))>=2 then';
begin
 body := pg_get_functiondef('public.project_org_schedule_hierarchy(uuid,uuid)'::regprocedure);
 if (length(body)-length(replace(body,original,'')))/length(original)<>1 then
   raise exception 'Unexpected installed management retry contract';
 end if;
 execute replace(body,original,replacement);
end
$patch$;

-- One audited recovery for an existing Project Director that was prematurely
-- blocked by historical (pre-ratification) failure counts. Never reset attempts,
-- rewrite decisions, expand authority, alter budgets or manually call a worker.
create function public.project_org_resume_scoped_root_retry(
 p_owner uuid,p_project uuid,p_new_release text,p_expected_release text,
 p_scope_hash text,p_source_mission uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
declare
 p work_projects; a project_provider_execution; root project_organization_nodes;
 source agent_missions; rat project_scope_ratification_approvals;
 failures integer; used integer; stamp timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 select * into p from work_projects where id=p_project for update;
 select * into a from project_provider_execution where project_id=p_project for update;
 select * into root from project_organization_nodes
  where project_id=p_project and kind='project_director'
  and parent_id is null and status='active' for update;
 select * into source from agent_missions where id=p_source_mission and project_id=p_project for update;
 select * into rat from project_scope_ratification_approvals
  where project_id=p_project and scope_hash=p_scope_hash;
 if p.id is null or p_owner is null or a.owner_id is distinct from p_owner
    or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
    or p_new_release is null or p_new_release !~ '^[a-f0-9]{40}$'
    or p_expected_release is null or p_expected_release !~ '^[a-f0-9]{40}$'
    or p_new_release=p_expected_release
    or p_scope_hash is null or p_scope_hash !~ '^[a-f0-9]{64}$'
 then raise exception 'Authenticated, exact-release project owner approval required';end if;

 select count(*) into failures from agent_missions m
  where m.project_id=p.id and m.project_kind='management'
   and m.project_evidence->>'organizationNodeId'=root.id::text
   and m.status in ('blocked','stopped') and m.created_at>=rat.approved_at;
 select count(*) into used from agent_missions m where m.project_id=p.id;

 if p.organization_version<>1 or not project_provider_mode(p.id)
    or p.status<>'blocked' or p.phase<>'development'
    or p.detail is distinct from 'Project management cannot achieve its objective within bounded retry authority'
    or p.active_mission_id is distinct from p_source_mission
    or p.lease is not null or p.lease_until is not null
    or p.deadline<=clock_timestamp()+interval '5 minutes'
    or p.approval_hash is distinct from p_scope_hash
    or p.approved_hash is distinct from p_scope_hash or a.approved_scope is distinct from p_scope_hash
    or a.deadline is distinct from p.deadline or a.continuation_release_sha is distinct from p_expected_release
    or a.continued_at is null or not project_provider_continued(p.id)
    or root.id is null or not root.decision_needed or root.deadline<p.deadline
    or rat.proposal_id is null or source.id is null
    or source.project_kind<>'management'
    or source.project_evidence->>'organizationNodeId' is distinct from root.id::text
    or source.status<>'blocked' or source.created_at<rat.approved_at
    or failures<>1 or used>=p.max_missions
    or not exists(select 1 from mission_assignments j
       where j.mission_id=source.id and j.status='failed'
         and j.result->'managementCommandRejection'->>'code'='director_appointment')
    or (select count(*) from project_organization_scope_grants g
        join project_organization_nodes n on n.id=g.node_id where n.project_id=p.id)<>1
    or not exists(select 1 from project_organization_scope_grants g
        where g.node_id=root.id and g.scope_hash=p_scope_hash and g.parent_id is null)
    or not exists(select 1 from project_organization_nodes n where n.parent_id=root.id and n.area='game_delivery' and n.management_level='functional_director' and n.status='active' and not('development'=any(n.tools)))
    or exists(select 1 from project_work_packages where project_id=p.id)
    or exists(select 1 from agent_missions where project_id=p.id and status in ('draft','running','awaiting_approval'))
    or project_provider_request_pending(p.id)
    or exists(select 1 from project_events
        where project_id=p.id and event='scoped_root_retry_authorized'
          and data->>'sourceMissionId'=p_source_mission::text)
 then raise exception 'Original scoped root-retry evidence or authority changed';end if;

 stamp:=clock_timestamp();
 update work_projects set status='running',lease=null,lease_until=null,
  detail='Scoped Project Director retry authorized after preserving pre-ratification failures',
  updated_at=stamp where id=p.id;
 insert into project_events(project_id,event,data) values(
  p.id,'scoped_root_retry_authorized',
  jsonb_build_object('ownerId',p_owner,'newReleaseSha',p_new_release,
   'continuationReleaseSha',p_expected_release,'scopeHash',p_scope_hash,
   'sourceMissionId',p_source_mission,'approvedAt',rat.approved_at,
   'scopedRootFailures',failures,'historicalMissions',used,
   'maxMissions',p.max_missions,'deadline',p.deadline,
   'preservedActiveMissionId',p_source_mission,'authorizedAt',stamp)
 );
 return jsonb_build_object('projectId',p.id,'status','running',
  'sourceMissionId',p_source_mission,'newReleaseSha',p_new_release,
  'scopedRootFailures',failures,'historicalMissions',used,'authorizedAt',stamp);
end
$fn$;

revoke all on function public.project_org_resume_scoped_root_retry(uuid,uuid,text,text,text,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.project_org_resume_scoped_root_retry(uuid,uuid,text,text,text,uuid) to service_role;
commit;
