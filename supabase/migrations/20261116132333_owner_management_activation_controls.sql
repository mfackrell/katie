begin;
-- Read-only owner preflight. No new table, scope or resource authority.
create function public.project_org_management_activation_offer(p_owner uuid,p_project uuid,p_release text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p work_projects;a project_provider_execution;s agent_missions;r project_paused_window_renewals;
 resume project_management_resume_receipts;used integer;stage text;
begin
 select * into p from work_projects where id=p_project;
 select * into a from project_provider_execution where project_id=p_project;
 if p.id is null or p_owner is null or a.owner_id is distinct from p_owner
 or not standalone_verify_scope(p_owner,p.actor_id,p.chat_id)
 then raise exception 'Authenticated original project owner required';end if;
 if p_release is null or p_release !~ '^[a-f0-9]{40}$' then raise exception 'Exact active release required';end if;
 select * into s from agent_missions where id=p.active_mission_id and project_id=p.id;
 select * into r from project_paused_window_renewals where project_id=p.id;
 select * into resume from project_management_resume_receipts where project_id=p.id;
 select count(*) into used from agent_missions where project_id=p.id;
 -- A recorded resume is status evidence, never a fresh execution command.
 if resume.project_id is not null then
  if r.authorization_id is null or r.owner_id<>p_owner or r.release_sha<>p_release
   or resume.owner_id<>p_owner or resume.window_id<>r.authorization_id or resume.source_mission_id<>r.source_mission_id
   or resume.release_sha<>r.release_sha or resume.prior_release_sha<>r.prior_release_sha
   or resume.scope_hash<>r.scope_hash or resume.cutoff<>r.cutoff
   or p.approved_hash is distinct from r.scope_hash or p.max_missions<>96 or p.token_allowance<>600000
  then raise exception 'Recorded management resume does not match this release';end if;
  return jsonb_build_object('projectId',p.id,'stage','resumed','releaseSha',p_release,'cutoff',r.cutoff,
   'sourceMissionId',r.source_mission_id,'windowId',r.authorization_id,'authorizationId',r.authorization_id,
   'scopeHash',r.scope_hash,'stateHash',project_org_hierarchy_recovery_state(p.id),'status',p.status,
   'maxMissions',p.max_missions,'tokenAllowance',p.token_allowance,'historicalMissions',used,'nodeCount',r.node_count);
 end if;
 if p.status<>'paused' or p.phase<>'development' or p.organization_version<>1
 or p.lease is not null or p.lease_until is not null
 or p.max_missions<>96 or p.token_allowance<>600000 or used>=96
 or p.approved_hash is null or p.approval_hash is distinct from p.approved_hash or a.approved_scope is distinct from p.approved_hash
 or a.deadline is distinct from p.deadline or a.objective_hash is distinct from encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex')
 or not project_provider_continued(p.id) or s.id is null or s.status<>'blocked' or s.project_kind<>'management'
 or not exists(select 1 from project_organization_nodes n join project_organization_assignments b on b.node_id=n.id
  join mission_assignments j on j.id=b.assignment_id where n.project_id=p.id and n.id::text=s.project_evidence->>'organizationNodeId'
  and n.kind='manager' and n.status='active' and j.mission_id=s.id and j.status='failed')
 or (select count(*) from project_organization_nodes where project_id=p.id)<>13
 or not exists(select 1 from project_organization_nodes where project_id=p.id and kind='project_director' and parent_id is null and token_limit=600000)
 or exists(select 1 from project_organization_nodes n where n.project_id=p.id and (n.status<>'active' or n.deadline is distinct from p.deadline
  or (n.parent_id is not null and not exists(select 1 from project_organization_nodes parent where parent.id=n.parent_id
   and parent.project_id=p.id and parent.depth=n.depth-1 and n.tools<@parent.tools))))
 or exists(with recursive qa as (select id from project_organization_nodes where project_id=p.id and area in ('independent_qa','quality_assurance')
  union all select n.id from project_organization_nodes n join qa on n.parent_id=qa.id)
  select 1 from qa join project_organization_nodes n on n.id=qa.id where 'development'=any(n.tools))
 or exists(select 1 from project_work_packages where project_id=p.id)
 or exists(select 1 from agent_missions where project_id=p.id and status in ('draft','running','awaiting_approval'))
 or exists(select 1 from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=p.id and j.status in ('queued','running','waiting_external'))
 or exists(select 1 from project_organization_work where project_id=p.id and status in ('queued','running'))
 or project_provider_request_pending(p.id)
 then raise exception 'Paused project, scope, work or preserved resource contracts changed';end if;
 if r.authorization_id is null then
  if s.project_evidence->>'providerContinuationRelease' is distinct from a.continuation_release_sha
   or s.project_evidence->>'providerContinuationWindow' is distinct from a.window_id::text
   or s.project_evidence->>'providerContinuationDecision' is distinct from a.continuation_decision_id::text
   or not project_org_window_authorized(p.id,p_owner,a.continuation_release_sha,a.continuation_decision_id,p.deadline)
  then raise exception 'Original management source or execution window changed';end if;
  stage:='renew';
 else
  if r.owner_id<>p_owner or r.release_sha<>p_release or r.authorization_id<>a.window_id
   or r.cutoff is distinct from p.deadline or r.scope_hash is distinct from p.approved_hash
   or r.historical_missions<>used or r.source_mission_id<>s.id
   or not project_org_renewed_management_source(p.id,p_owner,s.id,a.window_id,r.prior_release_sha,p_release,p.approved_hash,p.deadline)
   or (select count(*) from project_organization_contract_changes where project_id=p.id and window_id=r.authorization_id)<>13
   or exists(select 1 from project_organization_nodes n where n.project_id=p.id and not exists(
    select 1 from project_organization_contract_changes c where c.node_id=n.id and c.window_id=r.authorization_id
     and c.prior_deadline=r.prior_cutoff and c.deadline=r.cutoff and c.prior_tools=n.tools and c.tools=n.tools
     and c.prior_submission is not distinct from n.completion_submission))
  then raise exception 'Renewal receipt, source or thirteen preserved contracts changed';end if;
  stage:='resume';
 end if;
 return jsonb_build_object('projectId',p.id,'stage',stage,'releaseSha',p_release,
  'expectedReleaseSha',a.continuation_release_sha,'scopeHash',p.approved_hash,'sourceMissionId',s.id,
  'windowId',a.window_id,'priorCutoff',p.deadline,'cutoff',coalesce(r.cutoff,p.deadline+interval '24 hours'),
  'stateHash',project_org_hierarchy_recovery_state(p.id),'authorizationId',r.authorization_id,'renewalStateHash',r.state_hash,
  'status',p.status,'historicalMissions',used,'maxMissions',p.max_missions,'tokenAllowance',p.token_allowance,'nodeCount',13);
end $$;
-- Bind displayed state and durable renewal under the SAME lock as #1049's
-- existing writer. A changed contract/ledger cannot race HTTP preflight.
create function public.project_org_resume_management_confirmed(
 p_owner uuid,p_project uuid,p_release text,p_authorization uuid,p_state_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare offer jsonb;result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('katie.mission.state',0));
 offer:=project_org_management_activation_offer(p_owner,p_project,p_release);
 if p_authorization is null or offer->>'authorizationId' is distinct from p_authorization::text
 or offer->>'stage' not in ('resume','resumed')
 then raise exception 'Verified renewal receipt required before separate management resume';end if;
 if p_state_hash is null or p_state_hash is distinct from offer->>'stateHash'
 then raise exception 'Management resume state changed';end if;
 if offer->>'stage'='resumed' then return offer||jsonb_build_object('existing',true);end if;
 if (offer->>'cutoff')::timestamptz<=clock_timestamp()+interval '5 minutes'
 then raise exception 'Management resume approved cutoff expired';end if;
 result:=project_org_resume_management(p_owner,p_project,p_release,offer->>'expectedReleaseSha',offer->>'scopeHash',(offer->>'sourceMissionId')::uuid);
 return result||jsonb_build_object('authorizationId',p_authorization,'cutoff',offer->>'cutoff','stage','resumed','status','running','existing',false);
end $$;
revoke all on function public.project_org_management_activation_offer(uuid,uuid,text),
 public.project_org_resume_management_confirmed(uuid,uuid,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.project_org_management_activation_offer(uuid,uuid,text),
 public.project_org_resume_management_confirmed(uuid,uuid,text,uuid,text) to service_role;
commit;
