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
 // Substitute the exact existing production execution-team identities and
 // capability snapshots in this disposable fixture BEFORE any preservation
 // snapshot. Restore the ordinary immutable hierarchy trigger immediately.
 const actualTeam=[{"id":"e7d25ada-a761-41bf-8f65-f87056f175fa","config":{"name":"Project Lead","research":false,"reviewMode":"always","attachments":false,"development":false,"instructions":"Manage the original user outcome. Preserve acceptance requirements across milestones. Deliver only evidence-backed integrated results; a plan or partial milestone is not project completion.","maxInputChars":16000,"maxActiveTasks":1}},{"id":"0c491807-490a-4bfb-a56b-115d4dece4bf","config":{"name":"Project Research","research":true,"reviewMode":"always","attachments":false,"development":false,"instructions":"Research primary evidence, distinguish facts and gaps, independently challenge unsupported conclusions. Do not invent findings or actions.","maxInputChars":16000,"maxActiveTasks":1}},{"id":"8421786a-0874-4d86-992e-f0f087d8018e","config":{"name":"Game Development Specialist v1","research":true,"reviewMode":"always","attachments":false,"development":true,"instructions":"Implement only approved game requirements. Read lib/game-development/GAME_CONTRACT.md. Separate a self-contained pure transition(state,action) engine from UI, persistence, bot and network behavior. Preserve source-grounded edition/rules, approved interpretations and unresolved decisions. Execute registered model and real-browser scenarios through the existing independent workflow. Repair proven gameplay defects only; preserve verified source on infrastructure failures. Return exact commit, receipts and usable Preview. Do not merge, publish production, expand scope or change orchestration, secrets, dependencies or services.","maxInputChars":16000,"maxActiveTasks":1}}];
 const [leadIdentity,conflictIdentity,developerIdentity]=actualTeam.map(a=>a.id);
 for(const a of actualTeam)await db.query('insert into managed_agents(id,actor_id,config,archived) values($1,$2,$3,false)',[a.id,p0.actor_id,a.config]);
 await db.query('alter table project_organization_nodes disable trigger project_org_immutable');
 await db.query('update project_organization_nodes set agent_id=$2 where id=$1',[analyst.id,conflictIdentity]);
 await db.query('alter table project_organization_nodes enable trigger project_org_immutable');
 analyst.agent_id=conflictIdentity;
 await db.query('update work_projects set team=$2 where id=$1',[project,actualTeam.map(a=>a.id)]);
 assert.equal((await one('select agent_id from project_organization_nodes where id=$1',[analyst.id])).agent_id,conflictIdentity);
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
 await db.query('savepoint approved_four_capacity');
 const result=(await one(authorize,args)).r;
 assert.equal(result.stage,'authorized');assert.equal(result.maxMissions,100);assert.equal(result.paidInferenceLimit,4);
 await deny(()=>db.query(authorize,args));
 await db.query('reset role');
 assert.deepEqual(await snapshot(),history,'All 96 historical missions, assignments, original hierarchy contracts, scope, decisions, receipts preserved');
 const renewed=await one('select * from work_projects where id=$1',[project]);
 assert.equal(renewed.status,'running');assert.equal(renewed.max_missions,100);assert.equal(renewed.token_allowance,pre.token_allowance);
 assert.deepEqual(renewed.deadline,pre.deadline);assert(renewed.progress_since>pre.progress_since);
 let receipt=await one('select * from project_coding_capacity_receipts where project_id=$1',[project]);
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
 let decisionWrites=0;
 const {executeManagementClaim,assertManagementCommands}=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>pgAdapter},
  '@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='project_provider_mode')return true;
   assert.equal(name,'project_org_decide');decisionWrites++;return db.query('select project_org_decide($1,$2,$3)',[args.p_job,args.p_lease,JSON.stringify(args.p_commands)]);
  }}})('@/lib/projects/organization');

 let claimRelease=release,claimGeneration=generation,claimDeployment=deployment;
 const schedule=async(node)=>{
  await db.query('reset role');
  const lease=randomUUID();
  await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,lease]);
  await db.query('set role service_role');
  const s=(await one('select project_org_schedule($1,$2) r',[project,lease])).r;
  assert.equal(s.nodeId,node.id,JSON.stringify(s));assert.ok(s.missionId);
  await db.query('reset role');
  await db.query("update mission_assignments set available_at=clock_timestamp()+interval '15 minutes',lease_until=now()-interval '1 second' where mission_id not in (select id from agent_missions where project_id=$1) and status='running' and lease_until>clock_timestamp()",[project]);
  await db.query("update mission_assignments set available_at=clock_timestamp()+interval '15 minutes' where mission_id not in (select id from agent_missions where project_id=$1) and status in ('queued','waiting_external')",[project]);
  await db.query("update mission_assignments set available_at=now()-interval '1 second' where mission_id=$1",[s.missionId]);
  await db.query('set role service_role');
  assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,claimRelease,claimGeneration+1,claimDeployment])).ok,false);
  assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,claimRelease,claimGeneration,claimDeployment])).ok,true);
  const c=(await one('select claim_mission_work_release_epoch($1,$2,$3) r',[claimRelease,claimGeneration,claimDeployment])).r;
  assert.equal(c.mission.id,s.missionId);assert.equal(c.job.attempts,1);assert.ok(c.job.lease);
  assert.equal(c.mission.project_evidence.codingCapacityAuthorizationId,receipt.authorization_id);
  assert.notEqual((await one('select claim_mission_work_release_epoch($1,$2,$3) r',[claimRelease,claimGeneration,claimDeployment])).r?.job?.id,c.job.id);
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
  const context=JSON.parse(input);
  assert.equal(context.principal.id,c.job.payload.organizationNodeId);
  if(c.job.payload.organizationNodeId===manager.id&&instruction.includes('SIGNED APPOINTMENT IDENTITY CONTRACT')){
   assert.deepEqual(context.executionTeam.map(a=>a.id).sort(),[leadIdentity,developerIdentity].sort());
   assert.match(instruction,new RegExp(developerIdentity));assert.match(instruction,new RegExp(leadIdentity));
   assert.ok(!context.executionTeam.some(a=>a.id===conflictIdentity));
  }
  await settle(c);
  return {text:JSON.stringify(commands)};
 });
 const appointment=(name,tools,area)=>({action:'appoint',kind:'worker',managementLevel:'worker',name,area,objective:'Produce bounded milestone output for '+name,acceptance:['Verify approved result'],tools,paths:[],tokens:1000,deadline});
 let c=await schedule(game);
 const firstCommissioningMission=c.mission.id;
 await deny(()=>execute(c,[{action:'reject',nodeId:qa.id,findings:['Forbidden']}]));
 await execute(c,[{action:'reject',nodeId:manager.id,findings:['Commission the approved implementation workers and package']},{action:'ready'}]);
 c=await schedule(manager);
 // The exact historical response is unavailable. Exhaust the two direct
 // report identities that could pass the deployed application guard and
 // trigger the observed SQL error in the frozen 13-node production topology.
 // Test variants, never claim these were the actual historical JSON batch.
 const supervisor=nodes.find(n=>n.parent_id===manager.id&&n.area==='delivery_planning');
 assert.ok(supervisor&&analyst);
 const targets=[analyst,supervisor];
 const legitimateAppointments=[
  {...appointment('Capacity Coder',['analysis','development'],'delivery_implementation'),reuseAgentId:developerIdentity},
  {...appointment('Capacity Reviewer',['analysis'],'delivery_package_review'),reuseAgentId:leadIdentity}
 ];
 for(const target of targets){
  const grant={action:'grant_scope',nodeId:target.id,paths:scopePaths};
  for(const batch of [[grant],[...legitimateAppointments,grant,{action:'ready'}]]){
   assertManagementCommands(manager,nodes,batch); // old general validator accepts every possible direct target.
   await deny(async()=>{
    await settle(c);
    await db.query('select project_org_decide($1,$2,$3)',[c.job.id,c.job.lease,JSON.stringify(batch)]);
   },e=>e.code==='P0001'&&e.message==='Grant only newly appointed direct workers their approved scope');
   const before=decisionWrites;
   await deny(()=>execute(c,batch),e=>e.name==='ManagementCommandRejection'&&e.evidence?.code==='commissioning_stage'
    &&e.evidence?.action==='grant_scope'&&e.evidence?.targets?.[0]?.id===target.id
    &&typeof e.evidence?.proposalHash==='string');
   assert.equal(decisionWrites,before,'Corrected application rejects before decision RPC');
  }
 }
 assert.equal((await one('select count(*)::int n from project_organization_nodes where project_id=$1',[project])).n,13);
 assert.equal((await one('select count(*)::int n from project_work_packages where project_id=$1',[project])).n,0);
 console.log('MISSION98_EXHAUSTIVE_TARGET_REPRODUCTION_PASS: two possible prior direct targets; grant alone and mixed appointments; same P0001, unchanged SQL; corrected application rejects before RPC');
 await deny(()=>execute(c,[{...appointment('Forbidden',['analysis'],'delivery_planning'),kind:'manager',managementLevel:'manager'}]));
 await deny(()=>execute(c,[appointment('Unauthorized',['analysis','production_deploy'],'delivery_implementation')]));
 await deny(()=>execute(c,[legitimateAppointments[0],legitimateAppointments[0],{action:'ready'}]));
 const collision=[legitimateAppointments[0],{...legitimateAppointments[1],reuseAgentId:conflictIdentity}];
 // Exact historical response is unavailable; this is a reconstruction of
 // the saved conflicting ID and actual SQL uniqueness failure.
 await deny(async()=>{
  await settle(c);
  await db.query('select project_org_decide($1,$2,$3)',[c.job.id,c.job.lease,JSON.stringify(collision)]);
 },e=>e.code==='23505'&&e.constraint==='project_organization_nodes_project_id_agent_id_key'&&e.detail.includes(conflictIdentity));
 const preIdentityWrites=decisionWrites;
 for(const bad of [collision,
  [{...legitimateAppointments[0],reuseAgentId:leadIdentity},legitimateAppointments[1]],
  [legitimateAppointments[0],{...legitimateAppointments[1],reuseAgentId:developerIdentity}],
  [legitimateAppointments[0],{...legitimateAppointments[1],reuseAgentId:randomUUID()}],
  [legitimateAppointments[0],{...legitimateAppointments[1],reuseAgentId:undefined}],
  [legitimateAppointments[0],{...legitimateAppointments[1],parentId:qa.id}]]){
  await deny(()=>execute(c,bad),e=>e.name==='ManagementCommandRejection'&&['commissioning_agent_identity','commissioning_stage'].includes(e.evidence?.code));
 }
 assert.equal(decisionWrites,preIdentityWrites);
 await db.query('reset role');
 await db.query('savepoint missing_reviewer_identity');
 await db.query('update managed_agents set archived=true where id=$1',[leadIdentity]);
 await db.query('set role service_role');
 await assert.rejects(()=>execute(c,legitimateAppointments),/Commissioning resource constraint/);
 await db.query('reset role');
 await db.query('rollback to savepoint missing_reviewer_identity');await db.query('release savepoint missing_reviewer_identity');
 await db.query('set role service_role');
 console.log('MISSION99_IDENTITY_REGRESSION_PASS: actual assigned ID and native 23505 reproduced; assigned, duplicate, unknown, missing, incapable and cross-hierarchy identities rejected before RPC; unavailable reviewer fails before inference');
 // Qualify exact successor approval from the settled, actually rejected
 // M98 fixture. Preserve original history/receipt; only the isolated fixture
 // substitutes original IDs and production release identity.
 const failedClaim=c,initialReceipt=receipt;
 await db.query('savepoint mission98_resume_branch');
 await settle(c);
 await deny(()=>db.query('select project_org_decide($1,$2,$3)',[c.job.id,c.job.lease,JSON.stringify([{action:'grant_scope',nodeId:analyst.id,paths:scopePaths}])]),e=>e.code==='P0001'&&e.message==='Grant only newly appointed direct workers their approved scope');
 const failure='Mission state operation failed: {"code":"P0001","details":null,"hint":null,"message":"Grant only newly appointed direct workers their approved scope"}';
 assert.equal((await one("select commit_mission_work($1,$2,$3,'[]','failed','blocked',null) ok",[c.job.id,c.job.lease,JSON.stringify({detail:failure,diagnostic:{stage:'work',errorType:'Error',acceptedIssue:false}})])).ok,true);
 await db.query('reset role');
 const failureLease=randomUUID();
 await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,failureLease]);
 await db.query('set role service_role');
 const failed=(await one('select project_org_schedule($1,$2) r',[project,failureLease])).r;
 assert.equal(failed.blocked,'Commissioning assignment failed; automatic retries are not authorized');
 assert.equal((await one("select finish_work_project($1,$2,'block',$3) ok",[project,failureLease,JSON.stringify({detail:failed.blocked})])).ok,true);
 await db.query('reset role');
 const preservedIds=(await db.query('select id from agent_missions where project_id=$1 order by id',[project])).rows.map(x=>x.id);
 assert.equal(preservedIds.length,98);
 const preserved=async()=>({
  missions:(await db.query('select to_jsonb(m) v from agent_missions m where id=any($1::uuid[]) order by id',[preservedIds])).rows,
  assignments:(await db.query('select to_jsonb(j) v from mission_assignments j where mission_id=any($1::uuid[]) order by id',[preservedIds])).rows,
  decisions:(await db.query('select to_jsonb(d) v from project_organization_decisions d where assignment_id in (select id from mission_assignments where mission_id=any($1::uuid[])) order by id',[preservedIds])).rows,
  requests:(await db.query('select to_jsonb(q) v from project_provider_requests q where mission_id=any($1::uuid[]) order by id',[preservedIds])).rows,
  nodes:(await db.query("select to_jsonb(n)-'decision_needed'-'updated_at' v from project_organization_nodes n where id=any($1::uuid[]) order by id",[nodes.map(n=>n.id)])).rows,
  grants:(await db.query('select to_jsonb(g) v from project_organization_scope_grants g where node_id=any($1::uuid[]) order by node_id,scope_hash',[nodes.map(n=>n.id)])).rows,
  receipt:await one('select * from project_coding_capacity_receipts where project_id=$1',[project])
 });
 const saved98=await preserved();
 const baseline98=await one('select * from work_projects where id=$1',[project]);
 assert.equal(baseline98.status,'blocked');assert.equal(baseline98.max_missions,100);assert.equal(baseline98.active_mission_id,c.mission.id);
 let recoverySql=readFileSync('supabase/migrations/20261124193000_mission98_coding_capacity_resume.sql','utf8')
  .replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
 const fixtureIds=[['99788be7-2c41-4145-b1a7-a96e6635a667',initialReceipt.authorization_id],
  ['4bb4e90717064f07f0d0ef8424d48b38f044a4ab',release],['dpl_83d7Wz9ArXqiwyJCGKQyoybNmbzx',deployment],
  ['5bd4b72d-cd8b-4425-a6dd-16fdcfd346d7',c.mission.id],['3cf41309-6f35-4c68-8e75-7da55d5669c6',c.job.id],
  ['780f3dd3-20d1-46a5-966a-53ff600863c1',firstCommissioningMission],['r.release_generation<>41','r.release_generation<>'+generation]];
 for(const [a,b] of fixtureIds){assert.ok(recoverySql.includes(a));recoverySql=recoverySql.replaceAll(a,b);}
 for(const match of [...recoverySql.matchAll(/\('([^']+)'[,\s]+'([a-f0-9]{32})'\)/g)]){
  const hash=(await one('select md5(prosrc) h from pg_proc where oid=$1::regprocedure',[match[1]])).h;
  recoverySql=recoverySql.replace("'"+match[2]+"'","'"+hash+"'");
 }
 await db.query(recoverySql);
 assert.deepEqual(await preserved(),saved98);assert.deepEqual(await one('select * from work_projects where id=$1',[project]),baseline98);
 assert.equal((await one('select count(*)::int n from project_coding_capacity_resume_receipts')).n,0);
 const newRelease='f'.repeat(40),newDeployment='dpl_Mission98Corrected';
 // Fixture uses the real guarded CLOSE/OPEN functions. Canonical deployment
 // is independently verified by the HTTP route, with a mock Vercel probe in
 // owner runtime qualification. No production aliases are touched here.
 await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5)',[project,release,deployment,'closed',generation]);
 await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5)',[project,newRelease,newDeployment,'active',generation+1]);
 claimRelease=newRelease;claimGeneration=generation+2;claimDeployment=newDeployment;
 await db.query('set role service_role');
 const offer98=(await one('select project_org_coding_capacity_offer($1,$2,$3) o',[owner,project,newRelease])).o;
 assert.equal(offer98.stage,'authorize');assert.equal(offer98.historicalMissions,98);assert.equal(offer98.priorMaxMissions,100);
 assert.equal(offer98.remainingMissions,2);assert.equal(offer98.additionalMissions,3);assert.equal(offer98.maxMissions,101);
 assert.equal(offer98.paidInferenceLimit,3);assert.equal(offer98.sourceMissionId,c.mission.id);assert.equal(offer98.sourceAssignmentId,c.job.id);
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,newRelease,claimGeneration,newDeployment])).ok,false);
 await deny(()=>db.query('select project_org_schedule($1,$2)',[project,randomUUID()]));
 await deny(()=>db.query('select authorize_work_project_resources($1,$2,$3,600000,null,101,null,$4,$5)',[project,pre.actor_id,pre.chat_id,randomUUID(),'Unauthorized successor capacity renewal test']));
 const newAuth=randomUUID(),resumeArgs=[owner,project,newRelease,claimGeneration,newDeployment,newAuth,offer98.stateHash,offer98.scopeHash,offer98.cutoff,3,101,3,0,600000,offer98.remainingRecordedTokens,initialReceipt.authorization_id,c.mission.id,c.job.id];
 const resumeSql='select project_org_coding_capacity_resume_authorize('+Array.from({length:18},(_,i)=>'$'+(i+1)).join(',')+') r';
 for(const [i,v] of [[0,randomUUID()],[2,release],[3,generation],[4,deployment],[5,initialReceipt.authorization_id],[6,'e'.repeat(64)],[7,'e'.repeat(64)],[8,new Date(Date.now()+1e8).toISOString()],[9,2],[10,102],[11,4],[12,1],[13,600001],[14,offer98.remainingRecordedTokens-1],[15,randomUUID()],[16,randomUUID()],[17,randomUUID()]]){
  await deny(()=>db.query(resumeSql,resumeArgs.map((x,j)=>j===i?v:x)));
 }
 const authorized98=(await one(resumeSql,resumeArgs)).r;
 assert.equal(authorized98.stage,'authorized');assert.equal(authorized98.authorizationId,newAuth);assert.equal(authorized98.remainingMissions,3);
 await deny(()=>db.query(resumeSql,resumeArgs));
 await db.query('reset role');
 assert.deepEqual(await preserved(),saved98);
 const resumed98=await one('select * from work_projects where id=$1',[project]);
 assert.equal(resumed98.status,'running');assert.equal(resumed98.active_mission_id,null);assert.equal(resumed98.max_missions,101);
 assert.equal(resumed98.token_allowance,600000);assert.deepEqual(resumed98.deadline,baseline98.deadline);assert(resumed98.progress_since>baseline98.progress_since);
 const savedResume=await one('select * from project_coding_capacity_resume_receipts where project_id=$1',[project]);
 await deny(()=>db.query('update project_coding_capacity_resume_receipts set paid_inference_limit=4 where project_id=$1',[project]));
 await deny(()=>db.query('update work_projects set max_missions=102 where id=$1',[project]));
 receipt={authorization_id:newAuth};
 c=await schedule(manager);
 assert.ok(!preservedIds.includes(c.mission.id));await execute(c,[...legitimateAppointments,{action:'ready'}]);
 const newWorkers=(await db.query('select * from project_organization_nodes where parent_id=$1 order by id',[manager.id])).rows;
 const newCoder=newWorkers.find(x=>x.name==='Capacity Coder'),newReviewer=newWorkers.find(x=>x.name==='Capacity Reviewer');
 assert.ok(newCoder&&newReviewer);assert.notEqual(newCoder.id,newReviewer.id);
 assert.equal(newCoder.agent_id,developerIdentity);assert.equal(newReviewer.agent_id,leadIdentity);
 assert.equal(newCoder.parent_id,manager.id);assert.equal(newReviewer.parent_id,manager.id);
 c=await schedule(manager);
 await deny(()=>execute(c,[{action:'grant_scope',nodeId:analyst.id,paths:scopePaths}]));
 await deny(()=>execute(c,[{action:'grant_scope',nodeId:newCoder.id,paths:['app/']}]));
 await execute(c,[{action:'grant_scope',nodeId:newCoder.id,paths:scopePaths},{action:'ready'}]);
 c=await schedule(manager);
 const scopeFiles=['app/milestone-3-tic-tac-toe/page.tsx','lib/milestone-3-tic-tac-toe/game.ts','tests/milestone-3-tic-tac-toe/game.test.ts'];
 const task=(role,paths)=>({objective:role+' bounded milestone output',deliverable:role+' evidence',instruction:'Complete the exact approved milestone contract for '+role,parentObjective:manager.objective,capability:'analysis',acceptance:[{criterion:'Approved browser contract passes',evidence:'Same source verification'}],inventory:[{item:'Approved tic-tac-toe milestone',contextChars:1000}],estimate:{basis:'declared_inventory',rationale:'One bounded deliverable',uncertainty:'Verify actual output',tokens:1000,seconds:30},tokens:2000,maxAssignments:2,deadline,paths});
 const commission={action:'commission_package',workerId:newCoder.id,writerId:newCoder.id,reviewerId:newReviewer.id,milestoneIndex:0,objective:'Implement approved tic-tac-toe game',deliverables:['Playable game and scoped tests'],interfaces:[],acceptance:['Approved browser contract passes'],dependencies:[],paths:scopePaths,deadline,maxAttempts:2,tasks:{development:task('development',scopeFiles),compose:task('compose',[]),review:task('review',[])}};
 await deny(()=>execute(c,[{...commission,reviewerId:newCoder.id}]));
 await deny(()=>execute(c,[{...commission,tasks:{...commission.tasks,development:{...commission.tasks.development,parentObjective:'Wrong parent objective'}}}]));
 await execute(c,[commission]);
 await db.query('reset role');
 const final98=await one('select * from work_projects where id=$1',[project]);
 const package98=await one('select * from project_work_packages where project_id=$1',[project]);
 assert.equal(final98.status,'paused');assert.equal(final98.active_mission_id,null);assert.equal(final98.max_missions,101);assert.equal(final98.token_allowance,600000);
 assert.equal(package98.status,'queued');assert.equal(package98.worker_id,newCoder.id);assert.equal(package98.reviewer_id,newReviewer.id);
 assert.equal((await one('select count(*)::int n from project_work_packages where project_id=$1',[project])).n,1);
 assert.equal((await one('select count(*)::int n from project_worker_contracts where package_id=$1',[package98.id])).n,3);
 assert.equal((await one('select count(*)::int n from agent_missions where project_id=$1',[project])).n,101);
 assert.equal((await one("select count(*)::int n from project_provider_requests where project_id=$1 and NOT mission_id=any($2::uuid[]) and operation='inference' and resolved_at is not null",[project,preservedIds])).n,3);
 assert.equal((await one('select count(*)::int n from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1 and NOT m.id=any($2::uuid[]) and j.attempts=1',[project,preservedIds])).n,3);
 assert.deepEqual(await preserved(),saved98);assert.deepEqual(await one('select * from project_coding_capacity_resume_receipts where project_id=$1',[project]),savedResume);
 assert.equal((await one('select project_org_coding_capacity_live($1) ok',[project])).ok,false);
 await db.query('set role service_role');
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,newRelease,claimGeneration,newDeployment])).ok,false);
 console.log('MISSION98_RESUME_NATIVE_PASS '+JSON.stringify({history:98,oldCeiling:100,newCeiling:101,freshMissions:3,paidFixtureReceipts:3,attemptsEach:1,packages:1,smartContracts:3,packageId:package98.id,realProviderCalls:0}));
 await db.query('reset role');
 await db.query('rollback to savepoint mission98_resume_branch');await db.query('release savepoint mission98_resume_branch');
 receipt=initialReceipt;claimRelease=release;claimGeneration=generation;claimDeployment=deployment;c=failedClaim;
 await db.query('set role service_role');
 await execute(c,[...legitimateAppointments,{action:'ready'}]);
 const children=(await db.query('select * from project_organization_nodes where parent_id=$1 order by id',[manager.id])).rows;
 const coder=children.find(x=>x.name==='Capacity Coder'),reviewer=children.find(x=>x.name==='Capacity Reviewer');assert.ok(coder&&reviewer);
 assert.equal(coder.agent_id,developerIdentity);assert.equal(reviewer.agent_id,leadIdentity);
 assert.equal(coder.kind,'worker');assert.equal(coder.tools.includes('development'),true);
 c=await schedule(manager);
 const beforeGrantDecision=decisionWrites;
 await deny(()=>execute(c,[{action:'grant_scope',nodeId:analyst.id,paths:scopePaths}]),e=>e.evidence?.code==='commissioning_stage');
 await deny(()=>execute(c,[{action:'grant_scope',nodeId:qa.id,paths:scopePaths}]));
 await deny(()=>execute(c,[{action:'grant_scope',nodeId:coder.id,paths:['app/']}]));
 assert.equal(decisionWrites,beforeGrantDecision);

 await execute(c,[{action:'grant_scope',nodeId:coder.id,paths:scopePaths},{action:'ready'}]);
 c=await schedule(manager);
 const files=['app/milestone-3-tic-tac-toe/page.tsx','lib/milestone-3-tic-tac-toe/game.ts','tests/milestone-3-tic-tac-toe/game.test.ts'];
 const smart=(role,paths)=>({objective:role+' bounded milestone output',deliverable:role+' evidence',instruction:'Complete the exact approved milestone contract for '+role,parentObjective:manager.objective,capability:'analysis',acceptance:[{criterion:'Approved browser contract passes',evidence:'Same source verification'}],inventory:[{item:'Approved tic-tac-toe milestone',contextChars:1000}],estimate:{basis:'declared_inventory',rationale:'One bounded deliverable',uncertainty:'Verify actual output',tokens:1000,seconds:30},tokens:2000,maxAssignments:2,deadline,paths});
 const command={action:'commission_package',workerId:coder.id,writerId:coder.id,reviewerId:reviewer.id,milestoneIndex:0,objective:'Implement approved tic-tac-toe game',deliverables:['Playable game and scoped tests'],interfaces:[],acceptance:['Approved browser contract passes'],dependencies:[],paths:scopePaths,deadline,maxAttempts:2,tasks:{development:smart('development',files),compose:smart('compose',[]),review:smart('review',[])}};
 await deny(()=>execute(c,[{action:'grant_scope',nodeId:coder.id,paths:scopePaths}]),e=>e.evidence?.code==='commissioning_stage');
 await deny(()=>execute(c,[command,command]),e=>e.evidence?.code==='commissioning_stage');
 await deny(()=>execute(c,[{...command,tasks:{...command.tasks,development:{...command.tasks.development,parentObjective:'Wrong manager'}}}]));
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
 // Separately prove a smaller owner-selected allowance stops before a package.
 await db.query('reset role');
 await db.query('rollback to savepoint approved_four_capacity');
 await db.query('release savepoint approved_four_capacity');
 await db.query('set role service_role');
 const single=(await one(authorize,await auth(1))).r;
 assert.equal(single.maxMissions,97);assert.equal(single.paidInferenceLimit,1);
 await db.query('reset role');
 receipt=await one('select * from project_coding_capacity_receipts where project_id=$1',[project]);
 c=await schedule(game);
 await execute(c,[{action:'reject',nodeId:manager.id,findings:['Commission the authorized implementation package']},{action:'ready'}]);
 await db.query('reset role');
 const stopped=await one('select * from work_projects where id=$1',[project]);
 assert.equal(stopped.status,'blocked');assert.equal(stopped.active_mission_id,null);
 assert.equal(stopped.max_missions,97);assert.equal(stopped.token_allowance,600000);
 assert.equal((await one('select count(*)::int n from agent_missions where project_id=$1',[project])).n,97);
 assert.equal((await one('select count(*)::int n from project_work_packages where project_id=$1',[project])).n,0);
 assert.deepEqual(await snapshot(),history);
 await db.query('set role service_role');
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation,deployment])).ok,false);
 console.log('CODING_CAPACITY_CEILING_PASS: one selected mission, 97/97, zero packages, no further claim');
 console.log('CODING_CAPACITY_NATIVE_PASS '+JSON.stringify({priorMissions:96,approvedMax:100,missions:100,managementDecisions:4,packages:1,smartContracts:3,finalStatus:'paused',syntheticInferenceReceipts:4,realProviderCalls:0}));
}
