import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

test('agent management: real SQL snapshots, grants, associations, concurrent admission and claims', {timeout:180000},async t=>{
 const bin=process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin';
 const root=mkdtempSync(join(tmpdir(),'katie-agents-')), data=join(root,'data');
 const clients=[];let started=false;
 const run=(name,args)=>{const r=spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,(r.stderr||r.error?.message||'')+(name==='pg_ctl'?readFileSync(join(root,'log'),'utf8'):''));};
 const connect=async()=>{const c=new pg.Client({host:root,port:55432,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});await c.connect();clients.push(c);return c;};
 try {
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  run('pg_ctl',['-D',data,'-l',join(root,'log'),'-o',`-h '' -k ${root} -p 55432`,'-w','start']);started=true;
  const db=await connect();
  await db.query(`create role anon;create role authenticated;create role service_role bypassrls;
   create table actors(id uuid primary key,name text,system_prompt text,review_mode text);
   create table chats(id uuid primary key,actor_id uuid references actors,title text,created_at timestamptz,updated_at timestamptz);
   create table chat_requests(request_id text primary key,actor_id text,chat_id text,status text,error_message text,updated_at timestamptz);grant select,update on chat_requests to service_role;create table repo_sync_runs(id uuid primary key,repository_full_name text);
   grant usage on schema public to service_role;grant select,insert,update on actors,chats,repo_sync_runs to service_role;alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  await db.query(readFileSync('supabase/migrations/20261016211426_agent_management.sql','utf8'));
  const cfg={name:'Researcher',instructions:'Analyze carefully',research:false,attachments:false,development:true,maxActiveTasks:1,maxInputChars:1000,reviewMode:'always'};
  const make=async(config=cfg)=>(await db.query('select save_managed_agent(null,$1,false) result',[config])).rows[0].result;
  const a=await make();
  const task=async(agent=a,kind='general',repo=null,id=randomUUID())=>(await db.query('select create_agent_task($1,$2,$3,$4,$5) result',[id,agent.id,'Saved task',kind,repo])).rows[0].result;
  const one=await task(),two=await task();
  await t.test('service-only tables and invoker functions reject real anon/authenticated calls',async()=>{
   const c=await connect();
   for(const role of ['anon','authenticated']){
    await c.query(`set role ${role}`);
    await assert.rejects(c.query('select * from managed_agents'),/permission denied/);
    await assert.rejects(c.query('select * from agent_tasks'),/permission denied/);
    await assert.rejects(c.query('select check_agent_chat($1,$2,$3)',[a.actor_id,one.chat_id,one.request_id]),/permission denied/);
    await assert.rejects(c.query('select save_managed_agent(null,$1,false)',[cfg]),/permission denied/);
    await c.query('reset role');
   }
   for(const privilege of ['UPDATE','DELETE','TRUNCATE'])assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',['service_role','agent_task_continuations',privilege])).rows[0].allowed,false);
   const rows=(await db.query("select relrowsecurity from pg_class where oid in ('managed_agents'::regclass,'agent_tasks'::regclass)")).rows;
   assert.ok(rows.every(r=>r.relrowsecurity));
   assert.ok((await db.query("select prosecdef from pg_proc where proname in ('save_managed_agent','create_agent_task','transition_agent_task','check_agent_chat','claim_agent_dispatch','claim_agent_execution')")).rows.every(r=>!r.prosecdef));
  });
  await t.test('updates preserve immutable task configuration and creation retries cannot change input',async()=>{
   await db.query('select save_managed_agent($1,$2,false)',[a.id,{...cfg,instructions:'Changed',research:true}]);
   assert.deepEqual((await db.query('select snapshot from agent_tasks where id=$1',[one.id])).rows[0].snapshot,cfg);
   assert.equal((await task(a,'general',null,one.id)).chat_id,one.chat_id);
   await assert.rejects(db.query('select create_agent_task($1,$2,$3,$4,null)',[one.id,a.id,'Forged','general']),/conflict/);
   await assert.rejects(make({...cfg,tools:['shell']}),/Invalid agent configuration/);
  });
  await t.test('two independent sessions serialize real admission and exactly one execution claim wins',async()=>{
   const c1=await connect(),c2=await connect();
   await c1.query('set role service_role');await c2.query('set role service_role');
   await c1.query('begin');await c1.query('select transition_agent_task($1,$2,null)',[one.id,'start']);
   const competing=c2.query('select transition_agent_task($1,$2,null)',[two.id,'start']).then(()=>({ok:true}),e=>({error:e}));
   let waiting=false;
   for(let i=0;i<100;i++){
    const r=await db.query("select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like 'select transition_agent_task%'");
    if(r.rows[0].n){waiting=true;break;}await new Promise(r=>setTimeout(r,10));
   }
   assert.ok(waiting,'second start actually waits on the first transaction');
   await c1.query('commit');assert.match((await competing).error.message,/Active task limit/);
   const claims=await Promise.all([c1,c2].map(c=>c.query('select claim_agent_execution($1,$2) won',[one.id,one.request_id])));
   assert.equal(claims.filter(r=>r.rows[0].won).length,1);
   await assert.rejects(c1.query('select check_agent_chat($1,$2,$3)',[a.actor_id,two.chat_id,one.request_id]),/admitted/);
   const authorized=(await c1.query('select check_agent_chat($1,$2,$3) task',[a.actor_id,one.chat_id,one.request_id])).rows[0].task;
   assert.equal(authorized.snapshot.instructions,cfg.instructions);
  });
  await t.test('abandoned turns recover once after the hard execution lifetime, with no automatic replay',async()=>{
   const c1=await connect(),c2=await connect();
   await c1.query('set role service_role');await c2.query('set role service_role');
   await db.query("set role anon");
   await assert.rejects(db.query("select recover_agent_execution($1,$2)",[one.id,one.request_id]),/permission denied/);
   await db.query('reset role');
   for(const during of [false,true]){
    const b=await make(),turn=await task(b);
    await db.query("select transition_agent_task($1,'start',null)",[turn.id]);
    await db.query('select claim_agent_execution($1,$2)',[turn.id,turn.request_id]);
    if(during)await db.query("insert into chat_requests values($1,$2,$3,'processing',null,now())",[turn.request_id,turn.actor_id,turn.chat_id]);
    assert.equal((await c1.query('select recover_agent_execution($1,$2) recovered',[turn.id,turn.request_id])).rows[0].recovered,false,'live work cannot be recovered');
    await db.query("update agent_tasks set execution_claimed_at=now()-interval '21 minutes' where id=$1",[turn.id]);
    const results=await Promise.all([c1,c2].map(c=>c.query('select recover_agent_execution($1,$2) recovered',[turn.id,turn.request_id])));
    assert.equal(results.filter(r=>r.rows[0].recovered).length,1);
    assert.equal((await db.query('select claim_agent_execution($1,$2) won',[turn.id,turn.request_id])).rows[0].won,false,'old request is never replayed');
    if(during)assert.equal((await db.query('select status from chat_requests where request_id=$1',[turn.request_id])).rows[0].status,'failed');
    const next=(await db.query("select transition_agent_task($1,'continue','Retry the saved task',$2,$3) task",[turn.id,randomUUID(),turn.request_id])).rows[0].task;
    assert.equal(next.chat_id,turn.chat_id);assert.deepEqual(next.snapshot,turn.snapshot);assert.notEqual(next.request_id,turn.request_id);
    assert.equal((await c1.query('select recover_agent_execution($1,$2) recovered',[turn.id,next.request_id])).rows[0].recovered,false);
    const claims=await Promise.all([c1,c2].map(c=>c.query('select claim_agent_execution($1,$2) won',[turn.id,next.request_id])));
    assert.equal(claims.filter(r=>r.rows[0].won).length,1);
   }
  });
  await t.test('continuation retries have immutable receipts during execution, after completion and after later turns',async()=>{
   const b=await make(),turn=await task(b),key=randomUUID();
   const c1=await connect(),c2=await connect();
   await c1.query('set role service_role');await c2.query('set role service_role');
   await db.query("update agent_tasks set status='completed' where id=$1",[turn.id]);
   const submit=(client,id=key,base=turn.request_id,message='Next turn')=>client.query("select transition_agent_task($1,'continue',$2,$3,$4) task",[turn.id,message,id,base]).then(r=>r.rows[0].task);
   await c1.query('begin');const first=await submit(c1);
   const retry=submit(c2);await c1.query('commit');
   const duplicate=await retry;
   assert.equal(duplicate.request_id,first.request_id);assert.equal(duplicate.continuation_receipt.request_id,first.request_id);
   const claims=await Promise.all([c1,c2].map(c=>c.query('select claim_agent_execution($1,$2) won',[turn.id,first.request_id])));
   assert.equal(claims.filter(r=>r.rows[0].won).length,1);
   assert.equal((await submit(c1)).request_id,first.request_id,'retry during execution');
   await db.query("update agent_tasks set status='completed' where id=$1",[turn.id]);
   assert.equal((await submit(c1)).request_id,first.request_id,'retry after completion');
   await assert.rejects(submit(c1,key,turn.request_id,'Changed'),/conflict/);
   await assert.rejects(submit(c1,key,first.request_id),/conflict/);
   const later=await submit(c1,randomUUID(),first.request_id,'Later turn');
   const old=await submit(c2);
   assert.equal(old.request_id,later.request_id);assert.equal(old.continuation_receipt.request_id,first.request_id);
   assert.notEqual(old.request_id,old.continuation_receipt.request_id,'old receipt cannot authorize the later turn');
   await assert.rejects(submit(c2,randomUUID(),first.request_id,'Competing later turn'),/advanced/);
   assert.equal((await db.query('select count(*)::int n from agent_task_continuations where task_id=$1',[turn.id])).rows[0].n,2);
   await c1.query('reset role');await c1.query('set role anon');
   await assert.rejects(c1.query('select * from agent_task_continuations'),/permission denied/);
   await c1.query('reset role');await c1.query('set role authenticated');
   await assert.rejects(c1.query('select * from agent_task_continuations'),/permission denied/);
  });
  await t.test('overlapping definition edits and archive serialize with task starts without changing snapshots',async()=>{
   const c1=await connect(),c2=await connect();
   const waitForLock=async()=>{for(let i=0;i<100;i++){const r=await db.query("select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like 'select transition_agent_task%'");if(r.rows[0].n)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected real start/definition row-lock overlap');};
   const b=await make(),pending=await task(b);
   await c1.query('begin');await c1.query('select save_managed_agent($1,$2,false)',[b.id,{...cfg,research:true,instructions:'New definition'}]);
   const start=c2.query('select transition_agent_task($1,$2,null) task',[pending.id,'start']);
   await waitForLock();await c1.query('commit');
   assert.deepEqual((await start).rows[0].task.snapshot,cfg);
   const archived=await make(),unstarted=await task(archived);
   await c1.query('begin');await c1.query('select save_managed_agent($1,$2,true)',[archived.id,cfg]);
   const rejected=c2.query('select transition_agent_task($1,$2,null)',[unstarted.id,'start']).then(()=>null,error=>error);
   await waitForLock();await c1.query('commit');assert.match((await rejected).message,/archived/);
  });
  await t.test('archive stops new tasks while preserving admitted context and FK history',async()=>{
   await db.query('select save_managed_agent($1,$2,true)',[a.id,cfg]);
   await assert.rejects(task(),/archived/);
   await assert.rejects(db.query('select transition_agent_task($1,$2,null)',[two.id,'start']),/archived/);
   assert.ok((await db.query('select check_agent_chat($1,$2,$3)',[a.actor_id,one.chat_id,one.request_id])).rows.length);
   await assert.rejects(db.query('delete from actors where id=$1',[a.actor_id]),/foreign key/);
   await assert.rejects(db.query('delete from chats where id=$1',[one.chat_id]),/foreign key/);
  });
  await t.test('development requires connected repo, permission and one durable dispatch claim',async()=>{
   const b=await make(), repo=randomUUID();
   await assert.rejects(task(b,'development',repo),/Connected repository/);
   await db.query('insert into repo_sync_runs values($1,$2)',[repo,'owner/repo']);
   const d=await task(b,'development',repo);
   await db.query('select transition_agent_task($1,$2,null)',[d.id,'start']);
   const claims=await Promise.all([db,await connect()].map(c=>c.query('select claim_agent_dispatch($1) won',[d.id])));
   assert.equal(claims.filter(r=>r.rows[0].won).length,1);
   const no=await make({...cfg,development:false});await assert.rejects(task(no,'development',repo),/denied/);
  });
 }finally{await Promise.allSettled(clients.map(c=>c.end()));if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);rmSync(root,{recursive:true,force:true});}
});
