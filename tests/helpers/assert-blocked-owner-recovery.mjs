import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';

// Invoked ONLY from the existing authenticated, native PostgreSQL #1057 fixture
// after its original renewal/resume receipts have actually been consumed.
// Every rewrite below belongs to an isolated SQL savepoint, never production.
export async function assertBlockedOwnerRecovery(db,x){
 const {project,owner,scopeHash,source,originalWindow,renewedWindow,activeRelease,actor,chat,rival}=x;
 const ORIGINAL='fe9d2658-41e3-44c1-ae8e-a0cba98371fe';
 const ORIGINAL_SOURCE='62cd8da3-1bcc-41ae-9470-574c6b05e420';
 const ORIGINAL_WINDOW='a08d3cac-6e3f-4c14-a75a-5f524987a676';
 const ORIGINAL_SCOPE='4849dff2cfce136b3a1f3db675ee3cc8e6e84315aa3cc3700ca529dcd84fe6c6';
 const PRIOR='2026-11-15T18:00:00Z',EXPIRED='2026-11-16T18:00:00Z';
 const NEW_RELEASE='b'.repeat(40);
 const future=new Date(Date.now()+3600000).toISOString();
 await db.query('savepoint blocked_owner_fixture');
 const reject=async(fn,regex)=>{
  await db.query('savepoint rejected_blocked_owner');
  try{await assert.rejects(fn(),regex);}
  finally{await db.query('rollback to savepoint rejected_blocked_owner');await db.query('release savepoint rejected_blocked_owner');}
 };
 try{
  await db.query('reset role');
  await db.query("set local session_replication_role='replica'");
  const replacements=[[project,ORIGINAL],[source.mission,ORIGINAL_SOURCE],[renewedWindow,ORIGINAL_WINDOW],[scopeHash,ORIGINAL_SCOPE]];
  for(const [before,after] of replacements){
   for(const {tablename} of (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows){
    const q='"'+tablename.replaceAll('"','""')+'"';
    const columns=(await db.query("select attname from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped and attgenerated='' and attidentity='' order by attnum",['public.'+q])).rows.map(r=>'"'+r.attname.replaceAll('"','""')+'"').join(',');
    if(columns)await db.query('update public.'+q+' t set ('+columns+')=(select '+columns+' from jsonb_populate_record(null::public.'+q+',replace(to_jsonb(t)::text,$1,$2)::jsonb)) where position($1 in to_jsonb(t)::text)>0',[before,after]);
   }
  }
  // Shift the previously executed (real) #1057 authorization records into the
  // exact expired/consumed state rather than inventing fresh receipts.
  await db.query('update project_execution_windows set cutoff=$2,prior_cutoff=$3 where id=$1',[ORIGINAL_WINDOW,EXPIRED,PRIOR]);
  await db.query("update project_execution_windows set prior_cutoff=$2::timestamptz-interval '24 hours',cutoff=$2 where id=$1",[originalWindow,PRIOR]);
  await db.query('update project_paused_window_renewals set cutoff=$2,prior_cutoff=$3 where project_id=$1',[ORIGINAL,EXPIRED,PRIOR]);
  await db.query('update project_management_resume_receipts set cutoff=$2 where project_id=$1',[ORIGINAL,EXPIRED]);
  await db.query('update project_organization_contract_changes set deadline=$2,prior_deadline=$3 where window_id=$1',[ORIGINAL_WINDOW,EXPIRED,PRIOR]);
  await db.query('update project_scoped_root_retry_receipts set cutoff=$2 where project_id=$1',[ORIGINAL,PRIOR]);
  await db.query('update work_projects set status=$2,phase=$3,active_mission_id=null,lease=null,lease_until=null,deadline=$4 where id=$1',
   [ORIGINAL,'blocked','development',EXPIRED]);
  await db.query('update project_provider_execution set deadline=$2 where project_id=$1',[ORIGINAL,EXPIRED]);
  await db.query('update project_organization_nodes set deadline=$2,decision_needed=false where project_id=$1',[ORIGINAL,EXPIRED]);
  // Existing 73 missions; append only three inert historical mission fixtures
  // to reproduce the observed 76/96, leaving source and old receipts intact.
  const n=(await db.query('select count(*)::int n from agent_missions where project_id=$1',[ORIGINAL])).rows[0].n;
  assert.equal(n,73);
  for(let i=n;i<76;i++)await db.query("insert into agent_missions select (jsonb_populate_record(null::agent_missions,to_jsonb(m)||jsonb_build_object('id',gen_random_uuid(),'status','blocked','project_evidence','{}'::jsonb))).* from agent_missions m where id=$1",[ORIGINAL_SOURCE]);
  await db.query("set local session_replication_role='origin'");
  await db.query('set role service_role');
  const get=async(sha=NEW_RELEASE,who=owner)=>db.query('select project_org_blocked_owner_offer($1,$2,$3) r',[who,ORIGINAL,sha]);
  // Reproduce the actual already-consumed old offer failing before the new path.
  await reject(()=>db.query('select project_org_management_activation_offer($1,$2,$3)',[owner,ORIGINAL,NEW_RELEASE]),/Recorded management resume does not match this release/);
  const migration=readFileSync('supabase/migrations/20261116195500_blocked_owner_window_resume.sql','utf8')
   .replace(/^begin;\s*/,'').replace(/\s*commit;\s*$/,'');
  // DDL is installed by the disposable fixture's privileged schema owner,
  // not by the service_role used for real owner RPCs.
  await db.query('reset role');
  await db.query(migration);
  await db.query('set role service_role');
  const offer=(await get()).rows[0].r;
  if(process.env.KATIE_TEST_BLOCKED_OWNER_BROWSER==='1')
   await (await import('./assert-blocked-owner-browser.mjs')).assertBlockedOwnerBrowser(db,{
    project:ORIGINAL,owner,release:NEW_RELEASE,
   });
  assert.equal(offer.stage,'authorize');assert.equal(offer.historicalMissions,76);
  assert.equal(offer.nodeCount,13);assert.equal(offer.status,'blocked');
  assert.equal(offer.priorCutoff,EXPIRED.replace('Z','+00:00'));
  assert.equal(offer.priorWindowId,ORIGINAL_WINDOW);
  const scopedSnapshot=async()=>{
   const result={};
   for(const table of ['agent_missions','project_organization_decisions','project_organization_exceptions','project_work_packages','project_provider_requests']){
    result[table]=(await db.query('select to_jsonb(t) r from '+table+' t where project_id=$1 order by to_jsonb(t)::text',[ORIGINAL])).rows;
   }
   result.assignments=(await db.query('select to_jsonb(j) r from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1 order by j.id',[ORIGINAL])).rows;
   result.nodes=(await db.query("select to_jsonb(n)-'deadline' r from project_organization_nodes n where project_id=$1 order by id",[ORIGINAL])).rows;
   result.project=(await db.query("select to_jsonb(p)-'deadline'-'status'-'detail'-'updated_at' r from work_projects p where id=$1",[ORIGINAL])).rows;
   result.provider=(await db.query("select to_jsonb(a)-'deadline'-'window_id'-'continuation_release_sha' r from project_provider_execution a where project_id=$1",[ORIGINAL])).rows;
   result.previousRenewal=(await db.query('select * from project_paused_window_renewals where project_id=$1',[ORIGINAL])).rows;
   result.previousResume=(await db.query('select * from project_management_resume_receipts where project_id=$1',[ORIGINAL])).rows;
   return result;
  };
  const before=await scopedSnapshot();
  const authorizeArgs=[owner,ORIGINAL,NEW_RELEASE,ORIGINAL_WINDOW,EXPIRED,future,randomUUID(),offer.stateHash];
  const authorize=(args=authorizeArgs)=>db.query('select project_org_authorize_blocked_owner_window($1,$2,$3,$4,$5,$6,$7,$8) r',args);
  const snapshotEntire=async()=>{
   const x={};
   await db.query('reset role');
   for(const {tablename} of (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows){
    x[tablename]=(await db.query('select to_jsonb(t) r from public."'+tablename.replaceAll('"','""')+'" t order by to_jsonb(t)::text')).rows;
   }
   await db.query('set role service_role');return x;
  };
  // Wrong owner, project, release and precise state are rejected before writes.
  await reject(()=>get(NEW_RELEASE,randomUUID()),/authenticated owner/);
  await reject(()=>get(activeRelease),/blocked and expired/);
  for(const role of ['anon','authenticated']){
   await db.query('reset role');await db.query('set role '+role);
   await reject(()=>get(),/permission denied/);
   await reject(()=>authorize(),/permission denied/);
   await db.query('set role service_role');
  }
  // SQL cannot know VERCEL_GIT_COMMIT_SHA; the authenticated production API
  // enforces the exact deployment SHA. SQL checks a fresh, immutable receipt.
  for(const [i,value] of [[0,randomUUID()],[1,randomUUID()],[3,randomUUID()],
   [4,PRIOR],[5,EXPIRED],[5,new Date(Date.now()+120000).toISOString()],
   [5,new Date(Date.now()+90000000).toISOString()],[6,ORIGINAL_WINDOW],[7,'f'.repeat(64)]]){
   await reject(()=>authorize(authorizeArgs.map((v,k)=>k===i?value:v)),/owner|cutoff|state|window|authority|authorization/i);
  }
  const beforeAll=await snapshotEntire();
  await db.query('reset role');
  await db.query("create function pg_temp.reject_blocked_window() returns trigger language plpgsql as $$begin if new.event='blocked_owner_window_authorized' then raise exception 'synthetic owner final-write abort';end if;return new;end$$");
  await db.query('create trigger reject_blocked_window before insert on project_events for each row execute function pg_temp.reject_blocked_window()');
  await db.query('set role service_role');
  await reject(()=>authorize(),/synthetic owner final-write abort/);
  assert.deepEqual(await snapshotEntire(),beforeAll,'Final-write exception must roll back all tables');
  await db.query('reset role');await db.query('drop trigger reject_blocked_window on project_events');await db.query('set role service_role');
  const receipt=(await authorize()).rows[0].r;
  assert.equal(receipt.stage,'resume');assert.equal(receipt.status,'blocked');
  const afterAuthorize=(await get()).rows[0].r;
  assert.equal(afterAuthorize.authorizationId,authorizeArgs[6]);assert.equal(afterAuthorize.stage,'resume');
  assert.equal((await db.query('select count(*)::int n from project_organization_contract_changes where window_id=$1',[authorizeArgs[6]])).rows[0].n,13);
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[ORIGINAL])).rows[0].n,76);
  assert.deepEqual(await scopedSnapshot(),before,'Deadline authorization preserves all existing non-authority state and historical evidence');
  assert.equal((await db.query('select status from work_projects where id=$1',[ORIGINAL])).rows[0].status,'blocked');
  await reject(()=>authorize(),/owner authorization/);
  if(rival){
   await rival.query('set role service_role');await rival.query("set statement_timeout='200ms'");
   try{await assert.rejects(rival.query('select project_org_authorize_blocked_owner_window($1,$2,$3,$4,$5,$6,$7,$8)',authorizeArgs),/statement timeout/);}
   finally{await rival.query('set statement_timeout=0');}
  }
  const resumeArgs=[owner,ORIGINAL,NEW_RELEASE,authorizeArgs[6],future,afterAuthorize.stateHash];
  const resume=(args=resumeArgs)=>db.query('select project_org_resume_blocked_owner_confirmed($1,$2,$3,$4,$5,$6) r',args);
  for(const [i,value] of [[0,randomUUID()],[1,randomUUID()],[2,'f'.repeat(40)],
   [3,randomUUID()],[4,EXPIRED],[5,offer.stateHash]]){
   await reject(()=>resume(resumeArgs.map((v,k)=>k===i?value:v)),/owner|release|receipt|state|current|window/i);
  }
  await db.query('savepoint resume_rollback');
  const simulated=(await resume()).rows[0].r;
  assert.equal(simulated.existing,false);
  assert.equal((await db.query('select status from work_projects where id=$1',[ORIGINAL])).rows[0].status,'running');
  assert.equal((await db.query('select project_provider_continued($1) ok',[ORIGINAL])).rows[0].ok,true);
  assert.equal((await db.query('select project_org_window_authorized($1,$2,$3,$4,$5) ok',[ORIGINAL,owner,NEW_RELEASE,
   (await db.query('select continuation_decision_id d from project_provider_execution where project_id=$1',[ORIGINAL])).rows[0].d,future])).rows[0].ok,true);
  assert.equal((await get()).rows[0].r.stage,'resumed');
  await db.query('rollback to savepoint resume_rollback');await db.query('release savepoint resume_rollback');
  assert.equal((await get()).rows[0].r.stage,'resume');
  // No task/mission gets dispatched by either owner RPC. Historical source
  // assignments must remain unclaimable under the new release.
  const resumed=(await resume()).rows[0].r;
  assert.equal(resumed.existing,false);
  assert.equal((await db.query('select count(*)::int n from project_blocked_owner_resumes where project_id=$1',[ORIGINAL])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[ORIGINAL])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[ORIGINAL])).rows[0].n,76);
  const fresh=(await get()).rows[0].r;
  assert.equal((await resume(resumeArgs.map((v,i)=>i===5?fresh.stateHash:v))).rows[0].r.existing,true);
  await reject(()=>resume(),/state|receipt/);
  assert.deepEqual(await scopedSnapshot(),before,'Actual resume preserves previous missions, assignments, decisions, contracts, limits and immutable receipts');
  assert.equal((await db.query('select project_provider_continued_assignment($1) ok',[source.job])).rows[0].ok,false);
  assert.equal((await db.query('select count(*)::int n from project_organization_nodes where project_id=$1 and deadline=$2',[ORIGINAL,future])).rows[0].n,13);
  for(const table of ['project_blocked_owner_windows','project_blocked_owner_resumes']){
   await db.query('reset role');await reject(()=>db.query('delete from '+table),/append-only/);await db.query('set role service_role');
  }
  console.log('BLOCKED_OWNER_CURRENT_STATE_POSTGRES_PASS: 76/96 missions, all 13 contracts, consumed original receipts, expired original cutoff, no active mission, owner-authorized bounded window then separate resume; rollback, replay, stale authority, original history, QA and release guards preserved; zero provider calls/dispatches');
 }finally{
  await db.query('rollback to savepoint blocked_owner_fixture');
  await db.query('release savepoint blocked_owner_fixture');
  await db.query('set role service_role');
 }
}
