import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import pg from 'pg';

test('ordinary owner approval atomically binds the displayed project snapshot',{timeout:90000},async()=>{
 const installed=existsSync('/usr/lib/postgresql')?readdirSync('/usr/lib/postgresql').sort((a,b)=>Number(b)-Number(a)):[];
 const bin=process.env.KATIE_TEST_PG_BIN||installed.map(v=>join('/usr/lib/postgresql',v,'bin')).find(p=>existsSync(join(p,'initdb')));
 assert.ok(bin&&existsSync(join(bin,'initdb')),'Native PostgreSQL required; set KATIE_TEST_PG_BIN');
 const root=mkdtempSync(join(tmpdir(),'katie-project-terms-')),data=join(root,'data'),log=join(root,'postgres.log');
 let started=false;const clients=[];
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,[r.stderr,r.error?.message,existsSync(log)?readFileSync(log,'utf8'):''].filter(Boolean).join('\n'));};
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  const tcp=process.env.KATIE_TEST_PG_TCP==='1',port=tcp?await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});}):55419;
  run('pg_ctl',['-D',data,'-l',log,'-o',tcp?`-h 127.0.0.1 -k '' -p ${port}`:`-h '' -k ${root} -p ${port}`,'-w','start']);started=true;
  const connect=async()=>{const c=new pg.Client({host:tcp?'127.0.0.1':root,port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});await c.connect();clients.push(c);return c;};
  const db=await connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create table actors(id uuid primary key,actor_kind text);create table chats(id uuid primary key,actor_id uuid,unique(id,actor_id));
   create table managed_agents(actor_id uuid);create table repo_sync_runs(id uuid primary key);create table agent_missions(id uuid primary key);
   create table standalone_owner_bindings(owner_id uuid,actor_id uuid,chat_id uuid);`);
  // Use the actual table definitions and security predicates, not test stand-ins.
  const projects=readFileSync('supabase/migrations/20261017141136_chat_projects.sql','utf8');
  await db.query(projects.match(/create table public\.work_projects \([\s\S]*?\n\);/)[0]);
  await db.query(projects.match(/create table public\.project_events\([\s\S]*?;/)[0]);
  const hierarchy=readFileSync('supabase/migrations/20261109172739_project_management_hierarchy.sql','utf8');
  await db.query(hierarchy.match(/alter table work_projects add column organization_version[^;]*;/)[0]);
  await db.query(hierarchy.match(/create table project_organization_authority \([\s\S]*?\n\);/)[0]);
  const provider=readFileSync('supabase/migrations/20261110010000_provider_controlled_game_trial.sql','utf8');
  await db.query(provider.match(/create table public\.project_provider_execution \([\s\S]*?\n\);/)[0]);
  await db.query(provider.match(/create function public\.project_provider_mode[\s\S]*?\$\$;/)[0]);
  const scope=readFileSync('supabase/migrations/20261028193000_standalone_provider_attempt_ledger.sql','utf8');
  await db.query(scope.match(/create function public\.standalone_verify_scope[\s\S]*?\$\$;/)[0]);
  const original=hierarchy.match(/create function project_org_authorize[\s\S]*?\$\$;/)[0];
  await db.query(original.replace('if exists(select 1 from project_organization_authority',"if project_provider_mode(p.id) then raise exception 'Trial uses provider account controls';end if;\n if exists(select 1 from project_organization_authority"));
  await db.query('revoke all on function project_org_authorize(uuid,uuid,text,numeric,numeric,boolean) from public;grant execute on function project_org_authorize(uuid,uuid,text,numeric,numeric,boolean) to service_role');
  assert.equal((await db.query("select count(*)::int n from pg_depend where refobjid='project_org_authorize(uuid,uuid,text,numeric,numeric,boolean)'::regprocedure and deptype='n'")).rows[0].n,0);
  await db.query(readFileSync('supabase/migrations/20261128195400_bind_project_owner_approval_terms.sql','utf8'));
  assert.equal((await db.query("select to_regprocedure('project_org_authorize(uuid,uuid,text,numeric,numeric,boolean)') f")).rows[0].f,null);
  const ids=Object.fromEntries(['owner','actor','chat','project','repository','otherRepository'].map(k=>[k,randomUUID()]));
  const terms={objective:'Build an inventory list.',clarifications:' Existing app only.',repositoryId:ids.repository,repository:'example/existing-app',deadline:'2099-01-01T12:00:00Z',limits:{codingJobs:3,missions:12,modelTokens:200000}};
  const hash=createHash('sha256').update(terms.objective+terms.clarifications).digest('hex');
  await db.query('insert into actors values($1,$2)',[ids.actor,'standard']);await db.query('insert into chats values($1,$2)',[ids.chat,ids.actor]);
  await db.query('insert into standalone_owner_bindings values($1,$2,$3)',[ids.owner,ids.actor,ids.chat]);
  await db.query('insert into repo_sync_runs values($1),($2)',[ids.repository,ids.otherRepository]);
  await db.query(`insert into work_projects(id,request_id,actor_id,chat_id,objective,clarifications,repository_id,repository_full_name,team,organization_version,deadline,max_cycles,max_missions,token_allowance)
   values($1::uuid,$1::uuid::text,$2,$3,$4,$5,$6,$7,'{}',1,$8,3,12,200000)`,[ids.project,ids.actor,ids.chat,terms.objective,terms.clarifications,ids.repository,terms.repository,terms.deadline]);
  const sql='select project_org_authorize($1,$2,$3,$4,$5,$6,$7) approved';
  const args=[ids.owner,ids.project,hash,1000001,1,true,terms];
  const authorize=(c=db,values=args)=>c.query(sql,values);
  for(const role of ['anon','authenticated']){await db.query('set role '+role);await assert.rejects(authorize(),{code:'42501'});await db.query('reset role');}
  await db.query('set role service_role');await assert.rejects(db.query('select project_org_authorize($1,$2,$3,1000001,1,true)',args.slice(0,3)),{code:'42883'});
  await assert.rejects(authorize(db,[randomUUID(),...args.slice(1)]),/owner-approved/);await db.query('reset role');
  const rejectedChange=async(query,values=[])=>{await db.query('begin');try{await db.query(query,values);await db.query('set local role service_role');await assert.rejects(authorize(),/Displayed project terms changed/);}finally{await db.query('rollback');}};
  for(const query of ["update work_projects set deadline=deadline+interval '1 hour'",'update work_projects set max_cycles=max_cycles+1','update work_projects set max_missions=max_missions+1','update work_projects set token_allowance=token_allowance+1000',"update work_projects set repository_full_name='example/changed-app'",'update work_projects set objective=objective||clarifications,clarifications=\'\''])await rejectedChange(query);
  await rejectedChange('update work_projects set repository_id=$1',[ids.otherRepository]);
  await db.query('set role service_role');
  for(const snapshot of [null,{}, {...terms,extra:true},{...terms,deadline:null},{...terms,limits:{...terms.limits,missions:13}}])await assert.rejects(authorize(db,[...args.slice(0,6),snapshot]),/Displayed project terms changed/);
  await assert.rejects(authorize(db,[...args.slice(0,6),{...terms,deadline:'invalid'}]),/timestamp/);await db.query('reset role');
  await db.query('begin');await db.query('insert into project_provider_execution(project_id,owner_id,objective_hash,deadline) values($1,$2,$3,$4)',[ids.project,ids.owner,hash,terms.deadline]);
  await assert.rejects(authorize(),/provider account controls/);await db.query('rollback');
  assert.equal((await db.query('select count(*)::int n from project_organization_authority')).rows[0].n,0);

  // A concurrent update owns the row first: approval waits, then rejects its stale snapshot.
  const concurrent=await connect();await concurrent.query('set role service_role');
  const pid=(await concurrent.query('select pg_backend_pid() pid')).rows[0].pid;
  await db.query('begin');await db.query("update work_projects set deadline=deadline+interval '1 hour'");
  const waiting=authorize(concurrent).then(()=>({approved:true}),error=>({error}));
  let blocked=false;
  for(let n=0;n<100;n++){if((await db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
  assert.equal(blocked,true,'Approval must wait for the project row lock');await db.query('commit');
  assert.match((await waiting).error?.message??'',/Displayed project terms changed/);
  assert.equal((await db.query('select count(*)::int n from project_events')).rows[0].n,0);
  await db.query('update work_projects set deadline=$1',[terms.deadline]);
  const approved=await authorize(concurrent);assert.equal(approved.rows[0].approved,true);
  assert.equal((await authorize(concurrent)).rows[0].approved,true);
  const events=(await db.query('select data from project_events')).rows;assert.equal(events.length,1);assert.deepEqual(events[0].data.terms,terms);
  assert.equal(events[0].data.ceilingMicrousd,1000001);assert.equal(events[0].data.perCallMicrousd,1);
  await assert.rejects(authorize(concurrent,[...args.slice(0,3),2000000,...args.slice(4)]),/silently amended/);
 }finally{
  await Promise.all(clients.map(c=>c.end()));if(started)spawnSync(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{timeout:15000});rmSync(root,{recursive:true,force:true});
 }
});
