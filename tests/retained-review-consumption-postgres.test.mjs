import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import pg from 'pg';

const migration='supabase/migrations/20261128192606_retained_review_consumption.sql';
const sha=n=>n.repeat(40),hash=n=>n.repeat(64);
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);

test('retained technical review stays distinct, authenticated, immutable and nonbillable',{timeout:90000},async()=>{
 const installed=existsSync('/usr/lib/postgresql')?readdirSync('/usr/lib/postgresql').sort((a,b)=>Number(b)-Number(a)):[];
 const bin=process.env.KATIE_TEST_PG_BIN||installed.map(v=>join('/usr/lib/postgresql',v,'bin')).find(p=>existsSync(join(p,'initdb')));
 assert.ok(bin&&existsSync(join(bin,'initdb')),'Native PostgreSQL required; set KATIE_TEST_PG_BIN');
 const root=mkdtempSync(join(tmpdir(),'katie-review-settlement-')),data=join(root,'data'),log=join(root,'postgres.log');
 let started=false,db;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,[r.stderr,r.error?.message,existsSync(log)?readFileSync(log,'utf8'):''].filter(Boolean).join('\n'));};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  const tcp=process.env.KATIE_TEST_PG_TCP==='1';
  const port=tcp?await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});}):55519;
  run('pg_ctl',['-D',data,'-l',log,'-o',tcp?`-h 127.0.0.1 -k '' -p ${port}`:`-h '' -k ${root} -p ${port}`,'-w','start']);started=true;
  db=new pg.Client({host:tcp?'127.0.0.1':root,port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});await db.connect();
  // Match the existing tables/columns read by the production function. This
  // private fixture cannot connect to a project database or a provider.
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create table actors(id uuid primary key,actor_kind text);create table chats(id uuid primary key,actor_id uuid);create table managed_agents(id uuid primary key,actor_id uuid);
   create table standalone_owner_bindings(owner_id uuid,actor_id uuid,chat_id uuid);
   create table work_projects(id uuid primary key,actor_id uuid,chat_id uuid,approved_hash text,approval_hash text,repository_id uuid);
   create table project_work_packages(id uuid primary key,project_id uuid,scope_hash text,contract jsonb);
   create table agent_missions(id uuid primary key,project_id uuid,project_kind text,repository_id uuid,team jsonb);
   create table mission_assignments(id uuid primary key,mission_id uuid,role text,agent_id uuid,payload jsonb);
   create table agent_tasks(id uuid primary key,actor_id uuid,chat_id uuid,repository_full_name text,status text,external jsonb,agent_id uuid,kind text,repository_id uuid,initial_input text,snapshot jsonb,definition_version integer);
   create table project_runs(project_id uuid,mission_id uuid,kind text,binding jsonb);
   create table project_package_checkpoint_dispatches(authorization_id uuid,task_id uuid,run_id text);
   create table project_package_checkpoint_continuations(project_id uuid,package_id uuid,authorization_id uuid,owner_id uuid,mission_id uuid,assignment_id uuid,proof jsonb,state_hash text,authorized_at timestamptz,cutoff timestamptz,prior_state jsonb);
   create table project_package_corrective_receipts(receipt_id uuid,project_id uuid,package_id uuid,owner_id uuid,checkpoint jsonb,qualification jsonb,state_hash text,recorded_at timestamptz);
   create table project_events(project_id uuid,event text,data jsonb,created_at timestamptz default now());
   create table project_provider_requests(id uuid,operation text,worker_id uuid,mission_id uuid,project_id uuid,started_at timestamptz,resolved_at timestamptz,request_hash text,assignment_id uuid,provider_receipt text,execution_attempt text);`);
  const scopeSource=readFileSync('supabase/migrations/20261028193000_standalone_provider_attempt_ledger.sql','utf8');
  await db.query(scopeSource.match(/create function public\.standalone_verify_scope[\s\S]*?\$\$;/i)[0]);
  const projectSource=readFileSync('supabase/migrations/20261017141136_chat_projects.sql','utf8');
  await db.query(projectSource.match(/create function public\.project_canonical[\s\S]*?\$\$;/i)[0]);
  await db.query(readFileSync(migration,'utf8'));
  const ids=Object.fromEntries(['owner','actor','chat','agentActor','taskChat','repository','project','package','mission','task','worker','authorization','settlement'].map(k=>[k,randomUUID()]));
  const contract={path:'/demo',scenarios:[{name:'Initial state',steps:[{action:'expectText',selector:'#status',value:''}]}]};
  const contractHash=createHash('sha256').update(canonical(contract)).digest('hex');
  const binding={projectId:ids.project,scopeHash:hash('a'),contractHash,contract,baseSha:sha('7'),allowedPaths:['app/demo/'],cumulativePaths:['app/demo/']};
  const receipt={version:1,repository:'owner/repository',issue_number:12,run_id:123,outcome:'BLOCKED',pr_url:null,tested_head_sha:null,reviewed_head_sha:null};
  const proof={candidateSha:sha('b'),sourceTreeSha:sha('c')};
  await db.query('insert into actors values($1,$2);',[ids.actor,'standard']);
  await db.query('insert into chats values($1,$2)',[ids.chat,ids.actor]);
  await db.query('insert into actors values($1,$2)',[ids.agentActor,'managed_agent']);
  await db.query('insert into chats values($1,$2)',[ids.taskChat,ids.agentActor]);
  await db.query('insert into managed_agents values($1,$2)',[ids.worker,ids.agentActor]);
  await db.query('insert into standalone_owner_bindings values($1,$2,$3)',[ids.owner,ids.actor,ids.chat]);
  await db.query('insert into work_projects values($1,$2,$3,$4,$4,$5)',[ids.project,ids.actor,ids.chat,hash('a'),ids.repository]);
  await db.query('insert into project_work_packages values($1,$2,$3,$4)',[ids.package,ids.project,hash('a'),{milestone:{contract}}]);
  await db.query('insert into agent_missions values($1,$2,$3,$4,$5)',[ids.mission,ids.project,'development',ids.repository,JSON.stringify([{id:ids.worker,version:1,config:{development:true}}])]);
  await db.query('insert into mission_assignments values($1,$2,$3,$4,$5)',[ids.task,ids.mission,'development',ids.worker,{development_input:'Exact approved implementation context'}]);
  await db.query('insert into agent_tasks values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)',[ids.task,ids.agentActor,ids.taskChat,'owner/repository','blocked',{receipt,issueNumber:12,checkpointRecoveryAuthorizationId:ids.authorization,checkpointRecoveryCandidate:proof.candidateSha},ids.worker,'development',ids.repository,'Exact approved implementation context',{development:true}]);
  await db.query('insert into project_runs values($1,$2,$3,$4)',[ids.project,ids.mission,'development',binding]);
  await db.query('insert into project_package_checkpoint_dispatches values($1,$2,$3)',[ids.authorization,ids.task,'123']);
  await db.query("insert into project_package_checkpoint_continuations values($1,$2,$3,$4,$5,$6,$7,$8,now()-interval '2 hours',now()-interval '1 hour',jsonb_build_object('task',(select to_jsonb(t) from agent_tasks t where id=$6)))",[ids.project,ids.package,ids.authorization,ids.owner,ids.mission,ids.task,proof,hash('d')]);
  for(const [n,operation,provider] of [[0,'input-count','input-token-count'],[1,'inference','response-1']])await db.query("insert into project_provider_requests values($1,$2,$3,$4,$5,now()-interval '110 minutes'+$6*interval '10 seconds',now()-interval '109 minutes'+$6*interval '10 seconds',$7,$8,$9,$10)",[randomUUID(),operation,ids.worker,ids.mission,ids.project,n,hash('e'),ids.task,provider,'123']);
  const requests=(await db.query('select jsonb_agg(to_jsonb(x) order by x.started_at,x.id) requests from project_provider_requests x')).rows[0].requests;
  const checkpoint={mode:'retained-final-review-settlement',authorizationId:ids.authorization,missionId:ids.mission,assignmentId:ids.task,...proof,scopeHash:binding.scopeHash,contractHash,reviewVerdict:'pass',additionalPaidInference:0,nativeDispatchConsumed:true,workflowReceipt:receipt,providerRequests:requests};
  const qualification={kind:'retained-final-review-settlement',phase:'final-review',runId:'123',workflowConclusion:'failure',...proof,scopeHash:binding.scopeHash,contractHash,terminalEvent:'turn.completed',exitCode:0,findings:'PASS independent source review',artifactId:'1',artifactSha256:hash('f'),diagnosticsSha256:hash('1'),verificationDigest:hash('2'),snapshots:['initial','after-final-review','final'].map(label=>({label,head:proof.candidateSha})),providerUsage:{unknownUsage:0,responses:1,receipts:[{providerRequestId:'response-1'}]}};
  await db.query("insert into project_package_corrective_receipts values($1,$2,$3,$4,$5,$6,$7,now()-interval '90 minutes')",[ids.settlement,ids.project,ids.package,ids.owner,checkpoint,qualification,hash('d')]);
  await db.query("insert into project_events values($1,'package_checkpoint_authorized',$2,now()-interval '2 hours')",[ids.project,{authorizationId:ids.authorization}]);
  await db.query("insert into project_events values($1,'package_checkpoint_final_review_settled',$2,now()-interval '90 minutes')",[ids.project,{receiptId:ids.settlement,authorizationId:ids.authorization,candidateSha:proof.candidateSha,reviewVerdict:'pass',additionalPaidInference:0}]);
  const read=async(task=ids.task)=>(await db.query('select project_development_review_settlement($1) evidence',[task])).rows[0].evidence;
  assert.equal(await read(randomUUID()),null);
  for(const role of ['anon','authenticated']){
   await db.query('set role '+role);await assert.rejects(read(),{code:'42501'});await db.query('reset role');
  }
  await db.query('set role service_role');
  await assert.rejects(db.query('select * from project_package_corrective_receipts'),{code:'42501'});
  const accepted=await read();assert.equal(accepted.receiptId,ids.settlement);assert.equal(accepted.workflowReceipt.outcome,'BLOCKED');
  assert.ok(Date.parse(accepted.cutoff)<Date.now(),'expired execution authorization does not erase accepted evidence');
  await db.query('reset role');
  const before=(await db.query('select to_jsonb(t) state from agent_tasks t')).rows[0].state;
  // Negative cases exercise the actual SQL against one change at a time.
  const rejectChange=async(sql,args=[])=>{await db.query('begin');try{await db.query(sql,args);await assert.rejects(read(),/authenticated evidence|no rows/);}finally{await db.query('rollback');}};
  await rejectChange("update work_projects set approved_hash=$1",[hash('9')]);
  await rejectChange('update standalone_owner_bindings set owner_id=$1',[randomUUID()]);
  await rejectChange('update agent_tasks set chat_id=$1',[randomUUID()]);
  await rejectChange('update agent_tasks set agent_id=$1',[randomUUID()]);
  await rejectChange('update agent_tasks set actor_id=$1,chat_id=$2',[ids.actor,ids.chat]);
  await rejectChange('update chats set actor_id=$1 where id=$2',[ids.actor,ids.taskChat]);
  const otherTaskChat=randomUUID();await db.query('insert into chats values($1,$2)',[otherTaskChat,ids.agentActor]);
  await rejectChange('update agent_tasks set chat_id=$1',[otherTaskChat]);
  await rejectChange('update agent_tasks set repository_id=$1',[randomUUID()]);
  await rejectChange("update agent_tasks set kind='general'");
  await rejectChange("update agent_tasks set initial_input='Different implementation context'");
  await rejectChange("update agent_tasks set snapshot='{}'");
  await rejectChange('update agent_tasks set definition_version=2');
  await rejectChange('update work_projects set repository_id=$1',[randomUUID()]);
  await rejectChange("update agent_tasks set external=jsonb_set(external,'{receipt,outcome}','\"READY\"')");
  await rejectChange("update project_package_corrective_receipts set qualification=jsonb_set(qualification,'{candidateSha}',to_jsonb($1::text))",[sha('9')]);
  await rejectChange("update project_provider_requests set provider_receipt='different' where operation='inference'");
  await rejectChange('update project_provider_requests set resolved_at=null where operation=\'inference\'');
  await rejectChange("delete from project_events where event='package_checkpoint_authorized'");
  await rejectChange("delete from project_events where event='package_checkpoint_final_review_settled'");
  await rejectChange("update project_runs set binding=jsonb_set(binding,'{contract,scenarios,0,steps,0,value}','\"tampered\"')");
  await rejectChange("update project_package_corrective_receipts set recorded_at=now()");
  await db.query('begin');await db.query('insert into project_package_corrective_receipts select * from project_package_corrective_receipts');await assert.rejects(read(),/Ambiguous/);await db.query('rollback');
  assert.deepEqual((await db.query('select to_jsonb(t) state from agent_tasks t')).rows[0].state,before);
  assert.equal((await db.query('select count(*) n from project_provider_requests')).rows[0].n,'2');

  // Release authority is an independently qualified dependency. This local
  // fixture switches its exact identity to prove the consumer enforces it.
  await db.query(`alter table work_projects add column deadline timestamptz,add column status text,add column phase text,add column active_mission_id uuid,add column lease uuid,add column lease_until timestamptz,add column verified_sha text,add column preview jsonb,add column detail text,add column updated_at timestamptz;
   alter table agent_missions add column status text;
   alter table mission_assignments add column status text,add column result jsonb,add column lease uuid,add column lease_until timestamptz,add column detail text,add column updated_at timestamptz;
   create table fixture_release(project_id uuid,release_sha text,generation bigint,deployment_id text,active boolean);
   create function public.project_org_package_nonbillable_release_live(uuid,text,bigint,text) returns boolean language sql stable as $$select exists(select 1 from fixture_release where project_id=$1 and release_sha=$2 and generation=$3 and deployment_id=$4 and active)$$;
   create function public.project_provider_request_pending(uuid) returns boolean language sql stable as $$select exists(select 1 from project_provider_requests where project_id=$1 and resolved_at is null)$$;`);
  await db.query("insert into fixture_release values($1,$2,3,'dpl_test',true)",[ids.project,sha('8')]);
  await db.query("update project_package_checkpoint_continuations set cutoff=now()+interval '1 hour'");
  await db.query("update work_projects set deadline=(select cutoff from project_package_checkpoint_continuations),status='blocked',phase='development',active_mission_id=$1",[ids.mission]);
  await db.query("update agent_missions set status='blocked'");
  const failedResult={detail:'Infrastructure failure',external:{receipt}};
  await db.query("update mission_assignments set status='failed',result=$1",[failedResult]);
  const preview={url:'https://demo-abcdef123-owner.vercel.app/demo',headSha:proof.candidateSha,deploymentId:123,statusId:456,provider:'vercel',immutable:true};
  const browser={version:1,projectId:ids.project,contractHash,headSha:proof.candidateSha,deploymentId:123,statusId:456,url:preview.url,checkedAt:new Date().toISOString(),passed:true,checks:[{name:'Initial state',passed:true,detail:'Expected initial state observed'}]};
  const acceptance=({version,projectId,contractHash,headSha,passed,checks})=>({version,projectId,contractHash,headSha,passed,checks});
  const evidence={observedHeadSha:proof.candidateSha,testedHeadSha:proof.candidateSha,reviewedHeadSha:proof.candidateSha,sourceTreeSha:proof.sourceTreeSha,reviewSettlement:{receiptId:ids.settlement,authorizationId:ids.authorization,scopeHash:binding.scopeHash,contractHash},changedFiles:[{path:'app/demo/page.tsx'}],packageDelta:{baseSha:binding.baseSha,headSha:proof.candidateSha,changedFiles:[{path:'app/demo/page.tsx'}]},preview,projectAcceptance:acceptance(browser)};
  const consume=async(client=db,ev=evidence,br=browser)=>(await client.query('select project_consume_development_review_settlement($1,$2,$3,3,$4,$5,$6) result',[ids.task,ids.settlement,sha('8'),'dpl_test',ev,br])).rows[0].result;
  for(const role of ['anon','authenticated']){await db.query('set role '+role);await assert.rejects(consume(),{code:'42501'});await db.query('reset role');}
  await db.query('grant select,insert on project_events to service_role; grant select,update on mission_assignments to service_role');
  await db.query('set role service_role');
  await assert.rejects(db.query("insert into project_events(project_id,event,data) values($1,'development_review_settlement_consumed',$2)",[ids.project,{receiptId:ids.settlement,result:{consumed:true}}]),/authenticated definer/);
  await db.query('reset role');
  const denyConsume=async(sql,args=[])=>{await db.query('begin');try{await db.query(sql,args);await assert.rejects(consume(),/authority|authenticated evidence/);}finally{await db.query('rollback');}};
  await denyConsume('update fixture_release set active=false');
  await denyConsume('update work_projects set lease=$1',[randomUUID()]);
  await denyConsume('update mission_assignments set lease=$1',[randomUUID()]);
  await denyConsume("update agent_missions set status='running'");
  await denyConsume("update project_package_checkpoint_continuations set cutoff=now()-interval '1 minute'");
  await assert.rejects(consume(db,{...evidence,changedFiles:[{path:'outside.ts'}]}),/authority/);
  await assert.rejects(consume(db,{...evidence,changedFiles:[{path:'app/demo/../secret'}]}),/authority/);
  await assert.rejects(consume(db,{...evidence,sourceTreeSha:sha('9')}),/authority/);
  await assert.rejects(consume(db,{...evidence,packageDelta:{...evidence.packageDelta,baseSha:sha('9')}}),/authority/);
  for(const bad of [{...browser,passed:false},{...browser,statusId:999},{...browser,checks:[]},{...browser,checks:[{name:'Different scenario',passed:true}]},{...browser,checkedAt:new Date(Date.now()-3600000).toISOString()}])await assert.rejects(consume(db,{...evidence,projectAcceptance:acceptance(bad)},bad),/authority/);
  // Simultaneous callers serialize to one semantic consumption. No mission,
  // package, task, budget or provider record is promoted or reset.
  const peer=new pg.Client({host:tcp?'127.0.0.1':root,port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});await peer.connect();
  try{await db.query('set role service_role');await peer.query('set role service_role');const results=await Promise.all([consume(),consume(peer)]);assert.deepEqual(results[0],results[1]);assert.equal(results[0].organizationAcceptancePending,true);}finally{await db.query('reset role');await peer.end();}
  const event=(await db.query("select data from project_events where event='development_review_settlement_consumed'")).rows;
  assert.equal(event.length,1);assert.deepEqual(event[0].data.priorAssignment.result,failedResult);
  assert.equal((await db.query('select status from mission_assignments')).rows[0].status,'completed');
  assert.equal((await db.query('select status from agent_missions')).rows[0].status,'blocked');
  assert.equal((await db.query('select status from work_projects')).rows[0].status,'blocked');
  assert.deepEqual((await db.query('select to_jsonb(t) state from agent_tasks t')).rows[0].state,before);
  assert.equal((await db.query('select count(*) n from project_provider_requests')).rows[0].n,'2');
  await assert.rejects(db.query("update project_events set data='{}' where event='development_review_settlement_consumed'"),/append-only/);
  await assert.rejects(db.query("delete from project_events where event='development_review_settlement_consumed'"),/append-only/);
  await assert.rejects(db.query("update project_events set event='development_review_settlement_consumed' where event='package_checkpoint_authorized'"),/append-only/);
  await assert.rejects(consume(db,{...evidence,sourceTreeSha:sha('9')}),/conflicts/);
  await db.query('update fixture_release set active=false');
  assert.equal((await consume()).consumed,true,'same completed operation remains idempotent after release closes');
  assert.equal((await db.query("select count(*) n from project_events where event='development_review_settlement_consumed'")).rows[0].n,'1');
 }finally{
  await db?.end();if(started)spawnSync(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{timeout:15000});rmSync(root,{recursive:true,force:true});
 }
});
