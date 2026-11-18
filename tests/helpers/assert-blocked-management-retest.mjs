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
  "select to_regprocedure('public.project_org_bind_retest_claim_release(uuid,uuid,text,uuid,uuid,text,bigint,text)') sig"
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
    (id,mission_id,job_key,role,agent_id,instruction,payload,status,result,attempts)
    values($1,$2,'plan','work',$3,'Make bounded management decisions',
      jsonb_build_object('organizationNodeId',$5::uuid),'failed',
      jsonb_build_object('detail',$4::text),$6::integer)`,
    [i===1?'cd81b57d-0812-485c-b8f6-d658aa80186f':randomUUID(),id,node.agent_id,detail,node.id,i===1?1:0]);
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
  const releaseEpoch=async release=>(await first.query(
   'select project_org_retest_release_epoch($1,$2) e',[project,release])).rows[0].e;
  const isolatedNegativeClaim=async(release,observedGeneration,deployment='dpl_NativeFixture79')=>{
   await first.query('savepoint negative_release_claim');
   try{
    if(observedGeneration==='legacy')
     return (await first.query('select claim_mission_work_release($1) r',[release])).rows[0].r;
    const generation=observedGeneration??(await releaseEpoch(release)).generation;
    return (await first.query('select claim_mission_work_release_epoch($1,$2,$3) r',
     [release,generation,deployment])).rows[0].r;
   }
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
  // Fixture-only reconstruction of the original expired receipt/window;
  // historical owner retest first needed a live synthetic window to execute.
  // All triggers are restored BEFORE any future owner authorization is tested.
  const expiredOriginalCutoff='2026-11-18T14:00:00Z';
  await first.query('reset role');
  await first.query("set local session_replication_role = 'replica'");
  try{
   await first.query('update project_blocked_management_retest_receipts set cutoff=$2 where project_id=$1',[project,expiredOriginalCutoff]);
   await first.query('update project_blocked_owner_windows set cutoff=$2 where project_id=$1',[project,expiredOriginalCutoff]);
   await first.query('update project_execution_windows set cutoff=$2 where id=$1',[windowId,expiredOriginalCutoff]);
   await first.query('update project_provider_execution set deadline=$2 where project_id=$1',[project,expiredOriginalCutoff]);
   await first.query('update work_projects set deadline=$2 where id=$1',[project,expiredOriginalCutoff]);
   await first.query('update project_organization_contract_changes set deadline=$2 where project_id=$1 and window_id=$3',[project,expiredOriginalCutoff,windowId]);
   await first.query('update project_organization_nodes set deadline=$2 where project_id=$1',[project,expiredOriginalCutoff]);
   await first.query('update agent_missions set deadline=$2 where id=$1',[scheduled.missionId,expiredOriginalCutoff]);
  }finally{await first.query("set local session_replication_role = 'origin'");}
  assert.equal((await first.query("show session_replication_role")).rows[0].session_replication_role,'origin');
  await first.query('set role service_role');
  const originalAuthority=(await first.query(
   'select r.window_id,r.cutoff,project_provider_continued(p.id) continued from work_projects p join project_blocked_management_retest_receipts r on r.project_id=p.id where p.id=$1',
   [project])).rows[0];
  assert.equal(new Date(originalAuthority.cutoff).toISOString(),'2026-11-18T14:00:00.000Z');
  assert.equal(originalAuthority.window_id,'7d216bbe-596e-457e-b84d-e07ad1e80365');
  assert.equal(originalAuthority.continued,true);
  // Only the disposable fixture commits the synthetic 79th management
  // mission before concurrent owner writes; production is never touched.
  await first.query('commit');
  assert.equal((await observer.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,79);
  await first.query('begin');

  // Compare all immutable records BEFORE owner renewal, again after renewal
  // and after release binding. Exempt only mission79 deadline/status/update
  // timestamps, never its source evidence, usage or token reservations.
  const originalIntegrity=async()=>{
   await first.query('reset role');
   try{
    const sources={
     missions:"select md5(coalesce(jsonb_agg(case when m.id=$2::uuid then to_jsonb(m)-'deadline'-'status'-'updated_at' else to_jsonb(m) end order by m.id)::text,'[]')) h from agent_missions m where m.project_id=$1",
     calls:"select md5(coalesce(jsonb_agg(to_jsonb(c) order by c.id)::text,'[]')) h from mission_calls c join mission_assignments j on j.id=c.job_id join agent_missions m on m.id=j.mission_id where m.project_id=$1",
     providerRequests:"select md5(coalesce(jsonb_agg(to_jsonb(r) order by r.id)::text,'[]')) h from project_provider_requests r where r.project_id=$1",
     providerDispatches:"select md5(coalesce(jsonb_agg(to_jsonb(d) order by d.task_id)::text,'[]')) h from project_provider_dispatches d join mission_assignments j on j.id=d.task_id join agent_missions m on m.id=j.mission_id where m.project_id=$1",
     assignments:"select md5(coalesce(jsonb_agg(to_jsonb(j) order by j.id)::text,'[]')) h from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1",
     originalRetestReceipt:"select md5(coalesce(jsonb_agg(to_jsonb(r) order by r.project_id)::text,'[]')) h from project_blocked_management_retest_receipts r where r.project_id=$1",
     originalContracts:"select md5(coalesce(jsonb_agg(to_jsonb(c) order by c.node_id)::text,'[]')) h from project_organization_contract_changes c where c.project_id=$1 and c.window_id=$2::uuid",
     grants:"select md5(coalesce(jsonb_agg(to_jsonb(g) order by g.node_id)::text,'[]')) h from project_organization_scope_grants g join project_organization_nodes n on n.id=g.node_id where n.project_id=$1",
     decisions:"select md5(coalesce(jsonb_agg(to_jsonb(d) order by d.id)::text,'[]')) h from project_organization_decisions d where d.project_id=$1",
     exceptions:"select md5(coalesce(jsonb_agg(to_jsonb(e) order by e.id)::text,'[]')) h from project_organization_exceptions e where e.project_id=$1",
     packageCount:"select count(*)::text h from project_work_packages where project_id=$1",
     exposure:"select coalesce(sum(greatest(coalesce(m.actual_tokens,0),coalesce(m.reserved_tokens,0))),0)::text h from agent_missions m where m.project_id=$1"
    };
    const hashes={};
    for(const [name,query] of Object.entries(sources))
     hashes[name]=(await first.query(query,
      name==='missions'?[project,scheduled.missionId]:
      name==='originalContracts'?[project,windowId]:[project])).rows[0].h;
    return hashes;
   }finally{await first.query('set role service_role');}
  };
  const sourceBeforeOwnerRenewal=await originalIntegrity();

  // The release operator, not the owner UI or service-role runtime, must
  // open the canonical production epoch only after verifying READY on alias.
  // All gate transitions here are in disposable native PostgreSQL.
  await first.query('set role service_role');
  await rejected(()=>first.query(
   'select project_org_retest_set_release_gate($1,$2,$3,$4)',
   [project,executionRelease,'dpl_NativeFixture79','active']),/permission denied/i);
  await first.query('reset role');
  const activeGate=(await first.query(
   'select project_org_retest_set_release_gate($1,$2,$3,$4) g',
   [project,executionRelease,'dpl_NativeFixture79','active'])).rows[0].g;
  assert.equal(activeGate.state,'active');
  const activeEpoch=(await first.query('select project_org_retest_release_epoch($1,$2) e',
   [project,executionRelease])).rows[0].e;
  assert.equal(activeEpoch.active,true);assert.equal(activeEpoch.generation,activeGate.generation??1);
  await first.query('set role service_role');
  assert.equal((await first.query(
   'select project_org_retest_active_release($1,$2) allowed',
   [project,executionRelease])).rows[0].allowed,true);
  assert.equal((await first.query(
   'select project_org_retest_active_release($1,$2) allowed',
   [project,unboundRelease])).rows[0].allowed,false);

  // End-to-end: Chromium owner-selected cutoff -> real first-party route ->
  // authenticated owner bearer -> real immutable PostgreSQL receipt. The
  // browser integration rolls back a nested savepoint; no extra window survives.
  const {assertMission79BrowserPostgres}=await import('./assert-mission79-browser-postgres.mjs');
  await assertMission79BrowserPostgres(first,{
   project,owner,release:executionRelease,missionId:scheduled.missionId,
   assignmentId:originalJob.id,stage:'authorize'
  });
  const futureOffer=(await first.query(
   'select project_org_retest_future_window_offer($1,$2,$3) r',offerArgs)).rows[0].r;
  assert.equal(futureOffer.stage,'authorize');
  assert.equal(futureOffer.missionId,scheduled.missionId);
  assert.equal(futureOffer.assignmentId,originalJob.id);
  assert.equal(futureOffer.historicalMissions,79);
  // Neither an altered source lineage nor a QA supervisor reporting into
  // delivery may be silently re-baselined by the fresh owner window.
  await first.query('savepoint original_lineage_negative');
  try{
   await first.query('reset role');
   await first.query("set local session_replication_role = 'replica'");
   await first.query("update agent_missions set project_evidence=jsonb_set(project_evidence,'{providerContinuationRelease}',to_jsonb($2::text)) where id=$1",
    [source,'f'.repeat(40)]);
   await first.query("set local session_replication_role = 'origin'");
   await first.query('set role service_role');
   await rejected(()=>first.query('select project_org_retest_future_window_offer($1,$2,$3)',
    offerArgs),/Original owner retest and project identity not eligible/i);
  }finally{
   await first.query('rollback to savepoint original_lineage_negative');
   await first.query('release savepoint original_lineage_negative');
  }
  await first.query('savepoint original_qa_topology_negative');
  try{
   await first.query('reset role');
   await first.query("set local session_replication_role = 'replica'");
   await first.query("update project_organization_nodes set parent_id=(select id from project_organization_nodes where project_id=$1 and area='delivery_management' limit 1) where id=(select id from project_organization_nodes where project_id=$1 and area='qa_planning' limit 1)",[project]);
   await first.query("set local session_replication_role = 'origin'");
   await first.query('set role service_role');
   await rejected(()=>first.query('select project_org_retest_future_window_offer($1,$2,$3)',
    offerArgs),/Original owner retest and project identity not eligible/i);
  }finally{
   await first.query('rollback to savepoint original_qa_topology_negative');
   await first.query('release savepoint original_qa_topology_negative');
  }
  assert.equal((await first.query('select project_org_retest_original_owner_lineage($1) verified',[project])).rows[0].verified,true,
   'Untampered original source and QA hierarchy must remain valid');
  console.log('MISSION79_HISTORICAL_SOURCE_AND_QA_TOPOLOGY_NEGATIVES_PASS');
  const authorizationId=randomUUID();
  const explicitFutureCutoff=new Date(Date.now()+4*3600000).toISOString();
  assert.ok(Date.parse(explicitFutureCutoff)>Date.parse(futureOffer.priorCutoff));
  const approveArgs=[owner,project,executionRelease,scheduled.missionId,originalJob.id,authorizationId,explicitFutureCutoff,futureOffer.stateHash,activeEpoch.generation,'dpl_NativeFixture79'];
  const approve=()=>first.query(
   'select project_org_authorize_retest_future_window($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',approveArgs);
  await rejected(()=>first.query('select project_org_retest_future_window_offer($1,$2,$3)',
   [randomUUID(),project,executionRelease]),/owner|auth|original/i);
  await rejected(()=>first.query(
   'select project_org_authorize_retest_future_window($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   [...approveArgs.slice(0,7),'f'.repeat(64),...approveArgs.slice(8)]),/state|owner|fresh|authorization/i);
  await rejected(()=>first.query(
   'select project_org_authorize_retest_future_window($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   [owner,project,executionRelease,randomUUID(),originalJob.id,authorizationId,explicitFutureCutoff,futureOffer.stateHash,...approveArgs.slice(8)]),
   /mission|state|owner|original|exact/i);
  await rejected(()=>first.query(
   'select project_org_authorize_retest_future_window($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   [...approveArgs.slice(0,8),activeEpoch.generation+1,'dpl_NativeFixture79']),
   /Observed canonical release epoch or deployment changed/i);
  await rejected(()=>first.query(
   'select project_org_authorize_retest_future_window($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   [...approveArgs.slice(0,9),'dpl_WrongNativeFixture']),
   /Observed canonical release epoch or deployment changed/i);
  await first.query('set role anon');await rejected(approve,/permission denied/i);
  await first.query('set role service_role');
  const ownerWindow=(await approve()).rows[0].r;
  assert.deepEqual(await originalIntegrity(),sourceBeforeOwnerRenewal,
   'Owner-selected window preserves 79 historical missions, all charges, immutable retest receipt, original contracts and grants');
  assert.equal(ownerWindow.stage,'authorized');assert.equal(ownerWindow.status,'blocked');
  assert.equal(ownerWindow.missionStatus,'blocked');assert.equal(ownerWindow.authorizationId,authorizationId);
  assert.equal(Date.parse(ownerWindow.cutoff),Date.parse(explicitFutureCutoff));
  assert.equal(ownerWindow.historicalMissions,79);
  await raceNewOwnerRpc('OWNER_WINDOW',
   'select project_org_authorize_retest_future_window($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',approveArgs);
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
  // A separate real browser interaction must bind the already persisted
  // owner window; it must not double-write its immutable approval.
  await assertMission79BrowserPostgres(first,{
   project,owner,release:executionRelease,missionId:scheduled.missionId,
   assignmentId:originalJob.id,stage:'authorized'
  });
  const immutableBeforeBinding=await unmodified();
  const bindArgs=[owner,project,executionRelease,scheduled.missionId,originalJob.id,claimOffer.stateHash,activeEpoch.generation,'dpl_NativeFixture79'];
  const bind=()=>first.query('select project_org_bind_retest_claim_release($1,$2,$3,$4,$5,$6,$7,$8) r',bindArgs);
  await rejected(()=>first.query('select project_org_retest_claim_release_offer($1,$2,$3)',
   [randomUUID(),project,executionRelease]),/authenticated|owner|window/);
  await rejected(()=>first.query(
   'select project_org_bind_retest_claim_release($1,$2,$3,$4,$5,$6,$7,$8)',
   [...bindArgs.slice(0,5),'f'.repeat(64),...bindArgs.slice(6)]),/exact|state|required|fresh|owner/);
  await rejected(()=>first.query(
   'select project_org_bind_retest_claim_release($1,$2,$3,$4,$5,$6,$7,$8)',
   [...bindArgs.slice(0,6),activeEpoch.generation+1,'dpl_NativeFixture79']),
   /Observed canonical release epoch or deployment changed/i);
  await rejected(()=>first.query(
   'select project_org_bind_retest_claim_release($1,$2,$3,$4,$5,$6,$7,$8)',
   [...bindArgs.slice(0,7),'dpl_WrongNativeFixture']),
   /Observed canonical release epoch or deployment changed/i);
  await first.query('set role anon');await rejected(bind,/permission denied/i);
  await first.query('set role service_role');
  const receipt=(await bind()).rows[0].r;
  assert.equal(receipt.stage,'bound');assert.equal(receipt.releaseSha,executionRelease);
  assert.deepEqual(await originalIntegrity(),sourceBeforeOwnerRenewal,
   'Exact-release binding preserves all original mission and provider accounting data');
  await raceNewOwnerRpc('RELEASE_BIND',
   'select project_org_bind_retest_claim_release($1,$2,$3,$4,$5,$6,$7,$8) r',bindArgs);
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
  // Simulate privilege-separated canonical alias promotion: under the
  // identical claim/state locks operator closes the gate BEFORE alias moves.
  // A stale runtime cannot reactivate it and cannot claim even with a saved
  // immutable binding/old SHA. Reopen only after a verified READY alias.
  await first.query('reset role');
  const closedGate=(await first.query(
   'select project_org_retest_set_release_gate($1,$2,$3,$4) g',
   [project,executionRelease,'dpl_NativeFixture79','closed'])).rows[0].g;
  assert.equal(closedGate.state,'closed');
  await first.query('set role service_role');
  const staleWhileClosed=await isolatedNegativeClaim(executionRelease);
  assert.equal((await releaseEpoch(executionRelease)).active,false);
  assert.notEqual(staleWhileClosed?.job?.id,originalJob.id,
   'A superseded deployment cannot claim the original assignment while the canonical alias gate is sealed');
  await rejected(()=>first.query(
   'select project_org_retest_set_release_gate($1,$2,$3,$4)',
   [project,executionRelease,'dpl_NativeFixture79','active']),/permission denied/i);
  await first.query('reset role');
  assert.equal((await first.query(
   'select project_org_retest_set_release_gate($1,$2,$3,$4) g',
   [project,executionRelease,'dpl_NativeFixture79','active'])).rows[0].g.state,'active');
  await first.query('set role service_role');
  const reopenedEpoch=await releaseEpoch(executionRelease);
  assert.equal(reopenedEpoch.active,true);
  assert.ok(reopenedEpoch.generation>activeEpoch.generation,
   'Closing/reopening the release gate must advance its generation');
  const wrongDeployment=await isolatedNegativeClaim(executionRelease,reopenedEpoch.generation,'dpl_OtherDeployment');
  assert.notEqual(wrongDeployment?.job?.id,originalJob.id,
   'Same release SHA with a different deployment ID must not lease mission79');
  const staleEpochClaim=await isolatedNegativeClaim(executionRelease,activeEpoch.generation);
  assert.notEqual(staleEpochClaim?.job?.id,originalJob.id,
   'Old pre-promotion epoch must not claim the original job after reopening');
  const legacyClaim=await isolatedNegativeClaim(executionRelease,'legacy');
  assert.notEqual(legacyClaim?.job?.id,originalJob.id);
  const claimed=(await first.query('select claim_mission_work_release_epoch($1,$2,$3) r',
   [executionRelease,reopenedEpoch.generation,'dpl_NativeFixture79'])).rows[0].r;
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
   const workerBody=(await first.query("select pg_get_functiondef('public.claim_mission_work_release_epoch(text,bigint)'::regprocedure) definition")).rows[0].definition;
   console.log('MISSION79_CLAIM_REJECTION_DIAGNOSTIC '+JSON.stringify({
    diagnostic,patchOccurrences:workerBody.split('project_org_retest_claim_release_authorized_epoch(b.project_id,p_release,p_epoch,p_deployment)').length-1,
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
  const duplicate=(await first.query('select claim_mission_work_release_epoch($1,$2,$3) r',
   [executionRelease,reopenedEpoch.generation,'dpl_NativeFixture79'])).rows[0].r;
  assert.notEqual(duplicate?.job?.id,originalJob.id,'Lease must prevent duplicate worker claim');

  // Closing an active generation must fail if a paid worker already owns a
  // lease. The SQL gate locks serialize with new claims, while this safety
  // check also covers an expired worker whose lease has been requeued.
  const gateStateBeforeAttempt=(await first.query(
   'select state,generation from project_retest_production_release_gate where project_id=$1',
   [project])).rows[0];
  await first.query('reset role');
  await rejected(()=>first.query(
   'select project_org_retest_set_release_gate($1,$2,$3,$4)',
   [project,executionRelease,'dpl_NativeFixture79','closed']),
   /Undrained owner-renewed worker attempt/i);
  await first.query('savepoint expired_mission79_claim');
  await first.query("update mission_assignments set status='queued',lease=null,lease_until=null where id=$1",
   [originalJob.id]);
  await rejected(()=>first.query(
   'select project_org_retest_set_release_gate($1,$2,$3,$4)',
   [project,executionRelease,'dpl_NativeFixture79','closed']),
   /Undrained owner-renewed worker attempt/i);
  await first.query('rollback to savepoint expired_mission79_claim');
  await first.query('release savepoint expired_mission79_claim');
  await first.query('set role service_role');
  assert.deepEqual((await first.query(
   'select state,generation from project_retest_production_release_gate where project_id=$1',
   [project])).rows[0],gateStateBeforeAttempt,
   'Live/expired attempted worker must not change the sealed release-gate generation');
  console.log('MISSION79_RELEASE_GATE_UNDRAINED_LEASE_NEGATIVES_PASS');

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
  // Read the REAL approved organization, decisions, grants and milestones from
  // the native PostgreSQL fixture. No fabricated management topology.
  const adapter={from(table){
   assert.match(table,/^[a-z_]+$/);let columns='*',where=[],values=[],orders=[],single=false,range;
   const q={select(c){assert.match(c,/^[a-z_,*]+$/);columns=c;return q;},
    eq(k,v){values.push(v);where.push(k+'=$'+values.length);return q;},
    in(k,v){values.push(v);where.push(k+'=any($'+values.length+')');return q;},
    order(k,o){orders.push(k+(o.ascending?' asc':' desc'));return q;},
    range(a,b){range=[a,b];return q;},single(){single=true;return q;},
    then(ok,bad){
     const sql='select '+columns+' from '+table+
      (where.length?' where '+where.join(' and '):'')+
      (orders.length?' order by '+orders.join(','):'')+
      (range?' limit '+(range[1]-range[0]+1)+' offset '+range[0]:'');
     return first.query(sql,values).then(r=>({
      data:JSON.parse(JSON.stringify(single?r.rows[0]:r.rows)),error:null
     })).then(ok,bad);
    }};return q;
  }};
  const originalPlan=(await first.query(
   'select purpose,direction,outcomes,milestones,organizations from project_organization_plans where node_id=$1',
   [root.id])).rows[0];
  assert.ok(originalPlan?.purpose&&Array.isArray(originalPlan.organizations)&&originalPlan.organizations.length>0);
  const commands=[{action:'plan',purpose:originalPlan.purpose,
   direction:originalPlan.direction+' Continue the approved development and independent QA objectives under unchanged owner authority.',
   outcomes:originalPlan.outcomes,milestones:originalPlan.milestones,
   organizations:originalPlan.organizations},{action:'ready'}];
  const decisionCountBefore=(await first.query(
   'select count(*)::int n from project_organization_decisions where project_id=$1',[project])).rows[0].n;
  const controlledCalls=[];
  const loader=modules({
   '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>adapter},
   '@/lib/missions/store':{rpc:async(name,args)=>{
    controlledCalls.push({name,args});
    if(name==='project_provider_mode')return true;
    if(name==='project_org_decide'){
     const result=await first.query('select project_org_decide($1,$2,$3::jsonb) accepted',
      [args.p_job,args.p_lease,JSON.stringify(args.p_commands)]);
     assert.equal(result.rows[0].accepted,true,'Saved original hierarchy must accept this offline model decision');
     return true;
    }
    throw Error('Controlled management unexpectedly called '+name);
   }},
  });
  let modelCalls=0;
  await loader('@/lib/missions/worker').executeClaim(claimed,async(c,instruction,input,tools)=>{
   modelCalls++;assert.equal(tools,'none');assert.equal(c.job.id,originalJob.id);
   assert.match(instruction,/Never write code/);
   assert.equal(JSON.parse(input).project.objective,approvedProjectRecord.objective);
   assert.equal(JSON.parse(input).reporting.organizationNodeCount,13);
   return {text:JSON.stringify(commands),model:'deterministic-offline-fixture'};
  });
  assert.equal(modelCalls,1);
  assert.deepEqual(controlledCalls.map(c=>c.name),['project_provider_mode','project_org_decide']);
  assert.equal(controlledCalls[1].args.p_lease,claimed.job.lease);
  assert.equal((await first.query('select count(*)::int n from project_organization_decisions where project_id=$1',[project])).rows[0].n,
   decisionCountBefore+1,'Actual PostgreSQL must record one management decision under the real lease');
  assert.equal((await first.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0,
   'No downstream coding package is commissioned by the offline qualification');
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
