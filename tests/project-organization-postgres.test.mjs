import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
const migration='supabase/migrations/20261109172739_project_management_hierarchy.sql';
test('durable organization: real PostgreSQL hierarchy, authority, concurrency and restart',{timeout:120000},async()=>{
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin',root=mkdtempSync(join(tmpdir(),'katie-org-')),clients=[];let started=false;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,(r.stderr||r.error?.message)+(existsSync(join(root,'log'))?readFileSync(join(root,'log'),'utf8'):''));};
 const connect=async()=>{const c=new pg.Client({host:process.env.KATIE_TEST_PG_TCP==='1'?'127.0.0.1':root,port:55479,user:'postgres',database:'postgres'});await c.connect();const query=c.query.bind(c);c.query=(sql,args)=>query(sql,sql.includes('project_org_decide')&&args?[args[0],args[1],JSON.stringify(args[2])]:args);clients.push(c);return c;};
 try{
 run('initdb',['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8']);run('pg_ctl',['-D',join(root,'data'),'-l',join(root,'log'),'-o',process.env.KATIE_TEST_PG_TCP==='1'?"-h 127.0.0.1 -k '' -p 55479":`-h '' -k ${root} -p 55479`,'-w','start']);started=true;
 const db=await connect();await db.query(readFileSync('tests/fixtures/project-base.sql','utf8'));
 for(const f of ['20261016211426_agent_management.sql','20261016234048_autonomous_missions.sql','20261017141136_chat_projects.sql','20261018185909_project_phase_budgets.sql','20261022093000_separate_project_resource_estimates.sql'])await db.query(readFileSync('supabase/migrations/'+f,'utf8'));
 await db.query(readFileSync('supabase/migrations/202604030001_model_registry.sql','utf8'));
 // Minimal canonical ledger schemas: trigger behavior is real; full production
 // ledger fixtures run separately in the existing project/financial suites.
 await db.query(`create table benchmark_budget_accounts(id uuid primary key,developer_project_id uuid,developer_task_id uuid);
 create table benchmark_budget_calls(id uuid primary key,account_id uuid,legacy_mission_call_id uuid,reserved_tokens bigint,actual_tokens bigint,state text);
 create table benchmark_dollar_exposures(call_id uuid primary key,account_id uuid,exposure_microusd numeric);
 alter table actors add column actor_kind text;
 create table standalone_owner_bindings(owner_id uuid,actor_id uuid,chat_id uuid,revoked_at timestamptz);`);
 const ownerSql=readFileSync('supabase/migrations/20261029153000_standalone_deleted_scope_history.sql','utf8');
 const start=ownerSql.indexOf('create or replace function public.standalone_verify_scope');
 await db.query(ownerSql.slice(start,ownerSql.indexOf('$$;',start)+3));
 await db.query(readFileSync(migration,'utf8'));
 const actor=randomUUID(),chat=randomUUID(),project=randomUUID(),owner=randomUUID();
 await db.query('insert into actors(id,name) values($1,$2)',[actor,'Synthetic owner']);await db.query('insert into chats(id,actor_id,title) values($1,$2,$3)',[chat,actor,'Synthetic hierarchy']);
 await db.query('set role service_role');
 await db.query('select create_work_project($1,$2,$3,$4,$5,null)',[project,'org-'+project,actor,chat,'Build an inventory application with independent quality assurance']);
 const nodes=async()=> (await db.query('select * from project_organization_nodes where project_id=$1 order by depth,created_at,id',[project])).rows;
 const rootNode=(await nodes())[0];assert.equal(rootNode.kind,'project_director');assert.equal((await nodes()).length,1);
 await assert.rejects(db.query("update project_organization_nodes set kind='worker' where id=$1",[rootNode.id]),/permission denied/);
 await assert.rejects(db.query('select project_org_assert_execution($1)',[rootNode.agent_id]),/cannot execute/);
 await assert.rejects(db.query("select create_agent_task($1,$2,'Write some code','general',null)",[randomUUID(),rootNode.agent_id]),/cannot create execution/);
 await db.query('reset role');await assert.rejects(db.query("update managed_agents set config=jsonb_set(config,'{development}','true') where id=$1",[rootNode.agent_id]),/cannot be reconfigured/);
 await db.query('insert into standalone_owner_bindings values($1,$2,$3,null)',[owner,actor,chat]);
 const hash=(await db.query("select encode(sha256(convert_to(objective||clarifications,'UTF8')),'hex') h from work_projects where id=$1",[project])).rows[0].h;
 await db.query('set role service_role');
 await assert.rejects(db.query('select project_org_authorize($1,$2,$3,1000000,100000)',[randomUUID(),project,hash]),/owner-approved/);
 await db.query('select project_org_authorize($1,$2,$3,1000000,100000)',[owner,project,hash]);
 const management=async()=>{
 const p=(await db.query('select claim_work_project() p')).rows[0].p;assert.equal(p.id,project);
 const result=(await db.query('select project_org_schedule($1,$2) r',[project,p.lease])).rows[0].r;assert.ok(result.missionId,JSON.stringify(result));
 const work=(await db.query('select claim_mission_work() c')).rows[0].c;assert.equal(work.mission.id,result.missionId);return work;
 };
 const deadline=new Date(Date.now()+3600000).toISOString();
 const cmd=(name,tokens=100000,kind='manager',extra={})=>({action:'appoint',kind,name,area:name.toLowerCase(),objective:'Complete '+name,acceptance:['Verified '+name+' deliverable'],tokens,deadline,tools:['manage','analysis','development'],paths:[],...extra});
 let work=await management();
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,randomUUID(),[{action:'ready'}]]),/Live management/);
 await db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'plan',purpose:'Deliver the owner inventory outcome',direction:'Delegate design, implementation and independent QA',outcomes:[{criterion:'All inventory scenarios pass',verification:'Independent browser tests'}],milestones:[{objective:'Integrated inventory accepted'}],organizations:['research','development','quality_assurance']},cmd('Research'),cmd('Development'),cmd('QA',100000,'manager',{area:'quality_assurance',tools:['manage','analysis']}),{action:'ready'}]]);
 assert.equal((await nodes()).filter(n=>n.parent_id===rootNode.id).length,3);
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[cmd('Duplicate')]]),/Live management/);
 // Restart connection and reclaim: persistent organization ownership is unchanged.
 const restarted=await connect();await restarted.query('set role service_role');assert.equal((await restarted.query('select agent_id from project_organization_nodes where id=$1',[rootNode.id])).rows[0].agent_id,rootNode.agent_id);
 await db.query('reset role');await db.query('update work_projects set lease_until=now()-interval \'1 second\' where id=$1',[project]);await db.query('set role service_role');
 work=await management();
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[cmd('Too large',200000)]]),/resources exceed/);
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[cmd('Tool escape',10000,'worker',{tools:['production_deploy']})]]),/authority exceeds/);
 const rival=await connect();await rival.query('set role service_role');
 const race=await Promise.allSettled([db,rival].map(async c=>c.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[cmd('Submanager',80000,'manager',{tools:(await nodes()).find(n=>n.agent_id===work.job.agent_id).tools})]])));
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1,'One fenced decision wins concurrent replay');
 assert.equal((await nodes()).filter(n=>n.depth===2).length,1);
 await db.query('reset role');await db.query('update work_projects set lease_until=now()-interval \'1 second\' where id=$1',[project]);await db.query('set role service_role');
 work=await management();await db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[cmd('Coder',40000,'worker',{tools:(await nodes()).find(n=>n.agent_id===work.job.agent_id).tools})]]);
 assert.equal((await nodes()).filter(n=>n.depth===3&&n.kind==='worker').length,1);

 // Resume the lowest manager and delegate a real work package through the
 // existing mission queue. Test time advances only leases, never budgets.
 const resetLease=async()=>{await db.query('reset role');await db.query("update work_projects set lease_until=now()-interval '1 second' where id=$1",[project]);await db.query('set role service_role');};
 const coder=(await nodes()).find(n=>n.kind==='worker');
 const submanager=(await nodes()).find(n=>n.id===coder.parent_id);
 await db.query('reset role');await db.query('update project_organization_nodes set decision_needed=true where id=$1',[submanager.id]);await db.query('set role service_role');
 await resetLease();work=await management();assert.equal(work.job.agent_id,submanager.agent_id);
 await db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'assign',nodeId:coder.id,capability:'analysis',instruction:'Design the inventory data contract with measurable acceptance.'},{action:'exception',reason:'routine',detail:'Resolve a local design inconsistency.'}]]);
 const local=(await db.query('select * from project_organization_exceptions where origin_id=$1',[submanager.id])).rows[0];assert.equal(local.owner_id,submanager.id);
 assert.equal((await db.query('select decision_needed from project_organization_nodes where id=$1',[rootNode.id])).rows[0].decision_needed,false,'Routine problem never wakes root');
 // Drain the other functional directors' initial decisions; then worker is admitted.
 for(let i=0;i<2;i++){await resetLease();work=await management();await db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'ready'}]]);}
 await resetLease();work=await management();assert.equal(work.mission.project_kind,'organization_work');assert.equal(work.job.agent_id,coder.agent_id);

 // Actual worker failure is routed to its immediate manager, then repaired
 // through a new bounded work assignment without waking the Project Director.
 await db.query('reset role');
 await db.query("update mission_assignments set status='failed',detail='Synthetic local design failure' where id=$1",[work.job.id]);
 await db.query("update agent_missions set status='blocked' where id=$1",[work.mission.id]);
 const failure=(await db.query('select * from project_organization_exceptions where origin_id=$1',[coder.id])).rows[0];assert.equal(failure.owner_id,submanager.id);
 assert.equal((await db.query('select decision_needed from project_organization_nodes where id=$1',[rootNode.id])).rows[0].decision_needed,false);
 await db.query('set role service_role');await resetLease();const failedClaim=(await db.query('select claim_work_project() p')).rows[0].p;
 await db.query('select project_org_schedule($1,$2)',[project,failedClaim.lease]);
 await resetLease();work=await management();assert.equal(work.job.agent_id,submanager.agent_id);
 await db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'assign',nodeId:coder.id,capability:'analysis',instruction:'Repair the saved local design inconsistency using existing evidence.'}]]);
 await resetLease();work=await management();assert.equal(work.job.agent_id,coder.agent_id);
 const executed=work;
 await assert.rejects(db.query('select project_org_finish_work($1,$2,$3)',[work.job.id,randomUUID(),{text:'Forged work'}]),/Live subordinate/);
 await db.query('select project_org_finish_work($1,$2,$3)',[work.job.id,work.job.lease,{text:'Verified design artifact: item identifier is unique; quantity is a nonnegative integer.'}]);
 await resetLease();let p0=(await db.query('select claim_work_project() p')).rows[0].p;await db.query('select project_org_schedule($1,$2)',[project,p0.lease]);
 await resetLease();work=await management();assert.equal(work.job.agent_id,submanager.agent_id);
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'certify',nodeId:coder.id,assignmentId:randomUUID()}]]),/Authenticated component/);
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'certify',nodeId:coder.id,assignmentId:executed.job.id,checks:[]}]]),/Every original delegated criterion/);
 await db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'resolve',exceptionId:failure.id,assignmentId:executed.job.id,evidence:'Completed local repair'},{action:'resolve',exceptionId:local.id,assignmentId:executed.job.id,evidence:'Completed design assignment '+executed.job.id},{action:'certify',nodeId:coder.id,assignmentId:executed.job.id,checks:coder.acceptance.map(criterion=>({criterion,passed:true,assignmentId:executed.job.id,evaluation:'Verified the actual design artifact against this criterion'}))},{action:'exception',reason:'authority',detail:'Data service credential exceeds this organization authority.'}]]);
 assert.equal((await db.query('select status from project_organization_nodes where id=$1',[coder.id])).rows[0].status,'accepted');
 const escalation=(await db.query("select * from project_organization_exceptions where reason='authority'")).rows[0];assert.equal(escalation.owner_id,submanager.parent_id);assert.notEqual(escalation.owner_id,rootNode.id);
 await resetLease();work=await management();assert.equal(work.job.agent_id,(await nodes()).find(n=>n.id===submanager.parent_id).agent_id);
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'resolve',exceptionId:failure.id,assignmentId:executed.job.id,evidence:'Completed local repair'},{action:'resolve',exceptionId:local.id,assignmentId:executed.job.id,evidence:'Bypass reporting'}]]),/another manager/);
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'close'}]]),/Only the Project Director/);
 const activity=(await db.query("select j.id from mission_assignments j join project_organization_assignments b on b.assignment_id=j.id join agent_missions m on m.id=j.mission_id where b.node_id=$1 and m.project_kind='management' and j.status='completed' limit 1",[submanager.id])).rows[0];
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'certify',nodeId:submanager.id,assignmentId:activity.id,checks:[]}]]),/Authenticated component evidence/);
 // Real admission reserves use verified registry prices and inherited token limits.
 await db.query('reset role');
 await db.query("insert into model_registry(provider_name,model_id,normalized_model_id,is_active,reasoning_tier,capability_status,pricing_status,routing_eligibility,capability_verified_at,pricing_verified_at,pricing_input_per_1m,pricing_output_per_1m) values('openai','synthetic-executive','synthetic-executive',true,'high','verified','verified','verified',now(),now(),2,8)");
 await db.query('set role service_role');
 await assert.rejects(db.query('select reserve_mission_call($1,$2,$3,$4,1000)',[work.job.id,work.job.lease,randomUUID(),'openai:unverified']),/Verified authorized/);
 assert.equal((await db.query('select reserve_mission_call($1,$2,$3,$4,1000) ok',[work.job.id,work.job.lease,randomUUID(),'openai:synthetic-executive'])).rows[0].ok,true);
 await assert.rejects(db.query('select reserve_mission_call($1,$2,$3,$4,20000)',[work.job.id,work.job.lease,randomUUID(),'openai:synthetic-executive']),/monetary ceiling/);

 // Native ledger trigger transactions use a separate appointed coding worker.
 await db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'ready'}]]);
 await db.query('reset role');
 const dev=(await nodes()).find(n=>n.name==='Development');
 const nativeAgent=(await db.query("select save_managed_agent(null,$1,false) a",[{name:'Synthetic native worker',instructions:'Execute approved code only',research:false,development:true,attachments:false,reviewMode:'always',maxActiveTasks:1,maxInputChars:16000}])).rows[0].a.id;
 const nativeNode=(await db.query("insert into project_organization_nodes(project_id,parent_id,agent_id,kind,name,objective,acceptance,tools,token_limit,deadline,depth,decision_needed) values($1,$2,$3,'worker','Native worker','Implement approved component','[\"Verified code\"]',array['analysis','development'],20000,$4,2,false) returning id",[project,dev.id,nativeAgent,deadline])).rows[0].id;
 const scope='a'.repeat(64),head='b'.repeat(40),nativeMid=randomUUID(),nativeJob=randomUUID(),account=randomUUID();
 await db.query("update work_projects set spec=$2,approved_hash=$3,approval_hash=$3,verified_sha=$4 where id=$1",[project,{allowedPaths:['src/'],finalContract:{scenarios:[]}},scope,head]);
 await db.query('insert into project_organization_scope_grants values($1,$2,$3,$4)',[nativeNode,scope,['src/'],dev.id]);
 await db.query('select create_mission($1,$2,$3,20,null)',[nativeMid,'Synthetic native execution',[nativeAgent]]);
 await db.query("update agent_missions set project_id=$2,project_kind='development' where id=$1",[nativeMid,project]);
 const nativeAssignment=(await db.query('select id from mission_assignments where mission_id=$1',[nativeMid])).rows[0].id;
 await db.query('insert into benchmark_budget_accounts values($1,$2,$3)',[account,project,nativeAssignment]);
 const nativeCall=randomUUID();
 await db.query("insert into benchmark_budget_calls values($1,$2,null,1000,null,'reserved')",[nativeCall,account]);
 await db.query('insert into benchmark_dollar_exposures values($1,$2,10000)',[nativeCall,account]);
 await assert.rejects(db.query("insert into benchmark_budget_calls values($1,$2,null,21000,null,'reserved')",[randomUUID(),account]),/resource authority/);
 await assert.rejects(db.query('insert into benchmark_dollar_exposures values($1,$2,200000)',[randomUUID(),account]),/monetary ceiling/);
 await db.query("update benchmark_budget_calls set state='settled',actual_tokens=800 where id=$1",[nativeCall]);
 await db.query('update benchmark_dollar_exposures set exposure_microusd=8000 where call_id=$1',[nativeCall]);
 assert.equal((await db.query('select exposure_microusd from benchmark_dollar_exposures where call_id=$1',[nativeCall])).rows[0].exposure_microusd,'8000');
 // A mission projection is represented once, on the mission rail; the
 // canonical projection must not consume a second organizational reservation.
 const projected=randomUUID();
 await db.query('begin');
 await db.query("insert into benchmark_budget_calls values($1,$2,$3,50000,800,'settled')",[projected,account,randomUUID()]);
 await db.query('insert into benchmark_dollar_exposures values($1,$2,1000000)',[projected,account]);
 await db.query('rollback');
 // Native settlement is never suppressed even when actual exposure exceeds authority.
 await db.query('begin');await db.query('update benchmark_dollar_exposures set exposure_microusd=2000000 where call_id=$1',[nativeCall]);
 assert.equal((await db.query('select status from work_projects where id=$1',[project])).rows[0].status,'blocked');await db.query('rollback');
 // Final-acceptance fixture: authenticated current assessment, separate author
 // and QA reviewer, persisted completed components. Negative mutations roll back.
 const qa=(await nodes()).find(n=>n.area==='quality_assurance'&&n.depth===1);
 const qaAgent=(await db.query("select save_managed_agent(null,$1,false) a",[{name:'Independent QA worker',instructions:'Verify original requirements',research:false,development:false,attachments:false,reviewMode:'always',maxActiveTasks:1,maxInputChars:16000}])).rows[0].a.id;
 const qaNode=(await db.query("insert into project_organization_nodes(project_id,parent_id,agent_id,kind,name,objective,acceptance,tools,token_limit,deadline,depth,decision_needed) values($1,$2,$3,'worker','QA worker','Verify original requirements','[\"All original requirements pass\"]',array['analysis'],10000,$4,2,false) returning id",[project,qa.id,qaAgent,deadline])).rows[0].id;
 const assessment=randomUUID(),reviewId=randomUUID();
 const preview={headSha:head,immutable:true,browserAcceptance:{passed:true,headSha:head}};
 await db.query('select create_mission($1,$2,$3,20,null)',[assessment,'Independent final assessment',[nativeAgent,qaAgent]]);
 await db.query("update agent_missions set project_id=$2,project_kind='assessment',project_evidence=$3 where id=$1",[assessment,project,{approvedScopeHash:scope,approvedFinalContract:{scenarios:[]},preview}]);
 await db.query("update mission_assignments set role='compose',status='completed',result='{}' where mission_id=$1",[assessment]);
 const checks=['requirement:assigned-outcome','criterion:1','criterion:2','overall-objective','factual-support','prior-findings'].map(id=>({id,passed:true}));
 await db.query("insert into mission_assignments(id,mission_id,agent_id,job_key,role,instruction,status,result) values($1,$2,$3,'independent-final-qa','review','Evaluate original requirements','completed',$4)",[reviewId,assessment,qaAgent,{verdict:'pass',checks}]);
 await db.query("update agent_missions set status='completed',result='Independent requirements passed' where id=$1",[assessment]);
 await db.query("update mission_calls set actual_tokens=800,status='completed' where job_id=$1",[work.job.id]);
 await db.query("update project_organization_exceptions set status='resolved',resolution='Synthetic completed dependency evidence' where project_id=$1",[project]);

 // Seed authenticated technical outputs, then certify EVERY organization through
 // its actual manager RPC, bottom-up. Only model/provider output is synthetic.
 const artifacts=new Map([[qaNode,reviewId]]);
 for(const manager of (await nodes()).filter(n=>n.kind==='manager')){
  if((await nodes()).some(n=>n.parent_id===manager.id))continue;
  const agent=(await db.query('select save_managed_agent(null,$1,false) a',[{name:'Component worker',instructions:'Deliver component',research:false,development:false,attachments:false,reviewMode:'always',maxActiveTasks:1,maxInputChars:16000}])).rows[0].a.id;
  await db.query("insert into project_organization_nodes(project_id,parent_id,agent_id,kind,name,objective,acceptance,tools,token_limit,deadline,depth,decision_needed) values($1,$2,$3,'worker','Component worker','Deliver component','[\"Verified deliverable\"]',array['analysis'],1000,$4,$5,false)",[project,manager.id,agent,deadline,manager.depth+1]);
 }
 for(const worker of (await nodes()).filter(n=>n.kind==='worker'&&!artifacts.has(n.id))){
  const mid=randomUUID();await db.query('select create_mission($1,$2,$3,20,null)',[mid,'Synthetic completed component',[worker.agent_id]]);
  await db.query("update agent_missions set project_id=$2,project_kind='organization_work',project_evidence=$3 where id=$1",[mid,project,{approvedScopeHash:scope}]);
  const job=(await db.query("update mission_assignments set role='work',status='completed',result=$2 where mission_id=$1 returning id",[mid,{text:'Verified '+worker.name+' deliverable'}])).rows[0].id;
  await db.query("update agent_missions set status='completed',result='Verified component' where id=$1",[mid]);artifacts.set(worker.id,job);
 }
 await db.query("update work_projects set active_mission_id=$2,phase='assessment',preview=$3 where id=$1",[project,assessment,preview]);
 for(const manager of (await nodes()).filter(n=>n.kind==='manager').sort((a,b)=>b.depth-a.depth)){
  await db.query('reset role');await db.query('update project_organization_nodes set decision_needed=(id=$2) where project_id=$1',[project,manager.id]);
  await db.query('set role service_role');await resetLease();const session=await management();assert.equal(session.job.agent_id,manager.agent_id);
  const children=(await nodes()).filter(n=>n.parent_id===manager.id);
  await db.query('select project_org_decide($1,$2,$3)',[session.job.id,session.job.lease,children.map(child=>({action:'certify',nodeId:child.id,assignmentId:artifacts.get(child.id),checks:child.acceptance.map(criterion=>({criterion,passed:true,assignmentId:artifacts.get(child.id),evaluation:'Verified the component artifact against the delegated criterion'}))}))]);
  artifacts.set(manager.id,manager.id===qa.id?reviewId:artifacts.get(children[0].id));
 }
 await db.query('reset role');

 await db.query("update project_organization_nodes set decision_needed=true where id=$1",[rootNode.id]);
 await db.query("update work_projects set active_mission_id=$2,phase='assessment',preview=$3 where id=$1",[project,assessment,preview]);
 await db.query('set role service_role');await resetLease();work=await management();assert.equal(work.job.agent_id,rootNode.agent_id);
 const rootCerts=(await nodes()).filter(n=>n.parent_id===rootNode.id).map(n=>({action:'certify',nodeId:n.id,assignmentId:artifacts.get(n.id),checks:n.acceptance.map(criterion=>({criterion,passed:true,assignmentId:artifacts.get(n.id),evaluation:'Verified the organization outcome against its delegated criterion'}))}));
 await db.query('reset role');await db.query('begin');
 await db.query("update mission_assignments set result=jsonb_set(result,'{checks,0,passed}','false') where id=$1",[reviewId]);
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[...rootCerts,{action:'close'}]]),/Independent original-requirement/);await db.query('rollback');
 await db.query('begin');await db.query("update project_organization_nodes set evidence=jsonb_set(evidence,'{assignmentId}',to_jsonb($2::text)) where id=$1",[qa.id,executed.job.id]);
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[...rootCerts.map(c=>c.nodeId===qa.id?{...c,assignmentId:artifacts.get(dev.id)}:c),{action:'close'}]]),/Authenticated component|Independent original-requirement/);await db.query('rollback');
 await db.query('begin');await db.query("update benchmark_budget_calls set state='reserved' where id=$1",[nativeCall]);
 await assert.rejects(db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[...rootCerts,{action:'close'}]]),/Unresolved native/);await db.query('rollback');
 await db.query('set role service_role');
 await db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[...rootCerts,{action:'close'}]]);
 const closure=(await db.query('select * from project_organization_closures where project_id=$1',[project])).rows[0];assert.equal(closure.director_id,rootNode.id);assert.equal(closure.receipt.nativeRecordedExposureMicrousd,8000);assert.equal(closure.receipt.settledMissionCostUpperBoundMicrousd,8000);
 // Source-bound final lifecycle completion remains independently mandatory;
 // remove the synthetic closure to exercise the director-only negative below.
 await db.query('reset role');await db.query('delete from project_organization_closures where project_id=$1',[project]);await db.query('set role service_role');

 await resetLease();work=await management();assert.equal(work.job.agent_id,rootNode.agent_id);
 await db.query('reset role');await db.query('begin');await db.query('set role service_role');
 await db.query('select project_org_decide($1,$2,$3)',[work.job.id,work.job.lease,[{action:'grant_scope',nodeId:dev.id,paths:['src/']}]]);
 const reopened=(await db.query('select * from project_organization_nodes where id=$1',[dev.id])).rows[0];assert.equal(reopened.status,'active');assert.equal(reopened.decision_needed,true);assert.equal(reopened.evidence,null);
 await db.query('rollback');await db.query('reset role');await db.query('begin');
 await db.query('update work_projects set approved_hash=$2,approval_hash=$2 where id=$1',[project,'c'.repeat(64)]);
 assert.equal((await db.query("select count(*)::int n from project_organization_nodes where project_id=$1 and (status='accepted' or evidence is not null)",[project])).rows[0].n,0);
 await db.query('rollback');
 // A legacy planner cannot assign analysis to a worker with only coding tools.
 const noAnalysis=(await db.query("select save_managed_agent(null,$1,false) a",[{name:'Coding only',instructions:'Code only',research:false,development:true,attachments:false,reviewMode:'always',maxActiveTasks:1,maxInputChars:16000}])).rows[0].a.id;
 await db.query("insert into project_organization_nodes(project_id,parent_id,agent_id,kind,name,objective,acceptance,tools,token_limit,deadline,depth,decision_needed) values($1,$2,$3,'worker','Coding only','Code only','[\"Code\"]',array['development'],1000,$4,2,false)",[project,dev.id,noAnalysis,deadline]);
 await assert.rejects(db.query("insert into mission_assignments(id,mission_id,agent_id,job_key,role,instruction,payload) values($1,$2,$3,'escape','work','Calculate something','{\"capability\":\"analysis\"}')",[randomUUID(),nativeMid,noAnalysis]),/delegated execution authority/);
 await db.query('set role service_role');
 await db.query('reset role');await assert.rejects(db.query('update work_projects set organization_version=0 where id=$1',[project]),/cannot be disabled/);await db.query('set role service_role');
 await db.query('reset role');await assert.rejects(db.query('update project_organization_nodes set parent_id=id where id=$1',[rootNode.id]),/Circular|immutable/);
 await assert.rejects(db.query("insert into project_organization_nodes select gen_random_uuid(),project_id,parent_id,agent_id,kind,area,name,objective,acceptance,scope_paths,tools,token_limit,deadline,depth,decision_needed,scope_hash,status,evidence,created_at,management_contract from project_organization_nodes where id=$1",[rootNode.id]),/duplicate key/);
 await assert.rejects(db.query("update work_projects set status='completed' where id=$1",[project]),/Director closure/);
 await (await import('./helpers/assert-dynamic-project-management.mjs')).assertDynamicProjectManagement(db);
 }finally{for(const c of clients)await c.end().catch(()=>{});if(started)spawnSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','stop']);rmSync(root,{recursive:true,force:true});}
});
