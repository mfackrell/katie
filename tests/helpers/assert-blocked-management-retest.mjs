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
  console.log('BLOCKED_MANAGEMENT_ONCE_POSTGRES_PASS: original 78 failed missions preserved, owner-scoped one-shot receipt, stale/replay/ACL negatives, zero owner-created missions, then one real lease-bound root management mission 79/96; disposable rollback, no inference');
 }finally{
  await first.query('rollback');
 }
 assert.equal((await observer.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,78,
  'Committed synthetic failure must remain exactly 78 after scheduler rollback');
 assert.equal((await observer.query('select count(*)::int n from project_blocked_management_retest_receipts where project_id=$1',[project])).rows[0].n,1,
  'Exactly one durable recovery receipt after two actual competing owner RPCs');
 assert.equal((await observer.query("select count(*)::int n from project_events where project_id=$1 and event='blocked_management_retest_authorized'",[project])).rows[0].n,1,
  'Exactly one owner transition must be recorded');
 console.log('BLOCKED_MANAGEMENT_ONCE_COMMITTED_RPC_RACE_PASS: two real owner RPCs, advisory wait, one receipt/transition, 78 preserved missions, rollback-only 79th scheduler admission');
}
