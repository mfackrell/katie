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
    return {job:job.id,lease,node:scheduled.nodeId};
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
    {action:'appoint',kind:'manager',name:'Game Delivery',area:'game_delivery',objective:'Manage the scoped game implementation',
      acceptance:['Only approved game scope is implemented'],tokens:60000,deadline,paths:[],tools:['manage','analysis','development','repository_review']},
    {action:'appoint',kind:'manager',name:'Independent QA',area:'quality_assurance',objective:'Verify the scoped game independently',
      acceptance:['Same-commit Preview acceptance'],tokens:40000,deadline,paths:[],tools:['manage','analysis','repository_review']},
    {action:'ready'}
  ]);
  await db.query('reset role');
  await db.query("update work_projects set status='blocked',phase='research',active_mission_id=null,lease=null,lease_until=null where id=$1",[project]);
  await db.query('set role service_role');

  const contract={path:'/milestone-3-tic-tac-toe',scenarios:[{name:'Initial state',steps:[{action:'expectText',selector:'#status',value:"X's turn"}]}]};
  const spec={name:'Recovered scoped game',summary:'Exact accepted organization game scope',requirements:['Implement the owner-approved tic-tac-toe game'],
    allowedPaths:scopePaths,milestones:[{title:'Game',instruction:'Implement only the approved game scope',contract}],finalContract:contract};
  const base='b'.repeat(40);
  const badSpec={...spec,allowedPaths:['app/unapproved-scope/']};
  await assert.rejects(db.query('select project_org_prepare_scope_ratification($1,$2,$3)',[project,badSpec,base]),/exceeds accepted organization evidence/);

  const prepared=(await db.query('select project_org_prepare_scope_ratification($1,$2,$3) q',[project,spec,base])).rows[0].q;
  const replayed=(await db.query('select project_org_prepare_scope_ratification($1,$2,$3) q',[project,spec,base])).rows[0].q;
  assert.equal(replayed.proposalId,prepared.proposalId,'identical inert proposal preparation is idempotent');
  assert.equal(replayed.scopeHash,prepared.scopeHash);
  assert.match(prepared.scopeHash,/^[a-f0-9]{64}$/);
  assert.match(prepared.organizationHash,/^[a-f0-9]{64}$/);
  assert.deepEqual(prepared.specification.allowedPaths,scopePaths);
  assert.equal(prepared.baselineSha,base);
  assert.equal((await db.query("select has_function_privilege('anon','project_org_ratify_scope(uuid,uuid,text)','EXECUTE') ok")).rows[0].ok,false);
  assert.equal((await db.query("select has_function_privilege('authenticated','project_org_ratify_scope(uuid,uuid,text)','EXECUTE') ok")).rows[0].ok,false);
  assert.equal((await db.query("select has_function_privilege('service_role','project_org_ratify_scope(uuid,uuid,text)','EXECUTE') ok")).rows[0].ok,true);
  await assert.rejects(db.query('insert into project_scope_ratification_approvals(proposal_id,project_id,owner_id,scope_hash,transaction_id) values($1,$2,$3,$4,txid_current())',
    [prepared.proposalId,project,owner,prepared.scopeHash]),/permission denied/);
  await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3)',[randomUUID(),prepared.proposalId,prepared.scopeHash]),/authenticated owner/);
  await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3)',[owner,prepared.proposalId,'f'.repeat(64)]),/authenticated owner/);

  // A provider-specific invalid browser route is permitted to exist as an inert
  // proposal but fails inside activation. The prior receipt/provider state must
  // roll back with the failed project update.
  const wrongRoute={...spec,milestones:[{...spec.milestones[0],contract:{...contract,path:'/wrong'}}],finalContract:{...contract,path:'/wrong'}};
  const wrong=(await db.query('select project_org_prepare_scope_ratification($1,$2,$3) q',[project,wrongRoute,base])).rows[0].q;
  await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3)',[owner,wrong.proposalId,wrong.scopeHash]),/isolated tic-tac-toe route/);
  assert.equal((await db.query('select approved_scope from project_provider_execution where project_id=$1',[project])).rows[0].approved_scope,null);
  assert.equal((await db.query('select count(*)::int n from project_scope_ratification_approvals where project_id=$1',[project])).rows[0].n,0);

  const snapshot=async()=>({
    nodes:(await db.query('select jsonb_agg(to_jsonb(n) order by n.id) v from project_organization_nodes n where project_id=$1',[project])).rows[0].v,
    decisions:(await db.query('select jsonb_agg(to_jsonb(d) order by d.created_at,d.id) v from project_organization_decisions d where project_id=$1',[project])).rows[0].v,
    plans:(await db.query('select jsonb_agg(to_jsonb(pl) order by pl.node_id) v from project_organization_plans pl join project_organization_nodes n on n.id=pl.node_id where n.project_id=$1',[project])).rows[0].v,
  });
  const before=await snapshot();
  const rootNode=(await db.query("select id from project_organization_nodes where project_id=$1 and kind='project_director' and parent_id is null",[project])).rows[0];
  await db.query('begin');
  try{
    await db.query('reset role');
    await db.query('update project_organization_nodes set decision_needed=not decision_needed where id=$1',[rootNode.id]);
    await db.query('set role service_role');
    await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3)',[owner,prepared.proposalId,prepared.scopeHash]),/organization changed/);
  }finally{await db.query('rollback');await db.query('set role service_role');}

  await db.query('begin');
  try{
    const approved=(await db.query('select project_org_ratify_scope($1,$2,$3) p',[owner,prepared.proposalId,prepared.scopeHash])).rows[0].p;
    assert.equal(approved.status,'running');assert.equal(approved.phase,'development');
    assert.equal(approved.approval_hash,prepared.scopeHash);assert.equal(approved.approved_hash,prepared.scopeHash);
    assert.equal(approved.baseline_sha,base);assert.deepEqual(approved.spec.allowedPaths,scopePaths);
    assert.deepEqual(await snapshot(),before,'ratification must preserve node state, evidence, decisions and pending decisions byte-for-byte');
    assert.equal((await db.query('select approved_scope from project_provider_execution where project_id=$1',[project])).rows[0].approved_scope,prepared.scopeHash);
    const grants=(await db.query('select g.*,n.kind from project_organization_scope_grants g join project_organization_nodes n on n.id=g.node_id where n.project_id=$1 and g.scope_hash=$2',[project,prepared.scopeHash])).rows;
    assert.equal(grants.length,1);assert.equal(grants[0].kind,'project_director');assert.equal(grants[0].parent_id,null);assert.deepEqual(grants[0].paths,scopePaths);
    await assert.rejects(db.query('select project_org_ratify_scope($1,$2,$3)',[owner,prepared.proposalId,prepared.scopeHash]),/stale or already consumed/);

    // Existing management authority remains mandatory after root ratification.
    const rootGrant=await activate(rootNode.id);
    const game=(await db.query("select id from project_organization_nodes where project_id=$1 and name='Game Delivery'",[project])).rows[0];
    await decide(rootGrant,[{action:'grant_scope',nodeId:game.id,paths:scopePaths},{action:'ready'}]);
    assert.equal((await db.query('select count(*)::int n from project_organization_scope_grants where node_id=$1 and scope_hash=$2',[game.id,prepared.scopeHash])).rows[0].n,1);

    const manager=await activate(game.id);
    await decide(manager,[{action:'appoint',kind:'worker',name:'Coder',area:'game_delivery',objective:'Implement only the approved tic-tac-toe package',
      acceptance:['Approved browser contract passes'],tokens:1000,deadline,paths:[],tools:['analysis','development']},{action:'ready'}]);
    const coder=(await db.query("select id from project_organization_nodes where parent_id=$1 and name='Coder'",[game.id])).rows[0];
    assert.ok(coder?.id);
    const delegator=await activate(game.id);
    await decide(delegator,[{action:'grant_scope',nodeId:coder.id,paths:scopePaths},{action:'ready'}]);
    assert.equal((await db.query('select count(*)::int n from project_organization_scope_grants where node_id=$1 and scope_hash=$2',[coder.id,prepared.scopeHash])).rows[0].n,1,
      'coding worker receives scope only through existing manager delegation');
  }finally{await db.query('rollback');await db.query('set role service_role');}
  console.log('PROJECT_SCOPE_RATIFICATION_POSTGRES_PASS');
}
