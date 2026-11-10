import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

export async function assertProviderControlledGameTrial(db,rival){
 await db.query('reset role');
 const financial=async()=> (await db.query(`select
  (select count(*)::int from project_organization_authority) authorities,
  (select count(*)::int from mission_calls) mission_calls,
  (select count(*)::int from benchmark_budget_calls) native_calls,
  (select count(*)::int from benchmark_budget_accounts) accounts,
  (select count(*)::int from benchmark_dollar_exposures) exposures`)).rows[0];
 const original=await financial();
 const [actor,chat,owner,repo]=Array.from({length:4},randomUUID);
 await db.query("insert into actors(id,name,actor_kind) values($1,'Trial owner fixture','standard')",[actor]);
 await db.query("insert into chats(id,actor_id,title) values($1,$2,'Provider-controlled trial fixture')",[chat,actor]);
 await db.query("insert into repo_sync_runs(id,repository_full_name) values($1,'mfackrell/katie')",[repo]);
 await db.query('select standalone_bind_scope($1,$2,$3)',[owner,actor,chat]);
 await db.query('set role service_role');
 const launch=async(o=owner)=>(await db.query('select project_provider_launch($1,$2,$3) p',[o,actor,chat])).rows[0].p;
 await assert.rejects(launch(randomUUID()),/authenticated owner-bound/i);
 const p=await launch(),project=p.id;
 assert.match(p.objective,/tic-tac-toe/i);
 const row=async()=> (await db.query('select * from project_provider_execution where project_id=$1',[project])).rows[0];
 const activation=await row();
 assert.ok(activation.deadline.getTime()<=Date.now()+7200000);
 assert.equal((await launch()).id,project);
 assert.deepEqual(await row(),activation,'activation replay cannot renew');
 await assert.rejects(db.query('select project_provider_enable($1,$2,$3)',[owner,project,activation.objective_hash]),/permission denied/);
 await assert.rejects(db.query('select project_org_authorize($1,$2,$3,10000,1000,true)',[owner,project,activation.objective_hash]),/provider account controls/);
 await assert.rejects(db.query('update project_provider_execution set deadline=now() where project_id=$1',[project]),/permission denied/);
 const leaseProject=async()=>{
  const lease=randomUUID();
  await db.query('reset role');
  await db.query("update work_projects set lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[project,lease]);
  await db.query('set role service_role');return lease;
 };
 const schedule=async()=> (await db.query('select project_org_schedule($1,$2) s',[project,await leaseProject()])).rows[0].s;
 const claim=async mission=>{
  const lease=randomUUID();
  await db.query('reset role');
  const job=(await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where mission_id=$1 and status='queued' returning id",[mission,lease])).rows[0].id;
  await db.query('set role service_role');
  return {job,lease};
 };
 const session=async()=>{
  const s=await schedule();assert.ok(s?.missionId,JSON.stringify(s));
  return {...await claim(s.missionId),node:s.nodeId};
 };
 await db.query('reset role');
 await db.query('alter table model_registry rename to trial_unavailable_model_registry');
 await db.query('set role service_role');
 const root=await session();
 const requestSql='select project_provider_request($1,$2,$3,$4,$5,$6,$7) ok';
 const attempt=(job,execution,id,operation='inference',hash='d'.repeat(64),scope=null,receipt=null)=>
  [job,execution,id,operation,hash,scope,receipt];
 const request=async(c,args)=>(await c.query(requestSql,args)).rows[0].ok;
 const firstRequests=Array.from({length:2},()=>attempt(root.job,root.lease,randomUUID()));
 const race=await Promise.all([db,rival].map((c,i)=>request(c,firstRequests[i])));
 assert.equal(race.filter(Boolean).length,1,'Only one concurrent provider request is admitted');
 const winner=firstRequests[race.indexOf(true)];
 assert.equal(await request(rival,[...winner.slice(0,6),'confirmed-response'].map((v,i)=>i===1?randomUUID():v)),false,'Wrong worker lease cannot clear the fence');
 assert.equal(await request(rival,attempt(root.job,root.lease,randomUUID(),'model-list')),false,'Other operations cannot overlap');
 assert.equal(await request(db,[...winner.slice(0,6),'response-max-output']),true,'Definitive bounded response clears the fence');
 assert.equal(await request(db,attempt(root.job,root.lease,randomUUID())),false,'Resolved request cannot replay in the same execution attempt');
 assert.equal(await request(db,attempt(root.job,randomUUID(),randomUUID())),false);
 await assert.rejects(db.query('delete from project_provider_requests'),/permission denied/);
 assert.deepEqual(await financial(),original,'provider admission records no financial authorization or reservation');
 const decide=(s,commands)=>db.query('select project_org_decide($1,$2,$3)',[s.job,s.lease,JSON.stringify(commands)]);
 await assert.rejects(decide(root,[{action:'appoint',kind:'worker'}]),/invalid|director|appointment/i);
 await assert.rejects(decide(root,[{action:'close'}]),/incomplete|QA|closure/i);
 // Exercise the existing production write path on a separate transaction, then
 // roll back so the rest of this fixture still proves the authorized lifecycle.
 const rejection={code:'immediate_reporting_authority',reason:'Management decisions require immediate reporting authority',
  position:3,action:'dependency',targets:[{field:'nodeId',status:'missing'}],priorAppointments:1};
 const terminal='select commit_mission_work($1,$2,$3,$4,$5,$6,$7) ok';
 await db.query('begin');
 try{
  const args=[root.job,root.lease,{detail:rejection.reason,managementCommandRejection:rejection},'[]','failed','blocked',null];
  assert.equal((await db.query(terminal,[args[0],randomUUID(),...args.slice(2)])).rows[0].ok,false);
  assert.equal((await db.query(terminal,args)).rows[0].ok,true);
  const record=(await db.query('select status,result from mission_assignments where id=$1',[root.job])).rows[0];
  assert.equal(record.status,'failed');assert.deepEqual(record.result.managementCommandRejection,rejection);
  assert.equal((await db.query(terminal,args)).rows[0].ok,false,'Committed failure cannot be replayed with a consumed lease');
 }finally{await db.query('rollback');}
 const deadline=new Date(activation.deadline.getTime()-1000).toISOString();
 await decide(root,[{action:'plan',purpose:'Deliver the scoped game',direction:'Commission implementation and independent QA',outcomes:[{criterion:'Playable game',verification:'Browser and rules checks'}],milestones:[{objective:'Playable game'}],organizations:['development','quality_assurance']},
  ...['development','quality_assurance'].map(area=>({action:'appoint',kind:'manager',name:area,area,objective:'Own '+area,
   acceptance:['Reviewed result'],tokens:1,deadline,paths:[],tools:area==='development'?['manage','analysis','development']:['manage','analysis']})),
  {action:'ready'}]);
 const contract={path:'/milestone-3-tic-tac-toe',scenarios:[{name:'Board starts empty',steps:[{action:'expectText',selector:'#state',value:'X'}]}]};
 const spec={name:'Tic-tac-toe trial fixture',summary:'Scoped game',requirements:['Board starts empty'],
  allowedPaths:['app/milestone-3-tic-tac-toe/'],milestones:[{title:'Game',instruction:'Build the scoped game',contract}],finalContract:contract};
 const scope='a'.repeat(64),base='b'.repeat(40);
 const propose=async candidate=>db.query("update work_projects set status='awaiting_approval',phase='approval',spec=$2,approval_hash=$3,baseline_sha=$4,repository_full_name='mfackrell/katie',active_mission_id=null where id=$1",[project,candidate,scope,base]);
 await assert.rejects(propose({...spec,allowedPaths:['app/']}),/isolated tic-tac-toe paths/);
 await propose(spec);
 await assert.rejects(db.query("select control_work_project($1,$2,$3,'approve',p_hash=>$4)",[project,actor,chat,scope]),/immutable/);
 await assert.rejects(db.query('select project_provider_approve_scope($1,$2,$3)',[randomUUID(),project,scope]),/authenticated owner/);
 await db.query('select project_provider_approve_scope($1,$2,$3)',[owner,project,scope]);
 assert.equal((await row()).approved_scope,scope);
 await assert.rejects(db.query("update work_projects set deadline=deadline+interval '1 second' where id=$1",[project]),/immutable/);
 await assert.rejects(db.query("update work_projects set status='completed' where id=$1",[project]),/closure|Director|Final assessment/i);
 const nodes=async()=> (await db.query('select * from project_organization_nodes where project_id=$1',[project])).rows;
 const activate=async node=>{
  await db.query('reset role');
  await db.query("update project_organization_nodes set decision_needed=(id=$2) where project_id=$1",[project,node.id]);
  await db.query('set role service_role');
  const next=await session();assert.equal(next.node,node.id);return next;
 };
 const director=(await nodes()).find(n=>n.kind==='project_director');
 const functional=(await nodes()).find(n=>n.area==='development');
 const paths=spec.allowedPaths;
 await decide(await activate(director),[{action:'grant_scope',nodeId:functional.id,paths}]);
 const roles=[['Coder',['analysis','development']],['Writer',['analysis']],['Reviewer',['analysis']]];
 await decide(await activate(functional),roles.map(([name,tools])=>({
  action:'appoint',kind:'worker',name,area:'development',objective:'Deliver '+name,acceptance:['Reviewed result'],
  tools,tokens:1,deadline,paths:[],
 })));
 const workers=(await nodes()).filter(n=>n.parent_id===functional.id);
 await decide(await activate(functional),workers.map(n=>({action:'grant_scope',nodeId:n.id,paths})));
 const files=['app/milestone-3-tic-tac-toe/page.tsx'];
 const smart=(role,paths)=>({objective:role+' bounded output',deliverable:role+' evidence',instruction:'Complete only '+role+' within the assigned scope.',
  parentObjective:functional.objective,capability:'analysis',acceptance:[{criterion:'Browser contract passes',evidence:'Verified output'}],
  inventory:[{item:'Approved game specification',contextChars:1000}],
  estimate:{basis:'declared_inventory',rationale:'Single deliverable',uncertainty:'Bounded verification required',tokens:1000,seconds:30},
  tokens:2000,maxAssignments:2,deadline,paths});
 const [coder,writer,reviewer]=roles.map(([name])=>workers.find(n=>n.name===name));
 const manager=await activate(functional);
 await decide(manager,[{action:'commission_package',workerId:coder.id,writerId:writer.id,reviewerId:reviewer.id,
  milestoneIndex:0,objective:'Build tic-tac-toe',deliverables:['Playable game'],interfaces:[],dependencies:[],
  acceptance:['Browser contract passes'],paths,deadline,maxAttempts:2,
  tasks:{development:smart('development',files),compose:smart('compose',[]),review:smart('review',[])}}]);
 const wp=(await db.query('select * from project_work_packages where project_id=$1',[project])).rows[0];
 assert.equal(wp.token_limit,null);
 assert.equal(wp.ceiling_microusd,null);
 await db.query("select finish_work_project($1,$2,'child',$3)",[project,await leaseProject(),{kind:'development',objective:'Implement approved game',evidence:{fixture:true}}]);
 const mid=(await db.query('select active_mission_id from work_projects where id=$1',[project])).rows[0].active_mission_id;
 const job=(await db.query("select * from mission_assignments where mission_id=$1 and role='development'",[mid])).rows[0];
 const agent=(await db.query('select * from managed_agents where id=$1',[coder.agent_id])).rows[0];
 const lease=randomUUID(),taskChat=randomUUID();
 await db.query("insert into chats(id,actor_id,title) values($1,$2,'Trial worker fixture')",[taskChat,agent.actor_id]);
 await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[job.id,lease]);
 const prepared=(await db.query('select prepare_mission_development($1,$2) input',[job.id,lease])).rows[0].input;
 await db.query("insert into agent_tasks(id,agent_id,actor_id,chat_id,snapshot,definition_version,kind,initial_input,input,repository_id,repository_full_name,request_id,status,external) values($1::uuid,$2,$3,$4,$5,$6,'development',$8,$8,$7,'mfackrell/katie',$1::text,'dispatching','{}')",[job.id,agent.id,agent.actor_id,taskChat,agent.config,agent.version,p.repository_id,prepared]);
 assert.equal((await db.query('select claim_project_dispatch($1,$2,$3) ok',[job.id,lease,'0'.repeat(64)])).rows[0].ok,false);
 const claims=await Promise.all([db,rival].map(c=>c.query('select claim_project_dispatch($1,$2,$3) ok',[job.id,lease,scope])));
 assert.equal(claims.filter(r=>r.rows[0].ok).length,1);
 const runs=await Promise.all([db,rival].map((c,i)=>c.query('select project_provider_dispatch_start($1,$2,$3) ok',[job.id,scope,String(i+1)])));
 assert.equal(runs.filter(r=>r.rows[0].ok).length,1);
 const run=String(runs.findIndex(r=>r.rows[0].ok)+1);
 assert.equal((await db.query('select project_provider_dispatch_start($1,$2,$3) ok',[job.id,scope,run])).rows[0].ok,false);
 assert.deepEqual(await financial(),original,'Coding dispatch did not reserve funds or issue a spending grant');
 const count=attempt(job.id,run,randomUUID(),'input-count','e'.repeat(64),scope);
 assert.equal(await request(db,count),true);
 assert.equal(await request(rival,[...count.slice(0,6),'input-token-count']),true);
 const native=attempt(job.id,run,randomUUID(),'inference','e'.repeat(64),scope);
 assert.equal(await request(db,native),true,'Confirmed preflight permits the original native request');
 await db.query('begin');
 assert.equal((await db.query('select project_provider_dispatch_stop($1,$2,$3) ok',[job.id,scope,run])).rows[0].ok,true);
 await db.query('rollback');
 assert.equal(await request(rival,attempt(job.id,run,randomUUID(),'inference','f'.repeat(64),scope)),false,'Rolled-back stop cannot reopen the native runner');
 assert.equal(await request(rival,[...native.slice(0,6),'native-confirmed'].map((v,i)=>i===1?'999':v)),false,'Another run cannot resolve the original attempt');
 assert.equal(await request(db,[...native.slice(0,6),'native-confirmed']),true);
 const lost=attempt(job.id,run,randomUUID(),'inference','f'.repeat(64),scope);
 const workerConnection=new pg.Client({host:rival.host,port:rival.port,user:rival.user,database:rival.database});
 await workerConnection.connect();
 try{
  await workerConnection.query('set role service_role');
  assert.equal(await request(workerConnection,lost),true);
 }finally{await workerConnection.end();}
 // The admitting connection disappeared without a receipt. The same committed
 // pending state covers loss before send, during transport, or before confirmation.
 await db.query("update mission_assignments set lease_until=now()-interval '1 second' where id=$1",[job.id]);
 assert.equal(await request(rival,lost),false,'Another connection cannot replay the abandoned request after lease expiry');
 assert.equal(await request(rival,attempt(job.id,run,randomUUID(),'input-count','a'.repeat(64),scope)),false);
 const binding=(await db.query('select binding from project_runs where mission_id=$1',[mid])).rows[0].binding;
 const head='c'.repeat(40);
 await db.query("update mission_assignments set status='completed',result=$2 where id=$1",[job.id,{verification:{
  testedHeadSha:head,reviewedHeadSha:head,observedHeadSha:head,
  projectAcceptance:{projectId:project,contractHash:binding.contractHash,headSha:head,passed:false,checks:[]},
  packageDelta:{baseSha:base,headSha:head,changedFiles:files.map(path=>({path}))}
 }}]);
 await db.query("update agent_missions set status='completed' where id=$1",[mid]);
 const evaluator=await session();
 assert.equal(evaluator.node,functional.id);
 assert.equal(await request(rival,attempt(evaluator.job,evaluator.lease,randomUUID())),false,'A newly scheduled manager cannot bypass an unresolved native call');
 await db.query('reset role');
 const pending=(await db.query('select id,project_id,mission_id,assignment_id,worker_id,execution_attempt,request_hash,resolved_at from project_provider_requests where resolved_at is null')).rows;
 assert.deepEqual(pending,[{id:lost[2],project_id:project,mission_id:mid,assignment_id:job.id,worker_id:agent.id,execution_attempt:run,request_hash:lost[4],resolved_at:null}]);
 await db.query('set role service_role');
 await assert.rejects(decide(evaluator,[{action:'evaluate_package',packageId:wp.id,assignmentId:job.id,accepted:true,
  checks:[{criterion:'Browser contract passes',passed:true,assignmentId:job.id,evaluation:'Forged pass'}]}]),/Verified original package acceptance required/);
 await decide(evaluator,[{action:'evaluate_package',packageId:wp.id,assignmentId:job.id,accepted:false,
  findings:['Independent browser criteria failed']},{action:'repair_package',packageId:wp.id}]);
 await schedule();
 await db.query("select finish_work_project($1,$2,'child',$3)",[project,await leaseProject(),{kind:'development',objective:'Repair the scoped game',evidence:{fixture:true}}]);
 const replacementMission=(await db.query('select active_mission_id from work_projects where id=$1',[project])).rows[0].active_mission_id;
 assert.notEqual(replacementMission,mid);
 const replacementLease=randomUUID();
 const replacementJob=(await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where mission_id=$1 and role='development' returning id",[replacementMission,replacementLease])).rows[0].id;
 const replacement={job:replacementJob,lease:replacementLease};
 const replacementChat=randomUUID();
 await db.query("insert into chats(id,actor_id,title) values($1,$2,'Trial replacement worker fixture')",[replacementChat,agent.actor_id]);
 const replacementInput=(await db.query('select prepare_mission_development($1,$2) input',[replacement.job,replacement.lease])).rows[0].input;
 await db.query("insert into agent_tasks(id,agent_id,actor_id,chat_id,snapshot,definition_version,kind,initial_input,input,repository_id,repository_full_name,request_id,status,external) values($1::uuid,$2,$3,$4,$5,$6,'development',$8,$8,$7,'mfackrell/katie',$1::text,'dispatching','{}')",[replacement.job,agent.id,agent.actor_id,replacementChat,agent.config,agent.version,p.repository_id,replacementInput]);
 assert.equal((await db.query('select project_provider_dispatch_live($1,$2) ok',[replacement.job,scope])).rows[0].ok,true,'Replacement otherwise has valid scope and SMART authority');
 assert.equal((await db.query('select claim_project_dispatch($1,$2,$3) ok',[replacement.job,replacement.lease,scope])).rows[0].ok,false,'Unresolved original request blocks a valid replacement before external dispatch');
 assert.equal(await request(rival,attempt(replacement.job,randomUUID(),randomUUID())),false);
 assert.deepEqual(await financial(),original);
 assert.equal(p.organization_version,1);
 await db.query('reset role');
 await db.query('alter table trial_unavailable_model_registry rename to model_registry');
 await db.query('set role service_role');
 console.log('PROVIDER_CONTROLLED_TRIAL_POSTGRES_PASS');
}
