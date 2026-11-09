import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function assertDynamicProjectManagement(db){
 for(const size of [2,24]){
  await db.query('reset role');
  const actor=randomUUID(),chat=randomUUID(),owner=randomUUID(),project=randomUUID();
  await db.query("insert into actors(id,name) values($1,'Dynamic owner')",[actor]);
  await db.query("insert into chats(id,actor_id,title) values($1,$2,'Dynamic organization')",[chat,actor]);
  await db.query('insert into standalone_owner_bindings(owner_id,actor_id,chat_id,revoked_at) values($1,$2,$3,null)',[owner,actor,chat]);
  await db.query('set role service_role');
  await db.query('select create_work_project($1,$2,$3,$4,$5,null)',[project,'dynamic-'+project,actor,chat,'Deliver '+size+' independently justified functional outcomes']);
  const p=(await db.query('select * from work_projects where id=$1',[project])).rows[0];
  const hash=(await db.query("select encode(sha256(convert_to(objective||clarifications,'UTF8')),'hex') h from work_projects where id=$1",[project])).rows[0].h;
  await db.query('select project_org_authorize($1,$2,$3,10000000,1000000,true)',[owner,project,hash]);
  const nodes=async()=> (await db.query('select * from project_organization_nodes where project_id=$1',[project])).rows;
  const root=(await nodes())[0],deadline=new Date(Date.parse(p.deadline)-1000).toISOString();
  const session=async()=>{
   const projectLease=randomUUID();await db.query('reset role');
   await db.query("update work_projects set lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[project,projectLease]);await db.query('set role service_role');
   const scheduled=(await db.query('select project_org_schedule($1,$2) s',[project,projectLease])).rows[0].s;assert.ok(scheduled.missionId,JSON.stringify(scheduled));
   const lease=randomUUID();await db.query('reset role');
   const job=(await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where mission_id=$1 returning id",[scheduled.missionId,lease])).rows[0].id;await db.query('set role service_role');
   return{job,lease,node:(await nodes()).find(n=>n.id===scheduled.nodeId)};
  };
  const decide=(session,commands)=>db.query('select project_org_decide($1,$2,$3)',[session.job,session.lease,commands]);
  const areas=Array.from({length:size},(_,i)=>i===size-1?'quality_assurance':'domain_'+i);
  const plan=organizations=>({action:'plan',purpose:p.objective,direction:'Commission independent organizations for the required outcomes',outcomes:[{criterion:'Every original functional outcome is independently accepted',verification:'Integrated acceptance evidence'}],milestones:[{objective:'Deliver the complete approved product'}],organizations});
  const appoint=(area,tokens)=>({action:'appoint',kind:'manager',area,name:area,purpose:'Own the '+area+' outcome',objective:'Deliver '+area,deliverables:['Verified '+area+' component'],interfaces:['Versioned component interface'],reporting:'Certify to immediate superior; escalate only material exceptions',acceptance:['Independent '+area+' acceptance passes'],tokens,deadline,tools:['manage','analysis'],paths:[]});
  let pending=areas.map((area,i)=>appoint(area,i===0?200000:15000)),s=await session();
  await assert.rejects(decide(s,[appoint('unaffordable',p.token_allowance+1)]),/resources exceed parent/);
  await assert.rejects(decide(s,[{action:'ready'}]),/purpose|functional organizations/);
  await decide(s,[plan(areas),...pending.splice(0,15)]);
  while(pending.length){s=await session();assert.equal(s.node.id,root.id,'unfinished organization design remains with its director');await decide(s,pending.splice(0,16));}
  assert.equal((await nodes()).filter(n=>n.parent_id===root.id).length,size);
  const savedPlan=(await db.query('select * from project_organization_plans where node_id=$1',[root.id])).rows[0];assert.equal(savedPlan.purpose,p.objective);assert.equal(savedPlan.organizations.length,size);
  if(size===2)continue;
  // Ten nested management levels are justified by this synthetic project, not
  // by a fixed depth in the implementation. Every allocation remains inherited.
  let deep=(await nodes()).find(n=>n.area==='domain_0'),oldLeader=deep.agent_id;
  for(let i=0;i<size+10;i++){
   const pendingManagers=(await nodes()).filter(n=>n.kind!=='worker'&&n.decision_needed);
   if(!pendingManagers.length)break;
   s=await session();
   if(s.node.area==='domain_0'&&s.node.depth<10){
    await decide(s,[appoint('domain_0',200000-s.node.depth*10000-20000)]);
   }else await decide(s,[{action:'ready'}]);
  }
  assert.equal(Math.max(...(await nodes()).map(n=>n.depth)),10);
  deep=(await nodes()).find(n=>n.parent_id===root.id&&n.area==='domain_0');
  const moved=(await nodes()).find(n=>n.parent_id===root.id&&n.area==='domain_2');
  const wakeRoot=async()=>{await db.query('reset role');await db.query('update project_organization_nodes set decision_needed=true where id=$1',[root.id]);await db.query('set role service_role');return session();};
  s=await wakeRoot();
  await assert.rejects(decide(s,[{action:'reorganize',nodeId:deep.id,underId:deep.id,reason:'Circular reporting'}]),/authority/);
  await assert.rejects(decide(s,[{action:'dependency',nodeId:deep.id,dependsOn:moved.id},{action:'reorganize',nodeId:moved.id,underId:deep.id,reason:'Would inherit a self dependency'}]),/circular inherited dependency/);
  await assert.rejects(decide(s,[{action:'dependency',nodeId:moved.id,dependsOn:deep.id},{action:'reorganize',nodeId:moved.id,underId:deep.id,reason:'Would depend on its own parent acceptance'}]),/circular inherited dependency/);
  await decide(s,[{action:'reorganize',nodeId:moved.id,underId:deep.id,reason:'Coordinate a related interface under its accountable director'},plan(areas.filter(a=>a!==moved.area))]);
  assert.equal((await nodes()).find(n=>n.id===moved.id).parent_id,deep.id);
  // A superior can reject a directorate and replace leadership without taking
  // coding authority, discarding subordinate contracts, or resetting spending.
  s=await wakeRoot();
  // The receiving manager is correctly scheduled first; complete that local
  // management turn, then the root can evaluate its direct component.
  if(s.node.id!==root.id){await decide(s,[{action:'ready'}]);s=await session();}
  const descendantsBefore=(await nodes()).filter(n=>n.parent_id===deep.id).map(n=>({id:n.id,contract:n.management_contract,limit:n.token_limit}));
  await decide(s,[{action:'reject',nodeId:deep.id,findings:'The delegated interface acceptance criterion is not yet satisfied'},{action:'replace_leader',nodeId:deep.id,reason:'Appoint leadership capable of completing the original contract'}]);
  const replaced=(await nodes()).find(n=>n.id===deep.id);assert.notEqual(replaced.agent_id,oldLeader);assert.equal(replaced.token_limit,deep.token_limit);
  assert.deepEqual((await nodes()).filter(n=>n.parent_id===deep.id).map(n=>({id:n.id,contract:n.management_contract,limit:n.token_limit})),descendantsBefore);
  assert.equal((await db.query('select count(*)::int n from project_organization_leadership where node_id=$1',[deep.id])).rows[0].n,2);
  await assert.rejects(db.query('select project_org_assert_execution($1)',[oldLeader]),/cannot execute/);
  await db.query('reset role');await assert.rejects(db.query("update managed_agents set config=jsonb_set(config,'{development}','true') where id=$1",[oldLeader]),/cannot be reconfigured/);
 }
 console.log('DYNAMIC_MANAGEMENT_PASS: 2 and 24 directorates, depth 10, bounded restructuring, rejection and leadership replacement');
}
