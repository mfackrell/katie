import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {modules} from './load-project-modules.mjs';

// This runs inside the existing owner-ratified provider-controlled PostgreSQL
// fixture. Build the persisted Game Delivery topology through real appointments,
// then exercise the unchanged application and SQL authority on real leases.
// Only the model transport is replaced; no provider calls or production writes.
export async function assertCodingCommissioningPath(db,x){
 const {project,game,rootNode,scopeHash,scopePaths,deadline,activate,decide,session}=x;
 await db.query('savepoint coding_commissioning_fixture');
 const reject=async(fn,pattern)=>{
  await db.query('savepoint rejected_commission');
  try{await assert.rejects(fn(),pattern);}
  finally{await db.query('rollback to savepoint rejected_commission');await db.query('release savepoint rejected_commission');}
 };
 const node=async id=>(await db.query('select * from project_organization_nodes where id=$1',[id])).rows[0];
 const child=async id=>(await db.query('select * from project_organization_nodes where parent_id=$1 order by id',[id])).rows;
 const packages=async()=> (await db.query('select * from project_work_packages where project_id=$1',[project])).rows;
 const appointment=(name,level,tools,objective,area,extra={})=>({
  action:'appoint',kind:level==='worker'?'worker':'manager',managementLevel:level,name,area,objective,
  acceptance:['Deliver verified bounded result within the approved milestone'],tools,paths:[],tokens:1000,deadline,...extra
 });
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
 const execute=async(s,commands,pattern)=>{
  const mission=(await db.query('select * from agent_missions where id=$1',[s.mission])).rows[0];
  const job=(await db.query('select * from mission_assignments where id=$1',[s.job])).rows[0];
  return executeManagementClaim({mission,job},async(_claim,instruction,input,tools)=>{
   assert.equal(tools,'none');if(pattern)assert.match(instruction,pattern);
   const ctx=JSON.parse(input);assert.equal(ctx.principal.id,s.node);
   assert.equal(ctx.project.approved_hash,scopeHash);assert.equal(ctx.project.milestoneIndex,0);
   return {text:JSON.stringify(commands)};
  });
 };
 try{
  assert.deepEqual(scopePaths,['app/milestone-3-tic-tac-toe/','lib/milestone-3-tic-tac-toe/','tests/milestone-3-tic-tac-toe/']);
  const managerObjective='Decompose and manage delivery of the responsive, same-device two-player browser tic-tac-toe game exactly as requested by the owner within the single coding milestone under app/milestone-3-tic-tac-toe/, lib/milestone-3-tic-tac-toe/, and tests/milestone-3-tic-tac-toe/, while preserving all no-extra-features constraints and using the existing execution team where appropriate.';
  await decide(await activate(game.id),[appointment('Delivery Manager, Tic-Tac-Toe Milestone','manager',['manage','analysis','development','repository_review'],managerObjective,'delivery_management'),{action:'ready'}]);
  const manager=(await child(game.id)).find(n=>n.name==='Delivery Manager, Tic-Tac-Toe Milestone');
  await decide(await activate(game.id),[{action:'grant_scope',nodeId:manager.id,paths:scopePaths},{action:'ready'}]);
  await decide(await activate(manager.id),[
   appointment('Implementation Planning Supervisor','supervisor',['manage','analysis','repository_review'],'Create a management-ready implementation plan without executing code','delivery_planning'),
   appointment('Repository Scope Analyst','worker',['analysis','repository_review'],'Report exact existing file inventory without proposing or performing implementation','delivery_repository_assessment'),{action:'ready'}
  ]);
  const reports=await child(manager.id),supervisor=reports.find(n=>n.kind==='manager'),analyst=reports.find(n=>n.kind==='worker');
  assert.equal((await node(manager.id)).tools.includes('development'),true);
  assert.equal(analyst.tools.includes('development'),false);assert.equal(supervisor.tools.includes('development'),false);
  assert.deepEqual((await db.query('select paths from project_organization_scope_grants where node_id=$1 and scope_hash=$2',[manager.id,scopeHash])).rows[0].paths,scopePaths);
  assert.equal(reports.filter(n=>n.kind==='worker'&&n.tools.includes('development')).length,0);
  assert.equal((await packages()).length,0);
  const original=(await db.query('select * from work_projects where id=$1',[project])).rows[0];
  const dev=(await db.query("select a.id from managed_agents a where a.id=any($1::uuid[]) and a.config->>'development'='true' and not exists(select 1 from project_organization_nodes n where n.project_id=$2 and n.agent_id=a.id) order by a.id limit 1",[original.team,project])).rows[0];
  assert.ok(dev,'Existing unappointed development specialist must be available');
  const coderAppointment=appointment('Approved Game Developer','worker',['analysis','development'],'Implement the exact approved tic-tac-toe file inventory and compose the implementation evidence','delivery_implementation',{reuseAgentId:dev.id});
  const reviewerAppointment=appointment('Technical Package Reviewer','worker',['analysis'],'Independently review package implementation evidence; do not replace final independent QA','delivery_package_review');
  const smart=(role,paths)=>({objective:role+' bounded milestone output',deliverable:role+' evidence',instruction:'Complete the exact approved milestone contract for '+role,parentObjective:managerObjective,capability:'analysis',acceptance:[{criterion:'Approved browser contract passes',evidence:'Same source verification'}],inventory:[{item:'Approved tic-tac-toe milestone',contextChars:1000}],estimate:{basis:'declared_inventory',rationale:'One bounded deliverable',uncertainty:'Verify actual output',tokens:1000,seconds:30},tokens:2000,maxAssignments:2,deadline,paths});
  const files=['app/milestone-3-tic-tac-toe/page.tsx','lib/milestone-3-tic-tac-toe/game.ts','tests/milestone-3-tic-tac-toe/game.test.ts'];
  const packageCommand=(coder,reviewer)=>({action:'commission_package',workerId:coder.id,writerId:coder.id,reviewerId:reviewer.id,milestoneIndex:0,objective:'Implement approved tic-tac-toe game',deliverables:['Playable game and scoped tests'],interfaces:[],acceptance:['Approved browser contract passes'],dependencies:[],paths:scopePaths,deadline,maxAttempts:2,tasks:{development:smart('development',files),compose:smart('compose',[]),review:smart('review',[])}});
  await db.query('savepoint original_stranding');
  const before=await activate(manager.id);
  await reject(()=>decide(before,[packageCommand(analyst,supervisor)]),/immediately delegated capable workers/);
  await decide(before,[coderAppointment,reviewerAppointment,{action:'ready'}]);
  assert.equal((await node(manager.id)).decision_needed,false,'Old successful appointment strands the issuing manager before scope and package turns');
  assert.equal((await packages()).length,0);
  await db.query('rollback to savepoint original_stranding');await db.query('release savepoint original_stranding');
  console.log('CODING_CHAIN_BEFORE_PASS: actual authority rejects analyst as coder; old successful appointment clears manager decision flag before package exists');

  // Install exact production patch within this disposable transaction and
  // prove that applying it does not modify even one existing data row.
  await db.query('reset role');
  const snapshot=async()=> {
   const out={};
   for(const table of ['work_projects','project_organization_nodes','project_organization_scope_grants','project_organization_decisions','agent_missions','mission_assignments','project_provider_requests','project_work_packages','project_worker_contracts']){
    const filter=table==='work_projects'?'id=$1':table==='mission_assignments'?'mission_id in (select id from agent_missions where project_id=$1)':table==='project_organization_scope_grants'?'node_id in (select id from project_organization_nodes where project_id=$1)':'project_id=$1';
    out[table]=(await db.query('select to_jsonb(t) r from '+table+' t where '+filter+' order by to_jsonb(t)::text',[project])).rows;
   }return out;
  };
  const history=await snapshot();
  const authority=async()=> (await db.query("select proname,prosrc,proacl::text,prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname in ('project_package_command','project_smart_contract','project_org_principal','project_org_reporting_guard','project_org_amend_delegation','project_org_decide') order by proname")).rows;
  const definitions=await authority();
  const sql=readFileSync('supabase/migrations/20261124165000_coding_commissioning_continuation.sql','utf8').replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
  await db.query(sql);
  assert.deepEqual(await snapshot(),history);assert.deepEqual(await authority(),definitions);
  const qa=(await db.query("select * from project_organization_nodes where project_id=$1 and area='independent_qa' and parent_id=$2",[project,rootNode.id])).rows[0];
  // Fixture-only initial scheduling state: the same uncompleted implementation
  // director competes with pending QA. No activation helper after this point.
  await db.query('update project_organization_nodes set decision_needed=(id in ($2,$3)) where project_id=$1',[project,game.id,qa.id]);
  await db.query('set role service_role');
  let s=await session();assert.equal(s.node,game.id);
  await reject(()=>execute(s,[{action:'assign',nodeId:analyst.id,capability:'repository_review',smart:smart('analysis',[])}]),/immediate reporting authority/);
  await reject(()=>decide(s,[packageCommand(analyst,supervisor)]),/immediately delegated capable workers/);
  await execute(s,[{action:'reject',nodeId:manager.id,findings:['No package or directly authorized coding worker exists for the approved milestone; appoint and grant scope before package commissioning.']},{action:'ready'}],/IMPLEMENTATION COMMISSIONING HANDOFF/);
  s=await session();assert.equal(s.node,manager.id,'Authorized delivery manager must take precedence over QA of an unbuilt candidate');
  await reject(()=>decide(s,[{...coderAppointment,tools:['analysis','development','production_deploy']}]),/Child authority exceeds parent/);
  await reject(()=>execute(s,[{action:'assign',nodeId:qa.id,capability:'analysis',smart:smart('analysis',[])}]),/immediate reporting authority/);
  await execute(s,[coderAppointment,reviewerAppointment,{action:'ready'}],/IMPLEMENTATION COMMISSIONING — APPOINT WORKERS/);
  const children=await child(manager.id),coder=children.find(n=>n.agent_id===dev.id),reviewer=children.find(n=>n.name==='Technical Package Reviewer');
  assert.ok(coder&&reviewer);assert.equal(coder.parent_id,manager.id);assert.equal(coder.kind,'worker');assert.equal(coder.tools.includes('development'),true);
  assert.equal(reviewer.parent_id,manager.id);assert.notEqual(reviewer.id,coder.id);
  assert.equal((await node(analyst.id)).tools.includes('development'),false);
  assert.equal((await node(qa.id)).tools.includes('development'),false);
  assert.equal((await node(manager.id)).decision_needed,true);
  s=await session();assert.equal(s.node,manager.id,'Successful worker appointment must schedule the same manager for scope');
  await reject(()=>decide(s,[{action:'grant_scope',nodeId:coder.id,paths:['app/']}]),/Scope grant exceeds approved parent/);
  await reject(()=>decide(s,[packageCommand(coder,reviewer)]),/worker scope/);
  await execute(s,[{action:'grant_scope',nodeId:coder.id,paths:scopePaths},{action:'ready'}],/IMPLEMENTATION COMMISSIONING — GRANT CODER SCOPE/);
  assert.deepEqual((await db.query('select paths from project_organization_scope_grants where node_id=$1 and scope_hash=$2',[coder.id,scopeHash])).rows[0].paths,scopePaths);
  assert.equal((await node(manager.id)).decision_needed,true);
  s=await session();assert.equal(s.node,manager.id,'Successful coder scope grant must schedule the same manager for separate package decision');
  const command=packageCommand(coder,reviewer);
  await reject(()=>decide(s,[{...command,workerId:analyst.id}]),/immediately delegated capable workers/);
  await reject(()=>decide(s,[{...command,reviewerId:coder.id}]),/Independent technical reviewer required/);
  await reject(()=>decide(s,[{...command,paths:['app/']}]),/Package exceeds delegated scope/);
  await reject(()=>decide(s,[{...command,tasks:{...command.tasks,development:smart('development',['app/unauthorized.tsx'])}}]),/bounded file inventory/);
  await reject(()=>execute(s,[{...command,tasks:{...command.tasks,development:{...command.tasks.development,parentObjective:'Wrong manager'}}}]),/SMART fields/);
  await reject(()=>decide(s,[{...command,tasks:{...command.tasks,development:{...command.tasks.development,parentObjective:'Wrong manager'}}}]),/Specific measurable single-worker SMART/);
  await reject(()=>decide(s,[command,command]),/duplicate key|unique constraint/);
  assert.equal((await packages()).length,0,'All invalid and duplicate batches are atomic');
  await execute(s,[command],/IMPLEMENTATION COMMISSIONING — PACKAGE PREREQUISITES/);
  const saved=await packages();assert.equal(saved.length,1);
  const wp=saved[0];
  assert.equal(wp.manager_id,manager.id);assert.equal(wp.worker_id,coder.id);assert.equal(wp.writer_id,coder.id);assert.equal(wp.reviewer_id,reviewer.id);
  assert.equal(wp.commissioned_by,s.job);assert.equal(wp.scope_hash,scopeHash);assert.deepEqual(wp.paths,scopePaths);
  const contracts=(await db.query('select role,worker_id,contract from project_worker_contracts where package_id=$1 order by role',[wp.id])).rows;
  assert.equal(contracts.length,3);assert.deepEqual(contracts.map(c=>c.role),['compose','development','review']);
  assert.deepEqual(contracts.find(c=>c.role==='development').contract.paths,files);
  assert(contracts.every(c=>c.contract.parentObjective===managerObjective));
  assert.equal((await node(manager.id)).decision_needed,false,'A real package terminates commissioning prework');
  await reject(()=>decide(s,[command]),/Live management|lease/);
  await db.query('reset role');
  const after=(await db.query('select max_missions,token_allowance,deadline,approved_hash,objective from work_projects where id=$1',[project])).rows[0];
  for(const k of Object.keys(after))assert.deepEqual(after[k],original[k]);
  const providerBefore=history.project_provider_requests;
  const providerAfter=(await db.query('select to_jsonb(t) r from project_provider_requests t where project_id=$1 order by to_jsonb(t)::text',[project])).rows;
  assert.deepEqual(providerAfter,providerBefore,'No provider request in commissioning qualification');
  assert.deepEqual(await authority(),definitions);
  console.log('CODING_CHAIN_NATIVE_PASS '+JSON.stringify({packageId:wp.id,managerId:manager.id,workerId:coder.id,reviewerId:reviewer.id,scopeHash:wp.scope_hash,packages:saved.length,smartContracts:contracts.length,providerRequestsAdded:0}));
 }finally{
  await db.query('rollback to savepoint coding_commissioning_fixture');
  await db.query('release savepoint coding_commissioning_fixture');await db.query('set role service_role');
 }
}
