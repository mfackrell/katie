import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const OVERFLOW='Required management decision evidence exceeds bounded context; do not omit current contracts, unresolved exceptions, or necessary assignment results.';
const BLOCKED='Project management cannot achieve its objective within bounded retry authority';
const DELEGATION='Mission state operation failed: {"code":"P0001","details":null,"hint":null,"message":"Worker assignment outside delegated authority"}';

// Run only inside the existing rollback-only original-project fixture, after
// the first signed context recovery and its one global scheduler claim.
export async function assertFollowupManagementNative(db,{project,owner,release,generation,deployment,firstMission,firstAssignment}){
 await db.query('savepoint followup_95');
 try{
  await db.query('reset role');
  const first=(await db.query('select * from project_context_retest_receipts where project_id=$1',[project])).rows[0];
  assert.ok(first?.authorization_id);
  assert.equal(first.source_mission_id,firstMission);
  assert.equal(first.source_assignment_id,firstAssignment);
  const oldReceipt=JSON.parse(JSON.stringify(first));
  const acceptedId=randomUUID();
  const prior=(await db.query('select * from agent_missions where id=$1',[firstMission])).rows[0];
  const priorJob=(await db.query('select * from mission_assignments where id=$1',[firstAssignment])).rows[0];
  const provider=(await db.query('select * from project_provider_execution where project_id=$1',[project])).rows[0];
  const original=(await db.query('select * from project_bounded_recovery_receipts where project_id=$1',[project])).rows[0];
  const active=(await db.query("select * from project_organization_nodes where project_id=$1 and kind='project_director'",[project])).rows[0];
  const game=(await db.query("select * from project_organization_nodes where project_id=$1 and area='game_delivery' and management_level='functional_director'",[project])).rows[0];
  const qa=(await db.query("select * from project_organization_nodes where project_id=$1 and area='independent_qa' and management_level='functional_director'",[project])).rows[0];
  assert.ok(active&&game&&qa&&prior&&priorJob&&provider&&original);
  await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,clock_timestamp())",[acceptedId,project,active.id,firstAssignment]);
  await db.query("update mission_assignments set status='completed',lease=null,lease_until=null,result=$2 where id=$1",[firstAssignment,{output:'Management decision recorded',decisionId:acceptedId}]);
  await db.query("update agent_missions set status='completed',calls=1,result='Management decisions committed' where id=$1",[firstMission]);
  const firstComplete=(await db.query('select status from agent_missions where id=$1',[firstMission])).rows[0].status;
  assert.equal(firstComplete,'completed');
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,90);
  let current;
  const failures=[];
  for(let i=0;i<5;i++){
   const node=i===1?game:i===3?qa:active;
   const isFailure=[1,3,4].includes(i),isFinal=i===4;
   const detail=isFailure?(i===1?DELEGATION:OVERFLOW):null;
   const mid=randomUUID(),jid=randomUUID(),did=randomUUID();
   const created=new Date(Date.now()+1000*(i+2)).toISOString();
   const m={...prior,id:mid,project_kind:'management',status:isFailure?'blocked':'completed',
    created_at:created,updated_at:created,deadline:original.cutoff,
    calls:isFailure?(i===1?1:0):1,actual_tokens:0,reserved_tokens:0,
    detail,result:isFailure?null:'Management decisions committed',
    team:[{id:node.agent_id,config:{name:node.name,maxActiveTasks:1}}],
    project_evidence:{...prior.project_evidence,
     organizationNodeId:node.id,providerContinuationWindow:provider.window_id,
     providerContinuationDecision:provider.continuation_decision_id,
     providerContinuationRelease:provider.continuation_release_sha,previousMissionId:null}};
   const j={...priorJob,id:jid,mission_id:mid,agent_id:node.agent_id,
    role:'work',job_key:'plan',status:isFailure?'failed':'completed',
    attempts:1,lease:null,lease_until:null,heartbeat_at:null,
    detail,result:isFailure?{detail,diagnostic:{stage:'work',errorType:'Error',acceptedIssue:false}}:
     {output:'Management decision recorded',decisionId:did},
    payload:{organizationNodeId:node.id},dependencies:[],
    available_at:'1800-01-01T00:00:04Z',created_at:isFinal?'1799-01-01T00:00:00Z':'1800-01-01T00:00:01Z',updated_at:created};
   await db.query('insert into agent_missions select (jsonb_populate_record(null::agent_missions,$1::jsonb)).*',[m]);
   await db.query('update work_projects set active_mission_id=$2 where id=$1',[project,mid]);
   await db.query('insert into mission_assignments select (jsonb_populate_record(null::mission_assignments,$1::jsonb)).*',[j]);
   await db.query("insert into project_organization_assignments(assignment_id,node_id,contract_hash) select $1,n.id,encode(sha256(convert_to(project_canonical(n.acceptance),'UTF8')),'hex') from project_organization_nodes n where n.id=$2",[jid,node.id]);
   if(!isFailure)await db.query("insert into project_organization_decisions(id,project_id,node_id,assignment_id,decision,created_at) values($1,$2,$3,$4,'[{\"action\":\"ready\"}]'::jsonb,$5)",[did,project,node.id,jid,created]);
   if(isFailure)failures.push({mid,jid,detail});
   if(isFinal)current={mid,jid};
  }
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,95);
  await db.query('update project_organization_nodes set decision_needed=true where id=$1',[active.id]);
  await db.query("update work_projects set status='blocked',detail=$2,lease=null,lease_until=null,progress_since=clock_timestamp()-interval '5 minutes',updated_at=clock_timestamp() where id=$1",[project,BLOCKED]);
  const beforeProgress=(await db.query('select progress_since from work_projects where id=$1',[project])).rows[0].progress_since;
  const historical=(await db.query('select to_jsonb(m) m,to_jsonb(j) j from agent_missions m join mission_assignments j on j.mission_id=m.id where m.id=$1',[failures[0].mid])).rows[0];
  const originalJob=(await db.query('select result,detail from mission_assignments where id=$1',[current.jid])).rows[0];
  const migration=readFileSync('supabase/migrations/20261124160000_followup_management_one_retest.sql','utf8');
  const actualMd5=(await db.query("select md5(prosrc) h from pg_proc where oid='public.project_org_retest_claim_release_authorized_epoch(uuid,text,bigint,text)'::regprocedure")).rows[0].h;
  assert.match(migration,/f4485be14215641819997f5d5dfa8ea0/,'Production preimage MD5 remains pinned');
  const testMigration=migration
   .replace(/^\s*(?:--[^\n]*\n)*BEGIN;\s*/i,'')
   .replace(/\s*COMMIT;\s*$/i,'')
   .replace("'f4485be14215641819997f5d5dfa8ea0'","'"+actualMd5+"'");
  await db.query(testMigration); // Native fixture DDL only, never production writes.
  await db.query('set role service_role');
  assert.equal((await db.query('select project_org_followup_context_retest_claim_authorized($1,$2,$3,$4) ok',[project,release,generation,deployment])).rows[0].ok,false);
  const offer=(await db.query('select project_org_followup_context_retest_offer($1,$2,$3) offer',[owner,project,release])).rows[0].offer;
  assert.equal(offer.stage,'authorize');
  assert.equal(offer.historicalMissions,95);
  assert.equal(offer.missionId,current.mid);
  assert.equal(offer.assignmentId,current.jid);
  assert.equal(offer.originalCalls,0);
  const authId=randomUUID(),args=[owner,project,release,generation,deployment,current.mid,current.jid,authId,offer.stateHash,'c'.repeat(64),45112];
  const sql='select project_org_followup_context_retest_authorize($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r';
  const denied=async invalid=>{
   await db.query('savepoint neg_followup');
   try{await assert.rejects(db.query(sql,invalid));}
   finally{await db.query('rollback to savepoint neg_followup');await db.query('release savepoint neg_followup');}
  };
  await denied([randomUUID(),...args.slice(1)]);
  await denied(args.map((v,i)=>i===2?'e'.repeat(40):v));
  await denied(args.map((v,i)=>i===8?'d'.repeat(64):v));
  await denied(args.map((v,i)=>i===10?48001:v));
  const receipt=(await db.query(sql,args)).rows[0].r;
  assert.equal(receipt.stage,'authorized');
  assert.equal(receipt.historicalMissions,95);
  assert.equal(receipt.originalAttempts,1);
  assert.equal((await db.query('select attempts from mission_assignments where id=$1',[current.jid])).rows[0].attempts,1);
  await denied(args);
  await db.query('reset role');
  const newReceipt=(await db.query('select * from project_followup_context_retest_receipts where project_id=$1',[project])).rows[0];
  const sameOld=(await db.query('select * from project_context_retest_receipts where project_id=$1',[project])).rows[0];
  assert.equal(newReceipt.source_mission_id,current.mid);
  assert.equal(newReceipt.original_assignment_detail,originalJob.detail);
  assert.deepEqual(newReceipt.original_assignment_result,originalJob.result);
  assert.deepEqual(JSON.parse(JSON.stringify(sameOld)),oldReceipt,'Previously signed owner approval is immutable');
  const historyAfter=(await db.query('select to_jsonb(m) m,to_jsonb(j) j from agent_missions m join mission_assignments j on j.mission_id=m.id where m.id=$1',[failures[0].mid])).rows[0];
  assert.deepEqual(historyAfter,historical,'Earlier post-inference delegation rejection remains immutable');
  const projectState=(await db.query('select status,progress_since from work_projects where id=$1',[project])).rows[0];
  assert.equal(projectState.status,'running');
  assert(projectState.progress_since>beforeProgress);
  await db.query('set role service_role');
  assert.equal((await db.query('select project_org_retest_claim_release_authorized_epoch($1,$2,$3,$4) ok',[project,release,generation,deployment])).rows[0].ok,true);
  await db.query('reset role');
  await db.query("update mission_assignments set available_at=clock_timestamp()+interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id<>$1 and status='running' and lease_until>clock_timestamp()",[current.jid]);
  await db.query("update mission_assignments set available_at=clock_timestamp()+interval '15 minutes' where id<>$1 and status in ('queued','waiting_external') and available_at<=clock_timestamp()",[current.jid]);
  await db.query('set role service_role');
  const claimed=(await db.query('select claim_mission_work_release_epoch($1,$2,$3) result',[release,generation,deployment])).rows[0].result;
  assert.equal(claimed?.job?.id,current.jid,'Actual global claim must grant exactly this approval');
  assert.equal(claimed.job.attempts,2);
  assert.ok(claimed.job.lease);
  assert.notEqual((await db.query('select claim_mission_work_release_epoch($1,$2,$3) result',[release,generation,deployment])).rows[0].result?.job?.id,current.jid);
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,95);
  console.log('MISSION95_ONE_FOLLOWUP_NATIVE_PASS: preserved 95 missions, prior owner receipt, M92 rejection and M94 overflow, source-bound one signed attempt, normal scheduler one claim at attempts2');
  if(process.env.KATIE_TEST_CODING_CAPACITY==='1'){
   const {assertCodingCapacityNative}=await import('./assert-coding-capacity-native.mjs');
   await assertCodingCapacityNative(db,{project,owner,release,generation,deployment,current,claimed});
  }
 }finally{
  await db.query('rollback to savepoint followup_95');
  await db.query('release savepoint followup_95');
  await db.query('reset role');
 }
}
