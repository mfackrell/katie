import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// QA-only assertions. This module must never be committed to the implementation
// PR: the isolated QA runner copies it into a detached exact-source checkout.
const keepAuthority=[
 'project_smart_contract','project_org_renew_paused_window',
 'project_org_resume_management','project_org_resume_management_confirmed',
 'project_org_management_activation_offer','project_org_schedule',
 'project_org_decide','project_org_hierarchy_recovery_state',
 'project_org_scoped_retry_release','project_org_management_resume_release',
];

export async function qaCaptureAuthority(db){
 await db.query('reset role');
 try{return (await db.query(
  "select proname,prosrc,proacl::text,proconfig,prosecdef,proowner from pg_proc where pronamespace='public'::regnamespace and proname=any($1) order by proname",
  [keepAuthority])).rows;}
 finally{await db.query('set role service_role');}
}
export async function qaSnapshotPublic(db){
 await db.query('reset role');
 const rows={};
 try{
  for(const {tablename} of (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows){
   rows[tablename]=(await db.query('select to_jsonb(t) r from public."'+tablename.replaceAll('"','""')+'" t order by to_jsonb(t)::text')).rows;
  }
  return rows;
 }finally{await db.query('set role service_role');}
}

export async function qaAssertInstallation(db,oldTables,oldAuthority){
 const now=await qaSnapshotPublic(db);
 for(const [name,rows] of Object.entries(oldTables))
  assert.deepEqual(now[name],rows,'QA installation may not change pre-existing '+name+' rows');
 for(const name of ['project_blocked_owner_windows','project_blocked_owner_resumes']){
  assert.ok(name in now,'expected additive receipt table: '+name);
  assert.equal(now[name].length,0,'new receipt tables must start empty');
 }
 assert.deepEqual(await qaCaptureAuthority(db),oldAuthority,
  'Existing original owner, SMART, scheduler, recovery, release and decision functions preserve bodies and ACLs');
 await db.query('reset role');
 let result;
 try{
  result=(await db.query(`select proname,prosecdef,proconfig,
   has_function_privilege('anon',oid,'EXECUTE') anon,
   has_function_privilege('authenticated',oid,'EXECUTE') authenticated,
   has_function_privilege('service_role',oid,'EXECUTE') service
   from pg_proc where pronamespace='public'::regnamespace
   and proname = any($1) order by proname`,
   [['project_org_blocked_owner_release','project_org_blocked_owner_offer',
     'project_org_authorize_blocked_owner_window','project_org_resume_blocked_owner_confirmed']])).rows;
 }finally{await db.query('set role service_role');}
 assert.equal(result.length,4);
 for(const f of result){
  assert.equal(f.prosecdef,true,f.proname+' SECURITY DEFINER');
  assert.ok(f.proconfig?.some(x=>/^search_path=public,\s*pg_temp$/.test(x)),
    f.proname+' must pin search path');
  assert.equal(f.anon,false,f.proname+' must deny anon');
  assert.equal(f.authenticated,false,f.proname+' must deny authenticated');
  assert.equal(f.service,f.proname!=='project_org_blocked_owner_release',
    f.proname+' must have only intended service-role entry permission');
 }
 console.log('INDEPENDENT_QA_BLOCKED_INSTALLATION_PASS: no historical project data mutated; original authority definitions/ACLs preserved; new service-only entry controls and private helper verified');
}

export async function qaAssertQaIsolationUnderFreshState(db,{project,owner,release}){
 await db.query('savepoint qa_invalid_delegation');
 try{
  await db.query('reset role');await db.query("set local session_replication_role='replica'");
  const rows=(await db.query("update project_organization_nodes set tools=array_append(tools,'development') where project_id=$1 and area in ('quality_assurance','independent_qa') returning id",[project])).rows;
  assert.ok(rows.length>=1,'original organization must contain QA node');
  await db.query("set local session_replication_role='origin'");await db.query('set role service_role');
  await assert.rejects(
   db.query('select project_org_blocked_owner_offer($1,$2,$3)',[owner,project,release]),
   /safeguards|contracts|history|changed|authority/i,
   'Fresh state cannot allow QA development tools');
 }finally{
  await db.query('rollback to savepoint qa_invalid_delegation');
  await db.query('release savepoint qa_invalid_delegation');
  await db.query('set role service_role');
 }
 console.log('INDEPENDENT_QA_BLOCKED_QA_ISOLATION_PASS: fresh QA tool escalation rejected, unchanged state restored');
}

export async function qaAssertNoPrematureNewRelease(db,{project,owner,release,cutoff}){
 const before=(await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n;
 assert.equal(before,76);
 const decision=(await db.query('select continuation_decision_id d from project_provider_execution where project_id=$1',[project])).rows[0].d;
 // This predicate intentionally denies service_role direct EXECUTE. Preserve
 // its production ACL; use only the disposable fixture schema owner to inspect.
 let authorized;
 await db.query('reset role');
 try{
  authorized=(await db.query('select project_org_window_authorized($1,$2,$3,$4,$5) ok',
   [project,owner,release,decision,cutoff])).rows[0].ok;
 }finally{await db.query('set role service_role');}
 assert.equal(authorized,false,'new release cannot claim before separate owner resume');
 const status=(await db.query('select status,active_mission_id from work_projects where id=$1',[project])).rows[0];
 assert.equal(status.status,'blocked');assert.equal(status.active_mission_id,null);
 assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
 console.log('INDEPENDENT_QA_BLOCKED_PRE_RESUME_FENCE_PASS: new release unauthorized before owner resume; no admitted missions or packages');
}

export async function qaAssertBoundedSchedulerAfterResume(db,{project,owner,release,previousRelease}){
 const prior=(await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n;
 assert.equal(prior,76);
 await db.query('savepoint qa_post_resume_scheduler');
 try{
  // Exercise three valid lease-bound scheduler attempts; all owner operations
  // have completed separately and no worker or provider is dispatched here.
  const waits=[];let r;
  for(let attempt=0;attempt<3;attempt++){
   const lease=randomUUID();
   await db.query('reset role');
   await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '5 minutes' where id=$1",[project,lease]);
   await db.query('set role service_role');
   r=(await db.query('select project_org_schedule($1,$2) r',[project,lease])).rows[0].r;
   if(r?.missionId)break;
   waits.push(r);
   assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,prior,
    'Waiting cannot spend mission allowance');
   assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0,
    'Waiting cannot silently publish a coding package');
  }
  if(waits.length){
   const flags=(await db.query('select count(*)::int n from project_organization_nodes where project_id=$1 and decision_needed',[project])).rows[0].n;
   console.log('INDEPENDENT_QA_BLOCKED_SCHEDULER_WAIT_TRACE: '+JSON.stringify({waits,decisionNeeded:flags,missionCount:prior}));
  }
  assert.ok(r?.missionId,'No bounded management mission after 3 valid scheduler attempts: '+JSON.stringify(waits));
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,prior+1);
  assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
  await db.query('reset role');
  await db.query("update agent_missions set status='blocked' where id<>$1 and status='running'",[r.missionId]);
  await db.query('update agent_missions set created_at=clock_timestamp() where id=$1',[r.missionId]);
  await db.query('set role service_role');
  const old=(await db.query('select claim_mission_work_release($1) c',[previousRelease])).rows[0].c;
  assert.notEqual(old?.mission?.id,r.missionId,'old release cannot claim newly authorized management work');
  const fresh=(await db.query('select claim_mission_work_release($1) c',[release])).rows[0].c;
  assert.equal(fresh?.mission?.id,r.missionId,'only exact current release can claim legitimate bounded work');
  assert.equal(fresh.mission.project_evidence.providerContinuationRelease,release);
  const window=(await db.query('select window_id from project_provider_execution where project_id=$1',[project])).rows[0].window_id;
  assert.equal(fresh.mission.project_evidence.providerContinuationWindow,window);
  console.log('INDEPENDENT_QA_BLOCKED_SCHEDULER_PASS: one bounded management mission, exact current source/window claim; old release denied');
 }finally{
  await db.query('rollback to savepoint qa_post_resume_scheduler');
  await db.query('release savepoint qa_post_resume_scheduler');
  await db.query('set role service_role');
 }
 assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,76,
   'QA scheduler attempt must leave parent fixture unmodified');
}
