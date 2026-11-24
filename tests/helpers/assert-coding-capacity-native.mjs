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
 for(const a of actualTeam){
  const actorId=randomUUID();
  await db.query('insert into actors(id,name,system_prompt,review_mode) values($1,$2,$3,$4)',[actorId,a.config.name,a.config.instructions,a.config.reviewMode]);
  await db.query('insert into managed_agents(id,actor_id,config,archived) values($1,$2,$3,false)',[a.id,actorId,a.config]);
 }
 await db.query('alter table project_organization_nodes disable trigger project_org_immutable');
 await db.query('update project_organization_nodes set agent_id=$2 where id=$1',[analyst.id,conflictIdentity]);
 await db.query('alter table project_organization_nodes enable trigger project_org_immutable');
 analyst.agent_id=conflictIdentity;
 // Transplant the original registered specialist binding too, instead of
 // weakening the real mission-admission check. This is fixture-only setup.
 const pin=await db.query("update game_specialist_bindings b set agent_id=a.id,definition_version=a.version,config_hash=encode(sha256(convert_to(project_canonical(a.config),'UTF8')),'hex') from managed_agents a where b.actor_id=$1 and a.id=$2",[p0.actor_id,developerIdentity]);
 assert.equal(pin.rowCount,1);
 for(const [role,id] of [['lead',leadIdentity],['research',conflictIdentity],['game-development',developerIdentity]]){
  await db.query('insert into project_agents(actor_id,role,agent_id) values($1,$2,$3) on conflict(actor_id,role) do update set agent_id=excluded.agent_id',[p0.actor_id,role,id]);
 }
 await db.query('update work_projects set team=$2 where id=$1',[project,actualTeam.map(a=>a.id)]);
 assert.equal((await one('select game_project_specialist_valid($1) ok',[project])).ok,true);
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
 const {executeManagementClaim,assertManagementCommands,codingCapacityManagerStage,assertCodingCapacityManagerStage}=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>pgAdapter},
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
  if(instruction.includes('SIGNED PACKAGE ROLE CONTRACT')){assert.match(instruction,/SIGNED SMART WORKLOAD CAPACITY/);assert.match(instruction,/"contextChars":16000/);}
  if(c.job.payload.organizationNodeId===manager.id&&instruction.includes('SIGNED APPOINTMENT IDENTITY CONTRACT')){
   assert.deepEqual(context.executionTeam.map(a=>a.id).sort(),[leadIdentity,developerIdentity].sort());
   assert.match(instruction,new RegExp(developerIdentity));assert.match(instruction,new RegExp(leadIdentity));
   assert.ok(!context.executionTeam.some(a=>a.id===conflictIdentity));
  }
  await settle(c);
  return {text:JSON.stringify(commands)};
 });
 const appointment=(name,tools,area)=>({action:'appoint',kind:'worker',managementLevel:'worker',name,area,objective:'Produce bounded milestone output for '+name,acceptance:['Verify approved result'],tools,paths:[],tokens:tools.includes('development')?32000:16000,deadline});
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
 assert.ok(!preservedIds.includes(c.mission.id));
 // Reproduce and settle M99 under the real preceding owner receipt. The
 // historical provider body was not retained; reconstruct the exact
 // conflicting existing ID with the native constraint.
 const m99Claim=c;
 await db.query('savepoint mission99_identity_resume');
 await settle(c);
 await deny(()=>db.query('select project_org_decide($1,$2,$3)',[c.job.id,c.job.lease,JSON.stringify(collision)]),
  e=>e.code==='23505'&&e.constraint==='project_organization_nodes_project_id_agent_id_key'&&e.detail.includes(conflictIdentity));
 const failure99='Mission state operation failed: '+JSON.stringify({code:'23505',details:'Key (project_id, agent_id)=('+project+', '+conflictIdentity+') already exists.',hint:null,message:'duplicate key value violates unique constraint "project_organization_nodes_project_id_agent_id_key"'});
 assert.equal((await one("select commit_mission_work($1,$2,$3,'[]','failed','blocked',null) ok",[c.job.id,c.job.lease,JSON.stringify({detail:failure99,diagnostic:{stage:'work',errorType:'Error',acceptedIssue:false}})])).ok,true);
 await db.query('reset role');
 const failureLease99=randomUUID();
 await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,failureLease99]);
 await db.query('set role service_role');
 const failed99=(await one('select project_org_schedule($1,$2) r',[project,failureLease99])).r;
 assert.equal(failed99.blocked,'Commissioning assignment failed; automatic retries are not authorized');
 assert.equal((await one("select finish_work_project($1,$2,'block',$3) ok",[project,failureLease99,JSON.stringify({detail:failed99.blocked})])).ok,true);
 await db.query('reset role');
 const history99Ids=(await db.query('select id from agent_missions where project_id=$1 order by id',[project])).rows.map(x=>x.id);
 assert.equal(history99Ids.length,99);
 const preserve99=async()=>({
  original:await preserved(),
  m99:await one('select to_jsonb(m) m,to_jsonb(j) j from agent_missions m join mission_assignments j on j.mission_id=m.id where m.id=$1',[m99Claim.mission.id]),
  requests:(await db.query('select to_jsonb(q) v from project_provider_requests q where mission_id=$1 order by id',[m99Claim.mission.id])).rows,
  prior:await one("select to_jsonb(s)-'supersedes_authorization_id' v from project_coding_capacity_resume_receipts s where project_id=$1 and historical_missions=98",[project]),
  team:(await db.query('select to_jsonb(a) v from managed_agents a where id=any($1::uuid[]) order by id',[actualTeam.map(a=>a.id)])).rows
 });
 const saved99=await preserve99();
 const blocked99=await one('select * from work_projects where id=$1',[project]);
 assert.equal(blocked99.status,'blocked');assert.equal(blocked99.max_missions,101);assert.equal(blocked99.active_mission_id,c.mission.id);
 let sql99=readFileSync('supabase/migrations/20261124195000_mission99_commissioning_identity_resume.sql','utf8')
  .replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
 for(const [a,b] of [['dcbfc493-6311-44eb-af33-bcba213c3d64',newAuth],
  ['b3094d37a99ebe4b9a0cc9e86ef2f35515b655f8',newRelease],['dpl_CsCXnyzKQbLkYYD7WGbMLr51ihej',newDeployment],
  ['43af2c7c-0b7c-48e6-a247-016e599f3349',c.mission.id],['fb7c3e64-64ba-4612-9bba-a4084c11aafe',c.job.id],
  ['s.release_generation<>43','s.release_generation<>'+claimGeneration]]){
  assert.ok(sql99.includes(a));sql99=sql99.replaceAll(a,b);
 }
 for(const match of [...sql99.matchAll(/\('([^']+)'[,\s]+'([a-f0-9]{32})'\)/g)]){
  const hash=(await one('select md5(prosrc) h from pg_proc where oid=$1::regprocedure',[match[1]])).h;
  sql99=sql99.replace("'"+match[2]+"'","'"+hash+"'");
 }
 const priorReceiptRelations=(await db.query("select oid::text,relname,relkind from pg_class where relname like 'project_coding_capacity%' order by oid")).rows;
 await db.query(sql99);
 // The isolated test installs DDL inside an existing, already-used transaction.
 // Replan cached statements as the production migration's next transaction would.
 await db.query('DISCARD PLANS');
 assert.deepEqual(await preserve99(),saved99);
 assert.deepEqual(await one('select * from work_projects where id=$1',[project]),blocked99);
 assert.equal((await one('select count(*)::int n from project_coding_capacity_resume_receipts where project_id=$1',[project])).n,1);
 const identityRelease='e'.repeat(40),identityDeployment='dpl_Mission99Corrected',identityGeneration=claimGeneration+2;
 await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5)',[project,newRelease,newDeployment,'closed',claimGeneration]);
 await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5)',[project,identityRelease,identityDeployment,'active',claimGeneration+1]);
 await db.query('set role service_role');
 const offer99=(await one('select project_org_coding_capacity_offer($1,$2,$3) o',[owner,project,identityRelease])).o;
 assert.equal(offer99.stage,'authorize');assert.equal(offer99.historicalMissions,99);assert.equal(offer99.priorMaxMissions,101);
 assert.equal(offer99.remainingMissions,2);assert.equal(offer99.additionalMissions,3);assert.equal(offer99.maxMissions,102);
 assert.equal(offer99.priorAuthorizationId,newAuth);assert.equal(offer99.sourceMissionId,c.mission.id);assert.equal(offer99.sourceAssignmentId,c.job.id);
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,identityRelease,identityGeneration,identityDeployment])).ok,false);
 await deny(()=>db.query('select authorize_work_project_resources($1,$2,$3,600000,null,102,null,$4,$5)',[project,pre.actor_id,pre.chat_id,randomUUID(),'Unauthorized successor capacity renewal test']));
 const auth99=randomUUID(),args99=[owner,project,identityRelease,identityGeneration,identityDeployment,auth99,offer99.stateHash,offer99.scopeHash,offer99.cutoff,3,102,3,0,600000,offer99.remainingRecordedTokens,newAuth,c.mission.id,c.job.id];
 for(const [i,v] of [[0,randomUUID()],[2,newRelease],[3,identityGeneration-2],[4,newDeployment],[5,newAuth],[6,'a'.repeat(64)],[7,'e'.repeat(64)],[8,new Date(Date.now()+1e8).toISOString()],[9,2],[10,103],[11,4],[12,1],[13,600001],[14,offer99.remainingRecordedTokens-1],[15,initialReceipt.authorization_id],[16,randomUUID()],[17,randomUUID()]]){
  await deny(()=>db.query(resumeSql,args99.map((x,j)=>j===i?v:x)));
 }
 const authorized99=(await one(resumeSql,args99)).r;
 assert.equal(authorized99.stage,'authorized');assert.equal(authorized99.authorizationId,auth99);assert.equal(authorized99.remainingMissions,3);
 await deny(()=>db.query(resumeSql,args99));
 await db.query('reset role');
 assert.deepEqual(await preserve99(),saved99);
 const resumed99=await one('select * from work_projects where id=$1',[project]);
 assert.equal(resumed99.status,'running');assert.equal(resumed99.active_mission_id,null);assert.equal(resumed99.max_missions,102);
 assert.equal(resumed99.token_allowance,600000);assert.deepEqual(resumed99.deadline,blocked99.deadline);assert(resumed99.progress_since>blocked99.progress_since);
 const receipt99=await one('select * from project_coding_capacity_resume_receipts where project_id=$1 and historical_missions=99',[project]);
 await deny(()=>db.query('update project_coding_capacity_resume_receipts set paid_inference_limit=4 where project_id=$1 and historical_missions=99',[project]));
 await deny(()=>db.query('update work_projects set max_missions=103 where id=$1',[project]));
 receipt={authorization_id:auth99};claimRelease=identityRelease;claimGeneration=identityGeneration;claimDeployment=identityDeployment;
 await db.query('DISCARD PLANS');
 try{c=await schedule(manager);}catch(e){console.error('MISSION99_SCHEDULER_DIAGNOSTIC',JSON.stringify({message:e.message,code:e.code,where:e.where,detail:e.detail,table:e.table,constraint:e.constraint,priorReceiptRelations}));throw e;}
 assert.ok(!history99Ids.includes(c.mission.id));
 await deny(()=>execute(c,collision),e=>e.evidence?.code==='commissioning_agent_identity');
 const actual100=[{"area":"tic_tac_toe_implementation","kind":"worker","name":"Game Development Specialist v1","paths":[],"tools":["development","analysis"],"action":"appoint","tokens":32000,"purpose":"Implement the approved single tic-tac-toe coding milestone within the existing milestone-3 scope and support technical composition under later package commissioning.","deadline":"2026-11-26T19:45:00+00:00","objective":"Implement the responsive, same-device two-player browser tic-tac-toe game exactly as requested by the owner within the single coding milestone under app/milestone-3-tic-tac-toe/, lib/milestone-3-tic-tac-toe/, and tests/milestone-3-tic-tac-toe/, while preserving all no-extra-features constraints and using the existing execution team where appropriate.","reporting":"Delivery Manager, Tic-Tac-Toe Milestone","acceptance":["Can receive later development and analysis package tasks for the single approved tic-tac-toe milestone","Remains limited to approved milestone-3 tic-tac-toe implementation scope only","Preserves all no-extra-features constraints and separation from independent QA"],"interfaces":["Receives later direct package commissioning from Delivery Manager, Tic-Tac-Toe Milestone","Works only within approved milestone-3 tic-tac-toe paths","Provides implementation artifacts and evidence for independent review"],"deliverables":["Bounded implementation work for the approved tic-tac-toe milestone","Technical composition support for the same approved milestone"],"reuseAgentId":"8421786a-0874-4d86-992e-f0f087d8018e","managementLevel":"worker"},{"area":"tic_tac_toe_technical_review","kind":"worker","name":"Project Lead","paths":[],"tools":["analysis"],"action":"appoint","tokens":16000,"purpose":"Provide independent technical analysis review for the approved single tic-tac-toe coding milestone after implementation work is produced.","deadline":"2026-11-26T19:45:00+00:00","objective":"Review the responsive, same-device two-player browser tic-tac-toe game implementation exactly as requested by the owner within the single coding milestone under app/milestone-3-tic-tac-toe/, lib/milestone-3-tic-tac-toe/, and tests/milestone-3-tic-tac-toe/, while preserving all no-extra-features constraints.","reporting":"Delivery Manager, Tic-Tac-Toe Milestone","acceptance":["Can receive later analysis review tasks for the single approved tic-tac-toe milestone","Remains distinct from the coding worker","Preserves independent technical review separation from implementation execution"],"interfaces":["Receives later direct review package commissioning from Delivery Manager, Tic-Tac-Toe Milestone","Reviews only approved milestone-3 tic-tac-toe scope artifacts","Provides analysis evidence distinct from the coding worker"],"deliverables":["Independent technical review of the approved tic-tac-toe milestone artifacts"],"reuseAgentId":"e7d25ada-a761-41bf-8f65-f87056f175fa","managementLevel":"worker"},{"action":"ready"}].map(c=>c.action==='appoint'?{...c,deadline}:c);
 const m100Claim=c;
 // The disposable fixture shares one outer transaction, unlike production
 // cron's separate transactions. Use real clock order for these new fixtures.
 await db.query('reset role');await db.query('update agent_missions set created_at=clock_timestamp() where id=$1',[c.mission.id]);await db.query('set role service_role');
 await execute(c,actual100);
 const workers99=(await db.query('select * from project_organization_nodes where parent_id=$1 order by id',[manager.id])).rows;
 const coder99=workers99.find(x=>x.agent_id===developerIdentity),reviewer99=workers99.find(x=>x.agent_id===leadIdentity);
 assert.ok(coder99&&reviewer99);assert.equal(coder99.agent_id,developerIdentity);assert.equal(reviewer99.agent_id,leadIdentity);
 assert.equal(coder99.parent_id,manager.id);assert.equal(reviewer99.parent_id,manager.id);assert.notEqual(coder99.id,reviewer99.id);
 c=await schedule(manager);
 await deny(()=>execute(c,[{action:'grant_scope',nodeId:analyst.id,paths:scopePaths}]));
 await deny(()=>execute(c,[{action:'grant_scope',nodeId:coder99.id,paths:['app/']}]));
 const m101Claim=c;
 await db.query('reset role');await db.query('update agent_missions set created_at=clock_timestamp() where id=$1',[c.mission.id]);await db.query('set role service_role');
 await execute(c,[{action:'grant_scope',nodeId:coder99.id,paths:scopePaths},{action:'ready'}]);
 c=await schedule(manager);
 const files99=['app/milestone-3-tic-tac-toe/page.tsx','lib/milestone-3-tic-tac-toe/game.ts','tests/milestone-3-tic-tac-toe/game.test.ts'];
 const smart99=(role,paths)=>({objective:role+' bounded milestone output',deliverable:role+' evidence',instruction:'Complete the exact approved milestone contract for '+role,parentObjective:manager.objective,capability:'analysis',acceptance:[{criterion:'Approved browser contract passes',evidence:'Same source verification'}],inventory:[{item:'Approved tic-tac-toe milestone',contextChars:1000}],estimate:{basis:'declared_inventory',rationale:'One bounded deliverable',uncertainty:'Verify actual output',tokens:1000,seconds:30},tokens:2000,maxAssignments:2,deadline,paths});
 const packageCommand99={action:'commission_package',workerId:coder99.id,writerId:coder99.id,reviewerId:reviewer99.id,milestoneIndex:0,objective:'Implement approved tic-tac-toe game',deliverables:['Playable game and scoped tests'],interfaces:[],acceptance:['Approved browser contract passes'],dependencies:[],paths:scopePaths,deadline,maxAttempts:2,tasks:{development:smart99('development',files99),compose:smart99('compose',[]),review:smart99('review',[])}};
 await deny(()=>execute(c,[packageCommand99,packageCommand99]));
 await deny(()=>execute(c,[{...packageCommand99,reviewerId:coder99.id}]));
 await deny(()=>execute(c,[{...packageCommand99,tasks:{...packageCommand99.tasks,development:{...packageCommand99.tasks.development,parentObjective:'Wrong parent objective'}}}]));
 // Preserve the exact post-M101 appointment/grant topology. Native replay
 // uses the saved real M100 commands with the fixture's existing cutoff;
 // database-generated node/mission UUIDs are mapped only for the test.
 const m102Claim=c;
 const post101=(await db.query('select * from project_organization_nodes where project_id=$1 order by id',[project])).rows;
 const grants101=(await db.query('select g.* from project_organization_scope_grants g join project_organization_nodes n on n.id=g.node_id where n.project_id=$1 order by g.node_id',[project])).rows;
 assert.equal(post101.length,15);assert.equal(grants101.length,4);
 const stage101=codingCapacityManagerStage(manager,post101,grants101,scopeHash);
 const direct=post101.filter(n=>n.parent_id===manager.id);
 assert.equal(direct.length,4);
 let rejectedCombinations=0;
 const invalid102=[];
 // The saved M102 error may be an old analyst/supervisor role or a
 // missing/nonzero milestone. Exhaust the combinations that passed the
 // previous application stage and immediate-reporting checks.
 for(const writer of direct)for(const reviewer of direct){
  if(reviewer.id===coder99.id||reviewer.id===writer.id)continue;
  if(writer.id===coder99.id&&reviewer.id===reviewer99.id)continue;
  invalid102.push({...packageCommand99,writerId:writer.id,reviewerId:reviewer.id});
 }
 for(const milestoneIndex of [1,-1,undefined])invalid102.push({...packageCommand99,milestoneIndex});
 for(const bad of invalid102){
  assertManagementCommands(manager,post101,[bad]);
  assertCodingCapacityManagerStage(manager,post101,stage101,[bad]); // prior stage-only guard
  await deny(async()=>{
   await settle(c);
   await db.query('select project_org_decide($1,$2,$3)',[c.job.id,c.job.lease,JSON.stringify([bad])]);
  },e=>e.code==='P0001'&&e.message==='Package must use newly authorized direct implementation workers');
  const writes=decisionWrites;
  await deny(()=>execute(c,[bad]),e=>e.evidence?.code==='commissioning_package_roles');
  assert.equal(decisionWrites,writes,'Rejected role never reached decision RPC');
  rejectedCombinations++;
 }
 assert.equal(rejectedCombinations,11); // Eight invalid direct-role pairs and three invalid milestone values.
 // The existing SQL authority ALREADY accepts the correct role binding.
 // Run the genuine package writer under a nested savepoint then roll it back,
 // proving the database is not the defect.
 await db.query('savepoint m102_valid_predecessor');
 await execute(c,[packageCommand99]);
 assert.equal((await one('select count(*)::int n from project_work_packages where project_id=$1',[project])).n,1);
 await db.query('rollback to savepoint m102_valid_predecessor');await db.query('release savepoint m102_valid_predecessor');
 console.log('MISSION102_ROLE_REGRESSION_PASS '+JSON.stringify({rejectedCombinations,actualTeam:[coder99.agent_id,reviewer99.agent_id],correctRolesAlreadyAcceptedBySQL:true}));
 await db.query('savepoint mission102_final_resume');
 await settle(c);
 const bad102=invalid102[0];
 await deny(()=>db.query('select project_org_decide($1,$2,$3)',[c.job.id,c.job.lease,JSON.stringify([bad102])]),
  e=>e.code==='P0001'&&e.message==='Package must use newly authorized direct implementation workers');
 const failure102='Mission state operation failed: {"code":"P0001","details":null,"hint":null,"message":"Package must use newly authorized direct implementation workers"}';
 assert.equal((await one("select commit_mission_work($1,$2,$3,'[]','failed','blocked',null) ok",[c.job.id,c.job.lease,JSON.stringify({detail:failure102,diagnostic:{stage:'work',errorType:'Error',acceptedIssue:false}})])).ok,true);
 await db.query('reset role');
 const failureLease102=randomUUID();
 await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,failureLease102]);
 await db.query('set role service_role');
 const failed102=(await one('select project_org_schedule($1,$2) r',[project,failureLease102])).r;
 assert.equal(failed102.blocked,'Commissioning assignment failed; automatic retries are not authorized');
 assert.equal((await one("select finish_work_project($1,$2,'block',$3) ok",[project,failureLease102,JSON.stringify({detail:failed102.blocked})])).ok,true);
 await db.query('reset role');
 const history102Ids=(await db.query('select id from agent_missions where project_id=$1 order by id',[project])).rows.map(x=>x.id);
 assert.equal(history102Ids.length,102);
 const preserve102=async()=>({
  prior:await preserve99(),
  missions:(await db.query('select to_jsonb(m) v from agent_missions m where id=any($1::uuid[]) order by id',[history102Ids])).rows,
  assignments:(await db.query('select to_jsonb(j) v from mission_assignments j where mission_id=any($1::uuid[]) order by id',[history102Ids])).rows,
  decisions:(await db.query('select to_jsonb(d) v from project_organization_decisions d where assignment_id in (select id from mission_assignments where mission_id=any($1::uuid[])) order by id',[history102Ids])).rows,
  requests:(await db.query('select to_jsonb(q) v from project_provider_requests q where mission_id=any($1::uuid[]) order by id',[history102Ids])).rows,
  nodes:(await db.query("select to_jsonb(n)-'decision_needed'-'updated_at' v from project_organization_nodes n where project_id=$1 order by id",[project])).rows,
  grants:(await db.query('select to_jsonb(g) v from project_organization_scope_grants g join project_organization_nodes n on n.id=g.node_id where n.project_id=$1 order by g.node_id,g.scope_hash',[project])).rows,
  receipts:(await db.query('select to_jsonb(s) v from project_coding_capacity_resume_receipts s where project_id=$1 and historical_missions in (98,99) order by historical_missions',[project])).rows
 });
 const saved102=await preserve102(),blocked102=await one('select * from work_projects where id=$1',[project]);
 assert.equal(blocked102.status,'blocked');assert.equal(blocked102.max_missions,102);assert.equal(blocked102.active_mission_id,c.mission.id);
 let sql102=readFileSync('supabase/migrations/20261124203500_mission102_final_package_authorization.sql','utf8')
  .replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
 for(const [a,b] of [['0597487f-326d-4951-a727-612be9d772f1',auth99],
  ['ea3d02049744c56e080c25ef98182dba6f9ebb07',identityRelease],['dpl_7mXNM9TW1dSVb7gwiYmuywE2KZaF',identityDeployment],
  ['3094d990-a16e-498b-bfb3-1a37245069c7',c.mission.id],['51274624-c601-4d66-826e-c635bb026e65',c.job.id],
  ['32cde957-b859-414d-88f0-ab726a238808',m100Claim.mission.id],['1e6d47e0-1515-4cd7-997a-47148d6d52f4',m100Claim.job.id],
  ['06be0829-baf2-4205-8ccd-42def3345c5a',m101Claim.mission.id],['00af04ad-d161-4e61-be80-101415028396',m101Claim.job.id],
  ['08e792df-1046-4282-89dc-83994a8a6b7e',coder99.id],['1cf12044-d9ba-4e8b-9ef4-8b7e5aa004a5',reviewer99.id],
  ['s.release_generation<>45','s.release_generation<>'+claimGeneration]]){
  assert.ok(sql102.includes(a),a);sql102=sql102.replaceAll(a,b);
 }
 for(const match of [...sql102.matchAll(/\('([^']+)'[,\s]+'([a-f0-9]{32})'\)/g)]){
  const hash=(await one('select md5(prosrc) h from pg_proc where oid=$1::regprocedure',[match[1]])).h;
  sql102=sql102.replace("'"+match[2]+"'","'"+hash+"'");
 }
 try{await db.query(sql102);}catch(e){console.error('MISSION102_MIGRATION_DIAGNOSTIC',JSON.stringify({message:e.message,code:e.code,position:e.position,internalPosition:e.internalPosition,internalQuery:e.internalQuery,where:e.where,detail:e.detail}));throw e;}
 await db.query('DISCARD PLANS');
 assert.deepEqual(await preserve102(),saved102);
 assert.deepEqual(await one('select * from work_projects where id=$1',[project]),blocked102);
 assert.equal((await one('select count(*)::int n from project_coding_capacity_resume_receipts where project_id=$1',[project])).n,2);
 assert.equal((await one('select project_org_coding_capacity_final_roles_valid($1) ok',[project])).ok,true);
 const finalRelease='d'.repeat(40),finalDeployment='dpl_Mission102Corrected',finalGeneration=claimGeneration+2;
 await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5)',[project,identityRelease,identityDeployment,'closed',claimGeneration]);
 await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5)',[project,finalRelease,finalDeployment,'active',claimGeneration+1]);
 await db.query('set role service_role');
 const offer102=(await one('select project_org_coding_capacity_offer($1,$2,$3) o',[owner,project,finalRelease])).o;
 assert.equal(offer102.stage,'authorize');assert.equal(offer102.historicalMissions,102);assert.equal(offer102.priorMaxMissions,102);
 assert.equal(offer102.remainingMissions,0);assert.equal(offer102.additionalMissions,1);assert.equal(offer102.maxMissions,103);
 assert.equal(offer102.paidInferenceLimit,1);assert.equal(offer102.coderId,coder99.id);assert.equal(offer102.writerId,coder99.id);assert.equal(offer102.reviewerId,reviewer99.id);
 assert.equal(offer102.priorAuthorizationId,auth99);assert.equal(offer102.sourceMissionId,c.mission.id);assert.equal(offer102.sourceAssignmentId,c.job.id);
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,finalRelease,finalGeneration,finalDeployment])).ok,false);
 await deny(()=>db.query('select authorize_work_project_resources($1,$2,$3,600000,null,103,null,$4,$5)',[project,pre.actor_id,pre.chat_id,randomUUID(),'Unauthorized final capacity renewal test']));
 const auth102=randomUUID(),args102=[owner,project,finalRelease,finalGeneration,finalDeployment,auth102,offer102.stateHash,offer102.scopeHash,offer102.cutoff,1,103,1,0,600000,offer102.remainingRecordedTokens,auth99,c.mission.id,c.job.id];
 for(const [i,v] of [[0,randomUUID()],[2,identityRelease],[3,finalGeneration-2],[4,identityDeployment],[5,auth99],[6,'a'.repeat(64)],[7,'e'.repeat(64)],[8,new Date(Date.now()+1e8).toISOString()],[9,2],[10,104],[11,2],[12,1],[13,600001],[14,offer102.remainingRecordedTokens-1],[15,newAuth],[16,randomUUID()],[17,randomUUID()]]){
  await deny(()=>db.query(resumeSql,args102.map((x,j)=>j===i?v:x)));
 }
 const authorized102=(await one(resumeSql,args102)).r;
 assert.equal(authorized102.stage,'authorized');assert.equal(authorized102.authorizationId,auth102);assert.equal(authorized102.remainingMissions,1);
 await deny(()=>db.query(resumeSql,args102));
 await db.query('reset role');
 assert.deepEqual(await preserve102(),saved102);
 const resumed102=await one('select * from work_projects where id=$1',[project]);
 assert.equal(resumed102.status,'running');assert.equal(resumed102.active_mission_id,null);assert.equal(resumed102.max_missions,103);
 assert.equal(resumed102.token_allowance,600000);assert.deepEqual(resumed102.deadline,blocked102.deadline);
 const receipt102=await one('select * from project_coding_capacity_resume_receipts where project_id=$1 and historical_missions=102',[project]);
 await deny(()=>db.query('update project_coding_capacity_resume_receipts set paid_inference_limit=2 where project_id=$1 and historical_missions=102',[project]));
 await deny(()=>db.query('update work_projects set max_missions=104 where id=$1',[project]));
 receipt={authorization_id:auth102};claimRelease=finalRelease;claimGeneration=finalGeneration;claimDeployment=finalDeployment;
 await db.query('DISCARD PLANS');
 c=await schedule(manager);
 assert.ok(!history102Ids.includes(c.mission.id));
 for(const bad of [...invalid102,{...packageCommand99,workerId:analyst.id},{...packageCommand99,reviewerId:qa.id},{...packageCommand99,paths:['app/']},
  {...packageCommand99,tasks:{...packageCommand99.tasks,development:{...packageCommand99.tasks.development,paths:[scopePaths[0]]}}},
  {...packageCommand99,tasks:{...packageCommand99.tasks,review:{...packageCommand99.tasks.review,paths:[files99[0]]}}},
  {...packageCommand99,tasks:{...packageCommand99.tasks,development:{...packageCommand99.tasks.development,parentObjective:'Invalid parent'}}}]){
  const writes=decisionWrites;await deny(()=>execute(c,[bad]));assert.equal(decisionWrites,writes);
 }
 await deny(()=>execute(c,[packageCommand99,packageCommand99]));
 await deny(()=>execute(c,actual100));
 await deny(()=>execute(c,[{action:'grant_scope',nodeId:coder99.id,paths:scopePaths}]));
 // SQL itself denies an attempted new appointment under the final receipt,
 // independently of application preflight. No production role is changed.
 await deny(async()=>{await settle(c);await db.query('select project_org_decide($1,$2,$3)',[c.job.id,c.job.lease,JSON.stringify(actual100)]);},
  e=>e.code==='P0001'&&e.message.includes('Final signed commissioning permits only'));
 // M103 failure is known to be REVIEW capacity (server stack); the original
 // numeric contract was not retained. Use the real M100/101 committed workers,
 // exact registry capacity and four grants, and the saved approved requirement
 // and browser evidence below. These are representative boundary cases, not
 // a claim to have reconstructed the discarded provider response.
 const m103Claim=c;
 const {smartJsonbChars,commissioningSmartCapacity,smartPackageCapacityFields}=modules()('@/lib/projects/smart-diagnostics');
 const nodes103=(await db.query('select * from project_organization_nodes where project_id=$1 order by id',[project])).rows;
 const registry103=(await db.query('select id,config,archived from managed_agents where id=any($1::uuid[]) order by id',[actualTeam.map(a=>a.id)])).rows;
 const savedProject103=await one('select * from work_projects where id=$1',[project]);
 const envelope=commissioningSmartCapacity(JSON.parse(JSON.stringify(nodes103.find(n=>n.id===manager.id))),JSON.parse(JSON.stringify(savedProject103)),
  JSON.parse(JSON.stringify(nodes103)),registry103,[],packageCommand99,true);
 assert.equal(envelope.workers.find(w=>w.nodeId===coder99.id).remainingSizingTokens,32000);
 assert.equal(envelope.workers.find(w=>w.nodeId===reviewer99.id).remainingSizingTokens,16000);
 assert.equal(envelope.workers.find(w=>w.nodeId===reviewer99.id).contextChars,16000);
 const approved103={"requirements":["Render an empty 3×3 board, display the turn, and start with X.","Alternate X and O only after legal moves. Ignore occupied-cell moves without changing the board or current turn.","Detect wins on all three rows, all three columns, and both diagonals. Display the winning mark and reject post-win moves.","Detect a full-board draw, display the draw result, and reject post-draw moves.","New Game and page reload must each clear the board and restore X as the first player.","Implement a responsive, accessible browser UI; cell buttons carry data-cell indices 0 through 8, with #board, #status, and #new-game selectors for acceptance.","No authentication, computer opponent, networking, persisted game state, added dependencies, or unrelated features.","Development must stay within approved milestone-3 paths and pass independent same-commit verification on a protected Preview."],"browser":{"path":"/milestone-3-tic-tac-toe","scenarios":[{"name":"Initial board and legal turns","steps":[{"value":"X's turn","action":"expectText","selector":"#status"},{"value":"","action":"expectText","selector":"[data-cell=\"0\"]"},{"action":"click","selector":"[data-cell=\"0\"]"},{"value":"X","action":"expectText","selector":"[data-cell=\"0\"]"},{"value":"O's turn","action":"expectText","selector":"#status"},{"action":"click","selector":"[data-cell=\"0\"]"},{"value":"O's turn","action":"expectText","selector":"#status"},{"action":"click","selector":"[data-cell=\"1\"]"},{"value":"O","action":"expectText","selector":"[data-cell=\"1\"]"},{"value":"X's turn","action":"expectText","selector":"#status"}]},{"name":"Horizontal win and terminal freeze","steps":[{"action":"click","selector":"[data-cell=\"0\"]"},{"action":"click","selector":"[data-cell=\"3\"]"},{"action":"click","selector":"[data-cell=\"1\"]"},{"action":"click","selector":"[data-cell=\"4\"]"},{"action":"click","selector":"[data-cell=\"2\"]"},{"value":"X wins","action":"expectText","selector":"#status"},{"action":"click","selector":"[data-cell=\"5\"]"},{"value":"","action":"expectText","selector":"[data-cell=\"5\"]"},{"value":"X wins","action":"expectText","selector":"#status"}]},{"name":"Vertical win","steps":[{"action":"click","selector":"[data-cell=\"0\"]"},{"action":"click","selector":"[data-cell=\"1\"]"},{"action":"click","selector":"[data-cell=\"3\"]"},{"action":"click","selector":"[data-cell=\"2\"]"},{"action":"click","selector":"[data-cell=\"6\"]"},{"value":"X wins","action":"expectText","selector":"#status"}]},{"name":"Main diagonal win","steps":[{"action":"click","selector":"[data-cell=\"0\"]"},{"action":"click","selector":"[data-cell=\"1\"]"},{"action":"click","selector":"[data-cell=\"4\"]"},{"action":"click","selector":"[data-cell=\"2\"]"},{"action":"click","selector":"[data-cell=\"8\"]"},{"value":"X wins","action":"expectText","selector":"#status"}]},{"name":"Anti diagonal win","steps":[{"action":"click","selector":"[data-cell=\"2\"]"},{"action":"click","selector":"[data-cell=\"0\"]"},{"action":"click","selector":"[data-cell=\"4\"]"},{"action":"click","selector":"[data-cell=\"1\"]"},{"action":"click","selector":"[data-cell=\"6\"]"},{"value":"X wins","action":"expectText","selector":"#status"}]},{"name":"O win","steps":[{"action":"click","selector":"[data-cell=\"0\"]"},{"action":"click","selector":"[data-cell=\"3\"]"},{"action":"click","selector":"[data-cell=\"1\"]"},{"action":"click","selector":"[data-cell=\"4\"]"},{"action":"click","selector":"[data-cell=\"8\"]"},{"action":"click","selector":"[data-cell=\"5\"]"},{"value":"O wins","action":"expectText","selector":"#status"}]},{"name":"Full board draw and terminal freeze","steps":[{"action":"click","selector":"[data-cell=\"0\"]"},{"action":"click","selector":"[data-cell=\"1\"]"},{"action":"click","selector":"[data-cell=\"2\"]"},{"action":"click","selector":"[data-cell=\"4\"]"},{"action":"click","selector":"[data-cell=\"3\"]"},{"action":"click","selector":"[data-cell=\"5\"]"},{"action":"click","selector":"[data-cell=\"7\"]"},{"action":"click","selector":"[data-cell=\"6\"]"},{"action":"click","selector":"[data-cell=\"8\"]"},{"value":"Draw","action":"expectText","selector":"#status"},{"action":"click","selector":"[data-cell=\"8\"]"},{"value":"Draw","action":"expectText","selector":"#status"}]},{"name":"New Game clears the board","steps":[{"action":"click","selector":"[data-cell=\"0\"]"},{"action":"click","selector":"[data-cell=\"4\"]"},{"action":"click","selector":"#new-game"},{"value":"X's turn","action":"expectText","selector":"#status"},{"value":"","action":"expectText","selector":"[data-cell=\"0\"]"},{"value":"","action":"expectText","selector":"[data-cell=\"4\"]"}]},{"name":"Reload clears the board","steps":[{"action":"click","selector":"[data-cell=\"0\"]"},{"path":"/milestone-3-tic-tac-toe","action":"goto"},{"value":"X's turn","action":"expectText","selector":"#status"},{"value":"","action":"expectText","selector":"[data-cell=\"0\"]"}]},{"name":"Responsive board and reset available","steps":[{"action":"expectVisible","selector":"#board"},{"action":"expectVisible","selector":"#new-game"},{"value":"X's turn","action":"expectText","selector":"#status"}]}]}};
 // These are measured inputs from the saved production contract; future
 // code/results do not exist and their sizes are planning allowances.
 assert.equal(smartJsonbChars(approved103.requirements),887);
 assert.equal(smartJsonbChars(approved103.browser),4599);
 const actualInventory=[
  {item:'Eight saved owner requirements, complete JSON',contextChars:smartJsonbChars(approved103.requirements)},
  {item:'Ten saved browser acceptance scenarios and their complete steps, one copy',contextChars:smartJsonbChars(approved103.browser)}
 ];
 const gameContractChars=4719;
 const intendedFiles=[files99[0],files99[1],scopePaths[1]+'rules.ts',files99[2]];
 const criterion=approved103.requirements.map((r,i)=>({criterion:r,evidence:'Requirement '+(i+1)+': source-bound test, browser scenario or exact changed-file evidence; do not claim success without receipts.'}));
 // A bounded engineering estimate, not an observed execution cost.
 // The whole small, single milestone is represented by three existing roles.
 // 18k+7k <= 32k coder allocation; 12k <= 16k reviewer allocation.
 // No fabricated completed evidence. If actual work/evidence cannot fit,
 // report a resource blocker; never discard necessary checks.
 const roleTask=(role,objective,deliverable,instruction,inventory,tokens,estTokens,seconds,paths,rationale)=>({
  objective,deliverable,instruction,parentObjective:manager.objective,capability:'analysis',acceptance:criterion,
  inventory,estimate:{basis:'declared_inventory',rationale,uncertainty:'Planning estimate, not actual use. New source and test artifacts are not yet generated; verify actual scope and evidence sizes before dispatch, stop and request lawful decomposition if required.',tokens:estTokens,seconds},
  tokens,maxAssignments:1,deadline,paths
 });
 const planned103={...packageCommand99,maxAttempts:1,objective:'Deliver the owner-approved responsive two-player tic-tac-toe milestone and independent same-commit acceptance, without additional features',
  deliverables:['Scoped rules and pure transition engine, accessible responsive route and deterministic test evidence','Technical composition receipt and distinct technical review'],
  acceptance:approved103.requirements,
  tasks:{
   development:roleTask('development','Build the approved game engine, route and deterministic tests','Scoped source and source-bound test receipts',
    'Implement the exact approved owner requirements, registered game contract, pure transitions, all win lines, illegal moves, draw, reset and reload. Run deterministic tests and the existing browser acceptance pathway. No extra dependencies or features; report exact changed files, immutable commit and receipts.',
    [...actualInventory,{item:'Existing registered GAME_CONTRACT.md source; read-only, not an editable file',contextChars:gameContractChars}],
    18000,16000,7200,intendedFiles,'Four planned new files: rules, pure engine, accessible UI and deterministic tests. Allow implementation, local test iterations and evidence packaging; one bounded assignment.'),
   compose:roleTask('compose','Assemble the implementation and acceptance evidence','Complete source-bound technical evidence record',
    'Use actual implementation receipts, changed-file list, commit and each owner requirement. Link every test and browser result to the same immutable commit; identify missing evidence instead of certifying. No source modification is authorized by this analysis task.',
    [...actualInventory,{item:'Expected implementation result and test receipt evidence, bounded planning allowance; verify actual length',contextChars:3000}],
    7000,6000,1800,[],'Eight requirements and ten browser scenarios, plus implementation evidence mapping and checked receipt references.'),
   review:roleTask('review','Independently assess technical evidence against the approved game contract','Independent evidence-based technical review',
    'Review the provided implementation and composition evidence against every original requirement and browser scenario. Check exact source SHA, changed-file inventory, scope, deterministic outcomes and receipt completeness. The independent QA organization remains separate. Do not claim real-browser acceptance that is not evidenced; report any material gap and require lawful decomposition if complete evidence cannot fit.',
    [...actualInventory,{item:'Expected bounded technical evidence with changed files, exact source references, outcomes for every scenario and relevant code evidence; estimate, not completed receipt',contextChars:3500}],
    12000,10000,3600,[],'Independently examine eight requirements, ten complete browser scenarios, scoped source/transition evidence and immutable verification receipts. No repository write or live research.')
  }
 };
 const sizeEvidence=[];
 for(const [role,task] of Object.entries(planned103.tasks)){
  const sqlChars=(await one('select length($1::jsonb::text)::int n',[JSON.stringify(task)])).n;
  assert.equal(smartJsonbChars(task),sqlChars,role+' native JSONB character count parity');
  const inventory=task.inventory.reduce((sum,i)=>sum+i.contextChars,0);
  sizeEvidence.push({role,contractChars:sqlChars,inventoryChars:inventory,totalContextChars:sqlChars+inventory,tokens:task.tokens,estimatedTokens:task.estimate.tokens,seconds:task.estimate.seconds});
 }
 assert.equal(smartPackageCapacityFields(planned103,envelope).length,0,JSON.stringify(sizeEvidence));
 // Every representative failure below reaches the original native SMART
 // reviewer admission, and the real corrected application rejects it first.
 const review103=planned103.tasks.review;
 const reviewBad=delta=>({...planned103,tasks:{...planned103.tasks,review:{...review103,...delta}}});
 const sqlCapacityCases=[
  {command:reviewBad({inventory:[{item:'Oversized review evidence',contextChars:16000}]}),field:'tasks.review.contextChars'},
  {command:reviewBad({estimate:{...review103.estimate,tokens:12001}}),field:'tasks.review.estimate.tokens*maxAssignments'},
  {command:reviewBad({estimate:{...review103.estimate,seconds:9999999}}),field:'tasks.review.estimate.seconds*maxAssignments'},
  {command:reviewBad({deadline:new Date(Date.parse(deadline)+60000).toISOString()}),field:'tasks.review.deadline'}
 ];
 const rejection='SMART estimated workload exceeds single-worker context, resources or execution window; decompose before dispatch';
 for(const {command,field} of sqlCapacityCases){
  await deny(async()=>{await settle(c);await db.query('select project_org_decide($1,$2,$3)',[c.job.id,c.job.lease,JSON.stringify([command])]);},
   e=>e.code==='P0001'&&e.message===rejection&&String(e.where).includes("w.reviewer_id,'review'"));
  const writes=decisionWrites;
  await deny(()=>execute(c,[command]),e=>e.evidence?.code==='smart_contract_capacity'&&e.evidence?.capacityFields?.some(f=>f.field===field));
  assert.equal(decisionWrites,writes);
 }
 // In provider mode, the old database intentionally does not reconcile
 // cumulative node token usage. The signed app sizing envelope (not a new
 // financial gate) also rejects declared sizing above the worker allocation.
 for(const [bad,field] of [[reviewBad({tokens:16001}),'worker.'+reviewer99.id+'.totalContractTokens'],
  [{...planned103,tasks:{...planned103.tasks,compose:{...planned103.tasks.compose,tokens:16001}}},'worker.'+coder99.id+'.totalContractTokens'],
  [reviewBad({maxAssignments:2}),'tasks.review.maxAssignments']]){
  const writes=decisionWrites;
  await deny(()=>execute(c,[bad]),e=>e.evidence?.code==='smart_contract_capacity'&&e.evidence?.capacityFields?.some(f=>f.field===field));
  assert.equal(decisionWrites,writes);
 }
 // Prove genuine admission before adding any successor authority. No
 // provider inference; actual app/SQL package and three contracts roll back.
 await db.query('savepoint m103_capacity_valid_predecessor');
 await execute(c,[planned103]);
 assert.equal((await one('select count(*)::int n from project_work_packages where project_id=$1',[project])).n,1);
 await db.query('rollback to savepoint m103_capacity_valid_predecessor');await db.query('release savepoint m103_capacity_valid_predecessor');
 console.log('MISSION103_SMART_BOUNDARY_NATIVE_PASS '+JSON.stringify({sqlReviewRejections:4,applicationSizingNegatives:3,sizes:sizeEvidence,originalSQLUnchanged:true,realProviderCalls:0}));
 await db.query('savepoint mission103_smart_resume');
 await settle(c);
 await deny(()=>db.query('select project_org_decide($1,$2,$3)',[c.job.id,c.job.lease,JSON.stringify([sqlCapacityCases[0].command])]),e=>e.code==='P0001'&&e.message===rejection);
 // Reproduce the saved rejection shape and hash, NOT the unknown M103 JSON.
 const rejection103={detail:rejection,managementCommandRejection:{code:'smart_contract_capacity',action:'commission_package',reason:rejection,targets:[],position:1,proposalHash:'d812f07753b5a1cb40edd4bcc6762bf8f50586b739c1651fa56f157bbc4f36bf',priorAppointments:0}};
 assert.equal((await one("select commit_mission_work($1,$2,$3,'[]','failed','blocked',null) ok",[c.job.id,c.job.lease,JSON.stringify(rejection103)])).ok,true);
 await db.query('reset role');
 const failLease103=randomUUID();
 await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[project,failLease103]);
 await db.query('set role service_role');
 const failed103=(await one('select project_org_schedule($1,$2) r',[project,failLease103])).r;
 assert.equal(failed103.blocked,'Commissioning assignment failed; automatic retries are not authorized');
 assert.equal((await one("select finish_work_project($1,$2,'block',$3) ok",[project,failLease103,JSON.stringify({detail:failed103.blocked})])).ok,true);
 await db.query('reset role');
 const ids103=(await db.query('select id from agent_missions where project_id=$1 order by id',[project])).rows.map(x=>x.id);
 assert.equal(ids103.length,103);
 const preserve103=async()=>({
  previous:await preserve102(),
  failed:await one('select to_jsonb(m) m,to_jsonb(j) j from agent_missions m join mission_assignments j on j.mission_id=m.id where m.id=$1',[m103Claim.mission.id]),
  requests:(await db.query('select to_jsonb(q) v from project_provider_requests q where mission_id=$1 order by id',[m103Claim.mission.id])).rows,
  prior:await one('select to_jsonb(r) v from project_coding_capacity_resume_receipts r where project_id=$1 and historical_missions=102',[project])
 });
 const saved103=await preserve103(),blocked103=await one('select * from work_projects where id=$1',[project]);
 assert.equal(blocked103.status,'blocked');assert.equal(blocked103.max_missions,103);assert.equal(blocked103.active_mission_id,c.mission.id);
 let sql103=readFileSync('supabase/migrations/20261124212500_mission103_smart_capacity_resume.sql','utf8')
  .replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
 for(const [a,b] of [['f83c4eb4-48c0-4cc8-b9b6-a1862f7b8f93',auth102],
  ['2f14afc16f9fe39a7e5a73892eba96fab1c9a6bd',finalRelease],['dpl_XXKkFT4MdD3L3VUp25GGsPZXe2TH',finalDeployment],
  ['f4ef8dd1-7802-409c-9787-88a3dd246861',c.mission.id],['9cfe36d9-f666-4019-8694-73db24577cac',c.job.id],
  ['08e792df-1046-4282-89dc-83994a8a6b7e',coder99.id],['1cf12044-d9ba-4e8b-9ef4-8b7e5aa004a5',reviewer99.id],
  ['s.release_generation<>47','s.release_generation<>'+claimGeneration]]){
  assert.ok(sql103.includes(a),a);sql103=sql103.replaceAll(a,b);
 }
 for(const match of [...sql103.matchAll(/\('([^']+)'[,\s]+'([a-f0-9]{32})'\)/g)]){
  const hash=(await one('select md5(prosrc) h from pg_proc where oid=$1::regprocedure',[match[1]])).h;
  sql103=sql103.replace("'"+match[2]+"'","'"+hash+"'");
 }
 try{await db.query(sql103);}catch(e){console.error('MISSION103_MIGRATION_DIAGNOSTIC',JSON.stringify({message:e.message,code:e.code,position:e.position,internalPosition:e.internalPosition,internalQuery:e.internalQuery,where:e.where,detail:e.detail}));throw e;}
 await db.query('DISCARD PLANS');
 assert.deepEqual(await preserve103(),saved103);
 assert.deepEqual(await one('select * from work_projects where id=$1',[project]),blocked103);
 assert.equal((await one('select count(*)::int n from project_coding_capacity_resume_receipts where project_id=$1',[project])).n,3);
 const smartRelease='a'.repeat(40),smartDeployment='dpl_Mission103Corrected',smartGeneration=claimGeneration+2;
 await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5)',[project,finalRelease,finalDeployment,'closed',claimGeneration]);
 await db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5)',[project,smartRelease,smartDeployment,'active',claimGeneration+1]);
 await db.query('set role service_role');
 const offer103=(await one('select project_org_coding_capacity_offer($1,$2,$3) o',[owner,project,smartRelease])).o;
 assert.equal(offer103.stage,'authorize');assert.equal(offer103.historicalMissions,103);assert.equal(offer103.priorMaxMissions,103);
 assert.equal(offer103.remainingMissions,0);assert.equal(offer103.additionalMissions,1);assert.equal(offer103.maxMissions,104);
 assert.equal(offer103.paidInferenceLimit,1);assert.equal(offer103.coderId,coder99.id);assert.equal(offer103.writerId,coder99.id);assert.equal(offer103.reviewerId,reviewer99.id);
 assert.equal(offer103.priorAuthorizationId,auth102);assert.equal(offer103.sourceMissionId,c.mission.id);assert.equal(offer103.sourceAssignmentId,c.job.id);
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,smartRelease,smartGeneration,smartDeployment])).ok,false);
 await deny(()=>db.query('select authorize_work_project_resources($1,$2,$3,600000,null,104,null,$4,$5)',[project,pre.actor_id,pre.chat_id,randomUUID(),'Unauthorized SMART capacity renewal test']));
 const auth103=randomUUID(),args103=[owner,project,smartRelease,smartGeneration,smartDeployment,auth103,offer103.stateHash,offer103.scopeHash,offer103.cutoff,1,104,1,0,600000,offer103.remainingRecordedTokens,auth102,c.mission.id,c.job.id];
 for(const [i,v] of [[0,randomUUID()],[2,finalRelease],[3,smartGeneration-2],[4,finalDeployment],[5,auth102],[6,'e'.repeat(64)],[7,'e'.repeat(64)],[8,new Date(Date.now()+1e8).toISOString()],[9,2],[10,105],[11,2],[12,1],[13,600001],[14,offer103.remainingRecordedTokens-1],[15,auth99],[16,randomUUID()],[17,randomUUID()]]){
  await deny(()=>db.query(resumeSql,args103.map((x,j)=>j===i?v:x)));
 }
 const authorized103=(await one(resumeSql,args103)).r;
 assert.equal(authorized103.stage,'authorized');assert.equal(authorized103.authorizationId,auth103);assert.equal(authorized103.remainingMissions,1);
 await deny(()=>db.query(resumeSql,args103));
 await db.query('reset role');
 assert.deepEqual(await preserve103(),saved103);
 const resumed103=await one('select * from work_projects where id=$1',[project]);
 assert.equal(resumed103.status,'running');assert.equal(resumed103.active_mission_id,null);assert.equal(resumed103.max_missions,104);
 assert.equal(resumed103.token_allowance,600000);assert.deepEqual(resumed103.deadline,blocked103.deadline);
 const receipt103=await one('select * from project_coding_capacity_resume_receipts where project_id=$1 and historical_missions=103',[project]);
 await deny(()=>db.query('update project_coding_capacity_resume_receipts set paid_inference_limit=2 where project_id=$1 and historical_missions=103',[project]));
 await deny(()=>db.query('update work_projects set max_missions=105 where id=$1',[project]));
 receipt={authorization_id:auth103};claimRelease=smartRelease;claimGeneration=smartGeneration;claimDeployment=smartDeployment;
 await db.query('DISCARD PLANS');
 c=await schedule(manager);
 assert.ok(!ids103.includes(c.mission.id));
 for(const {command,field} of sqlCapacityCases){
  const writes=decisionWrites;
  await deny(()=>execute(c,[command]),e=>e.evidence?.code==='smart_contract_capacity'&&e.evidence?.capacityFields?.some(f=>f.field===field));
  assert.equal(decisionWrites,writes);
 }
 for(const bad of [{...planned103,reviewerId:coder99.id},{...planned103,workerId:analyst.id},{...planned103,paths:['app/']},
  {...planned103,tasks:{...planned103.tasks,review:{...review103,parentObjective:'Wrong parent objective'}}},
  {...planned103,tasks:{...planned103.tasks,review:{...review103,paths:[files99[0]]}}}]){
  const writes=decisionWrites;await deny(()=>execute(c,[bad]));assert.equal(decisionWrites,writes);
 }
 await deny(()=>execute(c,[planned103,planned103]));
 await deny(()=>execute(c,actual100));
 await deny(()=>execute(c,[{action:'grant_scope',nodeId:coder99.id,paths:scopePaths}]));
 await execute(c,[planned103]);
 await db.query('reset role');
 const final103=await one('select * from work_projects where id=$1',[project]),pkg103=await one('select * from project_work_packages where project_id=$1',[project]);
 assert.equal(final103.status,'paused');assert.equal(final103.max_missions,104);assert.equal(final103.active_mission_id,null);
 assert.equal(pkg103.status,'queued');assert.equal(pkg103.worker_id,coder99.id);assert.equal(pkg103.writer_id,coder99.id);assert.equal(pkg103.reviewer_id,reviewer99.id);
 assert.equal((await one('select count(*)::int n from project_work_packages where project_id=$1',[project])).n,1);
 assert.equal((await one('select count(*)::int n from project_worker_contracts where package_id=$1',[pkg103.id])).n,3);
 assert.equal((await one('select count(*)::int n from agent_missions where project_id=$1',[project])).n,104);
 assert.equal((await one("select count(*)::int n from project_provider_requests where project_id=$1 and NOT mission_id=any($2::uuid[]) and operation='inference' and resolved_at is not null",[project,ids103])).n,1);
 assert.equal((await one('select count(*)::int n from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1 and NOT m.id=any($2::uuid[]) and j.attempts=1',[project,ids103])).n,1);
 assert.deepEqual(await preserve103(),saved103);
 assert.deepEqual(await one('select * from project_coding_capacity_resume_receipts where project_id=$1 and historical_missions=103',[project]),receipt103);
 assert.equal((await one('select project_org_coding_capacity_live($1) ok',[project])).ok,false);
 await db.query('set role service_role');
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,smartRelease,smartGeneration,smartDeployment])).ok,false);
 console.log('MISSION103_SMART_RESUME_NATIVE_PASS '+JSON.stringify({history:103,ceiling:104,freshMissions:1,paidFixtureReceipts:1,attemptsEach:1,packages:1,smartContracts:3,packageId:pkg103.id,realProviderCalls:0,sizes:sizeEvidence,workersAndGrantsPreserved:true}));
 await db.query('reset role');
 // Mission104 exact existing package authorization, inside the rollback-only fixture.
 const source104=await db.query("select pg_get_functiondef('project_org_retest_claim_release_authorized_epoch(uuid,text,bigint,text)'::regprocedure) as src");
 assert.ok(!source104.rows[0].src.includes('project_org_package_execution_claim'));
 const preserved104=(await db.query('select * from agent_missions where project_id=$1 order by id',[project])).rows;
 const contracts104=(await db.query('select * from project_worker_contracts where package_id=$1 order by id',[pkg103.id])).rows;
 const migration104=readFileSync('supabase/migrations/20261124233000_mission104_package_execution_authority.sql','utf8').replaceAll('fe9d2658-41e3-44c1-ae8e-a0cba98371fe',project).replaceAll('f88d4d10-dfe4-479e-a2cf-41b3e8209e47',pkg103.id);
 await db.query(migration104);
 await db.query('DISCARD PLANS');
 const offer104=(await one('select project_org_package_execution_offer($1,$2,$3) o',[receipt103.owner_id,project,smartRelease])).o;
 assert.equal(offer104.stage,'authorize');assert.equal(offer104.packageId,pkg103.id);assert.equal(offer104.terms.maxMissions,112);
 assert.equal(offer104.terms.paidInferenceLimit,47);assert.equal(offer104.terms.developmentAttempts,3);
 const args104=[receipt103.owner_id,project,pkg103.id,smartRelease,smartGeneration,smartDeployment,randomUUID(),offer104.stateHash,JSON.stringify(offer104.terms),true];
 const authorize104='select project_org_package_execution_authorize($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) o';
 await deny(()=>db.query(authorize104,[randomUUID(),...args104.slice(1)]));
 await deny(()=>db.query(authorize104,[...args104.slice(0,7),'0'.repeat(64),...args104.slice(8)]));
 await deny(()=>db.query(authorize104,[...args104.slice(0,8),JSON.stringify({...offer104.terms,paidInferenceLimit:48}),true]));
 await deny(()=>db.query(authorize104,[...args104.slice(0,9),false]));
 assert.equal((await one('select status from work_projects where id=$1',[project])).status,'paused');
 await db.query('set role service_role');
 const authorized104=(await one(authorize104,args104)).o;
 assert.equal(authorized104.stage,'authorized');assert.equal(authorized104.authorizationId,args104[6]);
 await deny(()=>db.query(authorize104,args104));
 await db.query('reset role');
 const after104=await one('select * from work_projects where id=$1',[project]);
 assert.equal(after104.status,'running');assert.equal(after104.max_missions,112);assert.equal(after104.active_mission_id,null);
 assert.deepEqual((await db.query('select * from agent_missions where project_id=$1 order by id',[project])).rows,preserved104);
 assert.deepEqual((await db.query('select * from project_worker_contracts where package_id=$1 order by id',[pkg103.id])).rows,contracts104);
 assert.deepEqual(await one('select * from project_work_packages where id=$1',[pkg103.id]),pkg103);
 assert.equal((await one('select count(*)::int n from project_work_package_attempts where package_id=$1',[pkg103.id])).n,0);
 assert.equal((await one('select project_org_package_execution_live($1) ok',[project])).ok,true);
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,smartRelease,smartGeneration,smartDeployment])).ok,false);
 console.log('MISSION104_PACKAGE_EXECUTION_NATIVE_PASS');
 await db.query('rollback to savepoint mission103_smart_resume');await db.query('release savepoint mission103_smart_resume');await db.query('DISCARD PLANS');
 receipt={authorization_id:auth102};claimRelease=finalRelease;claimGeneration=finalGeneration;claimDeployment=finalDeployment;c=m103Claim;
 await db.query('set role service_role');
 await execute(c,[packageCommand99]);
 await db.query('reset role');
 const final102=await one('select * from work_projects where id=$1',[project]),pkg102=await one('select * from project_work_packages where project_id=$1',[project]);
 assert.equal(final102.status,'paused');assert.equal(final102.max_missions,103);assert.equal(final102.active_mission_id,null);
 assert.equal(pkg102.status,'queued');assert.equal(pkg102.worker_id,coder99.id);assert.equal(pkg102.writer_id,coder99.id);assert.equal(pkg102.reviewer_id,reviewer99.id);
 assert.equal((await one('select count(*)::int n from project_work_packages where project_id=$1',[project])).n,1);
 assert.equal((await one('select count(*)::int n from project_worker_contracts where package_id=$1',[pkg102.id])).n,3);
 assert.equal((await one('select count(*)::int n from agent_missions where project_id=$1',[project])).n,103);
 assert.equal((await one("select count(*)::int n from project_provider_requests where project_id=$1 and NOT mission_id=any($2::uuid[]) and operation='inference' and resolved_at is not null",[project,history102Ids])).n,1);
 assert.equal((await one('select count(*)::int n from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1 and NOT m.id=any($2::uuid[]) and j.attempts=1',[project,history102Ids])).n,1);
 assert.deepEqual(await preserve102(),saved102);
 assert.deepEqual(await one('select * from project_coding_capacity_resume_receipts where project_id=$1 and historical_missions=102',[project]),receipt102);
 assert.equal((await one('select project_org_coding_capacity_live($1) ok',[project])).ok,false);
 await db.query('set role service_role');
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,finalRelease,finalGeneration,finalDeployment])).ok,false);
 console.log('MISSION102_FINAL_PACKAGE_NATIVE_PASS '+JSON.stringify({history:102,ceiling:103,freshMissions:1,paidFixtureReceipts:1,attemptsEach:1,packages:1,smartContracts:3,workerAgentId:coder99.agent_id,writerAgentId:coder99.agent_id,reviewerAgentId:reviewer99.agent_id,packageId:pkg102.id,realProviderCalls:0,workersAndGrantsPreserved:true}));
 await db.query('reset role');
 await db.query('rollback to savepoint mission102_final_resume');await db.query('release savepoint mission102_final_resume');await db.query('DISCARD PLANS');
 receipt={authorization_id:auth99};claimRelease=identityRelease;claimGeneration=identityGeneration;claimDeployment=identityDeployment;c=m102Claim;
 await db.query('set role service_role');
 await execute(c,[packageCommand99]);
 await db.query('reset role');
 const final99=await one('select * from work_projects where id=$1',[project]),pkg99=await one('select * from project_work_packages where project_id=$1',[project]);
 assert.equal(final99.status,'paused');assert.equal(final99.max_missions,102);assert.equal(final99.active_mission_id,null);
 assert.equal(pkg99.status,'queued');assert.equal(pkg99.worker_id,coder99.id);assert.equal(pkg99.reviewer_id,reviewer99.id);
 assert.equal((await one('select count(*)::int n from project_work_packages where project_id=$1',[project])).n,1);
 assert.equal((await one('select count(*)::int n from project_worker_contracts where package_id=$1',[pkg99.id])).n,3);
 assert.equal((await one('select count(*)::int n from agent_missions where project_id=$1',[project])).n,102);
 assert.equal((await one("select count(*)::int n from project_provider_requests where project_id=$1 and NOT mission_id=any($2::uuid[]) and operation='inference' and resolved_at is not null",[project,history99Ids])).n,3);
 assert.equal((await one('select count(*)::int n from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1 and NOT m.id=any($2::uuid[]) and j.attempts=1',[project,history99Ids])).n,3);
 assert.deepEqual(await preserve99(),saved99);assert.deepEqual(await one('select * from project_coding_capacity_resume_receipts where project_id=$1 and historical_missions=99',[project]),receipt99);
 assert.equal((await one('select project_org_coding_capacity_live($1) ok',[project])).ok,false);
 await db.query('set role service_role');
 assert.equal((await one('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,identityRelease,identityGeneration,identityDeployment])).ok,false);
 console.log('MISSION99_RESUME_NATIVE_PASS '+JSON.stringify({history:99,oldCeiling:101,newCeiling:102,freshMissions:3,paidFixtureReceipts:3,attemptsEach:1,workerAgentId:coder99.agent_id,reviewerAgentId:reviewer99.agent_id,packages:1,smartContracts:3,packageId:pkg99.id,realProviderCalls:0}));
 await db.query('reset role');
 await db.query('rollback to savepoint mission99_identity_resume');await db.query('release savepoint mission99_identity_resume');
 await db.query('DISCARD PLANS');
 receipt={authorization_id:newAuth};claimRelease=newRelease;claimGeneration=generation+2;claimDeployment=newDeployment;c=m99Claim;
 await db.query('set role service_role');
 await execute(c,[...legitimateAppointments,{action:'ready'}]);
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
