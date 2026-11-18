import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

// All mutations below occur inside a disposable PostgreSQL fixture transaction.
// No production project, provider, or API write is performed by this qualification.
export async function assertBlockedManagementRetest(first,second,observer,{project,owner,priorRelease,windowId,scopeHash}){
 const source='911d15bd-be5f-416e-bbac-fbe86ca6fa90';
 const repairedRelease='c'.repeat(40);
 const migration='supabase/migrations/20261117162000_one_time_blocked_management_retest.sql';
 await observer.query('reset role'); // DDL belongs to the disposable fixture's postgres owner, never service_role.
 const installed=(await observer.query("select to_regprocedure('public.project_org_resume_blocked_management_once(uuid,uuid,text,uuid,uuid,timestamptz,text)') sig")).rows[0].sig;
 if(!installed)await observer.query(readFileSync(migration,'utf8'));
 const definitions=(await observer.query(
  "select to_regprocedure('public.project_org_blocked_management_retest_offer(uuid,uuid,text)') offer,"+
  "to_regprocedure('public.project_org_resume_blocked_management_once(uuid,uuid,text,uuid,uuid,timestamptz,text)') admit"
 )).rows[0];
 assert.ok(definitions.offer&&definitions.admit,'Both guarded definitions must exist in committed PostgreSQL');
 // Install and qualify the new source-bound claim grant against the SAME
 // committed native owner-authorization and genuine PostgreSQL scheduler.
 const releaseMigration='supabase/migrations/20261118002000_original_retest_mission_release_claim.sql';
 const releaseInstalled=(await observer.query(
  "select to_regprocedure('public.project_org_bind_retest_claim_release(uuid,uuid,text,uuid,uuid,text)') sig"
 )).rows[0].sig;
 if(!releaseInstalled)await observer.query(readFileSync(releaseMigration,'utf8'));
 const claimRelease=(await observer.query("select to_regprocedure('public.project_org_retest_claim_release_authorized(uuid,text)') sig")).rows[0].sig;
 assert.ok(claimRelease,"Original worker claim's new exact-release predicate must be installed");

 await first.query('begin');
 try{
  await first.query('reset role');
  const root=(await first.query(
   "select id,agent_id from project_organization_nodes where project_id=$1 and kind='project_director' and parent_id is null",
   [project])).rows[0];
  const game=(await first.query("select id,agent_id from project_organization_nodes where project_id=$1 and area='game_delivery' and management_level='functional_director'",[project])).rows[0];
  assert.ok(root&&game,'The real 13-node organization must be present');
  const rat=(await first.query("select approved_at from project_scope_ratification_approvals where project_id=$1 and scope_hash=$2",[project,scopeHash])).rows[0];
  assert.ok(rat,'Historical owner scope ratification preserved');
  const priorRootFailed=Number((await first.query(
   "select count(*)::int n from agent_missions where project_id=$1 and project_kind='management' and project_evidence->>'organizationNodeId'=$2 and status in ('blocked','stopped') and created_at >= $3",
   [project,root.id,rat.approved_at])).rows[0].n);
  assert.ok(priorRootFailed<=1,'Synthetic source requires fewer than two prior post-ratification root failures');
  const exemplar=(await first.query("select id from agent_missions where project_id=$1 order by created_at desc,id desc limit 1",[project])).rows[0].id;
  const firstId=randomUUID();
  for(const [i,id,node] of [
   [0,firstId,priorRootFailed===0?root:game],
   [1,source,root]
  ]){
   const detail=i===1?'Mission state operation failed: No delegation change requested':'Management session blocked';
   await first.query(`insert into agent_missions
    select (jsonb_populate_record(null::agent_missions,to_jsonb(m)||jsonb_build_object(
     'id',$2::uuid,'status','blocked','project_kind','management',
     'project_evidence',jsonb_build_object('organizationNodeId',$3::uuid,'previousMissionId',null,
      'providerContinuationWindow',$4::uuid,'providerContinuationRelease',$5::text),
     'created_at',clock_timestamp(),'updated_at',clock_timestamp(),'calls',1,
     'detail',$6::text))).*
    from agent_missions m where m.id=$1`,
    [exemplar,id,node.id,windowId,priorRelease,detail]);
   // Model the real scheduler's exact temporary active-mission binding so
   // the existing management execution trigger remains ENFORCED in this fixture.
   await first.query('update work_projects set active_mission_id=$2 where id=$1',[project,id]);
   await first.query(`insert into mission_assignments
    (id,mission_id,job_key,role,agent_id,instruction,payload,status,result)
    values($1,$2,'plan','work',$3,'Make bounded management decisions',
      jsonb_build_object('organizationNodeId',$5::uuid),'failed',
      jsonb_build_object('detail',$4::text))`,
    [i===1?'cd81b57d-0812-485c-b8f6-d658aa80186f':randomUUID(),id,node.agent_id,detail,node.id]);
  }
  await first.query("update project_organization_nodes set decision_needed=(id=$2) where project_id=$1",[project,root.id]);
  await first.query(`update work_projects set status='blocked',
   detail='Project management cannot achieve its objective within bounded retry authority',
   active_mission_id=$2,lease=null,lease_until=null where id=$1`,[project,source]);
  assert.equal((await first.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,78);
  // This is a disposable PostgreSQL server. Commit the synthetic 78-mission
  // state so the SECOND actual database connection sees the blocked source.
  await first.query('commit');
  await first.query('begin');
  assert.equal((await observer.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,78);
  const unmodified=async()=>{
   await first.query('reset role');
   try{
   const rows={};
   for(const [name,sql] of Object.entries({
    missions:'select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.id)::text,\'[]\')) h from agent_missions m where project_id=$1',
    assignments:"select md5(coalesce(jsonb_agg(to_jsonb(j) order by j.id)::text,'[]')) h from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1",
    decisions:"select md5(coalesce(jsonb_agg(to_jsonb(d) order by d.id)::text,'[]')) h from project_organization_decisions d where project_id=$1",
    exceptions:"select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id)::text,'[]')) h from project_organization_exceptions e where project_id=$1",
    nodes:"select md5(coalesce(jsonb_agg(to_jsonb(n)-'decision_needed' order by n.id)::text,'[]')) h from project_organization_nodes n where project_id=$1",
    grants:"select md5(coalesce(jsonb_agg(to_jsonb(g) order by g.node_id)::text,'[]')) h from project_organization_scope_grants g join project_organization_nodes n on n.id=g.node_id where n.project_id=$1",
    packages:"select count(*)::text h from project_work_packages where project_id=$1",
   }))rows[name]=(await first.query(sql,[project])).rows[0].h;
   return rows;
   }finally{await first.query('set role service_role');}
  };
  const history=await unmodified();
  await first.query('set role service_role');
  const args=[owner,project,repairedRelease];
  const readOffer=async()=>(await first.query('select project_org_blocked_management_retest_offer($1,$2,$3) r',args)).rows[0].r;
  const offer=await readOffer();
  assert.equal(offer.stage,'retest');assert.equal(offer.sourceMissionId,source);
  assert.equal(offer.windowId,windowId);assert.equal(offer.historicalMissions,78);
  assert.equal(offer.maxMissions,96);assert.equal(offer.tokenAllowance,600000);
  const call=[owner,project,repairedRelease,source,windowId,offer.cutoff,offer.stateHash];
  const commitOnce=()=>first.query('select project_org_resume_blocked_management_once($1,$2,$3,$4,$5,$6,$7) r',call);
  const raceNewOwnerRpc=async(label,sql,args)=>{
   const pid=(await second.query('select pg_backend_pid() pid')).rows[0].pid;
   const contender=second.query(sql,args).then(r=>({ok:true,result:r.rows[0].r}),error=>({ok:false,error}));
   let waiting=false;
   for(let i=0;i<30;i++){
    const locks=await observer.query('select locktype,granted from pg_locks where pid=$1 and granted=false',[pid]);
    if(locks.rows.some(l=>l.locktype==='advisory'&&!l.granted)){waiting=true;break;}
    const done=await Promise.race([contender.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),50))]);
    if(done)throw Error(label+' competing writer returned before first transaction committed');
   }
   assert.equal(waiting,true,label+' requires real two-client advisory-lock contention');
   await first.query('commit');
   const rival=await contender;
   assert.equal(rival.ok,false,label+' competing RPC must reject a consumed receipt');
   assert.match(rival.error.message,/window|owner|authorization|retest|state|already|recorded|bound|release|mission/i);
   await first.query('begin');
   console.log('MISSION79_NEW_'+label+'_TWO_CONNECTION_RACE_PASS: two real writer RPCs, one immutable receipt and rejected competing caller');
  };
  const rejected=async(action,regex)=>{
   await first.query('savepoint negative');
   try{await assert.rejects(action(),regex);}
   finally{await first.query('rollback to savepoint negative');await first.query('release savepoint negative');}
  };
  await rejected(()=>first.query('select project_org_blocked_management_retest_offer($1,$2,$3)',[randomUUID(),project,repairedRelease]),/owner|original|scope/i);
  await rejected(()=>first.query('select project_org_resume_blocked_management_once($1,$2,$3,$4,$5,$6,$7)',[...call.slice(0,6),'f'.repeat(64)]),/state|exact|retest/i);
  await first.query('set role anon');
  await rejected(commitOnce,/permission denied/i);
  await first.query('set role service_role');
  const reply=(await commitOnce()).rows[0].r;
  assert.equal(reply.stage,'admitted');assert.equal(reply.status,'running');assert.equal(reply.existing,false);
  assert.equal(reply.sourceMissionId,source);assert.equal(reply.historicalMissions,78);
  assert.deepEqual(await unmodified(),history,'Owner recovery cannot modify source history, tools, grants or packages');
  const projectRow=(await first.query('select status,active_mission_id,max_missions,token_allowance,deadline from work_projects where id=$1',[project])).rows[0];
  assert.equal(projectRow.status,'running');assert.equal(projectRow.active_mission_id,null);
  assert.equal(projectRow.max_missions,96);assert.equal(Number(projectRow.token_allowance),600000);
  assert.equal((await first.query('select count(*)::int n from project_blocked_management_retest_receipts where project_id=$1',[project])).rows[0].n,1);
  assert.equal((await readOffer()).stage,'admitted');
  await rejected(commitOnce,/retest|exact|owner/i);
  // Two distinct PostgreSQL backends invoke the ACTUAL new write RPC while
  // the first transaction still holds its advisory lock. This is not a
  // synthetic advisory lock probe or a sequential replay.
  // Capture the actual rival backend identity BEFORE issuing the pending
  // RPC. A second query on that client would queue behind the contender.
  const contenderPid=(await second.query('select pg_backend_pid() pid')).rows[0].pid;
  assert.ok(Number.isInteger(contenderPid)&&contenderPid>0);
  const competing=second.query(
   'select project_org_resume_blocked_management_once($1,$2,$3,$4,$5,$6,$7) r',call
  ).then(result=>({ok:true,result:result.rows[0].r}),error=>({ok:false,error}));
  let sawAdvisory=false;
  for(let i=0;i<24;i++){
   const locks=await observer.query(
    "select locktype,granted from pg_locks where pid=$1 and granted=false",
    [contenderPid]);
   if(locks.rows.some(lock=>lock.locktype==='advisory'&&!lock.granted)){
    sawAdvisory=true;break;
   }
   const raced=await Promise.race([
    competing.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),50))
   ]);
   if(raced)throw Error('Competing new owner RPC completed before first transaction committed');
  }
  assert.ok(sawAdvisory,'New retest RPC must exhibit actual two-client advisory lock contention');
  await first.query('commit');
  const rival=await competing;
  assert.equal(rival.ok,false,'Concurrent replay cannot create another owner receipt');
  assert.match(rival.error.message,/retest|state|required|exact|owner/i);
  await assert.rejects(second.query(
   'select project_org_resume_blocked_management_once($1,$2,$3,$4,$5,$6,$7)',call
  ),/retest|state|required|exact|owner/i);
  await first.query('begin');
  // No manual management decision: existing scheduler creates a fresh 79th mission, using its lease.
  await first.query('reset role');
  const lease=randomUUID();
  await first.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '5 minutes' where id=$1",[project,lease]);
  await first.query('set role service_role');
  const scheduled=(await first.query('select project_org_schedule($1,$2) r',[project,lease])).rows[0].r;
  // Bind the disposable scheduler-generated payload to the *actual* immutable
  // production Mission 79 and assignment IDs. No production writes or
  // additional worker commissions: only these fixture row identifiers change.
  const exactMission79='b7c2e557-83e1-41cb-b174-bdb0d77d12e5';
  const exactJob79='85e229aa-e571-43ef-9d4a-5cb64f4efcd1';
  const generatedMission=scheduled.missionId;
  const generatedJob=(await first.query(
   'select id from mission_assignments where mission_id=$1',[generatedMission]
  )).rows[0]?.id;
  assert.ok(generatedJob,'Native scheduler must create exactly the claimed work assignment');
  await first.query('reset role');
  const srcMission=(await first.query('select to_jsonb(m) row from agent_missions m where id=$1',[generatedMission])).rows[0].row;
  const srcJob=(await first.query('select to_jsonb(j) row from mission_assignments j where id=$1',[generatedJob])).rows[0].row;
  await first.query(`insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb||jsonb_build_object('id',$2::uuid))).*`,[JSON.stringify(srcMission),exactMission79]);
  await first.query('update work_projects set active_mission_id=$2 where id=$1',[project,exactMission79]);
  await first.query(`insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb||jsonb_build_object('id',$2::uuid,'mission_id',$3::uuid))).*`,[JSON.stringify(srcJob),exactJob79,exactMission79]);
  const oldBindings=(await first.query('select to_jsonb(b) row from project_organization_assignments b where b.assignment_id=$1',[generatedJob])).rows.map(x=>x.row);
  for(const binding of oldBindings){
   await first.query(`insert into project_organization_assignments select (jsonb_populate_record(null::project_organization_assignments,$1::jsonb||jsonb_build_object('assignment_id',$2::uuid))).*`,[JSON.stringify(binding),exactJob79]);
  }
  await first.query('delete from project_organization_assignments where assignment_id=$1',[generatedJob]);
  await first.query('delete from mission_assignments where id=$1',[generatedJob]);
  await first.query('delete from agent_missions where id=$1',[generatedMission]);
  scheduled.missionId=exactMission79;
  await first.query('set role service_role');
  assert.ok(scheduled?.missionId,'Normal scheduler must admit precisely one fresh management mission: '+JSON.stringify(scheduled));
  assert.equal(scheduled.nodeId,root.id);
  const newMission=(await first.query('select project_kind,project_evidence from agent_missions where id=$1',[scheduled.missionId])).rows[0];
  assert.equal(newMission.project_kind,'management');
  assert.equal(newMission.project_evidence.organizationNodeId,root.id);
  assert.equal(newMission.project_evidence.providerContinuationWindow,windowId);
  assert.equal(newMission.project_evidence.providerContinuationRelease,priorRelease);
  assert.equal((await first.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,79);
  const stillSource=(await first.query('select status,detail from agent_missions where id=$1',[source])).rows[0];
  assert.equal(stillSource.status,'blocked');assert.match(stillSource.detail,/No delegation change requested/);
  assert.equal((await first.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
  // Return the project scheduling lease through the NORMAL project lifecycle.
  // The worker queue is not a Project Director management decision and does
  // not automatically acquire new owner permissions.
  const finished=(await first.query(
   "select finish_work_project($1,$2,'wait',$3::jsonb) ok",
   [project,lease,JSON.stringify({detail:'Awaiting the queued management assignment'})]
  )).rows[0].ok;
  assert.equal(finished,true,'Ordinary scheduler must relinquish project lease before worker claim');
  const originalJob=(await first.query(
   'select id,status,attempts,lease from mission_assignments where mission_id=$1',
   [scheduled.missionId])).rows[0];
  assert.equal(originalJob.status,'queued');assert.equal(originalJob.attempts,0);
  // The shared native fixture has other legitimate runnable projects. This
  // isolated test must inspect this one authorized mission's release fence,
  // not whichever unrelated job globally queued first. Follow the existing
  // continuation-qualification pattern: age ONLY the disposable assignment
  // before its history baseline, then roll back the whole scheduler test.
  await first.query('reset role');
  await first.query("update mission_assignments set created_at='2000-01-01T00:00:00Z' where id=$1",
   [originalJob.id]);
  await first.query('set role service_role');
  const executionRelease='d'.repeat(40),unboundRelease='e'.repeat(40);
  // Negative release probes must not leave unrelated fixture workers leased:
  // doing so fills the unchanged three-worker global cap before mission 79.
  const isolatedNegativeClaim=async release=>{
   await first.query('savepoint negative_release_claim');
   try{return (await first.query('select claim_mission_work_release($1) r',[release])).rows[0].r;}
   finally{
    await first.query('rollback to savepoint negative_release_claim');
    await first.query('release savepoint negative_release_claim');
   }
  };
  const stale=await isolatedNegativeClaim(executionRelease);
  assert.notEqual(stale?.job?.id,originalJob.id,'Without an exact owner-source binding, a later SHA cannot claim mission 79');

  const offerArgs=[owner,project,executionRelease];
  // The old binding MUST refuse: no renewed owner deadline exists yet.
  await rejected(()=>first.query(
   'select project_org_retest_claim_release_offer($1,$2,$3)',offerArgs
  ),/window|future|owner|release/i);

  // Reproduce the actual production 45-minute no-progress watchdog and its
  // expired management mission: neither status is changed in production.
  await first.query('reset role');
  await first.query(`update work_projects set status='blocked',
    progress_since=clock_timestamp()-interval '46 minutes',
    detail='No new completed artifact or external execution transition for 00:45:00 in development. Work is blocked; saved results and charges are retained.'
    where id=$1`,[project]);
  await first.query("update agent_missions set status='blocked',detail='Mission deadline reached; no work started' where id=$1",
   [scheduled.missionId]);
  await first.query('set role service_role');
  assert.equal((await first.query('select status from work_projects where id=$1',[project])).rows[0].status,'blocked');
  assert.equal((await first.query('select status from agent_missions where id=$1',[scheduled.missionId])).rows[0].status,'blocked');
  // Only the disposable fixture commits the synthetic 79th management
  // mission before concurrent owner writes; production is never touched.
  await first.query('commit');
  assert.equal((await observer.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,79);
  await first.query('begin');

  const futureOffer=(await first.query(
   'select project_org_retest_future_window_offer($1,$2,$3) r',offerArgs)).rows[0].r;
  assert.equal(futureOffer.stage,'authorize');
  assert.equal(futureOffer.missionId,scheduled.missionId);
  assert.equal(futureOffer.assignmentId,originalJob.id);
  assert.equal(futureOffer.historicalMissions,79);
  const authorizationId=randomUUID();
  const explicitFutureCutoff=new Date(Date.now()+4*3600000).toISOString();
  assert.ok(Date.parse(explicitFutureCutoff)>Date.parse(futureOffer.priorCutoff));
  const approveArgs=[owner,project,executionRelease,scheduled.missionId,originalJob.id,authorizationId,explicitFutureCutoff,futureOffer.stateHash];
  const approve=()=>first.query(
   'select project_org_authorize_retest_future_window($1,$2,$3,$4,$5,$6,$7,$8) r',approveArgs);
  await rejected(()=>first.query('select project_org_retest_future_window_offer($1,$2,$3)',
   [randomUUID(),project,executionRelease]),/owner|auth|original/i);
  await rejected(()=>first.query(
   'select project_org_authorize_retest_future_window($1,$2,$3,$4,$5,$6,$7,$8)',
   [...approveArgs.slice(0,7),'f'.repeat(64)]),/state|owner|fresh|authorization/i);
  await rejected(()=>first.query(
   'select project_org_authorize_retest_future_window($1,$2,$3,$4,$5,$6,$7,$8)',
   [owner,project,executionRelease,randomUUID(),originalJob.id,authorizationId,explicitFutureCutoff,futureOffer.stateHash]),
   /mission|state|owner|original|exact/i);
  await first.query('set role anon');await rejected(approve,/permission denied/i);
  await first.query('set role service_role');
  const ownerWindow=(await approve()).rows[0].r;
  assert.equal(ownerWindow.stage,'authorized');assert.equal(ownerWindow.status,'blocked');
  assert.equal(ownerWindow.missionStatus,'blocked');assert.equal(ownerWindow.authorizationId,authorizationId);
  assert.equal(Date.parse(ownerWindow.cutoff),Date.parse(explicitFutureCutoff));
  assert.equal(ownerWindow.historicalMissions,79);
  await raceNewOwnerRpc('OWNER_WINDOW',
   'select project_org_authorize_retest_future_window($1,$2,$3,$4,$5,$6,$7,$8) r',approveArgs);
  assert.equal((await observer.query('select count(*)::int n from project_retest_future_window_receipts where project_id=$1',[project])).rows[0].n,1);
  assert.equal((await observer.query("select count(*)::int n from project_events where project_id=$1 and event='mission79_future_window_owner_authorized'",[project])).rows[0].n,1);
  assert.equal((await first.query('select deadline,max_missions,token_allowance from work_projects where id=$1',
   [project])).rows[0].max_missions,96);
  assert.equal((await first.query('select count(*)::int n from project_retest_future_window_receipts where project_id=$1',
   [project])).rows[0].n,1);
  assert.equal((await first.query(
   'select organization_hash from project_retest_future_window_receipts where project_id=$1',[project]
  )).rows[0].organization_hash,await (async()=>{
    await first.query('reset role');
    try{return (await first.query('select project_org_scope_ratification_state($1) h',[project])).rows[0].h;}
    finally{await first.query('set role service_role');}
   })(),
   'New owner window must pin the immutable post-renewal organizational and QA contract');
  assert.equal((await first.query('select project_provider_continued($1) a',[project])).rows[0].a,true);
  assert.equal((await first.query('select project_provider_continued_assignment($1) a',[originalJob.id])).rows[0].a,true);
  const recordedWindow=(await first.query(
   'select project_org_retest_future_window_offer($1,$2,$3) r',offerArgs)).rows[0].r;
  assert.equal(recordedWindow.stage,'authorized');
  assert.equal(recordedWindow.authorizationId,authorizationId);
  await rejected(approve,/state|window|owner|authorization/i);
  await rejected(()=>first.query(
   'select project_org_retest_future_window_offer($1,$2,$3)',
   [owner,project,unboundRelease]),/SHA|release|window|production/i);
  const claimOffer=(await first.query(
   'select project_org_retest_claim_release_offer($1,$2,$3) r',offerArgs)).rows[0].r;
  assert.equal(claimOffer.stage,'bind');
  assert.equal(claimOffer.missionId,scheduled.missionId);
  assert.equal(claimOffer.assignmentId,originalJob.id);
  assert.equal(claimOffer.historicalMissions,79);
  assert.equal(claimOffer.maxMissions,96);
  assert.equal(claimOffer.tokenAllowance,600000);
  const immutableBeforeBinding=await unmodified();
  const bindArgs=[owner,project,executionRelease,scheduled.missionId,originalJob.id,claimOffer.stateHash];
  const bind=()=>first.query('select project_org_bind_retest_claim_release($1,$2,$3,$4,$5,$6) r',bindArgs);
  await rejected(()=>first.query('select project_org_retest_claim_release_offer($1,$2,$3)',
   [randomUUID(),project,executionRelease]),/authenticated|owner|window/);
  await rejected(()=>first.query(
   'select project_org_bind_retest_claim_release($1,$2,$3,$4,$5,$6)',
   [...bindArgs.slice(0,5),'f'.repeat(64)]),/exact|state|required|fresh|owner/);
  await first.query('set role anon');await rejected(bind,/permission denied/i);
  await first.query('set role service_role');
  const receipt=(await bind()).rows[0].r;
  assert.equal(receipt.stage,'bound');assert.equal(receipt.releaseSha,executionRelease);
  await raceNewOwnerRpc('RELEASE_BIND',
   'select project_org_bind_retest_claim_release($1,$2,$3,$4,$5,$6) r',bindArgs);
  assert.equal((await observer.query('select count(*)::int n from project_retest_claim_release_receipts where project_id=$1',[project])).rows[0].n,1);
  assert.equal((await observer.query("select count(*)::int n from project_events where project_id=$1 and event='mission79_new_window_release_bound'",[project])).rows[0].n,1);
  const resumed=(await first.query('select status,progress_since,detail from work_projects where id=$1',[project])).rows[0];
  assert.equal(resumed.status,'running','One guarded bound-release action must re-admit only the exact watchdog state');
  assert.match(resumed.detail,/mission79 admitted/);
  assert.ok(new Date(resumed.progress_since).getTime()>Date.now()-60000,
   'Watchdog interval may renew only on actual auditable release binding');
  assert.equal(receipt.existing,false);assert.equal(receipt.historicalMissions,79);
  const afterBinding=await unmodified();
  for(const key of ['assignments','decisions','exceptions','grants','packages','nodes'])
   assert.equal(afterBinding[key],immutableBeforeBinding[key],
    'Release binding must not change historical '+key);
  assert.equal((await first.query('select status from agent_missions where id=$1',[scheduled.missionId])).rows[0].status,
   'running','Only the owner-approved original blocked management mission may resume');
  await rejected(bind,/bound|changed|release|window|mission|owner/i);
  assert.equal((await first.query(
   'select project_org_retest_claim_release_authorized($1,$2) a',
   [project,executionRelease])).rows[0].a,true);
  assert.equal((await first.query(
   'select project_org_retest_claim_release_authorized($1,$2) a',
   [project,unboundRelease])).rows[0].a,false);
  assert.equal((await first.query(
   'select count(*)::int n from project_retest_claim_release_receipts where project_id=$1',
   [project])).rows[0].n,1);
  assert.equal((await first.query(
   'select continuation_release_sha from project_provider_execution where project_id=$1',
   [project])).rows[0].continuation_release_sha,priorRelease,
   'Original owner continuation SHA must remain immutable');
  assert.equal((await first.query(
   'select project_evidence from agent_missions where id=$1',
   [scheduled.missionId])).rows[0].project_evidence.providerContinuationRelease,priorRelease,
   'Mission 79 must retain its immutable original source release');

  const oldContinuationClaim=await isolatedNegativeClaim(priorRelease);
  assert.notEqual(oldContinuationClaim?.job?.id,originalJob.id,
   'Historical continuation release must never reclaim owner-renewed mission79');
  const staleOther=await isolatedNegativeClaim(unboundRelease);
  assert.notEqual(staleOther?.job?.id,originalJob.id,'A different new SHA still cannot claim the queued original mission');
  const claimed=(await first.query('select claim_mission_work_release($1) r',
   [executionRelease])).rows[0].r;
  if(!claimed||claimed.mission?.id!==scheduled.missionId){
   const predicateSql=[
    "select j.id job_id,j.status job_status,j.attempts,j.lease,j.available_at,",
    "m.id mission_id,m.status mission_status,p.status project_status,p.active_mission_id,p.deadline,",
    "benchmark_effective_mission_deadline(m.id) mission_deadline,",
    "project_provider_continued_assignment(j.id) source_ok,",
    "project_org_retest_claim_release_authorized(p.id,$2) release_ok,",
    "active_managed_work(j.agent_id,j.id) active_agent_work,",
    "(select (v->'config'->>'maxActiveTasks')::integer from jsonb_array_elements(m.team) v where v->>'id'=j.agent_id::text) team_max,",
    "(select (config->>'maxActiveTasks')::integer from managed_agents where id=j.agent_id) agent_max,",
    "not exists(select 1 from unnest(j.dependencies) dep where not exists(select 1 from mission_assignments d where d.mission_id=j.mission_id and d.job_key=dep and d.status='completed')) deps_ready,",
    "(select count(*) from mission_assignments aa join agent_missions bb on bb.id=aa.mission_id where aa.status='running' and aa.lease_until>now() and bb.status in ('running','awaiting_approval')) global_running",
    "from mission_assignments j join agent_missions m on m.id=j.mission_id join work_projects p on p.id=m.project_id where j.id=$1"
   ].join(' ');
   const diagnostic=(await first.query(predicateSql,[originalJob.id,executionRelease])).rows;
   const workerBody=(await first.query("select pg_get_functiondef('public.claim_mission_work_release(text)'::regprocedure) definition")).rows[0].definition;
   console.log('MISSION79_CLAIM_REJECTION_DIAGNOSTIC '+JSON.stringify({
    diagnostic,patchOccurrences:workerBody.split('project_org_retest_claim_release_authorized(b.project_id,p_release)').length-1,
    staleClaim:stale,otherClaim:staleOther,claimed
   }));
  }
  assert.equal(claimed?.mission?.id,scheduled.missionId,'Native release-bound worker must claim mission 79');
  assert.equal(claimed?.job?.id,originalJob.id);
  assert.equal(claimed?.job?.status,'running');
  assert.equal(claimed?.job?.attempts,1);
  assert.ok(claimed?.job?.lease,'Real six-minute worker lease required');
  assert.equal(claimed?.mission?.calls,0,'Claim must not reserve or pay for provider inference');
  assert.equal(claimed?.mission?.project_evidence?.providerContinuationRelease,priorRelease);
  const duplicate=(await first.query('select claim_mission_work_release($1) r',
   [executionRelease])).rows[0].r;
  assert.notEqual(duplicate?.job?.id,originalJob.id,'Lease must prevent duplicate worker claim');

  // Continue the REAL database-claimed management identity into the normal
  // executeClaim dispatcher with an injected deterministic no-network model.
  // The isolated DB command adapter is mocked here: no paid provider, worker
  // commissioning, or project decision is written during this assertion.
  // Reuse the real owner-ratified development specification from the
  // disposable original project. Do not fabricate a milestone in the model.
  const approvedProjectRecord=(await first.query(
   'select objective,team,phase,spec,approved_hash,deadline,milestone_index from work_projects where id=$1',
   [project])).rows[0];
  assert.ok(approvedProjectRecord?.spec?.milestones?.length>0,
   'Offline management context must use the saved approved project milestone');
  const {modules}=await import('./load-project-modules.mjs');
  const rows={
   project_organization_nodes:[{id:root.id,agent_id:root.agent_id,kind:'project_director',status:'active'}],
   project_organization_exceptions:[],
   project_organization_assignments:[],
   project_organization_scope_grants:[],
   project_organization_plans:[{node_id:root.id,purpose:'Existing approved delivery',direction:'Delegate to functional director'}],
   project_organization_dependencies:[],
  };
  const fakeDb={from(table){const q={
   select(){return q;},eq(){return q;},in(){return q;},order(){return q;},range(){return q;},
   single:async()=>({data:approvedProjectRecord,error:null}),
   then(ok){return Promise.resolve({data:rows[table]??[],error:null}).then(ok);}
  };return q;}};
  const controlledCalls=[];
  const loader=modules({
   '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>fakeDb},
   '@/lib/missions/store':{rpc:async(name,args)=>{
    controlledCalls.push({name,args});
    if(name==='project_provider_mode')return true;
    if(name==='project_org_decide')return true;
    throw Error('Controlled management unexpectedly called '+name);
   }},
  });
  let modelCalls=0;
  await loader('@/lib/missions/worker').executeClaim(claimed,async(c,instruction,input,tools)=>{
   modelCalls++;assert.equal(tools,'none');assert.equal(c.job.id,originalJob.id);
   assert.match(instruction,/Never write code/);
   assert.equal(JSON.parse(input).project.objective,approvedProjectRecord.objective);
   return {text:'[{"action":"ready"}]',model:'deterministic-offline-fixture'};
  });
  assert.equal(modelCalls,1);
  assert.deepEqual(controlledCalls.map(c=>c.name),['project_provider_mode','project_org_decide']);
  assert.equal(controlledCalls[1].args.p_lease,claimed.job.lease);
  assert.equal((await first.query('select calls from agent_missions where id=$1',
   [scheduled.missionId])).rows[0].calls,0,'Controlled test cannot produce a charged model call');
  console.log('RETEST_MISSION79_RELEASE_CLAIM_PASS: exact bound SHA only, original 79/96 ledger, source evidence, normal worker lease, one offline LLM management route, no paid inference');

  console.log('BLOCKED_MANAGEMENT_ONCE_POSTGRES_PASS: original 78 failed missions preserved, owner-scoped one-shot receipt, stale/replay/ACL negatives, zero owner-created missions, then one real lease-bound root management mission 79/96; disposable rollback, no inference');
 }finally{
  await first.query('rollback');
 }
 assert.equal((await observer.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,79,
  'Exactly the saved 79th synthetic management mission survives; worker claim remains rolled back');
 assert.equal((await observer.query('select count(*)::int n from project_blocked_management_retest_receipts where project_id=$1',[project])).rows[0].n,1,
  'Exactly one durable recovery receipt after two actual competing owner RPCs');
 assert.equal((await observer.query("select count(*)::int n from project_events where project_id=$1 and event='blocked_management_retest_authorized'",[project])).rows[0].n,1,
  'Exactly one owner transition must be recorded');
 console.log('BLOCKED_MANAGEMENT_ONCE_COMMITTED_RPC_RACE_PASS: two real owner RPCs, advisory wait, one receipt/transition, 78 preserved missions, rollback-only 79th scheduler admission');
}
