import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {projectMarker,contractHash} from '../../scripts/project-context.mjs';
import {assertProjectScope} from '../../scripts/project-scope.mjs';
import {runScenarios} from '../../scripts/project-browser-engine.mjs';
import {createNativeWipCheckpointer} from '../../scripts/benchmark/native-wip-checkpoint.mjs';

// Real PG + local Git + actual Node/Chromium checks. Model output and supplier
// usage are explicitly deterministic fixtures. Never dispatch GitHub or inference.
export async function assertProjectNativeDelegation(db,rival){
 const root=mkdtempSync(join(tmpdir(),'director-execution-')),repoPath=join(root,'worker'),remote=join(root,'durable.git');
 mkdirSync(repoPath);
 const gitAt=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 let workspace=repoPath;
 const git=(...args)=>gitAt(workspace,...args);
 const file=(path,content)=>{mkdirSync(dirname(join(workspace,path)),{recursive:true});writeFileSync(join(workspace,path),content);};
 try{
 gitAt(root,'init','--bare','-q',remote);git('init','-q');git('config','user.name','Deterministic worker');git('config','user.email','fixture@example.test');
 file('README.md','Supported Katie repository fixture');git('add','.');git('commit','-qm','Approved baseline');const baseline=git('rev-parse','HEAD');git('remote','add','origin',remote);git('push','-q','origin','HEAD:refs/heads/main');
 await db.query('reset role');
 const actor=randomUUID(),chat=randomUUID(),owner=randomUUID(),project=randomUUID(),repo=randomUUID();
 await db.query("insert into actors(id,name,actor_kind) values($1,'Hierarchy owner','standard')",[actor]);
 await db.query("insert into chats(id,actor_id,title) values($1,$2,'Hierarchy native qualification')",[chat,actor]);
 await db.query("insert into repo_sync_runs(id,repository_full_name) values($1,'mfackrell/katie')",[repo]);
 await db.query('select standalone_bind_scope($1,$2,$3)',[owner,actor,chat]);
 await db.query('set role service_role');
 const p=(await db.query('select create_work_project($1,$2,$3,$4,$5,$6) p',[project,'hierarchy-native-'+project,actor,chat,'Add two numbers and render the total with independent acceptance',repo])).rows[0].p;
 const objectiveHash=(await db.query("select encode(sha256(convert_to(objective||clarifications,'UTF8')),'hex') h from work_projects where id=$1",[project])).rows[0].h;
 await db.query('select project_org_authorize($1,$2,$3,2000000,500000,true)',[owner,project,objectiveHash]);
 const rows=async()=> (await db.query('select * from project_organization_nodes where project_id=$1',[project])).rows;
 const packages=async()=> (await db.query('select * from project_work_packages where project_id=$1 order by milestone_index',[project])).rows;
 const leaseProject=async()=>{
  const lease=randomUUID();await db.query('reset role');
  await db.query("update work_projects set lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[project,lease]);
  await db.query('set role service_role');return lease;
 };
 const schedule=async()=> (await db.query('select project_org_schedule($1,$2) s',[project,await leaseProject()])).rows[0].s;
 const session=async()=>{
  const scheduled=await schedule();assert.ok(scheduled?.missionId,JSON.stringify(scheduled));
  const lease=randomUUID();await db.query('reset role');
  const job=(await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where mission_id=$1 returning id",[scheduled.missionId,lease])).rows[0].id;
  await db.query('set role service_role');
  return {job,lease,node:(await rows()).find(n=>n.id===scheduled.nodeId)};
 };
 const decide=(s,commands)=>db.query('select project_org_decide($1,$2,$3)',[s.job,s.lease,JSON.stringify(commands)]);
 const deadline=new Date(Date.parse(p.deadline)-1000).toISOString();
 const appoint=(name,kind,tokens,tools,extra={})=>({action:'appoint',name,kind,objective:'Deliver '+name,acceptance:['Verified '+name],tokens,deadline,area:name.toLowerCase(),tools,paths:[],...extra});
 let s=await session();const rootNode=s.node;
 await assert.rejects(decide(s,[{action:'commission_package'}]),/immediate Functional Director/);
 await decide(s,[{action:'plan',purpose:'Deliver correct addition',direction:'Delegate architecture, QA and implementation',outcomes:[{criterion:'Both components accepted',verification:'Independent tests'}],milestones:[{objective:'Two components'}],organizations:['architecture','quality_assurance','development']},appoint('Architecture','manager',80000,['manage','analysis']),appoint('QA','manager',80000,['manage','analysis','research'],{area:'quality_assurance'}),appoint('Development','manager',400000,['manage','analysis','development']),{action:'ready'}]);
 for(let i=0;i<5;i++){
  s=await session();
  if(s.node.name==='Development')await decide(s,[appoint('Implementation manager','manager',350000,['manage','analysis','development'])]);
  else if(s.node.name==='Implementation manager'){
   await db.query('begin');await decide(s,[appoint('Manager direct worker','worker',10000,['analysis'])]);
   assert.ok((await rows()).some(n=>n.name==='Manager direct worker'&&n.parent_id===s.node.id));await db.query('rollback');
   await decide(s,[appoint('Implementation supervisor','manager',330000,['manage','analysis','development'],{managementLevel:'supervisor'})]);
  }
  else if(s.node.name==='Implementation supervisor')await decide(s,[appoint('Engine coder','worker',125000,['analysis','development']),appoint('View coder','worker',125000,['analysis','development']),appoint('Technical writer','worker',30000,['analysis']),appoint('Technical reviewer','worker',30000,['analysis'])]);
  else await decide(s,[appoint(s.node.name+' worker','worker',50000,['analysis'],{reuseAgentId:p.team[s.node.name==='Architecture'?0:1]})]);
 }
 const byName=name=>(awaitNodes.find(n=>n.name===name));let awaitNodes=await rows();
 const manager=byName('Implementation supervisor'),workstream=byName('Implementation manager'),engine=byName('Engine coder'),view=byName('View coder'),writer=byName('Technical writer'),reviewer=byName('Technical reviewer');
 assert.equal(manager.management_level,'supervisor');assert.equal(workstream.management_level,'manager');
 for(const leader of awaitNodes.filter(n=>n.kind!=='worker'))await assert.rejects(db.query('select project_org_assert_execution($1)',[leader.agent_id]),/cannot execute/);
 await assert.rejects(db.query("update project_organization_nodes set management_level='worker' where id=$1",[manager.id]),/permission denied/);
 await db.query('begin');await db.query('reset role');
 await assert.rejects(db.query("update project_organization_nodes set management_level='manager' where id=$1",[manager.id]),/immutable/);await db.query('rollback');
 assert.notEqual(engine.agent_id,p.team[2]);assert.notEqual(view.agent_id,p.team[2]);assert.notEqual(engine.agent_id,view.agent_id);
 const contract={path:'/',scenarios:[{name:'Correct original outcome',steps:[{action:'expectText',selector:'#state',value:'5'}]}]};
 const scope='a'.repeat(64),paths=['app/pilot/'];
 const spec={name:'Director integration',summary:'Two components',requirements:['Render 2 + 3 as 5'],allowedPaths:paths,milestones:[0,1].map(i=>({title:'Component '+i,instruction:'Implement approved component',contract})),finalContract:contract};
 await db.query("update work_projects set status='awaiting_approval',phase='approval',spec=$2,approval_hash=$3,baseline_sha=$4,repository_full_name='mfackrell/katie' where id=$1",[project,spec,scope,baseline]);
 await db.query("select control_work_project($1,$2,$3,'approve',p_hash=>$4)",[project,actor,chat,scope]);
 for(let i=0;i<6;i++){
  s=await session();
  await decide(s,(await rows()).filter(n=>n.parent_id===s.node.id).map(n=>({action:'grant_scope',nodeId:n.id,paths:n.id===engine.id?['app/pilot/engine/']:n.id===view.id?['app/pilot/view/']:paths})));
 }
 // Wake the delegated manager as an observed deterministic model turn.
 const wake=async node=>{await db.query('reset role');await db.query('update project_organization_nodes set decision_needed=true where id=$1',[node.id]);await db.query('set role service_role');};
 await wake(manager);s=await session();assert.equal(s.node.id,manager.id);
 const task=(parent,role,taskPaths=[],extra={})=>({objective:role+' one bounded component',deliverable:role+' verified artifact',instruction:'Perform '+role+' only for the explicitly inventoried component and return acceptance evidence.',parentObjective:parent.objective,capability:'analysis',acceptance:[{criterion:'Original component criterion passes',evidence:'Immutable source and executed test receipt'}],inventory:[{item:'Approved component contract and source files',contextChars:1000}],estimate:{basis:'declared_inventory',rationale:'One module and its focused test; existing interface and bounded source context',uncertainty:'Manager estimate; implementation may require rejection and bounded correction',tokens:1000,seconds:60},paths:taskPaths,tokens:role==='development'?100000:5000,maxAssignments:2,deadline,...extra});
 const taskPaths=i=>i?['app/pilot/view/render.mjs','app/pilot/view/render.test.mjs']:['app/pilot/engine/sum.mjs','app/pilot/engine/sum.test.mjs'];
 const commission=(i,worker,dependencies=[])=>({action:'commission_package',workerId:worker.id,writerId:writer.id,reviewerId:reviewer.id,milestoneIndex:i,objective:i?'Render the accepted engine result':'Provide correct arithmetic',deliverables:[i?'view module':'engine module'],interfaces:['sum(a,b) returns a number'],acceptance:[i?'Rendered total is 5':'sum(2,3) equals 5'],dependencies,paths:[i?'app/pilot/view/':'app/pilot/engine/'],tokens:125000,ceilingMicrousd:800000,deadline,maxAttempts:2,tasks:{development:task(manager,'development',taskPaths(i)),compose:task(manager,'compose'),review:task(manager,'review')}});
 await assert.rejects(decide(s,[{...commission(0,engine),paths:['app/pilot/view/']}]),/worker scope/);
 await assert.rejects(decide(s,[{...commission(0,engine),tokens:400000}]),/resources exceed/);
 await assert.rejects(decide(s,[{...commission(0,engine),reviewerId:engine.id}]),/Independent technical reviewer/);
 await assert.rejects(decide(s,[{...commission(0,engine),workerId:byName('QA worker').id}]),/immediately delegated/);
 await assert.rejects(decide(s,[appoint('Forbidden manager','manager',1,['manage'])]),/Reporting level violation/);
 await assert.rejects(decide(s,[{...commission(0,engine),tasks:{}}]),/SMART contract/);
 const oversized=commission(0,engine);oversized.tasks.development.inventory[0].contextChars=999999;
 await assert.rejects(decide(s,[oversized]),/decompose before dispatch/);
 const broad=commission(0,engine);broad.tasks.development.paths=['app/pilot/engine/'];
 await assert.rejects(decide(s,[broad]),/bounded file inventory/);
 const wrongParent=commission(0,engine);wrongParent.tasks.development.parentObjective='Unapproved objective';
 await assert.rejects(decide(s,[wrongParent]),/SMART contract/);
 const races=await Promise.allSettled([db,rival].map(c=>c.query('select project_org_decide($1,$2,$3)',[s.job,s.lease,JSON.stringify([commission(0,engine)])])));
 assert.equal(races.filter(x=>x.status==='fulfilled').length,1,'One concurrent commissioning decision');
 const first=(await packages())[0];
 await wake(manager);s=await session();await decide(s,[commission(1,view,[first.id])]);
 await assert.rejects(db.query("update project_work_packages set status='accepted' where id=$1",[first.id]),/permission denied/);
 await assert.rejects(db.query('select project_org_decide_hierarchy($1,$2,$3)',[s.job,s.lease,'[]']),/permission denied/);
 const accounts=[],acceptedJobs=[];
 let previousHead=baseline;
 for(const [milestone,deficient] of [[0,true],[0,false],[1,false]]){
  if(milestone===0&&!deficient){assert.deepEqual(await schedule(),{handled:true});}
  assert.equal(await schedule(),null,'The existing controller can dispatch the commissioned milestone');
  await db.query("select finish_work_project($1,$2,'child',$3)",[project,await leaseProject(),{kind:'development',objective:'Implement approved component '+milestone,evidence:{deterministicModelFixture:true}}]);
  const mission=(await db.query('select active_mission_id id from work_projects where id=$1',[project])).rows[0].id;
  const run=(await db.query('select * from project_runs where mission_id=$1',[mission])).rows[0];
  assert.equal(run.binding.baseSha,previousHead,'Cumulative implementation starts at the exact accepted predecessor');
  assert.deepEqual(run.binding.allowedPaths,taskPaths(milestone));
  const job=(await db.query("select * from mission_assignments where mission_id=$1 and role='development'",[mission])).rows[0];
  assert.equal(job.agent_id,(milestone?view:engine).agent_id);
  await assert.rejects(db.query('update mission_assignments set agent_id=$2 where id=$1',[job.id,(milestone?engine:view).agent_id]),/commissioned package ownership/);
  const agent=(await db.query('select * from managed_agents where id=$1',[job.agent_id])).rows[0],taskChat=randomUUID(),lease=randomUUID();
  await db.query("insert into chats(id,actor_id,title) values($1,$2,'Delegated native worker')",[taskChat,agent.actor_id]);
  await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[job.id,lease]);
  const prepared=(await db.query('select prepare_mission_development($1,$2) input',[job.id,lease])).rows[0].input;
  await db.query("insert into agent_tasks(id,agent_id,actor_id,chat_id,snapshot,definition_version,kind,initial_input,input,repository_id,repository_full_name,request_id,status,external) values($1::uuid,$2,$3,$4,$5,$6,'development',$8,$8,$7,'mfackrell/katie',$1::text,'dispatching','{}')",[job.id,agent.id,agent.actor_id,taskChat,agent.config,agent.version,repo,prepared]);
  await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[job.id,lease]);
  const reviewJob=(await db.query("select id from mission_assignments where mission_id=$1 and role='review'",[mission])).rows[0].id;
  await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[reviewJob,lease]);
  assert.equal((await db.query('select checkpoint_mission_review_model($1,$2,$3,$4) ok',[reviewJob,lease,'b'.repeat(64),{text:'Deterministic checkpoint',sources:[],calculations:[],model:'fixture'}])).rows[0].ok,true);
  await assert.rejects(db.query("update mission_assignments set payload=payload||'{\"development_input\":\"Forged\"}' where id=$1",[job.id]),/metadata requires authenticated/);
  await assert.rejects(db.query("update mission_assignments set instruction='Implement the whole project' where id=$1",[job.id]),/SMART assignment is immutable/);
  await assert.rejects(db.query("update agent_missions set objective='Bypass the contract' where id=$1",[mission]),/SMART mission context is immutable/);
  await assert.rejects(db.query("update mission_assignments set dependencies=array['fake'] where id=$1",[job.id]),/SMART assignment is immutable/);
  await db.query('begin');await db.query('reset role');
  await db.query("update project_worker_contracts set deadline=now()-interval '1 second' where worker_id=$1",[(milestone?view:engine).id]);
  await db.query('set role service_role');await assert.rejects(db.query("update mission_assignments set status='running',lease=gen_random_uuid() where id=$1",[job.id]),/SMART authority changed or expired/);await db.query('rollback');
  await assert.rejects(db.query('select project_smart_admit($1)',[job.id]),/permission denied/);
  await assert.rejects(db.query('select project_org_prepare_native($1,$2)',[job.id,randomUUID()]),/Live delegated/);
  assert.equal((await db.query('select developer_next_initial_task($1,$2) id',[owner,chat])).rows[0].id,null);
  const race=await Promise.all([db,rival].map(c=>c.query('select project_org_prepare_native($1,$2) ok',[job.id,lease])));assert.ok(race.every(r=>r.rows[0].ok));
  const d=(await db.query('select * from project_organization_native_delegations where task_id=$1',[job.id])).rows[0];
  const approval=(await db.query('select * from benchmark_native_spending_approvals where id=$1',[d.approval_id])).rows[0];
  assert.equal(approval.owner_id,owner);assert.equal(approval.task_id,job.id);assert.equal(approval.trial_id,null);assert.ok(d.limits.ceilingMicrousd<=2000000);assert.ok(d.limits.perCallMicrousd<=500000);assert.ok(Date.parse(approval.deadline)<=Date.parse(deadline));
  accounts.push(approval.account_id);
  assert.equal((await db.query('select count(*)::int n from benchmark_native_spending_approvals where task_id=$1',[job.id])).rows[0].n,1);
  const release='e'.repeat(40),token=randomBytes(32).toString('hex');
  assert.equal((await db.query('select developer_claim_dispatch($1,$2) ok',[approval.id,release])).rows[0].ok,true);
  const grant=(await db.query('select developer_issue_execution_grant($1,$2,$3,$4) g',[approval.id,job.id,token,release])).rows[0].g;
  const call=(await db.query('select developer_native_reserve($1,$2,$3,$4,$5,100) id',[token,project,grant.executionEpoch,randomUUID(),approval.model])).rows[0].id;
  const linked=(await db.query('select legacy_mission_call_id id from benchmark_budget_calls where id=$1',[call])).rows[0].id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'deterministic-fixture-'+call,{input_tokens:3,output_tokens:2,total_tokens:5}]);
  assert.equal((await db.query('select state from benchmark_budget_calls where id=$1',[call])).rows[0].state,'settled');
  assert.ok((await db.query('select organization_exposure_microusd from mission_calls where id=$1',[linked])).rows[0].organization_exposure_microusd);
  for(const boundary of ['expired','over_cap']){
   await db.query('begin');
   const pendingCall=(await db.query('select developer_native_reserve($1,$2,$3,$4,$5,100) id',[token,project,grant.executionEpoch,randomUUID(),approval.model])).rows[0].id;
   const pendingLinked=(await db.query('select legacy_mission_call_id id from benchmark_budget_calls where id=$1',[pendingCall])).rows[0].id;
   await db.query('reset role');
   if(boundary==='expired')await db.query("update project_worker_contracts set deadline=now()-interval '1 second' where worker_id=$1",[(milestone?view:engine).id]);
   else await db.query('update project_worker_contracts set token_limit=1 where worker_id=$1',[(milestone?view:engine).id]);
   await db.query('set role service_role');
   await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[pendingLinked,'late-'+pendingCall,{input_tokens:3,output_tokens:2,total_tokens:5}]);
   assert.equal((await db.query('select actual_tokens from mission_calls where id=$1',[pendingLinked])).rows[0].actual_tokens,5,'Actual supplier charges survive '+boundary);
   assert.equal((await db.query('select state from benchmark_budget_calls where id=$1',[pendingCall])).rows[0].state,'settled');
   await db.query('rollback');
  }
  // Admission is cumulative across attempts and transactionally preserves the
  // existing reservation when package money is narrower than the project cap.
  await db.query('begin');await db.query('reset role');
  await db.query('update project_work_packages set ceiling_microusd=1 where id=$1',[(await packages())[milestone].id]);await db.query('set role service_role');
  await assert.rejects(db.query('select developer_native_reserve($1,$2,$3,$4,$5,100)',[token,project,grant.executionEpoch,randomUUID(),approval.model]),/package authority/);
  await db.query('rollback');
  await db.query('begin');await db.query('reset role');
  const capPackage=(await packages())[milestone];
  await db.query('update project_work_packages set ceiling_microusd=1 where id=$1',[capPackage.id]);
  await db.query('update mission_calls set actual_tokens=actual_tokens where id=$1',[linked]);
  assert.equal((await packages())[milestone].status,'review','Actual settlement overrun prevents acceptance');
  assert.ok((await db.query("select count(*)::int n from project_organization_exceptions where owner_id=$1 and reason='resources'",[manager.id])).rows[0].n);
  assert.equal((await db.query('select actual_tokens from mission_calls where id=$1',[linked])).rows[0].actual_tokens,5,'Actual charge preserved');
  await db.query('rollback');
  // A real deterministic coding fixture writes source in a local isolated clone.
  git('checkout','--detach','-q',previousHead);
  if(!milestone){file('app/pilot/engine/sum.mjs',`export const sum=(a,b)=>a${deficient?'-':'+'}b;\n`);file('app/pilot/engine/sum.test.mjs',"import assert from 'node:assert/strict';import {sum} from './sum.mjs';assert.equal(sum(2,3),5);\n");}
  else{file('app/pilot/view/render.mjs',"import {sum} from '../engine/sum.mjs';export const render=()=>'<p id=\"state\">'+sum(2,3)+'</p>';\n");file('app/pilot/view/render.test.mjs',"import assert from 'node:assert/strict';import {render} from './render.mjs';assert.equal(render(),'<p id=\"state\">5</p>');\n");}
  const context={...run.binding};delete context.scopeHash;
  const request=join(root,'request');writeFileSync(request,projectMarker(context));
  // The existing checkpoint implementation writes an immutable remote Git tag.
  const checkpoint=createNativeWipCheckpointer({workspace,tempRoot:root,toolsRoot:resolve('scripts'),requestFile:request,context,identity:{projectId:project,taskId:job.id,runId:String(accounts.length),runAttempt:'1',approvedScopeHash:scope,grantId:grant.grantId,executionEpoch:grant.executionEpoch},expectedHead:()=>previousHead}).save({phase:'implementation'});
  assert.ok(checkpoint.checkpointSha);assert.equal(git('ls-remote','--refs','origin',checkpoint.ref).split(/\s/)[0],checkpoint.checkpointSha);
  git('add','app');assertProjectScope(request,workspace);git('commit','-qm','Deterministic package '+milestone);const head=git('rev-parse','HEAD');git('push','-q','origin','HEAD:refs/heads/candidate-'+accounts.length);
  const testPath=milestone?'app/pilot/view/render.test.mjs':'app/pilot/engine/sum.test.mjs';
  const check=spawnSync(process.execPath,['--test',testPath],{cwd:workspace,encoding:'utf8',env:{PATH:process.env.PATH},timeout:15000});assert.equal(check.status,deficient?1:0,check.stderr);
  const html=execFileSync(process.execPath,['--input-type=module','-e',milestone?"import {render} from './app/pilot/view/render.mjs';console.log(render())":"import {sum} from './app/pilot/engine/sum.mjs';console.log('<p id=\"state\">'+sum(2,3)+'</p>')"],{cwd:workspace,encoding:'utf8',env:{PATH:process.env.PATH}}).trim();
  const app=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(html);});
  await new Promise(done=>app.listen(0,'127.0.0.1',done));let browserChecks;
  try{browserChecks=await runScenarios(contract,'http://127.0.0.1:'+app.address().port,{timeout:4000});assert.equal(browserChecks.every(c=>c.passed),!deficient);}
  finally{await new Promise(done=>app.close(done));}
  const result={output:'Real source/test result from deterministic model fixture',verification:{testedHeadSha:head,reviewedHeadSha:head,observedHeadSha:head,changedFiles:assertProjectScope(request,workspace,true).map(path=>({path})),packageDelta:{baseSha:previousHead,headSha:head,changedFiles:git('diff','--name-only',previousHead,head).split('\n').map(path=>({path}))},projectAcceptance:{version:1,projectId:project,contractHash:run.binding.contractHash,headSha:head,passed:browserChecks.every(c=>c.passed),checks:browserChecks},localTest:{command:['node','--test',testPath],exitCode:check.status,stdout:check.stdout},checkpoint}};
  await db.query("update mission_assignments set status='completed',result=$2,lease=null,lease_until=null where id=$1",[job.id,result]);
  await db.query("update mission_assignments set status='completed',result=$2 where mission_id=$1 and role in ('compose','review')",[mission,{output:'Deterministic review of real test output',head,passed:!deficient}]);
  await db.query("update agent_missions set status='completed',result='Deterministic review completed' where id=$1",[mission]);
  await assert.rejects(db.query("select finish_work_project($1,$2,'advance',$3)",[project,await leaseProject(),{head}]),/director acceptance/);
  s=await session();assert.equal(s.node.id,manager.id);assert.equal((await rows()).find(n=>n.id===rootNode.id).decision_needed,false,'Local failures never wake Project Director');
  const wp=(await packages())[milestone];
  await assert.rejects(decide(s,[{action:'evaluate_package',packageId:wp.id,assignmentId:randomUUID(),accepted:true,checks:[]}]),/attempt evidence/);
  if(deficient){
   await assert.rejects(decide(s,[{action:'evaluate_package',packageId:wp.id,assignmentId:job.id,accepted:true,checks:[]}]),/original package acceptance/);
   await decide(s,[{action:'evaluate_package',packageId:wp.id,assignmentId:job.id,accepted:false,findings:['sum(2,3) produced -1; preserve the contract and correct addition']},{action:'repair_package',packageId:wp.id}]);
  }else{
   await decide(s,[{action:'evaluate_package',packageId:wp.id,assignmentId:job.id,accepted:true,checks:wp.contract.acceptance.map(criterion=>({criterion,passed:true,assignmentId:job.id,evaluation:'Real Node test on exact immutable head '+head}))}]);
   await db.query("select finish_work_project($1,$2,'advance',$3)",[project,await leaseProject(),{head,taskId:job.id,verification:result.verification}]);
   previousHead=head;acceptedJobs.push(job.id);
   // Certify each accepted worker against its own contract; retained across B.
   await wake(manager);s=await session();const worker=milestone?view:engine;
   await decide(s,[{action:'certify',nodeId:worker.id,assignmentId:job.id,checks:worker.acceptance.map(criterion=>({criterion,passed:true,assignmentId:job.id,evaluation:'Reviewed original package plus actual test output'}))}]);
   if(milestone===0){
    const before=JSON.stringify({nodes:await rows(),packages:await packages(),calls:(await db.query('select * from benchmark_budget_calls where account_id=any($1) order by id',[accounts])).rows});
    // Discard the runner; restore exact accepted source from durable Git.
    rmSync(workspace,{recursive:true,force:true});workspace=join(root,'restarted-worker');gitAt(root,'clone','-q',remote,workspace);git('checkout','--detach','-q',head);git('config','user.name','Restarted worker');git('config','user.email','fixture@example.test');
    const after=JSON.stringify({nodes:(await rival.query('select * from project_organization_nodes where project_id=$1',[project])).rows,packages:(await rival.query('select * from project_work_packages where project_id=$1 order by milestone_index',[project])).rows,calls:(await rival.query('select * from benchmark_budget_calls where account_id=any($1) order by id',[accounts])).rows});assert.equal(after,before,'Independent DB session and runner restart preserve accepted ownership and charges');
    assert.equal(readFileSync(join(workspace,'app/pilot/engine/sum.mjs'),'utf8'),'export const sum=(a,b)=>a+b;\n');
   }
  }
 }
 // Independent QA executes the original browser contract, not package reports.
 let seeded=true;
 const render=execFileSync(process.execPath,['--input-type=module','-e',"import {render} from './app/pilot/view/render.mjs';console.log(render())"],{cwd:workspace,encoding:'utf8',env:{PATH:process.env.PATH}}).trim();
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(seeded?render.replace('>5<','>4<'):render);});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 let failed,passed;
 try{const origin='http://127.0.0.1:'+server.address().port;failed=await runScenarios(contract,origin,{timeout:8000});assert.equal(failed[0].passed,false);seeded=false;passed=await runScenarios(contract,origin,{timeout:8000});assert.equal(passed[0].passed,true);}
 finally{await new Promise(done=>server.close(done));}
 assert.equal(new Set(accounts).size,3);
 assert.equal((await db.query("select count(*)::int n from project_events where project_id=$1 and event='organization_financial_authority'",[project])).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from project_organization_native_delegations where project_id=$1',[project])).rows[0].n,3);
 assert.equal((await packages()).filter(w=>w.status==='accepted').length,2);
 assert.equal((await db.query('select count(*)::int n from project_organization_decisions where node_id=$1',[rootNode.id])).rows[0].n,2,'Root made only strategy and scope delegation decisions during implementation');
 // Completion still flows through director certification and separate superior
 // acceptance. Real QA results are delivered by its own appointed worker.
 const checks=(node,id)=>node.acceptance.map(criterion=>({criterion,passed:true,assignmentId:id,evaluation:'Compared actual component artifacts and immutable test evidence with this original criterion'}));
 const finishOrganization=async director=>{
  await wake(director);let turn=await session();assert.equal(turn.node.id,director.id);
  const children=(await rows()).filter(n=>n.parent_id===director.id);
  const commands=[];
  for(const child of children.filter(n=>n.status!=='accepted')){
   const source=(await db.query("select j.id from mission_assignments j join project_organization_assignments b on b.assignment_id=j.id join agent_missions m on m.id=j.mission_id where b.node_id=$1 and j.status='completed' and m.status='completed' order by j.created_at desc limit 1",[child.id])).rows[0];
   assert.ok(source,'Completed worker evidence '+child.name);
   commands.push({action:'certify',nodeId:child.id,assignmentId:source.id,checks:checks(child,source.id)});
  }
  const source=acceptedJobs.at(-1);
  commands.push({action:'submit_component',assignmentId:source,checks:checks(director,source)});
  await decide(turn,commands);
 };
 await finishOrganization(manager);
 const development=byName('Development');
 s=await session();assert.equal(s.node.id,workstream.id);
 await decide(s,[{action:'certify',nodeId:manager.id,assignmentId:acceptedJobs.at(-1),checks:checks(manager,acceptedJobs.at(-1))},{action:'submit_component',assignmentId:acceptedJobs.at(-1),checks:checks(workstream,acceptedJobs.at(-1))}]);
 s=await session();assert.equal(s.node.id,development.id);
 await decide(s,[{action:'certify',nodeId:workstream.id,assignmentId:acceptedJobs.at(-1),checks:checks(workstream,acceptedJobs.at(-1))},{action:'submit_component',assignmentId:acceptedJobs.at(-1),checks:checks(development,acceptedJobs.at(-1))}]);
 s=await session();assert.equal(s.node.id,rootNode.id);
 await decide(s,[{action:'certify',nodeId:development.id,assignmentId:acceptedJobs.at(-1),checks:checks(development,acceptedJobs.at(-1))}]);
 for(const name of ['Architecture','QA']){
  const director=byName(name),worker=byName(name+' worker');
  for(const bad of name==='QA'?[true,false]:[false]){
   await wake(director);s=await session();assert.equal(s.node.id,director.id);
   await decide(s,[{action:'assign',nodeId:worker.id,capability:'analysis',smart:task(director,'work',[],{maxAssignments:1})}]);
   const work=await session();assert.equal(work.node.id,worker.id);
   const evidence=name==='QA'?{head:previousHead,checks:bad?failed:passed,passed:!bad}:{head:previousHead,interface:readFileSync(join(workspace,'app/pilot/engine/sum.mjs'),'utf8'),passed:true};
   await db.query('select project_org_finish_work($1,$2,$3)',[work.job,work.lease,{text:JSON.stringify(evidence),...evidence}]);
   await schedule(); // Restore the controller mission and wake the local manager.
   s=await session();assert.equal(s.node.id,director.id);
   if(bad){
    await decide(s,[{action:'reject',nodeId:worker.id,findings:'Seeded integration returned 4; original approved criterion requires 5'}]);
    assert.equal((await rows()).find(n=>n.id===rootNode.id).decision_needed,false);
    continue;
   }
   // Resolve the local seeded QA failure using the corrected real report.
   const exceptions=(await db.query("select * from project_organization_exceptions where owner_id=$1 and status='open'",[director.id])).rows;
   await decide(s,[...exceptions.map(e=>({action:'resolve',exceptionId:e.id,assignmentId:work.job,evidence:'Repeated original browser contract against corrected integrated source'})),{action:'certify',nodeId:worker.id,assignmentId:work.job,checks:checks(worker,work.job)},{action:'submit_component',assignmentId:work.job,checks:checks(director,work.job)}]);
   const submission=(await rows()).find(n=>n.id===director.id);assert.ok(submission.completion_submission);assert.equal(submission.status,'active','Director cannot accept itself');
   s=await session();assert.equal(s.node.id,rootNode.id);
   await decide(s,[{action:'certify',nodeId:director.id,assignmentId:work.job,checks:checks(director,work.job)}]);
  }
 }
 assert.ok((await rows()).filter(n=>n.parent_id).every(n=>n.status==='accepted'));
 // Unpackaged research/specification/assessment/revision jobs have the same
 // immediate-manager commissioning route; queued worker suggestions grant no authority.
 for(const phase of ['research','specification','assessment']){
  await db.query('begin');await db.query('reset role');
  const qa=byName('QA'),worker=byName('QA worker'),mid=randomUUID();
  await db.query('select create_mission($1,$2,$3,20,null)',[mid,'Evaluate one approved '+phase+' artifact',[worker.agent_id]]);
  await db.query("update agent_missions set project_id=$2,project_kind=$3,status='running',deadline=$4 where id=$1",[mid,project,phase,deadline]);
  await db.query("update work_projects set active_mission_id=$2 where id=$1",[project,mid]);
  const pending=(await db.query('select id from mission_assignments where mission_id=$1',[mid])).rows[0].id;
  await db.query('set role service_role');
  await db.query('savepoint negative');
  await assert.rejects(db.query("update mission_assignments set payload=payload||'{\"development_input\":\"Forged before claim\"}' where id=$1",[pending]),/metadata requires authenticated/);
  await db.query('rollback to savepoint negative');
  await db.query('savepoint seeded_insert');
  const seededId=(await db.query("insert into mission_assignments(mission_id,job_key,role,agent_id,instruction,payload) values($1,'forged-checkpoint','work',$2,'Suggested worker task','{\"capability\":\"analysis\",\"development_input\":\"Forged input\"}') returning id",[mid,worker.agent_id])).rows[0].id;
  await assert.rejects(db.query("update mission_assignments set status='running',lease=gen_random_uuid() where id=$1",[seededId]),/Preseeded SMART execution metadata/);
  await db.query('rollback to savepoint seeded_insert');
  const turn=await session();assert.equal(turn.node.id,qa.id,'Phase assignment returns to immediate QA director');
  await db.query('savepoint negative');
  await assert.rejects(decide(turn,[{action:'authorize_assignment',assignmentId:pending,smart:{}}]),/SMART contract/);
  await db.query('rollback to savepoint negative');
  await decide(turn,[{action:'authorize_assignment',assignmentId:pending,smart:task(qa,'plan',[],{maxAssignments:1,tokens:5000})}]);
  await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[pending,randomUUID()]);
  assert.equal((await db.query('select count(*)::int n from project_worker_admissions where assignment_id=$1',[pending])).rows[0].n,1);
  await db.query('rollback');
 }
 console.log('SMART_MANAGEMENT_PASS: explicit Manager/Supervisor hierarchy; broad/context/capability negatives; cumulative contracts; authentic prepare/checkpoint RPCs; phase jobs locally commissioned; restart and immutable admissions');
 // Components alone never authorize final project closure or production delivery.
 await wake(rootNode);s=await session();await assert.rejects(decide(s,[{action:'close'}]),/Only the Project Director may authorize closure/);await decide(s,[{action:'ready'}]);
 assert.notEqual((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'completed');
 console.log('PROJECT_ORGANIZATION_NATIVE_DELEGATION_PASS: two real source packages; local rejection/correction; three idempotent native grants; real tests and independent Chromium seeded failure; runner restart; one original owner envelope');
 }finally{rmSync(root,{recursive:true,force:true});}
}
