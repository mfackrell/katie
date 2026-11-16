import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function assertPausedWindowRenewal(db,x){
 const {rival,project,owner,scopeHash,release,source,supervisor,actor,chat}=x;
 await db.query('savepoint expired_window_fixture');
 const reject=async(fn,pattern)=>{
  await db.query('savepoint renewal_rejected');
  try{await assert.rejects(fn(),pattern);}finally{await db.query('rollback to savepoint renewal_rejected');await db.query('release savepoint renewal_rejected');}
 };
 const privileged=async(sql,args=[])=>{await db.query('reset role');const result=await db.query(sql,args);await db.query('set role service_role');return result;};
 try{
  // Construct an already expired 73/96, 13-node history only in this disposable
  // native database. Restore all triggers before testing any RPC.
  await db.query('reset role');
  await db.query("set local session_replication_role='replica'");
  const prior=(await db.query("select date_trunc('second',clock_timestamp())-interval '1 hour' t")).rows[0].t;
  const cutoff=new Date(prior.getTime()+86400000).toISOString();
  const authority=(await db.query('select * from project_provider_execution where project_id=$1',[project])).rows[0];
  const originalWindow=authority.window_id,intermediate='e'.repeat(40),newRelease='d'.repeat(40);
  await db.query('update project_execution_windows set prior_cutoff=$2::timestamptz-interval \'24 hours\',cutoff=$2 where id=$1',[originalWindow,prior]);
  await db.query('update project_provider_execution set deadline=$2,continuation_release_sha=$3 where project_id=$1',[project,prior,intermediate]);
  await db.query('update work_projects set deadline=$2,max_missions=96,token_allowance=600000 where id=$1',[project,prior]);
  await db.query("update project_organization_nodes set deadline=$2,token_limit=case when kind='project_director' then 600000 else token_limit end where project_id=$1",[project,prior]);
  await db.query("update agent_missions set deadline=$2,project_evidence=jsonb_set(project_evidence,'{providerContinuationRelease}',to_jsonb($3::text)) where id=$1",[source.mission,prior,intermediate]);
  // Existing #1047 release rebound chain remains immutable during the operation.
  await db.query(`insert into project_scoped_root_retry_receipts(source_mission_id,project_id,window_id,owner_id,decision_id,prior_release_sha,release_sha,scope_hash,cutoff)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[source.mission,project,originalWindow,owner,authority.continuation_decision_id,release,intermediate,scopeHash,prior]);
  let count=(await db.query('select count(*)::int n from project_organization_nodes where project_id=$1',[project])).rows[0].n;
  assert.ok(count<=13,'13-node production-shaped fixture');
  for(;count<13;count++){
   const agent=(await db.query("select save_managed_agent(null,$1,false) a",[{name:'Renewal historical worker '+count,instructions:'Retain original bounded contract',research:false,development:false,attachments:false,reviewMode:'always',maxActiveTasks:1,maxInputChars:16000}])).rows[0].a.id;
   await db.query(`insert into project_organization_nodes(project_id,parent_id,agent_id,kind,name,objective,acceptance,tools,token_limit,deadline,depth,decision_needed,management_level)
    values($1,$2,$3,'worker',$4,'Retain original delegated contract','["Verified original deliverable"]',array['analysis'],1000,$5,$6,false,'worker')`,[project,supervisor.id,agent,'Historical worker '+count,prior,supervisor.depth+1]);
  }
  const missions=(await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n;
  assert.ok(missions<=73);
  for(let i=missions;i<73;i++)await db.query(`insert into agent_missions select (jsonb_populate_record(null::agent_missions,to_jsonb(m)||jsonb_build_object('id',gen_random_uuid(),'project_evidence','{}'::jsonb))).* from agent_missions m where id=$1`,[source.mission]);
  await db.query("set local session_replication_role='origin'");
  assert.equal((await db.query('show session_replication_role')).rows[0].session_replication_role,'origin');
  const state=(await db.query('select project_org_hierarchy_recovery_state($1) h',[project])).rows[0].h;
  await db.query('set role service_role');
  const args=[owner,project,newRelease,intermediate,scopeHash,source.mission,originalWindow,prior,cutoff,randomUUID(),state];
  const statement='select project_org_renew_paused_window($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r';
  const renew=(a=args)=>db.query(statement,a);
  const resume=(sha=newRelease,mid=source.mission)=>db.query('select project_org_resume_management($1,$2,$3,$4,$5,$6) r',[owner,project,sha,intermediate,scopeHash,mid]);
  const snapshot=async()=>{
   const out={};await db.query('reset role');
   for(const table of ['agent_missions','project_organization_decisions','project_organization_exceptions','project_scope_ratification_approvals','project_provider_requests','project_scoped_root_retry_receipts','project_work_packages'])
    out[table]=(await db.query('select to_jsonb(t) r from '+table+' t where project_id=$1 order by to_jsonb(t)::text',[project])).rows;
   for(const table of ['project_organization_scope_grants','project_organization_leadership'])
    out[table]=(await db.query('select to_jsonb(t) r from '+table+' t where node_id in(select id from project_organization_nodes where project_id=$1) order by to_jsonb(t)::text',[project])).rows;
   out.nodes=(await db.query("select to_jsonb(n)-'deadline' r from project_organization_nodes n where project_id=$1 order by id",[project])).rows;
   out.project=(await db.query("select to_jsonb(p)-'deadline'-'updated_at' r from work_projects p where id=$1",[project])).rows;
   out.provider=(await db.query("select to_jsonb(a)-'deadline'-'window_id' r from project_provider_execution a where project_id=$1",[project])).rows;
   out.window=(await db.query('select to_jsonb(w) r from project_execution_windows w where id=$1',[originalWindow])).rows;
   out.assignments=(await db.query('select to_jsonb(j) r from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1 order by j.id',[project])).rows;
   await db.query('set role service_role');return out;
  };
  const preflight=(sha=newRelease,who=owner)=>db.query('select project_org_management_activation_offer($1,$2,$3) o',[who,project,sha]);
  const originalOffer=(await preflight()).rows[0].o;
  assert.equal(originalOffer.stage,'renew');assert.equal(originalOffer.stateHash,state);
  assert.equal(originalOffer.nodeCount,13);assert.equal(originalOffer.historicalMissions,73);
  await reject(()=>preflight(newRelease,randomUUID()),/original project owner/);
  for(const role of ['anon','authenticated']){
   await db.query('reset role');await db.query('set role '+role);await reject(()=>preflight(),/permission denied/);
   await reject(()=>db.query('select project_org_resume_management_confirmed($1,$2,$3,$4,$5)',[owner,project,newRelease,args[9],state]),/permission denied/);
  }
  await db.query('reset role');await db.query('set role service_role');
  if(process.env.KATIE_TEST_OWNER_ACTIVATION==='1'){
   await (await import('./assert-owner-management-browser.mjs')).assertOwnerManagementBrowser(db,{...x,originalWindow,prior,cutoff,intermediate,newRelease});
  }
  const before=await snapshot();
  assert.equal((await db.query('select project_provider_continued($1) ok',[project])).rows[0].ok,true);
  await reject(()=>resume(),/evidence or authority/);
  for(const [i,v] of [[0,randomUUID()],[1,randomUUID()],[2,null],[2,intermediate],[3,release],[4,'f'.repeat(64)],[5,randomUUID()],[6,randomUUID()],
   [7,new Date(prior.getTime()-1000)],[8,new Date(prior.getTime()+86401000)],[8,new Date(prior.getTime()+86399000)],[8,'infinity'],[9,null],[9,originalWindow],[10,'f'.repeat(64)]]){
   await reject(()=>renew(args.map((a,k)=>k===i?v:a)),/owner approval|renewal required|evidence or authority|recovery state/);
  }
  // Exercise the clock guards with coherent windows, not merely mismatched
  // timestamps. Fixture-only time construction leaves RPC code unchanged.
  for(const offset of [3600000,-90000000]){
   await db.query('savepoint clock_boundary');await db.query('reset role');
   await db.query("set local session_replication_role='replica'");
   const expired=new Date(Date.now()+offset),next=new Date(expired.getTime()+86400000);
   await db.query("update project_execution_windows set prior_cutoff=$2::timestamptz-interval '24 hours',cutoff=$2 where id=$1",[originalWindow,expired]);
   await db.query('update project_provider_execution set deadline=$2 where project_id=$1',[project,expired]);
   await db.query('update work_projects set deadline=$2 where id=$1',[project,expired]);
   await db.query('update project_organization_nodes set deadline=$2 where project_id=$1',[project,expired]);
   await db.query("set local session_replication_role='origin'");
   const h=(await db.query('select project_org_hierarchy_recovery_state($1) h',[project])).rows[0].h;
   await db.query('set role service_role');
   await reject(()=>renew(args.map((v,i)=>i===7?expired:i===8?next:i===10?h:v)),/renewal required/);
   await db.query('rollback to savepoint clock_boundary');await db.query('release savepoint clock_boundary');
  }
  // Wrong actor binding, source evidence, scope, budget, pending work and QA
  // authority are rejected even when the caller supplies a fresh state hash.
  const mutation=async(sql,params,pattern)=>{
   await db.query('savepoint mutated_state');
   try{
    await db.query('reset role');await db.query("set local session_replication_role='replica'");
    await db.query(sql,params);
    await db.query("set local session_replication_role='origin'");await db.query('set role service_role');
    const h=(await privileged('select project_org_hierarchy_recovery_state($1) h',[project])).rows[0].h;
    await reject(()=>renew(args.map((v,i)=>i===10?h:v)),pattern);
   }finally{await db.query('rollback to savepoint mutated_state');await db.query('release savepoint mutated_state');}
  };
  await mutation('delete from standalone_owner_bindings where owner_id=$1 and actor_id=$2 and chat_id=$3',[owner,actor,chat],/owner approval/);
  await mutation("update project_organization_nodes set tools=array_append(tools,'development') where project_id=$1 and area='independent_qa'",[project],/recovery state/);
  await mutation("update project_organization_nodes set parent_id=id where id=$1",[supervisor.id],/recovery state/);
  await mutation('update work_projects set approval_hash=$2 where id=$1',[project,'f'.repeat(64)],/evidence or authority/);
  await mutation('update work_projects set max_missions=97 where id=$1',[project],/evidence or authority/);
  await mutation('update work_projects set token_allowance=599999 where id=$1',[project],/evidence or authority/);
  await mutation("update agent_missions set project_evidence=jsonb_set(project_evidence,'{providerContinuationWindow}',to_jsonb($2::text)) where id=$1",[source.mission,randomUUID()],/evidence or authority/);
  await mutation("update mission_assignments set status='queued' where id=$1",[source.job],/evidence or authority/);
  await mutation("update project_provider_requests set resolved_at=null,provider_receipt=null where id=(select id from project_provider_requests where project_id=$1 limit 1)",[project],/evidence or authority/);
  // RPC/table permissions and immutable receipts are tested with real roles.
  for(const role of ['anon','authenticated']){
   await db.query('reset role');await db.query('set role '+role);await reject(()=>renew(),/permission denied/);
  }
  await db.query('reset role');await db.query('set role service_role');
  await reject(()=>db.query('delete from project_paused_window_renewals'),/permission denied/);
  // Inject a failure at the final write, after all 13 deadline updates.
  await privileged("create function public.paused_renewal_test_abort() returns trigger language plpgsql as $$ begin if new.event='paused_execution_window_renewed' then raise exception 'synthetic post-write failure';end if;return new;end $$");
  await privileged('create trigger paused_renewal_test_abort before insert on project_events for each row execute function paused_renewal_test_abort()');
  await reject(()=>renew(),/synthetic post-write failure/);
  assert.deepEqual(await snapshot(),before);
  assert.equal((await db.query('select count(*)::int n from project_execution_windows where id=$1',[args[9]])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from project_paused_window_renewals where project_id=$1',[project])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from project_organization_nodes where project_id=$1 and deadline=$2',[project,prior])).rows[0].n,13);
  await privileged('drop trigger paused_renewal_test_abort on project_events;drop function paused_renewal_test_abort()');
  const receipt=(await renew()).rows[0].r;
  assert.equal(receipt.status,'paused');assert.equal(receipt.historicalMissions,73);
  assert.deepEqual(await snapshot(),before,'renewal preserves all non-deadline project/provider/node fields and complete historical records');
  assert.equal((await db.query('select count(*)::int n from project_organization_contract_changes where window_id=$1',[args[9]])).rows[0].n,13);
  assert.equal((await db.query('select count(*)::int n from project_organization_nodes where project_id=$1 and deadline=$2',[project,cutoff])).rows[0].n,13);
  assert.equal((await db.query('select project_provider_continued_assignment($1) ok',[source.job])).rows[0].ok,false,'historical failed assignment remains ineligible');
  const renewedOffer=(await preflight()).rows[0].o;
  assert.equal(renewedOffer.stage,'resume');assert.equal(renewedOffer.authorizationId,args[9]);
  await reject(()=>preflight('f'.repeat(40)),/Renewal receipt/);
  await reject(()=>db.query('select project_org_resume_management_confirmed($1,$2,$3,$4,$5)',[owner,project,newRelease,args[9],state]),/state changed/);
  await reject(()=>db.query('select project_org_resume_management_confirmed($1,$2,$3,$4,$5)',[owner,project,newRelease,randomUUID(),renewedOffer.stateHash]),/Verified renewal/);
  await db.query('savepoint confirmed_resume');
  const confirmed=async()=>(await db.query('select project_org_resume_management_confirmed($1,$2,$3,$4,$5) r',[owner,project,newRelease,args[9],renewedOffer.stateHash])).rows[0].r;
  assert.equal((await confirmed()).existing,false);
  await reject(()=>confirmed(),/state changed/);
  const recorded=(await preflight()).rows[0].o;
  assert.equal((await db.query('select project_org_resume_management_confirmed($1,$2,$3,$4,$5) r',[owner,project,newRelease,args[9],recorded.stateHash])).rows[0].r.existing,true);
  assert.equal((await preflight()).rows[0].o.stage,'resumed');
  await db.query('rollback to savepoint confirmed_resume');await db.query('release savepoint confirmed_resume');

  // A competing actual RPC must wait on the same transaction lock; it cannot
  // bypass or partially renew while the first transaction is uncommitted.
  if(rival){
   await rival.query('set role service_role');await rival.query("set statement_timeout='250ms'");
   try{await assert.rejects(rival.query(statement,args),/statement timeout/);}
   finally{await rival.query('set statement_timeout=0');}
  }
  await reject(()=>renew(),/renewal required/);
  await reject(()=>resume('f'.repeat(40)),/evidence or authority/);
  await reject(()=>resume(newRelease,randomUUID()),/evidence or authority/);
  await reject(()=>db.query("select control_work_project($1,$2,$3,'resume')",[project,actor,chat]),/blocked or expired/);
  // Do not allow forged current-window evidence to evade the receipt bridge.
  await db.query('savepoint forged_source');
  await privileged("update agent_missions set project_evidence=jsonb_set(project_evidence,'{providerContinuationWindow}',to_jsonb($2::text)) where id=$1",[source.mission,args[9]]);
  await reject(()=>resume(),/evidence or authority/);
  await db.query('rollback to savepoint forged_source');await db.query('release savepoint forged_source');
  for(const table of ['project_paused_window_renewals','project_execution_windows','project_organization_contract_changes']){
   await db.query('reset role');await reject(()=>db.query('delete from '+table),/append-only/);await db.query('set role service_role');
  }
  await resume();await reject(()=>resume(),/evidence or authority/);
  assert.deepEqual((await db.query('select to_jsonb(m) r from agent_missions m where project_id=$1 order by to_jsonb(m)::text',[project])).rows,before.agent_missions,'resume preserves every historical mission exactly');
  assert.equal((await db.query('select project_provider_continued($1) ok',[project])).rows[0].ok,true);
  assert.equal((await db.query('select project_org_management_resume_release($1,$2) ok',[args[9],newRelease])).rows[0].ok,true);
  // Full ordinary scheduler/claim path after the original blocked pointer.
  let scheduled;
  for(let i=0;i<3;i++){
   const lease=randomUUID();await privileged("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '5 minutes' where id=$1",[project,lease]);
   scheduled=(await db.query('select project_org_schedule($1,$2) s',[project,lease])).rows[0].s;
   if(scheduled.missionId)break;assert.equal(scheduled.waiting,true);
  }
  assert.ok(scheduled.missionId,JSON.stringify(scheduled));
  await privileged("update agent_missions set status='blocked' where id<>$1 and status='running'",[scheduled.missionId]);
  await privileged('update agent_missions set created_at=clock_timestamp() where id=$1',[scheduled.missionId]);
  for(const sha of [release,intermediate,'f'.repeat(40)]){
   await db.query('savepoint stale_claim');
   assert.notEqual((await db.query('select claim_mission_work_release($1) c',[sha])).rows[0].c?.mission.id,scheduled.missionId);
   await db.query('rollback to savepoint stale_claim');await db.query('release savepoint stale_claim');
  }
  const claimed=(await db.query('select claim_mission_work_release($1) c',[newRelease])).rows[0].c;
  assert.equal(claimed?.mission.id,scheduled.missionId);
  assert.equal(claimed.mission.project_evidence.providerContinuationWindow,args[9]);
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,74);
  assert.equal((await db.query('select count(*)::int n from project_work_packages where project_id=$1',[project])).rows[0].n,0);
  console.log('PAUSED_WINDOW_RENEWAL_POSTGRES_PASS: 73/96 missions, 600000 tokens, 13 nodes; exact owner/state/release, append-only history, full-write rollback, competing RPC lock, replay, stale claims, terminal-source immutability; no provider calls');
 }finally{await db.query('rollback to savepoint expired_window_fixture');await db.query('release savepoint expired_window_fixture');await db.query('set role service_role');}
}
