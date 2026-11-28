import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import pg from 'pg';
import {assertFinalAssessmentRelease} from './helpers/assert-final-assessment-release.mjs';

const evidenceMigration='supabase/migrations/20261128192606_retained_review_consumption.sql';
const migration='supabase/migrations/20261128192855_nonbillable_release_continuity.sql';
const sha=n=>n.repeat(40),hash=n=>n.repeat(64);
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);

test('qualified release fences paid work and preserves only the signed final assessment',{timeout:90000},async()=>{
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
  await db.query(readFileSync(evidenceMigration,'utf8'));
  const ids=Object.fromEntries(['owner','actor','chat','agentActor','taskChat','repository','project','package','mission','task','worker','authorization','settlement'].map(k=>[k,randomUUID()]));
  ids.project='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
  const SCOPE='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
  const contract={path:'/demo',scenarios:[{name:'Initial state',steps:[{action:'expectText',selector:'#status',value:''}]}]};
  const contractHash=createHash('sha256').update(canonical(contract)).digest('hex');
  const binding={projectId:ids.project,scopeHash:SCOPE,contractHash,contract,baseSha:sha('7'),allowedPaths:['app/demo/'],cumulativePaths:['app/demo/']};
  const receipt={version:1,repository:'owner/repository',issue_number:12,run_id:123,outcome:'BLOCKED',pr_url:null,tested_head_sha:null,reviewed_head_sha:null};
  const proof={candidateSha:sha('b'),sourceTreeSha:sha('c')};
  await db.query('insert into actors values($1,$2);',[ids.actor,'standard']);
  await db.query('insert into chats values($1,$2)',[ids.chat,ids.actor]);
  await db.query('insert into actors values($1,$2)',[ids.agentActor,'managed_agent']);
  await db.query('insert into chats values($1,$2)',[ids.taskChat,ids.agentActor]);
  await db.query('insert into managed_agents values($1,$2)',[ids.worker,ids.agentActor]);
  await db.query('insert into standalone_owner_bindings values($1,$2,$3)',[ids.owner,ids.actor,ids.chat]);
  await db.query('insert into work_projects values($1,$2,$3,$4,$4,$5)',[ids.project,ids.actor,ids.chat,SCOPE,ids.repository]);
  await db.query('insert into project_work_packages values($1,$2,$3,$4)',[ids.package,ids.project,SCOPE,{milestone:{contract}}]);
  await db.query('insert into agent_missions values($1,$2,$3,$4,$5)',[ids.mission,ids.project,'development',ids.repository,JSON.stringify([{id:ids.worker,version:1,config:{development:true}}])]);
  await db.query('insert into mission_assignments values($1,$2,$3,$4,$5)',[ids.task,ids.mission,'development',ids.worker,{development_input:'Exact approved implementation context'}]);
  await db.query('insert into agent_tasks values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)',[ids.task,ids.agentActor,ids.taskChat,'owner/repository','blocked',{receipt,issueNumber:12,checkpointRecoveryAuthorizationId:ids.authorization,checkpointRecoveryCandidate:proof.candidateSha},ids.worker,'development',ids.repository,'Exact approved implementation context',{development:true}]);
  await db.query('insert into project_runs values($1,$2,$3,$4)',[ids.project,ids.mission,'development',binding]);
  await db.query('insert into project_package_checkpoint_dispatches values($1,$2,$3)',[ids.authorization,ids.task,'123']);
  await db.query("insert into project_package_checkpoint_continuations values($1,$2,$3,$4,$5,$6,$7,$8,now()-interval '2 hours',now()+interval '1 hour',jsonb_build_object('task',(select to_jsonb(t) from agent_tasks t where id=$6)))",[ids.project,ids.package,ids.authorization,ids.owner,ids.mission,ids.task,proof,hash('d')]);
  for(const [n,operation,provider] of [[0,'input-count','input-token-count'],[1,'inference','response-1']])await db.query("insert into project_provider_requests values($1,$2,$3,$4,$5,now()-interval '110 minutes'+$6*interval '10 seconds',now()-interval '109 minutes'+$6*interval '10 seconds',$7,$8,$9,$10)",[randomUUID(),operation,ids.worker,ids.mission,ids.project,n,hash('e'),ids.task,provider,'123']);
  const requests=(await db.query('select jsonb_agg(to_jsonb(x) order by x.started_at,x.id) requests from project_provider_requests x')).rows[0].requests;
  const checkpoint={mode:'retained-final-review-settlement',authorizationId:ids.authorization,missionId:ids.mission,assignmentId:ids.task,...proof,scopeHash:binding.scopeHash,contractHash,reviewVerdict:'pass',additionalPaidInference:0,nativeDispatchConsumed:true,workflowReceipt:receipt,providerRequests:requests};
  const qualification={kind:'retained-final-review-settlement',phase:'final-review',runId:'123',workflowConclusion:'failure',...proof,scopeHash:binding.scopeHash,contractHash,terminalEvent:'turn.completed',exitCode:0,findings:'PASS independent source review',artifactId:'1',artifactSha256:hash('f'),diagnosticsSha256:hash('1'),verificationDigest:hash('2'),snapshots:['initial','after-final-review','final'].map(label=>({label,head:proof.candidateSha})),providerUsage:{unknownUsage:0,responses:1,receipts:[{providerRequestId:'response-1'}]}};
  await db.query("insert into project_package_corrective_receipts values($1,$2,$3,$4,$5,$6,$7,now()-interval '90 minutes')",[ids.settlement,ids.project,ids.package,ids.owner,checkpoint,qualification,hash('d')]);
  await db.query("insert into project_events values($1,'package_checkpoint_authorized',$2,now()-interval '2 hours')",[ids.project,{authorizationId:ids.authorization}]);
  await db.query("insert into project_events values($1,'package_checkpoint_final_review_settled',$2,now()-interval '90 minutes')",[ids.project,{receiptId:ids.settlement,authorizationId:ids.authorization,candidateSha:proof.candidateSha,reviewVerdict:'pass',additionalPaidInference:0}]);
  // Add the live-release columns after seeding the shared historical evidence.
  // Legacy failed authorization branches are closed fixtures. The full current
  // gate, retained evidence resolver, fingerprint and paid predicates are real.
  await db.query(`
   alter table project_events add column id uuid default gen_random_uuid();
   alter table work_projects add column status text default 'blocked',add column phase text default 'development',
    add column deadline timestamptz,add column max_missions int default 124,add column token_allowance bigint default 600000,
    add column lease uuid,add column lease_until timestamptz,add column active_mission_id uuid,
    add column spec jsonb default '{}',add column objective text default 'fixture',add column clarifications jsonb,
    add column baseline_sha text,add column max_cycles int default 5,add column cycles int default 4,
    add column milestone_index int default 0,add column verified_sha text,add column preview jsonb,
    add column detail text,add column updated_at timestamptz,add column organization_version int default 1;
   alter table project_work_packages add column deadline timestamptz,add column status text default 'running',
    add column manager_id uuid,add column worker_id uuid,add column writer_id uuid,add column reviewer_id uuid,add column evidence jsonb;
   alter table project_package_checkpoint_continuations add column terms jsonb,add column renewed_fingerprint text,
    add column release_sha text,add column release_generation bigint,add column deployment_id text;
   alter table project_package_corrective_receipts add column ordinal int default 6,add column release_sha text,
    add column release_generation bigint,add column deployment_id text;
   alter table agent_missions add column status text default 'blocked',add column deadline timestamptz,
    add column created_at timestamptz default now(),add column project_evidence jsonb,add column calls int default 0,add column max_calls int default 10,add column result text;
   alter table mission_assignments add column status text default 'failed',add column attempts int default 1,
    add column lease uuid,add column lease_until timestamptz,add column job_key text,
    add column result jsonb,add column detail text,add column updated_at timestamptz;
   alter table managed_agents add column version int default 1,add column archived boolean default false,add column config jsonb;
   create table project_worker_contracts(id uuid,package_id uuid);
   create table project_organization_nodes(id uuid,project_id uuid,agent_id uuid,status text,deadline timestamptz);
   create table project_organization_scope_grants(node_id uuid);
   create table project_work_package_dependencies(package_id uuid);
   create table project_work_package_attempts(package_id uuid,mission_id uuid,attempt int);
   create table project_package_execution_receipts(project_id uuid,package_id uuid,owner_id uuid,scope_hash text,authorization_id uuid,historical_mission_ids uuid[],release_sha text,release_generation bigint,deployment_id text);
   create table project_provider_execution(project_id uuid,owner_id uuid,window_id uuid,deadline timestamptz,approved_scope text);
   create table project_execution_windows(id uuid,project_id uuid,owner_id uuid,cutoff timestamptz);
   create table project_retest_production_release_gate(project_id uuid,release_sha text,deployment_id text,alias_name text,state text,generation bigint,updated_at timestamptz);
   create table project_package_execution_release_receipts(project_id uuid,release_sha text,deployment_id text,release_generation bigint,prior_authorization_id uuid,package_id uuid,owner_id uuid);
   create table project_coding_capacity_authority(project_id uuid,approved_max_missions int);
   create table project_blocked_management_retest_receipts(project_id uuid,historical_missions int);
   create table project_retest_claim_release_receipts(project_id uuid,mission_id uuid,assignment_id uuid,bound_release_sha text,bound_deployment_id text,bound_release_generation bigint);
   create table project_retest_future_window_receipts(project_id uuid,authorized_at timestamptz);
   create table project_mission79_retry_receipts(project_id uuid,assignment_id uuid,mission_id uuid,release_sha text,release_generation bigint,deployment_id text,prior_attempts int,prior_calls int);
   create table project_bounded_recovery_receipts(project_id uuid,release_sha text,release_generation bigint,deployment_id text,cutoff timestamptz,additional_paid_retries int);
   create table project_m84_catalog_reconciliations(project_id uuid,assignment_id uuid,request_id uuid);
   create table project_provider_dispatches(task_id uuid,run_id text);
   create function project_org_package_checkpoint_snapshot(uuid) returns jsonb language sql as 'select null::jsonb';
   create function project_org_package_pending_retry_handoff_allowed(uuid,text,text,text,bigint) returns boolean language sql as 'select false';
   create function project_org_package_corrective_checkpoint(uuid) returns jsonb language sql as 'select null::jsonb';
   create function project_org_package_completion_checkpoint(uuid) returns jsonb language sql as 'select null::jsonb';
   create function project_org_package_release_drained(uuid) returns boolean language sql as 'select false';
   create function project_org_package_legacy_approval_checkpoint(uuid) returns boolean language sql as 'select false';
   create function project_org_package_record_pending_retry_handoff(uuid,text,text,bigint) returns void language sql as 'select';
   create function project_provider_continued(uuid) returns boolean language sql as 'select true';
   create function project_provider_continued_assignment(uuid) returns boolean language sql as 'select true';
   create function project_org_package_paid_retry_allowed(uuid,text,text) returns boolean language sql as 'select false';
   create function project_org_package_completion_limit(uuid,text,integer) returns integer language sql as 'select coalesce((terms->>$2)::int,$3) from project_package_checkpoint_continuations where project_id=$1';
  `);
  const extract=(source,name)=>{const match=source.match(new RegExp('create(?: or replace)? function public\\.'+name+'\\([\\s\\S]*?(?:\\$\\$|\\$function\\$);','i'));assert.ok(match,name);return match[0];};
  const checkpointSource=readFileSync('supabase/migrations/20261127165500_retained_native_checkpoint_continuation.sql','utf8');
  await db.query(extract(checkpointSource,'project_org_package_checkpoint_terms'));
  await db.query(extract(readFileSync('supabase/migrations/20261110010000_provider_controlled_game_trial.sql','utf8'),'project_provider_request_pending'));
  await db.query(extract(readFileSync('supabase/migrations/20261124233000_mission104_package_execution_authority.sql','utf8'),'project_org_package_execution_fingerprint'));
  await db.query(extract(checkpointSource,'project_org_package_checkpoint_live'));
  await db.query(extract(checkpointSource,'project_org_package_release_matches'));
  await db.query('create function project_org_package_execution_live(uuid) returns boolean language sql as $$select project_org_package_checkpoint_live($1)$$');
  await db.query(extract(checkpointSource,'project_org_package_execution_assignment'));
  await db.query(extract(checkpointSource,'project_org_package_checkpoint_dispatch_live'));
  await db.query(extract(checkpointSource,'project_org_package_execution_request'));
  await db.query(readFileSync('tests/fixtures/nonbillable-release-predecessor.sql','utf8'));
  await db.query('revoke all on function project_org_retest_set_release_gate(uuid,text,text,text,bigint) from public,anon,authenticated,service_role');
  const oldSha=sha('1'),newSha=sha('2'),oldDeployment='dpl_OldFixture',newDeployment='dpl_NewFixture';
  ids.reviewer=randomUUID();
  await db.query('update work_projects set active_mission_id=$1,deadline=(select cutoff from project_package_checkpoint_continuations),spec=$2',[ids.mission,{milestones:[{contract}],finalContract:contract}]);
  await db.query('update project_work_packages set worker_id=$1,writer_id=$1,reviewer_id=$2,deadline=(select cutoff from project_package_checkpoint_continuations)',[ids.worker,ids.reviewer]);
  for(const agent of [ids.worker,ids.reviewer]){
   await db.query('insert into managed_agents(id) values($1) on conflict(id) do nothing',[agent]);
   await db.query("insert into project_organization_nodes values($1,$2,$1,'active',(select cutoff from project_package_checkpoint_continuations))",[agent,ids.project]);
  }
  await db.query('insert into project_package_execution_receipts(project_id,package_id,owner_id,scope_hash,authorization_id,historical_mission_ids) values($1,$2,$3,$4,$5,$6)',[ids.project,ids.package,ids.owner,SCOPE,ids.authorization,Array.from({length:104},randomUUID)]);
  const historical=(await db.query('select historical_mission_ids ids from project_package_execution_receipts')).rows[0].ids;
  for(const id of historical)await db.query("insert into agent_missions(id,project_id,project_kind,status) values($1,$2,'management','completed')",[id,ids.project]);
  for(let i=1;i<=4;i++)await db.query('insert into project_work_package_attempts values($1,$2,$3)',[ids.package,ids.mission,i]);
  await db.query("update agent_missions set deadline=(select cutoff from project_package_checkpoint_continuations),project_evidence=$1 where id=$2",[{packageExecutionAuthorizationId:ids.authorization},ids.mission]);
  await db.query('insert into project_provider_execution select project_id,owner_id,authorization_id,cutoff,$1 from project_package_checkpoint_continuations',[SCOPE]);
  await db.query('insert into project_execution_windows select authorization_id,project_id,owner_id,cutoff from project_package_checkpoint_continuations');
  await db.query('update project_package_checkpoint_continuations set terms=project_org_package_checkpoint_terms(),renewed_fingerprint=project_org_package_execution_fingerprint(package_id),release_sha=$1,release_generation=71,deployment_id=$2',[oldSha,oldDeployment]);
  await db.query("insert into project_retest_production_release_gate values($1,$2,$3,'katie-mu.vercel.app','active',71,now())",[ids.project,oldSha,oldDeployment]);
  await db.query('insert into project_blocked_management_retest_receipts values($1,78)',[ids.project]);
  const gate=(action,sha,dep,generation)=>db.query('select project_org_retest_set_release_gate($1,$2,$3,$4,$5)',[ids.project,sha,dep,action,generation]);
  await assert.rejects(gate('closed',oldSha,oldDeployment,71),/Exact original project release authority/);
  const paidDefinitions=(await db.query("select proname,prosrc from pg_proc where proname in('project_org_package_checkpoint_live','project_org_package_checkpoint_dispatch_live','project_org_package_execution_request') order by proname")).rows;
  await db.query(readFileSync(migration,'utf8'));
  assert.deepEqual((await db.query("select proname,prosrc from pg_proc where proname in('project_org_package_checkpoint_live','project_org_package_checkpoint_dispatch_live','project_org_package_execution_request') order by proname")).rows,paidDefinitions);
  const live=(sha=oldSha,gen=71,dep=oldDeployment)=>(db.query('select project_org_package_nonbillable_release_live($1,$2,$3,$4) ok',[ids.project,sha,gen,dep])).then(r=>r.rows[0].ok);
  assert.equal(await live(),true);
  const negative=async(sql,args=[],pattern)=>{await db.query('begin');try{await db.query(sql,args);if(pattern)await assert.rejects(gate('closed',oldSha,oldDeployment,71),pattern);else await assert.rejects(gate('closed',oldSha,oldDeployment,71));}finally{await db.query('rollback');}};
  await negative("update work_projects set lease=gen_random_uuid()",[],/authority/);
  await negative("update mission_assignments set lease=gen_random_uuid()",[],/authority/);
  await negative("update agent_tasks set status='submitted'",[],/authority/);
  await negative("update project_package_checkpoint_continuations set cutoff=now()-interval '1 minute'",[],/authority/);
  await negative("update project_work_packages set contract='{}'",[],/evidence/);
  await negative("update project_package_checkpoint_continuations set terms=jsonb_set(terms,'{stopAt}','\"production\"')",[],/authority/);
  await negative("insert into project_provider_requests(id,project_id,assignment_id,operation,started_at,resolved_at,provider_receipt) values(gen_random_uuid(),$1,$2,'inference',now(),now(),'unapproved')",[ids.project,ids.task],/authority/);
  await negative("update project_provider_requests set resolved_at=null where operation='inference'",[],/evidence/);
  for(const role of ['anon','authenticated','service_role']){
   await db.query('set role '+role);await assert.rejects(gate('closed',oldSha,oldDeployment,71),{code:'42501'});
   await assert.rejects(db.query('select project_org_package_nonbillable_release_qualify($1,$2,73,$3,$4)',[ids.project,newSha,newDeployment,{}]),{code:'42501'});
   await db.query('reset role');
  }
  // A genuine paid predicate has a positive control on its original signed
  // identity. The same controlled pending-phase state must fail after release.
  const paidControl=async expected=>{
   await db.query('begin');try{
    await db.query("update work_projects set status='running';update agent_missions set status='running' where id=(select mission_id from project_package_checkpoint_continuations)");
    await db.query("update project_package_checkpoint_continuations set proof=proof||'{\"priorRunId\":\"122\"}'");
    await db.query("update agent_tasks set status='submitted',external=external||jsonb_build_object('providerExecutionRelease',$1::text,'checkpointRecoveryDispatchClaimedAt',now())",[oldSha]);
    await db.query("update agent_tasks set external=jsonb_set(external,'{receipt,run_id}','122')");
    const got=(await db.query('select project_org_package_execution_request($1,$2,$3,$4) ok',[ids.task,'123','input-count',SCOPE])).rows[0].ok;
    assert.equal(got,expected,'real provider admission is bound to the original paid release');
   }finally{await db.query('rollback');}
  };
  await paidControl(true);
  const before=(await db.query('select to_jsonb(c) cp from project_package_checkpoint_continuations c')).rows[0].cp;
  await assert.rejects(gate('closed',oldSha,oldDeployment,70),/generation changed/);
  await gate('closed',oldSha,oldDeployment,71);
  assert.equal(await live(),false);
  await assert.rejects(gate('active',newSha,newDeployment,71),/generation changed/);
  await gate('active',newSha,newDeployment,72);
  assert.equal(await live(newSha,73,newDeployment),false,'opening gate alone never qualifies runtime delivery');
  await paidControl(false);
  const q={releaseSha:newSha,deploymentId:newDeployment,canonicalAlias:'katie-mu.vercel.app',conclusion:'success',candidateSha:proof.candidateSha,additionalPaidInference:0,testedTree:sha('3'),pullRequest:'1197',ciRunId:'124'};
  const qualify=(client=db,value=q)=>client.query('select project_org_package_nonbillable_release_qualify($1,$2,$3,$4,$5) result',[ids.project,newSha,73,newDeployment,value]).then(r=>r.rows[0].result);
  for(const bad of [{...q,additionalPaidInference:1},{...q,candidateSha:sha('9')},{...q,conclusion:'failure'},{...q,testedTree:null},{...q,canonicalAlias:'other.vercel.app'}])await assert.rejects(qualify(db,bad),/qualified active/);
  const peer=new pg.Client({host:tcp?'127.0.0.1':root,port,user:'postgres',database:'postgres'});await peer.connect();
  try{const [first,second]=await Promise.all([qualify(),qualify(peer)]);assert.equal(first.receiptId,second.receiptId);}finally{await peer.end();}
  assert.equal(await live(newSha,73,newDeployment),true);
  assert.equal(await live(newSha,72,newDeployment),false);assert.equal(await live(oldSha,73,newDeployment),false);
  await paidControl(false);
  await assert.rejects(qualify(db,{...q,ciRunId:'125'}),/different evidence/);
  await assert.rejects(db.query("update project_events set data='{}' where event='package_nonbillable_release_qualified'"),/immutable/);
  await assert.rejects(db.query("delete from project_events where event='package_nonbillable_release_transition'"),/immutable/);
  await db.query('grant insert on project_events to service_role');await db.query('set role service_role');
  await assert.rejects(db.query("insert into project_events(project_id,event,data) values($1,'package_nonbillable_release_qualified','{}')",[ids.project]),/release operator/);
  await db.query('reset role');
  assert.deepEqual((await db.query('select to_jsonb(c) cp from project_package_checkpoint_continuations c')).rows[0].cp,before);
  assert.equal((await db.query('select count(*) n from project_provider_requests')).rows[0].n,'2');
  assert.equal((await db.query('select count(*) n from project_package_corrective_receipts')).rows[0].n,'1');
  assert.equal((await db.query("select external->'receipt'->>'outcome' outcome from agent_tasks")).rows[0].outcome,'BLOCKED');
  assert.equal((await db.query("select count(*) n from project_events where event='package_nonbillable_release_qualified'")).rows[0].n,'1');
  await assertFinalAssessmentRelease({db,ids,contract,contractHash,binding,proof,receipt,newSha,newDeployment,oldSha,oldDeployment,before});
 }finally{
  await db?.end();if(started)spawnSync(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{timeout:15000});rmSync(root,{recursive:true,force:true});
 }
});
