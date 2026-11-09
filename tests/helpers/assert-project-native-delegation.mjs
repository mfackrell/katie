import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';

// Complete installed native financial functions, synthetic provider receipts only.
export async function assertProjectNativeDelegation(db,rival){
 await db.query('reset role');
 const actor=randomUUID(),chat=randomUUID(),owner=randomUUID(),project=randomUUID(),repo=randomUUID();
 await db.query("insert into actors(id,name,actor_kind) values($1,'Hierarchy owner','standard')",[actor]);
 await db.query("insert into chats(id,actor_id,title) values($1,$2,'Hierarchy native qualification')",[chat,actor]);
 await db.query("insert into repo_sync_runs(id,repository_full_name) values($1,'mfackrell/katie')",[repo]);
 await db.query('select standalone_bind_scope($1,$2,$3)',[owner,actor,chat]);
 await db.query('set role service_role');
 const p=(await db.query('select create_work_project($1,$2,$3,$4,$5,$6) p',[project,'hierarchy-native-'+project,actor,chat,'Build two approved components with independent acceptance',repo])).rows[0].p;
 const objectiveHash=(await db.query("select encode(sha256(convert_to(objective||clarifications,'UTF8')),'hex') h from work_projects where id=$1",[project])).rows[0].h;
 await db.query('select project_org_authorize($1,$2,$3,2000000,500000,true)',[owner,project,objectiveHash]);
 const rows=async()=> (await db.query('select * from project_organization_nodes where project_id=$1',[project])).rows;
 const leaseProject=async()=>{
  const lease=randomUUID();await db.query('reset role');
  await db.query("update work_projects set lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[project,lease]);
  await db.query('set role service_role');return lease;
 };
 const session=async()=>{
  const scheduled=(await db.query('select project_org_schedule($1,$2) s',[project,await leaseProject()])).rows[0].s;
  assert.ok(scheduled.missionId,JSON.stringify(scheduled));
  const lease=randomUUID();await db.query('reset role');
  const job=(await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where mission_id=$1 returning id",[scheduled.missionId,lease])).rows[0].id;
  await db.query('set role service_role');
  return {job,lease,node:(await rows()).find(n=>n.id===scheduled.nodeId)};
 };
 const decide=(s,commands)=>db.query('select project_org_decide($1,$2,$3)',[s.job,s.lease,JSON.stringify(commands)]);
 const deadline=new Date(Date.parse(p.deadline)-1000).toISOString();
 const appoint=(name,kind,tokens,tools,extra={})=>({action:'appoint',name,kind,objective:'Deliver '+name,acceptance:['Verified '+name],tokens,deadline,area:name.toLowerCase(),tools,paths:[],...extra});
 let s=await session();
 await decide(s,[{action:'plan',purpose:'Deliver two approved components',direction:'Delegate architecture, QA and implementation',outcomes:[{criterion:'Both components accepted',verification:'Independent tests'}],milestones:[{objective:'Two components'}],organizations:['architecture','quality_assurance','development']},appoint('Architecture','manager',150000,['manage','analysis']),appoint('QA','manager',150000,['manage','analysis','research'],{area:'quality_assurance'}),appoint('Development','manager',220000,['manage','analysis','development']),{action:'ready'}]);
 for(let i=0;i<3;i++){
  s=await session();const index={Architecture:0,QA:1,Development:2}[s.node.name];
  await decide(s,[appoint(s.node.name+' worker','worker',index===2?180000:100000,s.node.tools.filter(t=>t!=='manage'),{reuseAgentId:p.team[index]})]);
 }
 const contract={path:'/pilot',scenarios:[{name:'Accepted',steps:[{action:'expectText',selector:'#state',value:'Accepted'}]}]};
 const scope='a'.repeat(64),baseline='b'.repeat(40);
 const spec={name:'Hierarchy native',summary:'Two components',requirements:['Show Accepted'],allowedPaths:['app/pilot/'],milestones:[0,1].map(i=>({title:'Component '+i,instruction:'Implement approved component',contract})),finalContract:contract};
 await db.query("update work_projects set status='awaiting_approval',phase='approval',spec=$2,approval_hash=$3,baseline_sha=$4,repository_full_name='mfackrell/katie' where id=$1",[project,spec,scope,baseline]);
 await db.query("select control_work_project($1,$2,$3,'approve',p_hash=>$4)",[project,actor,chat,scope]);
 s=await session();await decide(s,(await rows()).filter(n=>n.parent_id===s.node.id).map(n=>({action:'grant_scope',nodeId:n.id,paths:spec.allowedPaths})));
 for(let i=0;i<3;i++){
  s=await session();await decide(s,(await rows()).filter(n=>n.parent_id===s.node.id).map(n=>({action:'grant_scope',nodeId:n.id,paths:spec.allowedPaths})));
 }
 const accounts=[];
 for(let milestone=0;milestone<2;milestone++){
  await db.query("select finish_work_project($1,$2,'child',$3)",[project,await leaseProject(),{kind:'development',objective:'Implement approved component '+milestone,evidence:{syntheticOnly:true}}]);
  const mission=(await db.query('select active_mission_id id from work_projects where id=$1',[project])).rows[0].id;
  const job=(await db.query("select * from mission_assignments where mission_id=$1 and role='development'",[mission])).rows[0];
  const agent=(await db.query('select * from managed_agents where id=$1',[job.agent_id])).rows[0],taskChat=randomUUID(),lease=randomUUID();
  await db.query("insert into chats(id,actor_id,title) values($1,$2,'Delegated native worker')",[taskChat,agent.actor_id]);
  await db.query("insert into agent_tasks(id,agent_id,actor_id,chat_id,snapshot,definition_version,kind,initial_input,input,repository_id,repository_full_name,request_id,status,external) values($1::uuid,$2,$3,$4,$5,$6,'development','Frozen approved component','Frozen approved component',$7,'mfackrell/katie',$1::text,'dispatching','{}')",[job.id,agent.id,agent.actor_id,taskChat,agent.config,agent.version,repo]);
  await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[job.id,lease]);
  await assert.rejects(db.query('select project_org_prepare_native($1,$2)',[job.id,randomUUID()]),/Live delegated/);
  assert.equal((await db.query('select developer_next_initial_task($1,$2) id',[owner,chat])).rows[0].id,null,'No routine owner consent is offered for managed coding');
  const race=await Promise.all([db,rival].map(c=>c.query('select project_org_prepare_native($1,$2) ok',[job.id,lease])));
  assert.ok(race.every(r=>r.rows[0].ok));
  const d=(await db.query('select * from project_organization_native_delegations where task_id=$1',[job.id])).rows[0];
  const approval=(await db.query('select * from benchmark_native_spending_approvals where id=$1',[d.approval_id])).rows[0];
  assert.equal(approval.owner_id,owner);assert.equal(approval.task_id,job.id);assert.equal(approval.trial_id,null);
  assert.ok(d.limits.ceilingMicrousd<=2000000);assert.ok(d.limits.perCallMicrousd<=500000);assert.ok(Date.parse(approval.deadline)<=Date.parse(deadline));
  accounts.push(approval.account_id);
  assert.equal((await db.query('select count(*)::int n from benchmark_native_spending_approvals where task_id=$1',[job.id])).rows[0].n,1);
  const release='e'.repeat(40),token=randomBytes(32).toString('hex');
  assert.equal((await db.query('select developer_claim_dispatch($1,$2) ok',[approval.id,release])).rows[0].ok,true);
  const grant=(await db.query('select developer_issue_execution_grant($1,$2,$3,$4) g',[approval.id,job.id,token,release])).rows[0].g;
  const call=(await db.query('select developer_native_reserve($1,$2,$3,$4,$5,100) id',[token,project,grant.executionEpoch,randomUUID(),approval.model])).rows[0].id;
  const linked=(await db.query('select legacy_mission_call_id id from benchmark_budget_calls where id=$1',[call])).rows[0].id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-hierarchy-'+call,{input_tokens:3,output_tokens:2,total_tokens:5}]);
  assert.equal((await db.query('select state from benchmark_budget_calls where id=$1',[call])).rows[0].state,'settled');
  assert.ok((await db.query('select organization_exposure_microusd from mission_calls where id=$1',[linked])).rows[0].organization_exposure_microusd);
  // Synthetic accepted implementation output advances the fixture. No application
  // was generated, GitHub workflow dispatched, or production record accessed.
  await db.query("update agent_missions set status='completed',result='Synthetic accepted implementation' where id=$1",[mission]);
  await db.query("update work_projects set active_mission_id=null,milestone_index=$2 where id=$1",[project,milestone+1]);
 }
 assert.notEqual(accounts[0],accounts[1]);
 assert.equal((await db.query("select count(*)::int n from project_events where project_id=$1 and event='organization_financial_authority'",[project])).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from project_organization_native_delegations where project_id=$1',[project])).rows[0].n,2);
 console.log('PROJECT_ORGANIZATION_NATIVE_DELEGATION_PASS: one original owner envelope; two concurrent-idempotent task grants; actual canonical native reservations and settlement; no new owner consent');
}
