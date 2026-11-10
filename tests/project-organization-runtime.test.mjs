import test from 'node:test';
import {readFileSync} from 'node:fs';
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
 assert.equal(invoked,1);assert.deepEqual(calls.map(c=>c.name),['project_provider_mode','project_org_decide']);assert.equal(calls[1].args.p_lease,claim.job.lease);
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

test('coding packages require immediate Functional Director authority at dispatch',()=>{
 const {assertManagementCommands}=modules()('@/lib/projects/organization');
 const root={id:'root',kind:'project_director'},manager={id:'manager',kind:'manager'};
 const nodes=[root,{...manager,parent_id:root.id},{id:'coder',parent_id:manager.id},{id:'writer',parent_id:manager.id},{id:'reviewer',parent_id:manager.id}];
 const command={action:'commission_package',workerId:'coder',writerId:'writer',reviewerId:'reviewer'};
 assertManagementCommands(manager,nodes,[command]);
 assert.throws(()=>assertManagementCommands(root,nodes,[command]),/cannot assign execution/);
 for(const action of ['evaluate_package','repair_package'])assert.throws(()=>assertManagementCommands(root,nodes,[{action}]),/cannot assign execution/);
 assert.throws(()=>assertManagementCommands(manager,nodes,[{...command,workerId:'foreign'}]),/immediate reporting/);
});


test('native host authenticates package paths and predecessor before granting execution',async()=>{
 const host=readFileSync('scripts/benchmark/native-development-host.mjs','utf8');
 const start=host.indexOf('if(project.organization_version===1){'),end=host.indexOf('const priorRefs=',start);
 assert.ok(start>0&&end>start);
 const run=new (Object.getPrototypeOf(async function(){}).constructor)('project','task','readOne','wipContext','denied',host.slice(start,end));
 const binding={projectId:'project',baseSha:'accepted-predecessor',baselineSha:'original',allowedPaths:['app/pilot/view/'],cumulativePaths:['app/pilot/'],contractHash:'original-contract'};
 const readOne=async(table,column,id)=>{
  if(table==='mission_assignments'){assert.equal(column,'id');assert.equal(id,'task');return {mission_id:'mission'};}
  assert.equal(table,'project_runs');assert.equal(column,'mission_id');assert.equal(id,'mission');return {binding};
 };
 const denied=message=>{throw Error(message);};
 await run({organization_version:1},{id:'task'},readOne,binding,denied);
 for(const key of Object.keys(binding))await assert.rejects(run({organization_version:1},{id:'task'},readOne,{...binding,[key]:key.endsWith('Paths')?['app/escape/']:'forged'},denied),/package dispatch context mismatch/);
 await run({organization_version:0},{id:'historical'},()=>assert.fail('Historical execution must retain its existing guard'),{},denied);
});

test('explicit management levels restrict appointments without granting technical authority',()=>{
 const {assertManagementCommands}=modules()('@/lib/projects/organization');
 const manager={id:'m',kind:'manager',management_level:'manager'},supervisor={id:'s',kind:'manager',management_level:'supervisor'};
 assertManagementCommands(manager,[],[{action:'appoint',kind:'manager',managementLevel:'supervisor'},{action:'appoint',kind:'worker',managementLevel:'worker'}]);
 assertManagementCommands(supervisor,[],[{action:'appoint',kind:'worker',managementLevel:'worker'}]);
 assert.throws(()=>assertManagementCommands(supervisor,[],[{action:'appoint',kind:'manager',managementLevel:'manager'}]),/workers only/);
 assert.throws(()=>assertManagementCommands(manager,[],[{action:'appoint',kind:'manager',managementLevel:'functional_director'}]),/Managers commission/);
 assert.throws(()=>assertManagementCommands({id:'p',kind:'project_director'},[],[{action:'authorize_assignment',assignmentId:'worker-job'}]),/cannot assign/);
});

test('authenticated trial start and stop use the project controller without a financial approval',async()=>{
 const calls=[],actorId=randomUUID(),chatId=randomUUID(),projectId=randomUUID();
 let authenticated=false;
 const load=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>authenticated},
  '@/lib/missions/store':{rpc:async(name,args)=>{calls.push({name,args});return {id:projectId,status:'running'};}},
  '@/lib/data/persistence-store':{getMessages:async()=>[]},
 });
 const route=load('@/app/api/projects/organization/route');
 const request=trialAction=>new Request('https://synthetic.test/api/projects/organization',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({actorId,chatId,trialAction})});
 assert.equal((await route.POST(request('start'))).status,403);
 assert.equal(calls.length,0);
 authenticated=true;
 assert.equal((await (await route.POST(request('start'))).json()).projectId,projectId);
 assert.equal((await route.POST(request('stop'))).status,200);
 assert.deepEqual(calls.map(x=>x.name),['project_provider_launch','project_provider_owner_stop']);
 assert.equal(calls[0].args.p_chat,chatId);
});

test('trial Director can call the provider without any accounting service, and refusal is terminal',async()=>{
 const calls=[], agent=randomUUID();
 let refuse=false,attempts=0;
 const load=modules({
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>{throw Error('Accounting and registry unavailable');}},
  '@/lib/missions/store':{rpc:async(name,args)=>{calls.push(name);assert.match(name,/^project_provider_(mode|mission_live|mission_stop|request)$/);
   if(name==='project_provider_mission_stop')throw Error('503 stop write failed');
   if(name==='project_provider_request')assert.match(args.p_hash,/^[a-f0-9]{64}$/);
   return true;}},
  '@/lib/providers':{getAvailableProviders:()=>[{name:'openai',listModels:async()=>['gpt-5.4']},{name:'anthropic',listModels:async()=>{throw Error('Unexpected account switch');}}]},
  '@/lib/orchestration/bounded-provider':{boundedProvider:()=>({post:async()=>{throw Error('Token accounting must not be reached');},responses:{create:async()=>{
   attempts++;
   if(refuse)throw Error('Provider refused trial request');
   return {id:'fixture',status:'completed',output_text:'[{"action":"ready"}]',output:[]};
  }}})},
 });
 const now=Date.now();
 const claim={mission:{project_id:randomUUID(),project_kind:'management',objective:'Plan the game',deadline:new Date(now+3600000).toISOString(),team:[{id:agent,config:{}}]},
  job:{id:randomUUID(),agent_id:agent,role:'work',payload:{},lease:randomUUID(),lease_until:new Date(now+360000).toISOString()}};
 const model=load('@/lib/missions/model').missionModel;
 assert.equal((await model(claim,'Return the decision','Verified scope')).text,'[{"action":"ready"}]');
 assert.deepEqual(calls,['project_provider_mode','project_provider_mission_live',...Array(4).fill('project_provider_request')]);
 refuse=true;
 await assert.rejects(model(claim,'Return the decision','Verified scope'),error=>error.message==='Provider refused trial request'&&error.partial.providerOutcomeUnresolved===true);
 assert.equal(calls.at(-1),'project_provider_mission_stop');
 assert.equal(attempts,2);
});

test('management rejection locates a premature dependency without storing model prose or foreign IDs',()=>{
 const {assertManagementCommands,ManagementCommandRejection}=modules()('@/lib/projects/organization');
 const root={id:randomUUID(),kind:'project_director'};
 const foreign=randomUUID(),secret='secret-from-model-should-never-be-stored';
 const commands=[{action:'plan'},{action:'appoint',kind:'manager'},{action:'dependency',nodeId:foreign,dependsOn:secret}];
 assert.throws(()=>assertManagementCommands(root,[root],commands),error=>{
  assert.ok(error instanceof ManagementCommandRejection);
  const e=error.evidence;
  assert.equal(e.position,3);assert.equal(e.action,'dependency');assert.equal(e.priorAppointments,1);
  assert.equal(e.code,'immediate_reporting_authority');
  assert.equal(e.targets[0].field,'nodeId');assert.equal(e.targets[0].status,'unknown');assert.match(e.targets[0].idHash,/^[a-f0-9]{64}$/);
  assert.equal(e.targets[1].field,'dependsOn');assert.equal(e.targets[1].status,'malformed');
  assert.ok(!JSON.stringify(e).includes(secret)&&!JSON.stringify(e).includes(foreign));
  return true;
 });
 const branch={id:randomUUID(),parent_id:root.id},descendant={id:randomUUID(),parent_id:branch.id};
 assert.throws(()=>assertManagementCommands(root,[root,branch,descendant],[{action:'certify',nodeId:descendant.id}]),error=>{
  assert.equal(error.evidence.targets[0].status,'not_direct_report');
  assert.equal(error.evidence.targets[0].id,descendant.id);
  return true;
 });
 assert.doesNotThrow(()=>assertManagementCommands(root,[root],[{action:'plan'},{action:'appoint',kind:'manager'}]));
});

test('management rejection retries only a failed terminal write and fences inference after a lost receipt',async()=>{
 for(const mode of ['success','throw-once','false','throw-twice']){
  const id=randomUUID(),agent=randomUUID(),project=randomUUID(),writes=[];
  const rows={project_organization_nodes:[{id,agent_id:agent,kind:'project_director'}],work_projects:{objective:'Game',team:[]}};
  const db={from(table){const q={select(){return q;},eq(){return q;},in(){return q;},single(){return q;},then(ok){return Promise.resolve({data:rows[table]??[],error:null}).then(ok);}};return q;}};
  const claim={mission:{id:randomUUID(),project_id:project,project_kind:'management',calls:0},job:{id:randomUUID(),agent_id:agent,lease:randomUUID(),attempts:1,payload:{organizationNodeId:id}}};
  let next=claim,modelCalls=0;
  const load=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},'@/lib/missions/store':{rpc:async(name,args)=>{
   if(name==='claim_mission_work'){const result=next;next=null;return result;}
   if(name==='project_org_decide')assert.fail('Rejected command reached the dispatch RPC');
   if(name==='commit_mission_work'){
    writes.push(args);
    if(mode==='throw-twice'||mode==='throw-once'&&writes.length===1)throw Error('503 test write failure');
    return mode!=='false';
   }
   return true;
  }}});
  const worker=load('@/lib/missions/worker');
  const model=async()=>{modelCalls++;return{text:'[{"action":"dependency","nodeId":"unbound"}]'};};
  const result=await worker.runMissionBatch(model);
  assert.equal(result.outcomes[0].status,['false','throw-twice'].includes(mode)?'failure_record_unconfirmed':'blocked');
  assert.equal(modelCalls,1);
  assert.equal(writes.length,['throw-once','throw-twice'].includes(mode)?2:1);
  for(const write of writes){
   assert.equal(write.p_id,claim.job.id);assert.equal(write.p_lease,claim.job.lease);
   assert.equal(write.p_status,'failed');assert.equal(write.p_mission_status,'blocked');
   assert.equal(write.p_result.managementCommandRejection.action,'dependency');
  }
  if(writes.length===2)assert.deepEqual(writes[0],writes[1]);
  await assert.rejects(worker.executeClaim({...claim,mission:{...claim.mission,calls:1},job:{...claim.job,lease:randomUUID(),attempts:2}},model),/already admitted/);
  assert.equal(modelCalls,1);
 }
});

test('one-shot Director recovery requires the authenticated owner, exact release and explicit cutoff',async t=>{
 const prior=process.env.VERCEL_GIT_COMMIT_SHA;
 const release='a'.repeat(40);
 process.env.VERCEL_GIT_COMMIT_SHA=release;
 t.after(()=>{if(prior===undefined)delete process.env.VERCEL_GIT_COMMIT_SHA;else process.env.VERCEL_GIT_COMMIT_SHA=prior;});
 let authenticated=false;
 const calls=[];
 const route=modules({
  '@/lib/projects/owner-authorization':{verifiedProjectOwnerSession:async()=>authenticated},
  '@/lib/missions/store':{rpc:async(name,args)=>{calls.push({name,args});return {missionId:'receipt'};}},
 })('@/app/api/projects/organization/route');
 const input={projectId:randomUUID(),trialAction:'recover_director_once',releaseSha:release,cutoff:'2026-11-10T18:58:00Z'};
 const post=value=>route.POST(new Request('https://synthetic.test/api/projects/organization',{method:'POST',body:JSON.stringify(value)}));
 assert.equal((await post(input)).status,403);
 authenticated=true;
 assert.equal((await post({...input,cutoff:undefined})).status,400);
 assert.equal((await post({...input,releaseSha:'b'.repeat(40)})).status,409);
 assert.deepEqual(calls,[]);
 assert.deepEqual(await (await post(input)).json(),{missionId:'receipt'});
 assert.equal(calls.length,1);
 assert.equal(calls[0].name,'project_admit_director_recovery');
 assert.equal(calls[0].args.p_project,input.projectId);
 assert.equal(calls[0].args.p_release,input.releaseSha);
 assert.equal(calls[0].args.p_cutoff,input.cutoff);
});

test('one-shot Director recovery fences a mismatched runtime before inference and sanitizes unsupported commands',async()=>{
 const {executeManagementClaim,assertManagementCommands}=modules()('@/lib/projects/organization');
 const claim={mission:{project_evidence:{directorRecoveryRelease:'a'.repeat(40)}}};
 await assert.rejects(executeManagementClaim(claim,()=>assert.fail('Provider must not be reached')),/production worker/);
 const root={id:randomUUID(),kind:'project_director'};
 assertManagementCommands(root,[],[{action:'plan'},{action:'appoint',kind:'manager',managementLevel:'functional_director'},{action:'ready'}],true);
 assert.throws(()=>assertManagementCommands(root,[],[{action:'ready'},{action:'dependency',nodeId:'secret-like input'}],true),error=>{
  assert.equal(error.evidence.code,'director_recovery_action');
  assert.equal(error.evidence.position,2);
  assert.deepEqual(JSON.parse(JSON.stringify(error.evidence.targets)),[{field:'nodeId',status:'malformed'},{field:'dependsOn',status:'missing'}]);
  return true;
 });
});
