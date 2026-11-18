import test from 'node:test';
import assert from 'node:assert/strict';
import {fork, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';

const PROJECT='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
const SCOPE='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
const AUTHORIZE='select project_org_authorize_blocked_owner_window($1,$2,$3,$4,$5,$6,$7,$8) r';
const RESUME='select project_org_resume_blocked_owner_confirmed($1,$2,$3,$4,$5,$6) r';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

const capture=async(client,project,windowId)=>{
 await client.query('reset role');
 try{
  const historical={};
  const q={
   missions:'select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.id)::text,\'[]\')) hash from agent_missions m where m.project_id=$1',
   assignments:'select md5(coalesce(jsonb_agg(to_jsonb(j) order by j.id)::text,\'[]\')) hash from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1',
   decisions:'select md5(coalesce(jsonb_agg(to_jsonb(d) order by d.id)::text,\'[]\')) hash from project_organization_decisions d where d.project_id=$1',
   exceptions:'select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id)::text,\'[]\')) hash from project_organization_exceptions e where e.project_id=$1',
   packages:'select md5(coalesce(jsonb_agg(to_jsonb(p) order by p.id)::text,\'[]\')) hash from project_work_packages p where p.project_id=$1',
   providerRequests:'select md5(coalesce(jsonb_agg(to_jsonb(r) order by r.id)::text,\'[]\')) hash from project_provider_requests r where r.project_id=$1',
   nodes:"select md5(coalesce(jsonb_agg(to_jsonb(n)-'deadline'-'decision_needed' order by n.id)::text,'[]')) hash from project_organization_nodes n where n.project_id=$1",
   oldRenewal:'select md5(coalesce(jsonb_agg(to_jsonb(r) order by r.project_id)::text,\'[]\')) hash from project_paused_window_renewals r where r.project_id=$1',
   oldResume:'select md5(coalesce(jsonb_agg(to_jsonb(r) order by r.project_id)::text,\'[]\')) hash from project_management_resume_receipts r where r.project_id=$1',
   priorContracts:'select md5(coalesce(jsonb_agg(to_jsonb(c) order by to_jsonb(c)::text)::text,\'[]\')) hash from project_organization_contract_changes c where c.project_id=$1 and c.window_id<>$2',
   priorEvents:"select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id)::text,'[]')) hash from project_events e where e.project_id=$1 and e.event not in ('blocked_owner_window_authorized','blocked_owner_management_resumed')",
  };
  for(const [name,sql] of Object.entries(q)){
   const params=name==='priorContracts'?[project,windowId]:[project];
   historical[name]=(await client.query(sql,params)).rows[0].hash;
  }
  return historical;
 }finally{await client.query('set role service_role');}
};

const counts=async(client,project,windowId)=>{
 await client.query('reset role');
 try{
  const query=async(sql,params=[project])=>(await client.query(sql,params)).rows[0].n;
  return {
   missions:await query('select count(*)::int n from agent_missions where project_id=$1'),
   assignments:await query('select count(*)::int n from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1'),
   packages:await query('select count(*)::int n from project_work_packages where project_id=$1'),
   windows:await query('select count(*)::int n from project_blocked_owner_windows where project_id=$1'),
   resumes:await query('select count(*)::int n from project_blocked_owner_resumes where project_id=$1'),
   newContracts:await query('select count(*)::int n from project_organization_contract_changes where project_id=$1 and window_id=$2',[project,windowId]),
   authorizedEvents:await query("select count(*)::int n from project_events where project_id=$1 and event='blocked_owner_window_authorized'"),
   resumedEvents:await query("select count(*)::int n from project_events where project_id=$1 and event='blocked_owner_management_resumed'"),
   decisionsNeeded:await query('select count(*)::int n from project_organization_nodes where project_id=$1 and decision_needed'),
  };
 }finally{await client.query('set role service_role');}
};

async function observeRealRpcLock(observer, contenderPid, label, contender){
 assert.ok(Number.isInteger(contenderPid)&&contenderPid>0,'Second PostgreSQL backend PID required');
 const samples=[];
 for(let i=0;i<12;i++){
  const [activity,locks]=await Promise.all([
   observer.query('select state,wait_event_type,wait_event from pg_stat_activity where pid=$1',[contenderPid]),
   observer.query('select locktype,mode,granted from pg_locks where pid=$1 and granted=false',[contenderPid])
  ]);
  const r=activity.rows[0];
  if(i===0||i===5)samples.push({activity:r??null,ungranted:locks.rows});
  if(locks.rows.some(x=>x.locktype==='advisory')){
   console.log('BLOCKED_OWNER_COMMITTED_RPC_LOCK_OBSERVED: '+label+' pg_locks advisory');
   return;
  }
  if(r?.wait_event_type==='Lock'){
   console.log('BLOCKED_OWNER_COMMITTED_RPC_LOCK_OBSERVED: '+label+' pg_stat_activity '+r.wait_event);
   return;
  }
  const done=await Promise.race([
   contender.then(outcome=>({complete:true,outcome})),
   sleep(1).then(()=>({complete:false}))
  ]);
  if(done.complete)throw Error(label+': competing actual RPC returned before commit: '+String(done.outcome.ok?'UNEXPECTED SUCCESS':done.outcome.error?.message));
  await sleep(50);
 }
 // PostgreSQL can restrict activity statistics to the observer. This remains
 // a genuine pending second RPC while the first RPC's transaction holds its
 // locks; subsequent commit, rejected contender and receipts MUST also pass.
 console.log('BLOCKED_OWNER_COMMITTED_RPC_PENDING_PASS: '+label+
  ' real contender remained pending before first RPC commit; visibility='+JSON.stringify(samples));
}
async function realRace(a,b,observer,contenderPid,label,query,firstArgs,otherArgs){
 await a.query('begin');
 let committed=false;
 try{
  const first=(await a.query(query,firstArgs)).rows[0].r;
  const rival=b.query(query,otherArgs).then(
   result=>({ok:true,result:result.rows[0].r}),
   error=>({ok:false,error})
  );
  try{
   await observeRealRpcLock(observer,contenderPid,label,rival);
  }finally{
   await a.query('commit');
   committed=true;
  }
  const second=await rival;
  assert.equal(second.ok,false,label+' contender must not create another transition');
  assert.match(second.error.message,/owner|authorization|release|window|state|receipt|required|blocked|current/i);
  return {first,secondError:second.error.message};
 }finally{
  if(!committed)await a.query('rollback').catch(()=>{});
 }
}

test('new owner authorization and resume RPCs serialize across two committed-schema PostgreSQL connections',
 {timeout:240000},async()=>{
  const child=fork('tests/benchmark-renewal-postgres.test.mjs',[],{
   cwd:process.cwd(),execArgv:[],
   stdio:['ignore','pipe','pipe','ipc'],
   // The standalone native workflow sets these flags at job scope; full
   // npm test does not. Bind the complete 76-mission fixture chain explicitly
   // so the child cannot exit successfully before installing committed DDL.
   env:{...process.env,
    KATIE_TEST_COMPLETION_CONTROLS:'1',
    KATIE_TEST_AMENDMENT_SUCCESSOR:'1',
    KATIE_TEST_CAPACITY_RENEWAL:'1',
    KATIE_TEST_LIFECYCLE_AUTHORIZATION:'1',
    KATIE_TEST_ORDINARY_AUTHORITY:'1',
    KATIE_TEST_PROJECT_ORGANIZATION:'1',
    KATIE_TEST_DIRECTOR_ONE_SHOT:'1',
    KATIE_TEST_ORG_AMENDMENTS:'1',
    KATIE_TEST_BLOCKED_OWNER_RECOVERY:'1',
    KATIE_TEST_BLOCKED_OWNER_BROWSER:'0',
    KATIE_TEST_BLOCKED_OWNER_RACE_FIXTURE:'1',
    KATIE_TEST_PG_TCP:'1'},
  });
  let childOutput='',ready=false,port=55489,dataDir=null;
  const append=(buf)=>{childOutput=(childOutput+buf.toString()).slice(-20000);};
  child.stdout.on('data',append);
  child.stderr.on('data',append);
  const first=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});
  const second=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});
  const observer=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});
  let connected=false;
  try{
   const fixture=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Committed fixture startup timeout. '+childOutput)),160000);
    const fail=code=>{clearTimeout(timer);reject(Error('Fixture exited before committed DDL. Exit '+code+'. '+childOutput));};
    child.once('exit',fail);
    child.on('message',message=>{
     if(message?.kind==='blocked-owner-race-ready'){
      clearTimeout(timer);child.removeListener('exit',fail);resolve(message);
     }
    });
   });
   ready=true;
   assert.equal(fixture.project,PROJECT);
   assert.equal(fixture.release,'b'.repeat(40));
   await Promise.all([first.connect(),second.connect(),observer.connect()]);
   connected=true;
   dataDir=(await observer.query('show data_directory')).rows[0].data_directory;
   await first.query('set role service_role');
   await second.query('set role service_role');
   const functionVisibility=(await observer.query(
    "select to_regprocedure('public.project_org_authorize_blocked_owner_window(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid,text)') a,"+
    "to_regprocedure('public.project_org_resume_blocked_owner_confirmed(uuid,uuid,text,uuid,timestamptz,text)') b"
   )).rows[0];
   assert.ok(functionVisibility.a&&functionVisibility.b,'Both genuine new functions are COMMITTED and visible to the third connection');
   console.log('BLOCKED_OWNER_COMMITTED_DDL_VISIBLE_PASS: both real RPC definitions visible across sessions');
   const firstPid=(await first.query('select pg_backend_pid() pid')).rows[0].pid;
   const secondPid=(await second.query('select pg_backend_pid() pid')).rows[0].pid;
   const observerPid=(await observer.query('select pg_backend_pid() pid')).rows[0].pid;
   assert.ok(new Set([firstPid,secondPid,observerPid]).size===3,
    'Fixture must have three distinct real PostgreSQL backends; first two execute competing RPCs');
   console.log('BLOCKED_OWNER_CONNECTION_IDENTITIES_PASS: '+JSON.stringify({firstPid,secondPid,observerPid}));
   const activityAccess=(await observer.query("select current_user, session_user, current_setting('track_activities') tracked, (select rolsuper from pg_roles where rolname=current_user) superuser")).rows[0];
   console.log('BLOCKED_OWNER_ACTIVITY_VISIBILITY: '+JSON.stringify(activityAccess));


   const offerQuery='select project_org_blocked_owner_offer($1,$2,$3) r';
   const offer=async(client)=>(await client.query(offerQuery,[fixture.owner,PROJECT,fixture.release])).rows[0].r;
   const initial=await offer(first);
   assert.equal(initial.stage,'authorize');
   assert.equal(initial.status,'blocked');
   assert.equal(initial.historicalMissions,76);
   assert.equal(initial.maxMissions,96);
   assert.equal(initial.tokenAllowance,600000);
   assert.equal(initial.nodeCount,13);
   assert.equal(initial.priorWindowId,fixture.priorWindow);
   assert.equal(initial.priorCutoff,'2026-11-16T18:00:00+00:00');

   const future=new Date(Date.now()+3600000).toISOString();
   const winningWindow=randomUUID(),losingWindow=randomUUID();
   const authArgs=[fixture.owner,PROJECT,fixture.release,fixture.priorWindow,
    fixture.priorCutoff,future,winningWindow,initial.stateHash];
   const otherAuth=[...authArgs];otherAuth[6]=losingWindow;
   const historyBefore=await capture(observer,PROJECT,winningWindow);
   const baseline=await counts(observer,PROJECT,winningWindow);
   assert.equal(baseline.missions,76);
   assert.equal(baseline.windows,0);
   assert.equal(baseline.resumes,0);
   assert.equal(baseline.packages,0);
   assert.equal(baseline.decisionsNeeded,0);

   // A fully executed but rolled-back first authorization leaves no durable
   // authority. The next legitimate owner action may still proceed.
   await first.query('begin');
   try{
    const rolled=(await first.query(AUTHORIZE,authArgs)).rows[0].r;
    assert.equal(rolled.stage,'resume');
   }finally{await first.query('rollback');}
   assert.deepEqual(await counts(observer,PROJECT,winningWindow),baseline,
    'Rolled-back owner authorization cannot produce a window, contracts, event or mission');
   assert.equal((await offer(second)).stage,'authorize');
   console.log('BLOCKED_OWNER_COMMITTED_AUTH_ROLLBACK_PASS');

   // These are two REAL concurrent owner RPC calls (not direct lock probes).
   const authorized=await realRace(first,second,observer,secondPid,'authorize',AUTHORIZE,authArgs,otherAuth);
   assert.equal(authorized.first.stage,'resume');
   assert.equal(authorized.first.authorizationId,winningWindow);
   const authorizedCounts=await counts(observer,PROJECT,winningWindow);
   assert.deepEqual(authorizedCounts,{...baseline,windows:1,newContracts:13,authorizedEvents:1},
    'Only one atomic authorization, exactly 13 deadline contracts, zero missions');
   assert.deepEqual(await capture(observer,PROJECT,winningWindow),historyBefore,
    'Historical records unaffected by competing authorization RPCs');
   await assert.rejects(second.query(AUTHORIZE,authArgs),/owner authorization|state|window|receipt|required/i);
   await assert.rejects(second.query(AUTHORIZE,otherAuth),/owner authorization|state|window|receipt|required/i);
   const afterAuthorization=await offer(first);
   assert.equal(afterAuthorization.stage,'resume');
   assert.equal(afterAuthorization.authorizationId,winningWindow);
   assert.equal(afterAuthorization.status,'blocked');
   assert.equal((await observer.query('select status from work_projects where id=$1',[PROJECT])).rows[0].status,'blocked');
   console.log('BLOCKED_OWNER_COMMITTED_AUTH_RACE_PASS: two real sessions, one durable window, one rejected competitor');

   const resumeArgs=[fixture.owner,PROJECT,fixture.release,winningWindow,future,afterAuthorization.stateHash];
   await first.query('begin');
   try{
    const rolled=(await first.query(RESUME,resumeArgs)).rows[0].r;
    assert.equal(rolled.stage,'resumed');
    assert.equal(rolled.existing,false);
   }finally{await first.query('rollback');}
   assert.deepEqual(await counts(observer,PROJECT,winningWindow),authorizedCounts,
    'Rolled-back owner resume may not create a receipt, wake node, or change state');
   assert.equal((await offer(second)).stage,'resume');
   console.log('BLOCKED_OWNER_COMMITTED_RESUME_ROLLBACK_PASS');

   const resumed=await realRace(first,second,observer,secondPid,'resume',RESUME,resumeArgs,resumeArgs);
   assert.equal(resumed.first.stage,'resumed');
   assert.equal(resumed.first.existing,false);
   const resumedCounts=await counts(observer,PROJECT,winningWindow);
   assert.deepEqual(resumedCounts,{...authorizedCounts,resumes:1,resumedEvents:1,decisionsNeeded:1},
    'Only one management resume and single existing management wake-up, no missions');
   assert.deepEqual(await capture(observer,PROJECT,winningWindow),historyBefore,
    'Historical missions, assignments, decisions, exceptions, receipts and QA contracts are immutable');
   const post=await offer(first);
   assert.equal(post.stage,'resumed');
   assert.equal((await first.query(RESUME,[...resumeArgs.slice(0,5),post.stateHash])).rows[0].r.existing,true);
   await assert.rejects(second.query(RESUME,resumeArgs),/state|receipt|required|current/i);
   assert.deepEqual(await counts(observer,PROJECT,winningWindow),resumedCounts,
    'Idempotent fresh-state readback and stale replay are side-effect free');
   console.log('BLOCKED_OWNER_COMMITTED_RESUME_RACE_PASS: two real sessions, one receipt, idempotent fresh readback');

   await assert.rejects(first.query(offerQuery,[randomUUID(),PROJECT,fixture.release]),/owner|authenticated/i);
   await first.query('set role anon');
   try{await assert.rejects(first.query(RESUME,resumeArgs),/permission denied/i);}
   finally{await first.query('set role service_role');}
   const project=(await observer.query('select max_missions,token_allowance,approved_hash,approval_hash,active_mission_id,status from work_projects where id=$1',[PROJECT])).rows[0];
   assert.equal(project.max_missions,96);
   assert.equal(Number(project.token_allowance),600000);
   assert.equal(project.approved_hash,SCOPE);
   assert.equal(project.approval_hash,SCOPE);
   assert.equal(project.active_mission_id,null);
   assert.equal(project.status,'running');
   assert.equal((await observer.query('select count(*)::int n from project_organization_nodes where project_id=$1',[PROJECT])).rows[0].n,13);

   // A later lease-bound scheduler turn (NOT either owner click) admits one
   // source/window-bound management mission. Roll it back in this isolated DB.
   await first.query('begin');
   try{
    await first.query('reset role');
    const lease=randomUUID();
    await first.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '5 minutes' where id=$1",[PROJECT,lease]);
    await first.query('set role service_role');
    const scheduled=(await first.query('select project_org_schedule($1,$2) r',[PROJECT,lease])).rows[0].r;
    assert.ok(scheduled?.missionId,'Real authorized scheduler must admit one bounded management mission: '+JSON.stringify(scheduled));
    const m=(await first.query('select project_kind,project_evidence from agent_missions where id=$1',[scheduled.missionId])).rows[0];
    assert.equal(m.project_kind,'management');
    assert.equal(m.project_evidence.providerContinuationWindow,winningWindow);
    assert.equal(m.project_evidence.providerContinuationRelease,fixture.release);
    assert.equal((await first.query('select count(*)::int n from agent_missions where project_id=$1',[PROJECT])).rows[0].n,77);
   }finally{await first.query('rollback');}
   assert.deepEqual(await counts(observer,PROJECT,winningWindow),resumedCounts,
    'Normal scheduler test is rolled back; owner actions never consume missions or allowance');
   console.log('BLOCKED_OWNER_COMMITTED_NEXT_SCHEDULER_PASS: one bounded lawful management mission in rollback-only lease');

   // Exercise the exact subsequent 78-mission root failure after the original
   // owner resume. The helper commits synthetic state only to this disposable
   // fixture, proves REAL competing RPC contention, and tests mission 79
   // through a rolled-back normal scheduler turn. No production writes.
   await (await import('./helpers/assert-blocked-management-retest.mjs')).assertBlockedManagementRetest(
    first,second,observer,{project:PROJECT,owner:fixture.owner,priorRelease:fixture.release,
     windowId:winningWindow,scopeHash:SCOPE});
   const boundClaimRows=(await observer.query(
    'select count(*)::int n from project_retest_claim_release_receipts where project_id=$1',
    [PROJECT])).rows[0].n;
   assert.equal(boundClaimRows,0,'The mission79 exact release binding must never escape the disposable native transaction');
   console.log('BLOCKED_OWNER_REAL_TWO_CONNECTION_RPCS_PASS: COMMITTED schema, two actual concurrent authorize RPCs, two actual concurrent resume RPCs, single receipts, replay and rollback, 76/96 missions, 600000 allowance, 13 contracts, history and QA protections; zero live dispatch/inference');
  }catch(error){
   console.error('COMMITTED_RACE_DIAGNOSTIC: '+String(error?.stack||error));
   console.error('FIXTURE_TAIL: '+childOutput.slice(-5000));
   throw error;
  }finally{
   if(connected){
    await Promise.allSettled([first.end(),second.end(),observer.end()]);
   }else{
    for(const client of [first,second,observer])await client.end().catch(()=>{});
   }
   if(ready && child.connected)child.send({kind:'blocked-owner-race-finished'});
   await Promise.race([
    new Promise(resolve=>child.once('exit',resolve)),
    sleep(1200)
   ]);
   if(!child.killed)child.kill('SIGTERM');
   if(dataDir){
    const binary=(process.env.KATIE_TEST_PG_BIN||'/usr/lib/postgresql/16/bin')+'/pg_ctl';
    const stop=spawnSync(binary,['-D',dataDir,'-m','immediate','-w','stop'],{encoding:'utf8',timeout:15000});
    if(stop.status!==0)console.warn('Fixture PostgreSQL cleanup: '+String(stop.stderr||stop.error?.message||stop.status).slice(0,300));
   }
  }
});