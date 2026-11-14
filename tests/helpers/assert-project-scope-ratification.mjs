import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function assertProjectScopeRatification(db){
  await db.query('reset role');
  const actor=randomUUID(),chat=randomUUID(),owner=randomUUID(),repo=randomUUID();
  await db.query("insert into actors(id,name,actor_kind) values($1,'Scope ratification fixture','standard')",[actor]);
  await db.query("insert into chats(id,actor_id,title) values($1,$2,'Scope ratification fixture')",[chat,actor]);
  await db.query("insert into repo_sync_runs(id,repository_full_name) values($1,'mfackrell/katie')",[repo]);
  await db.query('select standalone_bind_scope($1,$2,$3)',[owner,actor,chat]);
  await db.query('set role service_role');
  const p=(await db.query('select project_provider_launch($1,$2,$3) p',[owner,actor,chat])).rows[0].p;
  const project=p.id;
  const authority=(await db.query('select * from project_provider_execution where project_id=$1',[project])).rows[0];
  const deadline=new Date(authority.deadline.getTime()-1000).toISOString();
  const leaseProject=async()=>{
    const lease=randomUUID();
    await db.query('reset role');
    await db.query("update work_projects set lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[project,lease]);
    await db.query('set role service_role');
    return lease;
  };
  const session=async()=>{
    const scheduled=(await db.query('select project_org_schedule($1,$2) s',[project,await leaseProject()])).rows[0].s;
    assert.ok(scheduled?.missionId,JSON.stringify(scheduled));
    const lease=randomUUID();
    await db.query('reset role');
    const job=(await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where mission_id=$1 and status='queued' returning id",[scheduled.missionId,lease])).rows[0];
    await db.query('set role service_role');
    assert.ok(job?.id);
    return {job:job.id,lease,node:scheduled.nodeId,mission:scheduled.missionId};
  };
  const decide=(s,commands)=>db.query('select project_org_decide($1,$2,$3)',[s.job,s.lease,JSON.stringify(commands)]);
  const activate=async nodeId=>{
    await db.query('reset role');
    await db.query('update project_organization_nodes set decision_needed=(id=$2) where project_id=$1',[project,nodeId]);
    await db.query('set role service_role');
    const s=await session();assert.equal(s.node,nodeId);return s;
  };
  const root=await session();
  const scopePaths=['app/milestone-3-tic-tac-toe/','lib/milestone-3-tic-tac-toe/','tests/milestone-3-tic-tac-toe/'];
  const direction='Commission implementation only within '+scopePaths.join(', ')+' and preserve independent QA.';
  await decide(root,[
    {action:'plan',purpose:'Deliver the owner tic-tac-toe outcome without expanding scope',direction,
      outcomes:[{criterion:'Playable game is independently accepted',verification:'Protected same-commit Preview'}],
      milestones:[{objective:'One bounded coding milestone'}],organizations:['game_delivery','independent_qa']},
    // Mirror the production Game Delivery director: implementation is withheld
    // until the owner-ratified root grant and a recorded parent amendment.
    {action:'appoint',kind:'manager',name:'Game Delivery',area:'game_delivery',objective:'Manage the scoped game implementation',
      acceptance:['Only approved game scope is implemented'],tokens:60000,deadline,paths:[],tools:['manage','analysis','repository_review']},
    {action:'appoint',kind:'manager',name:'Independent QA',area:'independent_qa',objective:'Verify the scoped game independently',
      acceptance:['Same-commit Preview acceptance'],tokens:40000,deadline,paths:[],tools:['manage','analysis','repository_review']},
    {action:'ready'}
  ]);
  const rootNode=(await db.query("select * from project_organization_nodes where project_id=$1 and kind='project_director' and parent_id is null",[project])).rows[0];
  const game=(await db.query("select * from project_organization_nodes where project_id=$1 and name='Game Delivery'",[project])).rows[0];
  const readiness=(await db.query(`
    select
      pl.objective_hash=(select encode(sha256(convert_to(p.objective||p.clarifications,'UTF8')),'hex') from work_projects p where p.id=$2) objective_bound,
      pl.organizations,
      exists(
        select 1 from project_organization_decisions d
        join mission_assignments j on j.id=d.assignment_id
        join agent_missions m on m.id=j.mission_id
        where d.project_id=$2 and d.node_id=$1 and j.status='completed' and m.status='completed'
          and exists(select 1 from jsonb_array_elements(d.decision) c where c->>'action'='ready')
      ) ready_committed,
      (select array_agg(distinct child.area order by child.area)
       from project_organization_nodes child
       where child.parent_id=$1 and child.kind='manager'
         and child.area=any(array['game_delivery','independent_qa'])) required_direct_reports
    from project_organization_plans pl where pl.node_id=$1
  `,[rootNode.id,project])).rows[0];
  assert.ok(readiness,'Director management plan must be durably committed');
  assert.equal(readiness.objective_bound,true,'Director plan must remain bound to the exact project objective');
  assert.deepEqual([...readiness.organizations].sort(),['game_delivery','independent_qa']);
  assert.equal(readiness.ready_committed,true,'Director ready decision must be committed by a completed management mission');
  assert.deepEqual(readiness.required_direct_reports,['game_delivery','independent_qa'],
    'every required organization must exist as a direct manager report');

  const deliverySetup=await activate(game.id);
  await decide(deliverySetup,[{action:'appoint',kind:'worker',name:'Repository Scope Analyst',area:'game_delivery',
    objective:'Inventory the already approved milestone paths without coding',
    acceptance:['Observed repository inventory is reported without implementation'],tokens:1000,deadline,paths:[],
    tools:['analysis','repository_review']},{action:'ready'}]);
  const existingWorker=(await db.query("select * from project_organization_nodes where parent_id=$1 and name='Repository Scope Analyst'",[game.id])).rows[0];

  const rootDecision=(await db.query('select * from project_organization_decisions where project_id=$1 and node_id=$2 order by created_at desc,id desc limit 1',[project,rootNode.id])).rows[0];
  const windowId=randomUUID(),release='c'.repeat(40),priorCutoff=new Date(authority.deadline.getTime()-60000);
  await db.query('reset role');
  // The PostgreSQL deadline is microsecond-precise. pg parses it as a JS Date
  // with millisecond precision, so round-tripping authority.deadline produces
  // a cutoff that fails the exact window/deadline equality in the continuation
  // authorization join. Read the canonical cutoff within PostgreSQL instead.
  const insertedWindow=await db.query(
    "insert into project_execution_windows(id,project_id,owner_id,release_sha,decision_id,prior_cutoff,cutoff) select $1,$2,$3,$4,$5,$6,a.deadline from project_provider_execution a where a.project_id=$2 and a.owner_id=$3 returning id",
    [windowId,project,owner,release,rootDecision.id,priorCutoff]);
  assert.equal(insertedWindow.rowCount,1,'one exact owner-bound continuation window must be inserted');
  assert.equal(insertedWindow.rows[0].id,windowId);
  await db.query("update project_provider_execution set continued_at=clock_timestamp(),continuation_decision_id=$2,continuation_release_sha=$3,window_id=$4 where project_id=$1",
    [project,rootDecision.id,release,windowId]);
  await db.query("insert into project_organization_exceptions(project_id,origin_id,owner_id,reason,detail) values($1,$2,$3,'authority','Synthetic pre-scope exception retained across ratification')",
    [project,existingWorker.id,game.id]);

  // Verify the synthetic continuation is genuinely admitted BEFORE any
  // management scheduling. The checks mirror the deployed owner-window join;
  // a missing relationship must fail, never produce an incomplete assignment.
  const continuation=(await db.query(`
    select public.project_provider_continued($1) authorized,
           w.id=a.window_id window_bound,
           w.project_id=a.project_id project_bound,
           w.owner_id=a.owner_id owner_bound,
           w.decision_id=a.continuation_decision_id decision_bound,
           w.release_sha=a.continuation_release_sha release_bound,
           w.cutoff=a.deadline exact_cutoff,
           p.deadline=a.deadline project_cutoff,
           d.id=a.continuation_decision_id approved_decision,
           n.kind='project_director' and n.parent_id is null rooted_decision,
           j.status='completed' and m.status='completed' committed_decision
    from project_provider_execution a
    join work_projects p on p.id=a.project_id
    join project_execution_windows w on w.id=a.window_id
    join project_organization_decisions d on d.id=a.continuation_decision_id and d.project_id=p.id
    join project_organization_nodes n on n.id=d.node_id and n.project_id=p.id
    join mission_assignments j on j.id=d.assignment_id
    join agent_missions m on m.id=j.mission_id
    where a.project_id=$1 and a.owner_id=$2
  `,[project,owner])).rows[0];
  assert.ok(continuation,'the owner decision and execution window must join to the existing project');
  for(const field of ['authorized','window_bound','project_bound','owner_bound','decision_bound',
    'release_bound','exact_cutoff','project_cutoff','approved_decision','rooted_decision','committed_decision'])
    assert.equal(continuation[field],true,'continuation authorization invariant: '+field);

  // Compare the actual installed test scheduler's authorization and evidence
  // binding against the verified deployed definition, not a replacement mock.
  const schedulerDef=(await db.query(
    "select pg_get_functiondef('public.project_org_schedule(uuid,uuid)'::regprocedure) body"
  )).rows[0]?.body;
  assert.ok(schedulerDef,'installed management scheduler must exist');
  for(const contract of [
    'if not found and not project_provider_continued(p_project)',
    'if project_provider_continued(p_project) then',
    "'providerContinuationWindow',a.window_id",
    'm.id is distinct from r.mission_id',
  ]) assert.ok(schedulerDef.includes(contract),'installed scheduler differs from production: '+contract);

  // Production-shaped history MUST be admitted by the existing management
  // scheduler. A direct create_mission() for a registered leader is correctly
  // rejected by project_org_execution_guard() before its principal is bound.
  const installBlockedManagement=async({providerEvidence=false}={})=>{
    const scheduled=await activate(rootNode.id);
    const {mission:mid,job,lease:attempt}=scheduled;
    // Confirm authority came from the scheduler before simulating the terminal
    // failure; do not create a technical assignment and relabel it afterwards.
    const bound=(await db.query(
      "select m.project_id,m.project_kind,m.project_evidence->>'organizationNodeId' principal_id,m.project_evidence->>'providerContinuationWindow' window_id,p.active_mission_id,j.agent_id,j.role,j.payload->>'organizationNodeId' assignment_node,j.status,j.lease,b.node_id from agent_missions m join mission_assignments j on j.mission_id=m.id join work_projects p on p.id=m.project_id join project_organization_assignments b on b.assignment_id=j.id where m.id=$1 and j.id=$2",
      [mid,job])).rows[0];
    assert.ok(bound,'management mission and principal binding must be durably admitted');
    assert.equal(bound.project_id,project);
    assert.equal(bound.project_kind,'management');
    assert.equal(bound.principal_id,rootNode.id);
    assert.equal(bound.window_id,windowId);
    assert.equal(bound.active_mission_id,mid);
    assert.equal(bound.agent_id,rootNode.agent_id);
    assert.equal(bound.role,'work');
    assert.equal(bound.assignment_node,rootNode.id);
    assert.equal(bound.node_id,rootNode.id);
    assert.equal(bound.status,'running');
    assert.equal(bound.lease,attempt);

    // Simulate the real terminal failure AFTER valid scheduler admission. This
    // preserves the scheduler-issued mission ID, assignment ID, and binding.
    await db.query('reset role');
    await db.query("update agent_missions set status='blocked',detail='Mission state operation failed: Scope grant exceeds approved parent',calls=$2 where id=$1",
      [mid,providerEvidence?1:0]);
    const failed=(await db.query("update mission_assignments set status='failed',attempts=1,result=$2,detail='Scope grant exceeds approved parent',lease=null,lease_until=null where id=$1 returning id,status,attempts",
      [job,{detail:'Scope grant exceeds approved parent',diagnostic:{stage:'work',acceptedIssue:false}}])).rows[0];
    assert.equal(failed?.id,job);
    assert.equal(failed.status,'failed');
    assert.equal(failed.attempts,1);
    if(providerEvidence){
      // Settled test receipts bind to the actual claimed management attempt.
      await db.query("insert into project_provider_requests(id,project_id,mission_id,assignment_id,worker_id,execution_attempt,operation,request_hash,started_at,provider_receipt,resolved_at) values($1,$2,$3,$4,$5,$6,'model-list',$7,clock_timestamp()-interval '2 seconds','model-catalog',clock_timestamp()-interval '1 second')",
        [randomUUID(),project,mid,job,rootNode.agent_id,attempt,'a'.repeat(64)]);
      await db.query("insert into project_provider_requests(id,project_id,mission_id,assignment_id,worker_id,execution_attempt,operation,request_hash,started_at,provider_receipt,resolved_at) values($1,$2,$3,$4,$5,$6,'inference',$7,clock_timestamp()-interval '1 second','synthetic-provider-receipt',clock_timestamp())",
        [randomUUID(),project,mid,job,rootNode.agent_id,attempt,'b'.repeat(64)]);
    }
    await db.query('set role service_role');
    assert.equal((await db.query('select active_mission_id from work_projects where id=$1',[project])).rows[0].active_mission_id,mid);
    return {mid,job};
  };
  const firstBlocked=await installBlockedManagement();
  // The scheduler restores the actual saved previousMissionId; there is no
  // requirement that an earlier Game Delivery mission remains the predecessor.
  // Inspect the durable blocked-management record, not an assumed session.
  const firstPredecessor=(await db.query(
    "select project_evidence->>'previousMissionId' previous_id from agent_missions where id=$1 and project_id=$2 and project_kind='management' and status='blocked'",
    [firstBlocked.mid,project])).rows[0];
  assert.ok(firstPredecessor,'original blocked management mission and its predecessor evidence must remain available');
  // The ordinary scheduler must reconcile the first failed session before
  // scheduling the second. Preserve the saved predecessor and consumed attempt.
  const reconciled=(await db.query('select project_org_schedule($1,$2) s',[project,await leaseProject()])).rows[0].s;
  assert.equal(reconciled?.waiting,true,JSON.stringify(reconciled));
  assert.equal((await db.query('select active_mission_id from work_projects where id=$1',[project])).rows[0].active_mission_id,
    firstPredecessor.previous_id,'reconciliation must restore the blocked mission\'s persisted previousMissionId');
  assert.equal((await db.query(
    "select project_evidence->>'previousMissionId' previous_id from agent_missions where id=$1",[firstBlocked.mid]
  )).rows[0].previous_id,firstPredecessor.previous_id,'reconciliation must not rewrite historical mission provenance');
  const firstAttempt=(await db.query('select status,attempts from mission_assignments where id=$1',[firstBlocked.job])).rows[0];
  assert.equal(firstAttempt?.status,'failed','consumed blocked management assignment must remain failed');
  assert.equal(firstAttempt.attempts,1,'consumed management attempt must never reset');
  const blocked=await installBlockedManagement({providerEvidence:true});
  // The admission helper returns under service_role. Only fixture setup may
  // change protected organization rows; never relax production SQL grants.
  await db.query('reset role');
  await db.query("update project_organization_nodes set decision_needed=(id=$2) where project_id=$1",[project,rootNode.id]);
  await db.query("update work_projects set status='blocked',phase='research',lease=null,lease_until=null where id=$1",[project]);
  await db.query('set role service_role');
  assert.equal((await db.query('select project_provider_continued($1) ok',[project])).rows[0].ok,true);
  assert.equal((await db.query('select project_provider_request_pending($1) ok',[project])).rows[0].ok,false);

  await db.query('begin');
  try{
    const lease=randomUUID();
    await db.query('reset role');
    await db.query("update work_projects set status='running',lease=$2,lease_until=clock_timestamp()+interval '5 minutes' where id=$1",[project,lease]);
    await db.query('set role service_role');
    const retained=(await db.query('select project_org_schedule($1,$2) s',[project,lease])).rows[0].s;
    assert.match(retained.blocked,/cannot achieve its objective within bounded retry authority/);
    assert.equal((await db.query('select active_mission_id from work_projects where id=$1',[project])).rows[0].active_mission_id,blocked.mid);
  }finally{await db.query('rollback');await db.query('set role service_role');}

  // Independently recover an expired hierarchy in a rolled-back PostgreSQL
  // fixture, then verify the unchanged pre-scope project still ratifies.
  await (await import('./assert-project-hierarchy-recovery.mjs'))
    .assertProjectHierarchyRecovery(db,{project,owner,rootNode,blocked});

  const contract={path:'/milestone-3-tic-tac-toe',scenarios:[{name:'Initial state',steps:[{action:'expectText',selector:'#status',value:"X's turn"}]}]};
  const spec={name:'Recovered scoped game',summary:'Exact accepted organization game scope',requirements:['Implement the owner-approved tic-tac-toe game'],
    allowedPaths:scopePaths,milestones:[{title:'Game',instruction:'Implement only the approved game scope',contract}],finalContract:contract};
  const base='b'.repeat(40);
  const badSpec={...spec,allowedPaths:['app/unapproved-scope/']};
  await assert.rejects(db.query('select project_org_prepare_scope_ratification($1,$2,$3)',[project,badSpec,base]),/exceeds accepted organization evidence/);
  // Prefixes of previously accepted paths are not themselves accepted paths:
  // permitting one would broaden the future root grant beyond approved scope.
  const broadenedPrefix={...spec,allowedPaths:['app/milestone-3-tic-tac']};
  await assert.rejects(
    db.query('select project_org_prepare_scope_ratification($1,$2,$3)',[project,broadenedPrefix,base]),
    /exceeds accepted organization evidence/,
    'a substring of an approved path must not grant authority to its parent prefix'
  );

  const prepared=(await db.query('select project_org_prepare_scope_ratification($1,$2,$3) q',[project,spec,base])).rows[0].q;
  const replayed=(await db.query('select project_org_prepare_scope_ratification($1,$2,$3) q',[project,spec,base])).rows[0].q;
  assert.equal(replayed.proposalId,prepared.proposalId,'identical inert proposal preparation is idempotent');
  assert.equal(replayed.scopeHash,prepared.scopeHash);
  assert.equal(prepared.activeMissionId,blocked.mid);
  assert.match(prepared.executionStateHash,/^[a-f0-9]{64}$/);
  assert.match(prepared.scopeHash,/^[a-f0-9]{64}$/);
  assert.match(prepared.organizationHash,/^[a-f0-9]{64}$/);
  assert.deepEqual(prepared.specification.allowedPaths,scopePaths);
  assert.equal(prepared.baselineSha,base);
  assert.equal((await db.query("select has_function_privilege('anon','project_org_ratify_scope(uuid,uuid,uuid,text)','EXECUTE') ok")).rows[0].ok,false);
  assert.equal((await db.query("select has_function_privilege('authenticated','project_org_ratify_scope(uuid,uuid,uuid,text)','EXECUTE') ok")).rows[0].ok,false);
  assert.equal((await db.query("select has_function_privilege('service_role','project_org_ratify_scope(uuid,uuid,uuid,text)','EXECUTE') ok")).rows[0].ok,true);
  await assert.rejects(db.query('insert into project_scope_ratification_approvals(proposal_id,project_id,owner_id,scope_hash,transaction_id) values($1,$2,$3,$4,txid_current())',
    [prepared.proposalId,project,owner,prepared.scopeHash]),/permission denied/);
  await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3,$4)',[owner,randomUUID(),prepared.proposalId,prepared.scopeHash]),/no rows|strict|query returned no rows/i,
    'proposal cannot authorize a different project context');
  await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3,$4)',[randomUUID(),project,prepared.proposalId,prepared.scopeHash]),/authenticated owner/);
  await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3,$4)',[owner,project,prepared.proposalId,'f'.repeat(64)]),/authenticated owner/);

  // A provider-specific invalid browser route is permitted to exist as an inert
  // proposal but fails inside activation. The prior receipt/provider state must
  // roll back with the failed project update.
  const wrongRoute={...spec,milestones:[{...spec.milestones[0],contract:{...contract,path:'/wrong'}}],finalContract:{...contract,path:'/wrong'}};
  const wrong=(await db.query('select project_org_prepare_scope_ratification($1,$2,$3) q',[project,wrongRoute,base])).rows[0].q;
  await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3,$4)',[owner,project,wrong.proposalId,wrong.scopeHash]),/isolated tic-tac-toe route/);
  assert.equal((await db.query('select approved_scope from project_provider_execution where project_id=$1',[project])).rows[0].approved_scope,null);
  assert.equal((await db.query('select count(*)::int n from project_scope_ratification_approvals where project_id=$1',[project])).rows[0].n,0);

  const snapshot=async()=>{
    // This is a privileged, read-only test audit, not an application RPC.
    // service_role deliberately cannot SELECT protected provider receipts.
    await db.query('reset role');
    try { return {
    nodes:(await db.query('select jsonb_agg(to_jsonb(n) order by n.id) v from project_organization_nodes n where project_id=$1',[project])).rows[0].v,
    decisions:(await db.query('select jsonb_agg(to_jsonb(d) order by d.created_at,d.id) v from project_organization_decisions d where d.project_id=$1',[project])).rows[0].v,
    plans:(await db.query('select jsonb_agg(to_jsonb(pl) order by pl.node_id) v from project_organization_plans pl join project_organization_nodes n on n.id=pl.node_id where n.project_id=$1',[project])).rows[0].v,
    exceptions:(await db.query('select jsonb_agg(to_jsonb(e) order by e.created_at,e.id) v from project_organization_exceptions e where e.project_id=$1',[project])).rows[0].v,
    mission:(await db.query('select to_jsonb(m) v from agent_missions m where id=$1',[blocked.mid])).rows[0].v,
    assignments:(await db.query('select jsonb_agg(to_jsonb(j) order by j.id) v from mission_assignments j where j.mission_id=$1',[blocked.mid])).rows[0].v,
    bindings:(await db.query('select jsonb_agg(to_jsonb(b) order by b.assignment_id) v from project_organization_assignments b join mission_assignments j on j.id=b.assignment_id where j.mission_id=$1',[blocked.mid])).rows[0].v,
    requests:(await db.query('select jsonb_agg(to_jsonb(r) order by r.started_at,r.id) v from project_provider_requests r where r.mission_id=$1',[blocked.mid])).rows[0].v,
    dispatches:(await db.query("select coalesce(jsonb_agg(to_jsonb(d) order by d.task_id,d.run_id),'[]'::jsonb) v from project_provider_dispatches d join mission_assignments j on j.id=d.task_id where j.mission_id=$1",[blocked.mid])).rows[0].v,
    }; } finally { await db.query('set role service_role'); }
  };
  const privilegedRead=async(sql,params)=>{
    await db.query('reset role');
    try { return await db.query(sql,params); }
    finally { await db.query('set role service_role'); }
  };
  const before=await snapshot();
  await db.query('begin');
  try{
    await db.query('reset role');
    await db.query('update project_organization_nodes set decision_needed=not decision_needed where id=$1',[rootNode.id]);
    await db.query('set role service_role');
    await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3,$4)',[owner,project,prepared.proposalId,prepared.scopeHash]),/organization changed/);
  }finally{await db.query('rollback');await db.query('set role service_role');}

  await db.query('begin');
  try{
    await db.query('reset role');
    await db.query('update mission_assignments set attempts=attempts+1 where id=$1',[blocked.job]);
    await db.query('set role service_role');
    await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3,$4)',[owner,project,prepared.proposalId,prepared.scopeHash]),/execution state changed/);
  }finally{await db.query('rollback');await db.query('set role service_role');}

  await db.query('begin');
  try{
    const approved=(await db.query('select project_org_ratify_scope($1,$2,$3,$4) p',[owner,project,prepared.proposalId,prepared.scopeHash])).rows[0].p;
    assert.equal(approved.status,'running');assert.equal(approved.phase,'development');
    assert.equal(approved.approval_hash,prepared.scopeHash);assert.equal(approved.approved_hash,prepared.scopeHash);
    assert.equal(approved.baseline_sha,base);assert.deepEqual(approved.spec.allowedPaths,scopePaths);
    assert.equal(approved.active_mission_id,null);
    assert.deepEqual(await snapshot(),before,'ratification preserves organization, exceptions, mission, attempts and provider evidence byte-for-byte');
    const approval=(await db.query('select * from project_scope_ratification_approvals where project_id=$1',[project])).rows[0];
    assert.equal(approval.prior_active_mission_id,blocked.mid);assert.equal(approval.execution_state_hash,prepared.executionStateHash);
    const audit=(await db.query("select data from project_events where project_id=$1 and event='scope_ratification_active_mission_reconciled'",[project])).rows;
    assert.equal(audit.length,1);assert.equal(audit[0].data.missionId,blocked.mid);
    assert.equal(audit[0].data.disposition,'pointer_cleared_terminal_management_state');
    assert.equal((await db.query('select approved_scope from project_provider_execution where project_id=$1',[project])).rows[0].approved_scope,prepared.scopeHash);
    const grants=(await db.query('select g.*,n.kind from project_organization_scope_grants g join project_organization_nodes n on n.id=g.node_id where n.project_id=$1 and g.scope_hash=$2',[project,prepared.scopeHash])).rows;
    assert.equal(grants.length,1);assert.equal(grants[0].kind,'project_director');assert.equal(grants[0].parent_id,null);assert.deepEqual(grants[0].paths,scopePaths);
    // A deliberately rejected replay aborts an ordinary PostgreSQL transaction.
    // Isolate that negative test so subsequent lifecycle checks can continue
    // under the original ratification transaction without bypassing replay guards.
    await db.query('savepoint ratification_replay_rejection');
    try{
      await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3,$4)',[owner,project,prepared.proposalId,prepared.scopeHash]),/stale or already consumed/);
    }finally{
      await db.query('rollback to savepoint ratification_replay_rejection');
      await db.query('release savepoint ratification_replay_rejection');
    }

    // After scope ratification, a deeper manager may still be marked pending.
    // Before the first scoped package, select the Project Director first to
    // authorize direct reports; never spend a subordinate management inference
    // while the root grant has not yet propagated to delivery.
    await db.query('reset role');
    await db.query('update project_organization_nodes set decision_needed=true where id in ($1,$2)',[rootNode.id,game.id]);
    await db.query('set role service_role');
    assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
    // Exhausted management capacity must never be reactivated by a scheduler
    // change alone. Require a separate, fresh, audited owner resource receipt;
    // keep this entire test fixture inside a rollback savepoint.
    await db.query('savepoint scoped_mission_capacity_recovery');
    try{
      await db.query('reset role');
      const beforeCapacity=(await db.query('select max_missions,token_allowance from work_projects where id=$1',[project])).rows[0];
      const consumed=(await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n;
      assert.ok(consumed>0,'capacity fixture must retain actual management missions');
      await db.query("update work_projects set status='blocked',detail='Approved project mission limit reached',max_missions=$2,active_mission_id=null,lease=null,lease_until=null where id=$1",[project,consumed]);
      await db.query('set role service_role');
      const authorizationId=randomUUID(),authorizedMaximum=consumed+16;
      const resumeArgs=[owner,project,release,prepared.scopeHash,authorizationId,consumed,authorizedMaximum];
      const resumeSql='select project_org_resume_after_capacity_authorization($1,$2,$3,$4,$5,$6,$7) r';
      await db.query('savepoint unapproved_capacity_recovery');
      try{
        await assert.rejects(db.query(resumeSql,resumeArgs),/Fresh owner-approved mission-only resource receipt required/,
          'a capacity deficit never authorizes automatic resumption');
      }finally{
        await db.query('rollback to savepoint unapproved_capacity_recovery');
        await db.query('release savepoint unapproved_capacity_recovery');
      }
      assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'blocked');
      const grant=(await db.query(
        'select authorize_work_project_resources($1,$2,$3,$4,$5,$6,$7,$8,$9) r',
        [project,actor,chat,beforeCapacity.token_allowance,null,authorizedMaximum,null,authorizationId,
          'Owner explicitly approved only a bounded mission safeguard renewal for exact release '+release+' and exact game scope '+prepared.scopeHash+'.']
      )).rows[0].r;
      assert.equal(grant.maxMissions,authorizedMaximum);
      await db.query('savepoint wrong_capacity_owner');
      try{
        await assert.rejects(db.query(resumeSql,[randomUUID(),...resumeArgs.slice(1)]),
          /Authenticated original project owner required/);
      }finally{
        await db.query('rollback to savepoint wrong_capacity_owner');
        await db.query('release savepoint wrong_capacity_owner');
      }
      await db.query('savepoint wrong_capacity_release');
      try{
        await assert.rejects(db.query(resumeSql,[owner,project,'d'.repeat(40),...resumeArgs.slice(3)]),
          /Fresh owner-approved mission-only resource receipt required/,
          'the owner receipt must bind to the exact candidate release, not any source SHA');
      }finally{
        await db.query('rollback to savepoint wrong_capacity_release');
        await db.query('release savepoint wrong_capacity_release');
      }
      const resumedCapacity=(await db.query(resumeSql,resumeArgs)).rows[0].r;
      assert.equal(resumedCapacity.status,'running');
      assert.equal(resumedCapacity.approvedMaxMissions,authorizedMaximum);
      assert.equal(resumedCapacity.historicalMissions,consumed);
      assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,consumed,
        'capacity recovery must not dispatch, rewrite, or delete any historical management mission');
      assert.equal((await db.query("select count(*)::int n from project_events where project_id=$1 and event='project_capacity_resumed'",[project])).rows[0].n,1);
      assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
      assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'running');
      await db.query('savepoint replay_capacity_recovery');
      try{
        await assert.rejects(db.query(resumeSql,resumeArgs),/Blocked capacity state, immutable scope or execution authority changed/,
          'an owner authorization may resume the original blocked project only once');
      }finally{
        await db.query('rollback to savepoint replay_capacity_recovery');
        await db.query('release savepoint replay_capacity_recovery');
      }
    }finally{
      await db.query('rollback to savepoint scoped_mission_capacity_recovery');
      await db.query('release savepoint scoped_mission_capacity_recovery');
      await db.query('set role service_role');
    }
    // Historical pre-ratification Director failures cannot exhaust the
    // newly approved development epoch. Preserve all historical rows and
    // test an exact owner-bound, one-shot recovery in a rollback savepoint.
    await db.query('savepoint scoped_root_epoch_recovery');
    try{
      const firstScoped=await session();
      assert.equal(firstScoped.node,rootNode.id);
      await db.query('reset role');
      await db.query("update agent_missions set status='blocked',calls=1,created_at=clock_timestamp(),detail='Project Director commissions Functional Directors only' where id=$1",[firstScoped.mission]);
      await db.query("update mission_assignments set status='failed',attempts=1,lease=null,lease_until=null,detail='Project Director commissions Functional Directors only',result=$2 where id=$1",
        [firstScoped.job,{managementCommandRejection:{code:'director_appointment',action:'appoint',position:6}}]);
      await db.query("update work_projects set status='blocked',detail='Project management cannot achieve its objective within bounded retry authority',lease=null,lease_until=null where id=$1",[project]);
      await db.query('set role service_role');
      const trialRelease='d'.repeat(40),source=firstScoped.mission;
      const recoverSql='select project_org_resume_scoped_root_retry($1,$2,$3,$4,$5,$6) r';
      const args=[owner,project,trialRelease,release,prepared.scopeHash,source];
      const rejectRecovery=async(values,pattern)=>{
        await db.query('savepoint rejected_root_recovery');
        try{await assert.rejects(db.query(recoverSql,values),pattern);}
        finally{await db.query('rollback to savepoint rejected_root_recovery');await db.query('release savepoint rejected_root_recovery');}
      };
      for(const role of ['anon','authenticated']){
        await db.query('reset role');await db.query('set role '+role);
        await rejectRecovery(args,/permission denied/);
      }
      await db.query('reset role');await db.query('set role service_role');
      await rejectRecovery([owner,project,trialRelease,'e'.repeat(40),prepared.scopeHash,source],/evidence or authority changed/);
      await rejectRecovery([owner,project,trialRelease,release,'e'.repeat(64),source],/evidence or authority changed/);
      await rejectRecovery([owner,project,trialRelease,release,prepared.scopeHash,randomUUID()],/evidence or authority changed/);
      await db.query('savepoint incorrect_scoped_root_owner');
      try{
        await assert.rejects(db.query(recoverSql,[randomUUID(),...args.slice(1)]),
          /Authenticated, exact-release project owner approval required/);
      }finally{
        await db.query('rollback to savepoint incorrect_scoped_root_owner');
        await db.query('release savepoint incorrect_scoped_root_owner');
      }
      const beforeCount=(await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n;
      const history=async()=>(await db.query(`select
        (select jsonb_agg(to_jsonb(m) order by id) from agent_missions m where project_id=$1) missions,
        (select jsonb_agg(to_jsonb(j) order by j.id) from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1) assignments,
        (select jsonb_agg(to_jsonb(w) order by id) from project_execution_windows w where project_id=$1) windows,
        (select jsonb_agg(to_jsonb(n) order by id) from project_organization_nodes n where project_id=$1) nodes,
        (select jsonb_build_array(deadline,max_missions,token_allowance,active_mission_id,approved_hash) from work_projects where id=$1) authority`,[project])).rows[0];
      const beforeHistory=await history();
      // An error after receipt insertion must roll back release rebinding too.
      await db.query('savepoint atomic_root_recovery');
      await db.query('reset role');
      await db.query("create function pg_temp.reject_scoped_resume() returns trigger language plpgsql as $$begin raise exception 'synthetic final write failure';end$$");
      await db.query('create trigger reject_scoped_resume before update on work_projects for each row execute function pg_temp.reject_scoped_resume()');
      await db.query('set role service_role');
      await rejectRecovery(args,/synthetic final write failure/);
      assert.equal((await db.query('select continuation_release_sha from project_provider_execution where project_id=$1',[project])).rows[0].continuation_release_sha,release);
      assert.equal((await db.query('select count(*)::int n from project_scoped_root_retry_receipts where project_id=$1',[project])).rows[0].n,0);
      await db.query('rollback to savepoint atomic_root_recovery');await db.query('release savepoint atomic_root_recovery');
      await db.query('set role service_role');
      const r=(await db.query(recoverSql,args)).rows[0].r;
      assert.deepEqual(await history(),beforeHistory,'recovery preserves all missions, assignments, windows, organization and owner limits');
      const rebound=(await db.query('select continuation_release_sha,window_id,project_provider_continued(project_id) authorized from project_provider_execution where project_id=$1',[project])).rows[0];
      assert.equal(rebound.continuation_release_sha,trialRelease);
      assert.equal(rebound.window_id,windowId);assert.equal(rebound.authorized,true);
      assert.equal((await db.query('select project_org_scoped_retry_release($1,$2) ok',[windowId,trialRelease])).rows[0].ok,true);
      assert.equal((await db.query('select project_org_scoped_retry_release($1,$2) ok',[randomUUID(),trialRelease])).rows[0].ok,false);
      for(const [role,statement,pattern] of [
        ['service_role','delete from project_scoped_root_retry_receipts',/permission denied/],
        ['service_role','insert into project_scoped_root_retry_receipts select * from project_scoped_root_retry_receipts',/permission denied/],
        [null,"update project_scoped_root_retry_receipts set release_sha=repeat('e',40)",/append-only/],
      ]){
        await db.query('savepoint immutable_retry_receipt');
        await db.query('reset role');if(role)await db.query('set role '+role);
        try{await assert.rejects(db.query(statement),pattern);}
        finally{await db.query('rollback to savepoint immutable_retry_receipt');await db.query('release savepoint immutable_retry_receipt');}
      }
      await db.query('set role service_role');
      assert.equal(r.status,'running');
      assert.equal(r.scopedRootFailures,1,'only one Director failure occurred after scope ratification');
      assert.equal(r.historicalMissions,beforeCount);
      assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,beforeCount,
        'resumption preserves historical missions and never fabricates development work');
      assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'running');
      await db.query('savepoint duplicate_scoped_root_recovery');
      try{
        await assert.rejects(db.query(recoverSql,args),/Original scoped root-retry evidence or authority changed/);
      }finally{
        await db.query('rollback to savepoint duplicate_scoped_root_recovery');
        await db.query('release savepoint duplicate_scoped_root_recovery');
      }
      const reconciled=(await db.query('select project_org_schedule($1,$2) s',[project,await leaseProject()])).rows[0].s;
      assert.equal(reconciled?.waiting,true,'a failed first scoped management decision is reconciled, not permanently blocked');
      const scheduledRetry=(await db.query('select project_org_schedule($1,$2) s',[project,await leaseProject()])).rows[0].s;
      await db.query('reset role');
      await db.query("update mission_assignments set created_at='2000-01-01' where mission_id=$1",[scheduledRetry.missionId]);
      await db.query('set role service_role');
      const staleClaim=(await db.query('select claim_mission_work_release($1) c',[release])).rows[0].c;
      assert.notEqual(staleClaim?.mission.id,scheduledRetry.missionId,'old release must not claim the rebound retry');
      const retryClaim=(await db.query('select claim_mission_work_release($1) c',[trialRelease])).rows[0].c;
      assert.equal(retryClaim?.mission.id,scheduledRetry.missionId,'the newly authorized release must claim the scheduled retry');
      assert.equal(retryClaim.mission.project_evidence.providerContinuationRelease,trialRelease);
      assert.equal(retryClaim.mission.project_evidence.providerContinuationWindow,windowId);
      assert.equal((await db.query('select project_provider_continued_assignment($1) ok',[retryClaim.job.id])).rows[0].ok,true);
      const secondScoped={node:scheduledRetry.nodeId,mission:scheduledRetry.missionId,job:retryClaim.job.id,lease:retryClaim.job.lease};
      assert.equal(secondScoped.node,rootNode.id,'scope-approved Project Director must receive its bounded second attempt');
      assert.notEqual(secondScoped.mission,firstScoped.mission);
      assert.equal((await db.query("select count(*)::int n from agent_missions where project_id=$1 and status='blocked' and project_kind='management' and project_evidence->>'organizationNodeId'=$2",[project,rootNode.id])).rows[0].n>=3,true,
        'pre-ratification failures remain in the ledger');
      // A second scoped rejection is still terminal; no third retry is granted.
      await db.query('savepoint terminal_scoped_failure');
      await db.query('reset role');
      await db.query("update agent_missions set status='blocked',created_at=clock_timestamp() where id=$1",[secondScoped.mission]);
      await db.query("update mission_assignments set status='failed',lease=null,lease_until=null where id=$1",[secondScoped.job]);
      await db.query('set role service_role');
      const terminal=(await db.query('select project_org_schedule($1,$2) s',[project,await leaseProject()])).rows[0].s;
      assert.match(terminal.blocked,/bounded retry authority/);
      await db.query('rollback to savepoint terminal_scoped_failure');await db.query('release savepoint terminal_scoped_failure');
      await db.query('set role service_role');
      const qaNode=(await db.query("select * from project_organization_nodes where project_id=$1 and area='independent_qa'",[project])).rows[0];
      await db.query('savepoint independent_qa_capability');
      try{
        await assert.rejects(decide(secondScoped,[
          {action:'amend_delegation',nodeId:qaNode.id,expectedTools:qaNode.tools,tools:[...qaNode.tools,'development'],
           expectedDeadline:new Date(qaNode.deadline).toISOString(),reason:'Invalid attempt to grant implementation to independent QA.'},
          {action:'ready'},
        ]),/Independent QA cannot inherit implementation authority/);
      }finally{await db.query('rollback to savepoint independent_qa_capability');await db.query('release savepoint independent_qa_capability');}
      await decide(secondScoped,[
        {action:'amend_delegation',nodeId:game.id,expectedTools:game.tools,tools:[...game.tools,'development'],
         expectedDeadline:new Date(game.deadline).toISOString(),reason:'Propagate the owner-ratified scope to existing Game Delivery.'},
        {action:'grant_scope',nodeId:game.id,paths:scopePaths},{action:'ready'},
      ]);
      assert.equal((await db.query('select tools from project_organization_nodes where id=$1',[game.id])).rows[0].tools.includes('development'),true);
      assert.deepEqual((await db.query('select paths from project_organization_scope_grants where node_id=$1',[game.id])).rows[0].paths,scopePaths);
      const qa=(await db.query("select tools from project_organization_nodes where project_id=$1 and area='independent_qa'",[project])).rows[0];
      assert.equal(qa.tools.includes('development'),false);
      assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
      console.log('SCOPED_ROOT_RETRY_RELEASE_CLAIM_DELEGATION_PASS');
    }finally{
      await db.query('rollback to savepoint scoped_root_epoch_recovery');
      await db.query('release savepoint scoped_root_epoch_recovery');
      await db.query('set role service_role');
    }
    const resumed=await session();
    assert.equal(resumed.node,rootNode.id,'root scope delegation must precede deeper pending management before the first coding package');
    assert.notEqual(resumed.mission,blocked.mid);
    const resumedMission=(await db.query('select * from agent_missions where id=$1',[resumed.mission])).rows[0];
    assert.equal(resumedMission.project_kind,'management');
    assert.equal(resumedMission.project_evidence.providerContinuationWindow,windowId);
    assert.equal(resumedMission.project_evidence.providerContinuationRelease,release);
    assert.equal((await db.query('select status from agent_missions where id=$1',[blocked.mid])).rows[0].status,'blocked');
    const blockedJob=(await db.query('select status,attempts from mission_assignments where id=$1',[blocked.job])).rows[0];
    assert.equal(blockedJob.status,'failed');assert.equal(blockedJob.attempts,1);
    assert.equal((await privilegedRead('select count(*)::int n from project_provider_requests where project_id=$1',[project])).rows[0].n,2);
    assert.equal((await privilegedRead('select count(*)::int n from project_provider_dispatches d join mission_assignments j on j.id=d.task_id join agent_missions m on m.id=j.mission_id where m.project_id=$1',[project])).rows[0].n,0,
      'scope ratification must not dispatch workers for this project');
    await decide(resumed,[{action:'ready'}]);

    const rootGrant=await activate(rootNode.id);
    const gameNow=(await db.query('select * from project_organization_nodes where id=$1',[game.id])).rows[0];
    await decide(rootGrant,[
      {action:'amend_delegation',nodeId:game.id,expectedTools:gameNow.tools,tools:['manage','analysis','development','repository_review'],
       expectedDeadline:new Date(gameNow.deadline).toISOString(),
       reason:'Owner-ratified scope now permits the existing Game Delivery director to delegate bounded implementation.'},
      {action:'grant_scope',nodeId:game.id,paths:scopePaths},{action:'ready'}
    ]);
    assert.equal((await db.query('select tools from project_organization_nodes where id=$1',[game.id])).rows[0].tools.includes('development'),true);
    assert.equal((await db.query('select count(*)::int n from project_organization_contract_changes where node_id=$1 and decision_id is not null',[game.id])).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from project_organization_scope_grants where node_id=$1 and scope_hash=$2',[game.id,prepared.scopeHash])).rows[0].n,1);

    await (await import('./assert-management-loop-recovery.mjs')).assertManagementLoopRecovery(db,{project,owner,actor,chat,game,rootNode,scopeHash:prepared.scopeHash,scopePaths,deadline,release,activate,decide});
    const manager=await activate(game.id);
    await decide(manager,[{action:'appoint',kind:'worker',name:'Coder',area:'game_delivery',objective:'Implement only the approved tic-tac-toe package',
      acceptance:['Approved browser contract passes'],tokens:1000,deadline,paths:[],tools:['analysis','development']},{action:'ready'}]);
    const coder=(await db.query("select id from project_organization_nodes where parent_id=$1 and name='Coder'",[game.id])).rows[0];
    assert.ok(coder?.id);
    assert.ok((await db.query('select id from project_organization_nodes where id=$1',[existingWorker.id])).rows[0]);
    const delegator=await activate(game.id);
    await decide(delegator,[{action:'grant_scope',nodeId:coder.id,paths:scopePaths},{action:'ready'}]);
    assert.equal((await db.query('select count(*)::int n from project_organization_scope_grants where node_id=$1 and scope_hash=$2',[coder.id,prepared.scopeHash])).rows[0].n,1,
      'coding worker receives scope only through existing manager delegation');
    assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
  }finally{await db.query('rollback');await db.query('set role service_role');}

  // The settled synthetic provider receipts and singleton are a test-only
  // fixture. The full immutable-history and rollback assertions above have
  // already verified their preservation across ratification. Release this
  // isolated fixture's singleton before the historical provider suites launch
  // their own independent test trials. Never change production grants or rows.
  await db.query('reset role');
  await db.query('begin');
  try{
    await db.query('delete from project_provider_requests where project_id=$1',[project]);
    await db.query('delete from project_provider_execution where project_id=$1',[project]);
    await db.query('commit');
  }catch(err){
    await db.query('rollback');
    throw err;
  }
  assert.equal((await db.query('select count(*)::int n from project_provider_execution')).rows[0].n,0,
    'isolated scope-ratification fixture must not consume the provider singleton for other suites');
  console.log('PROJECT_SCOPE_RATIFICATION_POSTGRES_PASS');
}
