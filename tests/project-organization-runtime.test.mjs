import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './helpers/load-project-modules.mjs';
test('executive selection requires verified fresh OpenAI or Anthropic reasoning; no guessed fallback',()=>{
 const {eligibleExecutiveModel}=modules()('@/lib/projects/organization');
 const now=Date.now(),m={provider_name:'openai',model_id:'synthetic-premier',is_active:true,reasoning_tier:'high',capability_status:'verified',pricing_status:'verified',routing_eligibility:'verified',capability_verified_at:new Date(now-1000).toISOString(),pricing_verified_at:new Date(now-1000).toISOString()};
 assert.equal(eligibleExecutiveModel(m,now),true);assert.equal(eligibleExecutiveModel({...m,provider_name:'anthropic'},now),true);
 for(const patch of [{provider_name:'other'},{is_active:false},{reasoning_tier:'medium'},{capability_status:'heuristic'},{pricing_status:'estimated'},{routing_eligibility:'restricted'},{capability_verified_at:null},{pricing_verified_at:new Date(now-86400001).toISOString()},{capability_verified_at:new Date(now+1000).toISOString()}])assert.equal(eligibleExecutiveModel({...m,...patch},now),false);
});
test('management worker dispatches only durable management decisions; never technical execution',async()=>{
 const id=randomUUID(),agent=randomUUID(),project=randomUUID(),calls=[];
 const rows={project_organization_nodes:[{id,agent_id:agent,kind:'project_director'}],project_organization_exceptions:[],project_organization_assignments:[],project_organization_scope_grants:[],project_organization_plans:[{purpose:'Original project purpose',direction:'Delegated outcomes'}],project_organization_dependencies:[],work_projects:{objective:'Original project',team:[],phase:'research'}};
 const db={from(table){const q={select(){return q;},eq(){return q;},in(){return q;},single(){return q;},then(ok){return Promise.resolve({data:rows[table],error:null}).then(ok);}};return q;}};
 const load=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/missions/store':{rpc:async(name,args)=>{calls.push({name,args});return true;},readMission:async()=>{throw Error('Technical mission dispatch reached');}}});
 const claim={mission:{id:randomUUID(),project_id:project,project_kind:'management'},job:{id:randomUUID(),agent_id:agent,lease:randomUUID(),payload:{organizationNodeId:id}}};
 let invoked=0;
 await load('@/lib/missions/worker').executeClaim(claim,async(c,instruction,input,tools)=>{invoked++;assert.equal(tools,'none');assert.match(instruction,/Never write code/);assert.doesNotMatch(instruction,/at least three|maxDepth|maxChildren/);assert.match(instruction,/replace_leader/);assert.equal(JSON.parse(input).plans[0].purpose,'Original project purpose');assert.equal(JSON.parse(input).project.objective,'Original project');return{text:'[{"action":"ready"}]',model:'synthetic-premier'};});
 assert.equal(invoked,1);assert.equal(calls.length,1);assert.equal(calls[0].name,'project_org_decide');assert.equal(calls[0].args.p_lease,claim.job.lease);
});
test('technical work uses a separate subordinate completion receipt, never project closure',async()=>{
 const calls=[],claim={mission:{project_kind:'organization_work',objective:'Design the interface'},job:{id:randomUUID(),lease:randomUUID(),instruction:'Produce the interface contract',payload:{capability:'analysis'}}};
 const load=modules({'@/lib/missions/store':{rpc:async(name,args)=>{calls.push({name,args});return true;}}});
 await load('@/lib/missions/worker').executeClaim(claim,async()=>({text:'Interface contract artifact',model:'synthetic-worker'}));
 assert.equal(calls.length,1);assert.equal(calls[0].name,'project_org_finish_work');assert.equal(calls[0].args.p_result.text,'Interface contract artifact');
 await assert.rejects(load('@/lib/missions/worker').executeClaim({...claim,job:{...claim.job,payload:{capability:'development'}}}),/Unapproved/);
});
test('managed coding derives native authority from its project envelope without another owner action',async()=>{
 const task={id:randomUUID(),status:'dispatching',external:{},input:'Approved component',snapshot:{instructions:'Implement approved component'},repository_full_name:'mfackrell/katie'},lease=randomUUID();
 const calls=[];let allowed=true;
 const db={from(){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:null,error:null})};return q;},rpc:async(name,args)=>{calls.push({name,args});return{data:allowed,error:null};}};
 const load=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/agents/store':{agentRpc:async(name,args)=>{assert.equal(name,'save_project_development_dispatch');return{...task,status:args.p_status,details:args.p_detail};}}});
 const dispatch=load('@/lib/agents/development').dispatchDevelopment;
 const result=await dispatch(task,{projectId:randomUUID(),organizationVersion:1},lease);
 assert.equal(result.status,'dispatching');assert.match(result.details,/original owner envelope/);
 assert.equal(calls[0].name,'project_org_prepare_native');assert.equal(calls[0].args.p_lease,lease);
 allowed=false;
 assert.equal((await dispatch(task,{projectId:randomUUID(),organizationVersion:1},lease)).status,'blocked');
});
test('original envelope requires authenticated explicit autonomous-execution consent',async()=>{
 let authenticated=false;const calls=[];
 const load=modules({'@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>authenticated},'@/lib/missions/store':{rpc:async(name,args)=>{calls.push({name,args});return true;}}});
 const route=load('@/app/api/projects/organization/route');
 const body={projectId:randomUUID(),objectiveHash:'a'.repeat(64),ceilingMicrousd:2000000,perCallMicrousd:500000,autonomousExecution:true};
 const request=value=>new Request('https://synthetic.test/api/projects/organization',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await route.POST(request(body))).status,403);assert.equal(calls.length,0);
 authenticated=true;assert.equal((await route.POST(request({...body,autonomousExecution:false}))).status,400);assert.equal(calls.length,0);
 assert.equal((await route.POST(request(body))).status,200);assert.equal(calls[0].name,'project_org_authorize');assert.equal(calls[0].args.p_autonomous,true);
});

test('dispatch preserves Functional Director authority and rejects executive worker supervision',()=>{
 const {assertManagementCommands}=modules()('@/lib/projects/organization');
 const root={id:'root',kind:'project_director'},director={id:'director',kind:'manager'},manager={id:'manager',kind:'manager'};
 const nodes=[root,{...director,parent_id:root.id},{...manager,parent_id:director.id},{id:'worker',parent_id:manager.id},{id:'direct-worker',parent_id:director.id}];
 assertManagementCommands(root,nodes,[{action:'appoint',kind:'manager'}]);
 for(const kind of ['worker',null,'project_director'])assert.throws(()=>assertManagementCommands(root,nodes,[{action:'appoint',kind,reuseAgentId:'existing'}]),/only Functional Directors/);
 assert.throws(()=>assertManagementCommands(root,nodes,[{action:'assign',nodeId:'worker'}]),/cannot assign execution/);
 assertManagementCommands(director,nodes,[{action:'appoint',kind:'worker'},{action:'appoint',kind:'manager'},{action:'assign',nodeId:'direct-worker'},{action:'submit_component'}]);
 assertManagementCommands(manager,nodes,[{action:'assign',nodeId:'worker'}]);
 for(const action of ['assign','certify','reject','grant_scope','replace_leader'])assert.throws(()=>assertManagementCommands(director,nodes,[{action,nodeId:'worker'}]),/immediate reporting authority/);
 assert.throws(()=>assertManagementCommands(root,nodes,[{action:'submit_component'}]),/responsible Functional Director/);
 assert.throws(()=>assertManagementCommands(director,nodes,[{action:'submit_component',nodeId:'manager'}]),/responsible Functional Director/);
 assert.throws(()=>assertManagementCommands(root,nodes,[{action:'reorganize',nodeId:'worker',underId:'director'}]),/immediate reporting authority/);
});
