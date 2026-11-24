import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {modules} from './load-project-modules.mjs';

export async function assertCodingCapacityNative(db,{project,owner,release,generation,deployment,current,claimed}){
 await db.query('reset role');
 const one=async(s,a=[]) => (await db.query(s,a)).rows[0];
 const p0=await one('select * from work_projects where id=$1',[project]);
 const nodes=(await db.query('select * from project_organization_nodes where project_id=$1 order by id',[project])).rows;
 const game=nodes.find(n=>n.area==='game_delivery'&&n.management_level==='functional_director');
 const manager=nodes.find(n=>n.area==='delivery_management'&&n.parent_id===game.id);
 const qa=nodes.find(n=>n.area==='independent_qa'&&n.management_level==='functional_director');
 const analyst=nodes.find(n=>n.area==='delivery_repository_assessment');
 assert.equal(nodes.length,13); assert.ok(game&&manager&&qa&&analyst);
 // Reconstruct the final two settled historical sessions inside the disposable
 // outer rollback fixture. No historical production data is touched.
 const decision95=randomUUID(),decision96=randomUUID(),mission96=randomUUID(),job96=randomUUID();
 await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]')",[decision95,project,claimed.job.payload.organizationNodeId,current.jid]);
 await db.query("update mission_assignments set status='completed',lease=null,lease_until=null,result=$2 where id=$1",[current.jid,{output:'Management decision recorded',decisionId:decision95}]);
 await db.query("update agent_missions set status='completed',calls=1,result='Management decisions committed' where id=$1",[current.mid]);
 const m=(await one('select to_jsonb(m) v from agent_missions m where id=$1',[current.mid])).v;
 const j=(await one('select to_jsonb(j) v from mission_assignments j where id=$1',[current.jid])).v;
 const stamp=new Date(Date.now()+9000).toISOString();
 await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[{...m,id:mission96,team:[{id:qa.agent_id,config:{name:qa.name,maxActiveTasks:1}}],project_evidence:{...m.project_evidence,organizationNodeId:qa.id,previousMissionId:null},created_at:stamp,updated_at:stamp,detail:null}]);
 await db.query('update work_projects set active_mission_id=$2 where id=$1',[project,mission96]);
 await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[{...j,id:job96,mission_id:mission96,agent_id:qa.agent_id,attempts:1,payload:{organizationNodeId:qa.id},result:{output:'Management decision recorded',decisionId:decision96},created_at:stamp,updated_at:stamp,detail:null}]);
 await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[job96,qa.id]);
 await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]')",[decision96,project,qa.id,job96]);
 // Earlier fixture branches deliberately leave unfinished synthetic jobs.
 // Normalize only this test baseline, before the preservation snapshot.
 await db.query("update agent_missions set status='blocked' where project_id=$1 and status not in ('completed','blocked','stopped','failed')",[project]);
 await db.query("update mission_assignments set status='failed',lease=null,lease_until=null where mission_id in (select id from agent_missions where project_id=$1) and (status not in ('completed','failed','blocked','stopped','cancelled','canceled') or lease is not null or lease_until is not null)",[project]);
 await db.query('update project_organization_nodes set decision_needed=(id=$2 or id=$3) where project_id=$1',[project,game.id,qa.id]);
 await db.query("update work_projects set status='blocked',detail='Approved project mission limit reached',active_mission_id=null,lease=null,lease_until=null,progress_since=clock_timestamp()-interval '5 minutes' where id=$1",[project]);
 const ids=(await db.query('select id from agent_missions where project_id=$1 order by id',[project])).rows.map(x=>x.id);
 assert.equal(ids.length,96);
 const snapshot=async()=>({
  missions:(await db.query('select to_jsonb(m) v from agent_missions m where id=any($1::uuid[]) order by id',[ids])).rows,
  assignments:(await db.query('select to_jsonb(j) v from mission_assignments j where mission_id=any($1::uuid[]) order by id',[ids])).rows,
  decisions:(await db.query('select to_jsonb(d) v from project_organization_decisions d where assignment_id in (select id from mission_assignments where mission_id=any($1::uuid[])) order by id',[ids])).rows,
  requests:(await db.query('select to_jsonb(r) v from project_provider_requests r where mission_id=any($1::uuid[]) order by id',[ids])).rows,
  grants:(await db.query('select to_jsonb(g) v from project_organization_scope_grants g where node_id=any($1::uuid[]) order by node_id,scope_hash',[nodes.map(n=>n.id)])).rows,
  nodes:(await db.query("select to_jsonb(n)-'decision_needed'-'updated_at' v from project_organization_nodes n where id=any($1::uuid[]) order by id",[nodes.map(n=>n.id)])).rows,
  oldReceipt:await one('select to_jsonb(r) v from project_followup_context_retest_receipts r where project_id=$1',[project])
 });
 const history=await snapshot();
 const pre=await one('select * from work_projects where id=$1',[project]);
 assert.equal(pre.max_missions,96);assert.equal(pre.token_allowance,600000);
 const install=async(path,adapt=false)=>{
  let s=readFileSync(path,'utf8').replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
  // Previous rollback-only fixtures substitute the native test owner and
  // release; the production preimage hashes remain strict and unchanged.
  if(adapt)for(const match of [...s.matchAll(/\('([^']+)'[,\s]+'([a-f0-9]{32})'\)/g)]){
   const h=(await one('select md5(prosrc) h from pg_proc where oid=$1::regprocedure',[match[1]])).h;
   s=s.replace("'"+match[2]+"'","'"+h+"'");
  }
  await db.query(s);
 };
 await install('supabase/migrations/20261124165000_coding_commissioning_continuation.sql');
 await install('supabase/migrations/20261124173000_owner_coding_capacity_recovery.sql',true);
 assert.deepEqual(await snapshot(),history);
 assert.equal((await one('select count(*)::int n from project_coding_capacity_receipts')).n,0);
 assert.deepEqual(await one('select * from work_projects where id=$1',[project]),pre);
 const gate=await one('select * from project_retest_production_release_gate where project_id=$1',[project]);
 assert.equal(gate.release_sha,release);assert.equal(Number(gate.generation),generation);
 const deny=async(fn,pattern)=>{
  await db.query('savepoint neg_capacity');
  try{await assert.rejects(fn(),pattern);}
  finally{await db.query('rollback to savepoint neg_capacity');await db.query('release savepoint neg_capacity');}
 };
 await db.query('set role service_role');
 const offer=await one('select project_org_coding_capacity_offer($1,$2,$3) o',[owner,project,release]).then(x=>x.o);
 assert.equal(offer.stage,'authorize');assert.equal(offer.historicalMissions,96);assert.equal(offer.remainingMissions,0);
 assert.equal(offer.recommendedAdditionalMissions,4);assert.equal(offer.directorId,game.id);assert.equal(offer.managerId,manager.id);
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation,deployment])).ok,false);
 await deny(()=>db.query('select project_org_schedule($1,$2)',[project,randomUUID()]));
 await deny(()=>db.query('select authorize_work_project_resources($1,$2,$3,600000,null,100,null,$4,$5)',[project,pre.actor_id,pre.chat_id,randomUUID(),'Unauthorized capacity renewal test']));
 const auth=async(n,id=randomUUID())=>[owner,project,release,generation,deployment,id,offer.stateHash,offer.scopeHash,offer.cutoff,n,96+n,n,0,600000,offer.remainingRecordedTokens];
 const authorize='select project_org_coding_capacity_authorize('+Array.from({length:15},(_,i)=>'$'+(i+1)).join(',')+') r';
 const args=await auth(4);
 for(const [i,v] of [[0,randomUUID()],[2,'f'.repeat(40)],[3,generation+1],[4,'dpl_Wrong'],[6,'f'.repeat(64)],[7,'f'.repeat(64)],[8,new Date(Date.now()+1e8).toISOString()],[9,9],[10,101],[11,5],[12,1],[13,600001],[14,offer.remainingRecordedTokens-1]]){
  await deny(()=>db.query(authorize,args.map((x,j)=>j===i?v:x)));
 }
 await deny(()=>db.query('delete from project_coding_capacity_receipts where project_id=$1',[project]));
 const result=(await one(authorize,args)).r;
 assert.equal(result.stage,'authorized');assert.equal(result.maxMissions,100);assert.equal(result.paidInferenceLimit,4);
 await deny(()=>db.query(authorize,args));
 await db.query('reset role');
 assert.deepEqual(await snapshot(),history,'All 96 historical missions, assignments, original hierarchy contracts, scope, decisions, receipts preserved');
 const renewed=await one('select * from work_projects where id=$1',[project]);
 assert.equal(renewed.status,'running');assert.equal(renewed.max_missions,100);assert.equal(renewed.token_allowance,pre.token_allowance);
 assert.deepEqual(renewed.deadline,pre.deadline);assert(renewed.progress_since>pre.progress_since);
 const receipt=await one('select * from project_coding_capacity_receipts where project_id=$1',[project]);
 await deny(()=>db.query('update project_coding_capacity_receipts set additional_missions=5 where project_id=$1',[project]));
 await deny(()=>db.query('update work_projects set max_missions=101 where id=$1',[project]));
 await deny(()=>db.query('update work_projects set token_allowance=600001 where id=$1',[project]));
 const scopePaths=offer.paths,scopeHash=offer.scopeHash,deadline=offer.cutoff;
 const pgAdapter={from(table){
  assert.match(table,/^[a-z_]+$/);let columns='*',where=[],values=[],orders=[],single=false,range;
  const q={select(c){assert.match(c,/^[a-z_,*]+$/);columns=c;return q;},
   eq(k,v){values.push(v);where.push(k+'=$'+values.length);return q;},
   in(k,v){values.push(v);where.push(k+'=any($'+values.length+')');return q;},
   order(k,o){orders.push(k+(o.ascending?' asc':' desc'));return q;},
   range(a,b){range=[a,b];return q;},single(){single=true;return q;},then(ok,bad){
    const sql='select '+columns+' from '+table+(where.length?' where '+where.join(' and '):'')+(orders.length?' order by '+orders.join(','):'')+(range?' limit '+(range[1]-range[0]+1)+' offset '+range[0]:'');
    return db.query(sql,values).then(r=>({data:JSON.parse(JSON.stringify(single?r.rows[0]:r.rows)),error:null})).then(ok,bad);
   }};return q;
 }};
 const {executeManagementClaim}=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>pgAdapter},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_provider_mode')return true;
   assert.equal(name,'project_org_decide');return db.query('select project_org_decide($1,$2,$3)',[args.p_job,args.p_lease,JSON.stringify(args.p_commands)]);
  }}})('@/lib/projects/organization');

 const schedule=async(node)=>{
  await db.query('reset role');
  const lease=randomUUID();
  await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,lease]);
  await db.query('set role service_role');
  const s=(await one('select project_org_schedule($1,$2) r',[project,lease])).r;
  assert.equal(s.nodeId,node.id,JSON.stringify(s));assert.ok(s.missionId);
  await db.query('reset role');
  await db.query("update mission_assignments set available_at=clock_timestamp()+interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where mission_id not in (select id from agent_missions where project_id=$1) and status='running' and lease_until>clock_timestamp()",[project]);
  await db.query("update mission_assignments set available_at=clock_timestamp()+interval '15 minutes' where mission_id not in (select id from agent_missions where project_id=$1) and status in ('queued','waiting_external')",[project]);
  await db.query("update mission_assignments set available_at=clock_timestamp()-interval '1 second' where mission_id=$1",[s.missionId]);
  await db.query('set role service_role');
  assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation+1,deployment])).ok,false);
  assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation,deployment])).ok,true);
  const c=(await one('select claim_mission_work_release_epoch($1,$2,$3) r',[release,generation,deployment])).r;
  assert.equal(c.mission.id,s.missionId);assert.equal(c.job.attempts,1);assert.ok(c.job.lease);
  assert.equal(c.mission.project_evidence.codingCapacityAuthorizationId,receipt.authorization_id);
  assert.notEqual((await one('select claim_mission_work_release_epoch($1,$2,$3) r',[release,generation,deployment])).r?.job?.id,c.job.id);
  return c;
 };
 const request=async(c,op,id,proof=null)=> (await one('select project_provider_request($1,$2,$3,$4,$5,null,$6) ok',[c.job.id,c.job.lease,id,op,'c'.repeat(64),proof])).ok;
 const settle=async(c)=>{
  const cat=randomUUID(),inf=randomUUID();
  assert.equal(await request(c,'inference',inf),false,'No inference before model catalog');
  assert.equal(await request(c,'model-list',cat),true);
  assert.equal(await request(c,'model-list',cat,'model-catalog'),true);
  assert.equal(await request(c,'inference',inf),true);
  assert.equal(await request(c,'inference',inf,'synthetic-commissioning-qualification-'+inf),true);
  assert.equal(await request(c,'inference',randomUUID()),false,'No duplicate paid inference');
 };
 const execute=async(c,commands)=>executeManagementClaim(c,async(_claim,instruction,input,tools)=>{
  assert.equal(tools,'none');assert.match(instruction,/OWNER-SIGNED COMMISSIONING-ONLY WINDOW/);
  assert.equal(JSON.parse(input).principal.id,c.job.payload.organizationNodeId);
  await settle(c);
  return {text:JSON.stringify(commands)};
 });
 const appointment=(name,tools,area)=>({action:'appoint',kind:'worker',managementLevel:'worker',name,area,objective:'Produce bounded milestone output for '+name,acceptance:['Verify approved result'],tools,paths:[],tokens:1000,deadline});
 let c=await schedule(game);
 await deny(()=>execute(c,[{action:'reject',nodeId:qa.id,findings:['Forbidden']}]));
 await execute(c,[{action:'reject',nodeId:manager.id,findings:['Commission the approved implementation workers and package']},{action:'ready'}]);
 c=await schedule(manager);
 await deny(()=>execute(c,[{...appointment('Forbidden',['analysis'],'delivery_planning'),kind:'manager',managementLevel:'manager'}]));
 await deny(()=>execute(c,[appointment('Unauthorized',['analysis','production_deploy'],'delivery_implementation')]));
 await execute(c,[appointment('Capacity Coder',['analysis','development'],'delivery_implementation'),appointment('Capacity Reviewer',['analysis'],'delivery_package_review'),{action:'ready'}]);
 const children=(await db.query('select * from project_organization_nodes where parent_id=$1 order by id',[manager.id])).rows;
 const coder=children.find(x=>x.name==='Capacity Coder'),reviewer=children.find(x=>x.name==='Capacity Reviewer');assert.ok(coder&&reviewer);
 assert.equal(coder.kind,'worker');assert.equal(coder.tools.includes('development'),true);
 c=await schedule(manager);
 await deny(()=>execute(c,[{action:'grant_scope',nodeId:coder.id,paths:['app/']}]));
 await execute(c,[{action:'grant_scope',nodeId:coder.id,paths:scopePaths},{action:'ready'}]);
 c=await schedule(manager);
 const files=['app/milestone-3-tic-tac-toe/page.tsx','lib/milestone-3-tic-tac-toe/game.ts','tests/milestone-3-tic-tac-toe/game.test.ts'];
 const smart=(role,paths)=>({objective:role+' bounded milestone output',deliverable:role+' evidence',instruction:'Complete the exact approved milestone contract for '+role,parentObjective:manager.objective,capability:'analysis',acceptance:[{criterion:'Approved browser contract passes',evidence:'Same source verification'}],inventory:[{item:'Approved tic-tac-toe milestone',contextChars:1000}],estimate:{basis:'declared_inventory',rationale:'One bounded deliverable',uncertainty:'Verify actual output',tokens:1000,seconds:30},tokens:2000,maxAssignments:2,deadline,paths});
 const command={action:'commission_package',workerId:coder.id,writerId:coder.id,reviewerId:reviewer.id,milestoneIndex:0,objective:'Implement approved tic-tac-toe game',deliverables:['Playable game and scoped tests'],interfaces:[],acceptance:['Approved browser contract passes'],dependencies:[],paths:scopePaths,deadline,maxAttempts:2,tasks:{development:smart('development',files),compose:smart('compose',[]),review:smart('review',[])}};
 await deny(()=>execute(c,[{...command,workerId:analyst.id}]));
 await deny(()=>execute(c,[{...command,reviewerId:coder.id}]));
 await deny(()=>execute(c,[{...command,paths:['app/']}]));
 await execute(c,[command]);
 await db.query('reset role');
 const final=await one('select * from work_projects where id=$1',[project]);
 assert.equal(final.status,'paused');assert.equal(final.active_mission_id,null);assert.equal(final.max_missions,100);
 assert.equal(final.token_allowance,600000);assert.deepEqual(final.deadline,pre.deadline);
 const pack=await one('select * from project_work_packages where project_id=$1',[project]);
 assert.equal(pack.status,'queued');assert.equal(pack.worker_id,coder.id);assert.equal(pack.reviewer_id,reviewer.id);
 assert.equal((await one('select count(*)::int n from project_work_packages where project_id=$1',[project])).n,1);
 assert.equal((await one('select count(*)::int n from project_worker_contracts where package_id=$1',[pack.id])).n,3);
 assert.equal((await one('select count(*)::int n from agent_missions where project_id=$1',[project])).n,100);
 assert.equal((await one("select count(*)::int n from project_provider_requests where project_id=$1 and not mission_id=any($2::uuid[]) and operation='inference' and resolved_at is not null",[project,ids])).n,4);
 assert.deepEqual(await snapshot(),history);assert.deepEqual(await one('select * from project_coding_capacity_receipts where project_id=$1',[project]),receipt);
 assert.equal((await one('select project_org_coding_capacity_live($1) ok',[project])).ok,false);
 await db.query('set role service_role');
 await deny(()=>db.query('select project_org_schedule($1,$2)',[project,randomUUID()]));
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation,deployment])).ok,false);
 console.log('CODING_CAPACITY_NATIVE_PASS '+JSON.stringify({priorMissions:96,approvedMax:100,missions:100,managementDecisions:4,packages:1,smartContracts:3,finalStatus:'paused',syntheticInferenceReceipts:4,realProviderCalls:0}));
}
