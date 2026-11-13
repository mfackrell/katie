import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Native PostgreSQL, invoked by both existing compatibility suites. Historical
// expiry is constructed only in the disposable fixture; all actual recovery,
// authorization and permission checks run with normal database triggers/RLS.
export async function assertProjectHierarchyRecovery(db,{project,owner,rootNode,blocked}){
 await db.query('reset role');
 await db.query('begin');
 try{
  await db.query("set local session_replication_role='replica'");
  await db.query("update work_projects set deadline=date_trunc('second',clock_timestamp())-interval '1 hour' where id=$1",[project]);
  await db.query("update project_provider_execution set deadline=date_trunc('second',clock_timestamp())-interval '1 hour' where project_id=$1",[project]);
  await db.query("update project_organization_nodes set deadline=date_trunc('second',clock_timestamp())-(case depth when 0 then interval '30 minutes' when 1 then interval '90 minutes' when 2 then interval '120 minutes' else interval '150 minutes' end) where project_id=$1",[project]);
  await db.query("set local session_replication_role='origin'");
  assert.equal((await db.query('show session_replication_role')).rows[0].session_replication_role,'origin');
  await db.query('set role service_role');

  const offer=(await db.query('select project_org_hierarchy_recovery_offer($1,$2) o',[owner,project])).rows[0].o;
  assert.ok(offer,'original expired organization must receive an exact owner offer');
  assert.equal(offer.activeMissionId,blocked.mid);
  assert.match(offer.stateHash,/^[a-f0-9]{64}$/);
  assert.ok(offer.nodeCount>=4);
  assert.equal(offer.maxHours,24);
  assert.notEqual(offer.directorCutoff,offer.priorCutoff);
  assert.equal((await db.query('select project_org_hierarchy_recovery_offer($1,$2) o',[randomUUID(),project])).rows[0].o,null);
  for(const role of ['anon','authenticated']){
   assert.equal((await db.query("select has_function_privilege($1,'project_org_recover_hierarchy(uuid,uuid,text,uuid,timestamptz,timestamptz,timestamptz,uuid,text)','EXECUTE') ok",[role])).rows[0].ok,false);
  }
  assert.equal((await db.query("select has_function_privilege('service_role','project_org_recover_hierarchy(uuid,uuid,text,uuid,timestamptz,timestamptz,timestamptz,uuid,text)','EXECUTE') ok")).rows[0].ok,true);

  const queryNodes='select id,parent_id,deadline,tools,scope_paths,token_limit,evidence,status from project_organization_nodes where project_id=$1 order by depth,id';
  const prior=(await db.query(queryNodes,[project])).rows;
  const state=(await db.query('select status,phase,active_mission_id from work_projects where id=$1',[project])).rows[0];
  const attempts=(await db.query('select status,attempts from mission_assignments where id=$1',[blocked.job])).rows[0];
  const readRequests=async()=>{
    await db.query('reset role');
    try{return (await db.query('select jsonb_agg(to_jsonb(q) order by q.id) v from project_provider_requests q where q.project_id=$1',[project])).rows[0].v;}
    finally{await db.query('set role service_role');}
  };
  const requests=await readRequests();
  const decisionCount=(await db.query('select count(*)::int n from project_organization_decisions where project_id=$1',[project])).rows[0].n;
  const id=randomUUID(),release='d'.repeat(40),cutoff=new Date(Date.now()+900000).toISOString();
  const args=[owner,project,release,offer.decisionId,offer.priorCutoff,offer.directorCutoff,cutoff,id,offer.stateHash];
  const statement='select project_org_recover_hierarchy($1,$2,$3,$4,$5,$6,$7,$8,$9) r';
  const reject=async(values,pattern)=>{
   await db.query('savepoint hierarchy_rejected');
   try{await assert.rejects(db.query(statement,values),pattern);}
   finally{await db.query('rollback to savepoint hierarchy_rejected');await db.query('release savepoint hierarchy_rejected');}
  };
  await reject([randomUUID(),...args.slice(1)],/original project owner/);
  await reject([owner,randomUUID(),...args.slice(2)],/original project owner/);
  await reject(args.map((v,i)=>i===8?'f'.repeat(64):v),/state changed/);
  await reject(args.map((v,i)=>i===5?new Date(Date.now()-300000).toISOString():v),/Exact expired hierarchy/);
  await reject(args.map((v,i)=>i===6?new Date(Date.now()-300000).toISOString():v),/Exact expired hierarchy/);
  await reject(args.map((v,i)=>i===3?randomUUID():v),/Exact expired hierarchy/);

  // Post-write failure injection proves every contract, owner window and
  // one-shot receipt rolls back together.
  await db.query('reset role');
  await db.query("create function public.project_hierarchy_test_abort() returns trigger language plpgsql as $$ begin if new.event='project_hierarchy_recovery_authorized' then raise exception 'synthetic post-write failure'; end if; return new; end $$");
  await db.query('create trigger hierarchy_test_abort before insert on project_events for each row execute function project_hierarchy_test_abort()');
  await db.query('set role service_role');
  await reject(args,/synthetic post-write failure/);
  assert.equal((await db.query('select count(*)::int n from project_execution_windows where id=$1',[id])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from project_hierarchy_recovery_receipts where authorization_id=$1',[id])).rows[0].n,0);
  assert.deepEqual((await db.query(queryNodes,[project])).rows,prior);
  await db.query('reset role');
  await db.query('drop trigger hierarchy_test_abort on project_events');
  await db.query('drop function project_hierarchy_test_abort()');
  await db.query('set role service_role');

  const receipt=(await db.query(statement,args)).rows[0].r;
  assert.equal(receipt.projectId,project);
  assert.equal(receipt.decisionId,offer.decisionId);
  assert.equal(receipt.authorizationId,id);
  assert.equal(receipt.stateHash,offer.stateHash);
  assert.equal(receipt.activeMissionId,blocked.mid);
  assert.equal(receipt.existing,false);
  assert.equal(receipt.renewedNodeIds.length,offer.nodeCount);
  assert.equal((await db.query('select project_org_hierarchy_recovery_offer($1,$2) o',[owner,project])).rows[0].o,null);
  const next=(await db.query('select status,phase,deadline,active_mission_id from work_projects where id=$1',[project])).rows[0];
  assert.equal(next.status,state.status);
  assert.equal(next.phase,state.phase);
  assert.equal(next.active_mission_id,state.active_mission_id);
  assert.equal(new Date(next.deadline).toISOString(),new Date(cutoff).toISOString());
  const nodes=(await db.query(queryNodes,[project])).rows;
  for(let i=0;i<nodes.length;i++){
   for(const field of ['id','parent_id','tools','scope_paths','token_limit','evidence','status'])
     assert.deepEqual(nodes[i][field],prior[i][field],'must preserve '+field);
   assert.equal(new Date(nodes[i].deadline).toISOString(),new Date(cutoff).toISOString());
  }
  const changes=(await db.query('select node_id,prior_deadline,deadline,prior_tools,tools from project_organization_contract_changes where window_id=$1',[id])).rows;
  assert.equal(changes.length,offer.nodeCount);
  for(const ch of changes){
    const old=prior.find(x=>x.id===ch.node_id);
    assert.equal(new Date(ch.prior_deadline).toISOString(),new Date(old.deadline).toISOString());
    assert.deepEqual(ch.prior_tools,ch.tools);
  }
  assert.deepEqual((await db.query('select status,attempts from mission_assignments where id=$1',[blocked.job])).rows[0],attempts);
  assert.deepEqual(await readRequests(),requests);
  assert.equal((await db.query('select count(*)::int n from project_organization_decisions where project_id=$1',[project])).rows[0].n,decisionCount);
  assert.equal((await db.query('select project_provider_continued($1) ok',[project])).rows[0].ok,true);
  await reject(args,/Exact expired hierarchy|Inactive or changed organizational execution state/);
  await db.query('reset role');
  await db.query('savepoint immutable_receipt');
  try{await assert.rejects(db.query('delete from project_hierarchy_recovery_receipts where authorization_id=$1',[id]),/append-only/);}
  finally{await db.query('rollback to savepoint immutable_receipt');await db.query('release savepoint immutable_receipt');}
  await db.query('set role service_role');
  console.log('PROJECT_HIERARCHY_RECOVERY_POSTGRES_PASS: owner, atomic rollback, full hierarchy, replay, history');
 }finally{
  await db.query('reset role');
  await db.query('rollback');
  await db.query('set role service_role');
 }
}
