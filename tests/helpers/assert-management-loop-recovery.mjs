import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './load-project-modules.mjs';

export async function assertManagementLoopRecovery(db,x){
 const {project,owner,actor,chat,game,scopeHash,scopePaths,deadline,release,activate,decide}=x;
 await db.query('savepoint management_loop_fixture');
 const reject=async(fn,pattern)=>{
  await db.query('savepoint rejected_command');
  try{await assert.rejects(fn(),pattern);}finally{await db.query('rollback to savepoint rejected_command');await db.query('release savepoint rejected_command');}
 };
 const node=async id=>(await db.query('select * from project_organization_nodes where id=$1',[id])).rows[0];
 const child=async parent=>(await db.query('select * from project_organization_nodes where parent_id=$1 order by created_at desc,id desc',[parent])).rows;
 const appointment=(name,level,tools)=>({action:'appoint',kind:level==='worker'?'worker':'manager',managementLevel:level,name,area:name.toLowerCase(),objective:'Deliver bounded '+name,acceptance:['Approved game contract passes'],tools,paths:[],tokens:10000,deadline});
 const amend=n=>({action:'amend_delegation',nodeId:n.id,expectedTools:n.tools,expectedDeadline:new Date(n.deadline).toISOString(),tools:[...n.tools,'development'],reason:'Delegate the existing approved implementation milestone'});
 // Actual production context assembler/client validator + mocked model transport
 // + real PostgreSQL command admission. No provider or application code runs.
 const adapter={from(table){
  assert.match(table,/^[a-z_]+$/);let columns='*',where=[],values=[],orders=[],single=false,range;
  const q={select(c){assert.match(c,/^[a-z_,*]+$/);columns=c;return q;},eq(k,v){values.push(v);where.push(k+'=$'+values.length);return q;},in(k,v){values.push(v);where.push(k+'=any($'+values.length+')');return q;},order(k,o){orders.push(k+(o.ascending?' asc':' desc'));return q;},range(a,b){range=[a,b];return q;},single(){single=true;return q;},then(ok,bad){
   const sql='select '+columns+' from '+table+(where.length?' where '+where.join(' and '):'')+(orders.length?' order by '+orders.join(','):'')+(range?' limit '+(range[1]-range[0]+1)+' offset '+range[0]:'');
   return db.query(sql,values).then(r=>({data:JSON.parse(JSON.stringify(single?r.rows[0]:r.rows)),error:null})).then(ok,bad);
  }};return q;
 }};
 let calls=0;
 const {executeManagementClaim}=modules({'@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>adapter},'@/lib/missions/store':{rpc:async(name,args)=>{
  if(name==='project_provider_mode')return true;
  assert.equal(name,'project_org_decide');return db.query('select project_org_decide($1,$2,$3)',[args.p_job,args.p_lease,JSON.stringify(args.p_commands)]);
 }}})('@/lib/projects/organization');
 const mocked=async(s,commands,inspect=()=>{})=>{
  const mission=(await db.query('select * from agent_missions where id=$1',[s.mission])).rows[0];
  const job=(await db.query('select * from mission_assignments where id=$1',[s.job])).rows[0];
  await executeManagementClaim({mission,job},async(_claim,instruction,input,tools)=>{
   calls++;assert.equal(tools,'none');const context=JSON.parse(input);
   assert.equal(context.project.milestoneIndex,0);assert.ok(context.project.approvedContract.currentMilestone.instruction);
   assert.match(context.delegationPolicy,/BOTH development/);assert.match(instruction,/Historical open exceptions/);
   const scopedMissing=context.organization.filter(n=>n.kind==='manager'&&!n.tools.includes('development')&&context.scopeGrants.some(g=>g.node_id===n.id&&g.scope_hash===scopeHash)&&!['independent_qa','quality_assurance'].includes(n.area));
   if(context.principal.tools.includes('development')&&scopedMissing.length)assert.match(instruction,/SCOPED REPORTS WITHOUT IMPLEMENTATION CAPABILITY/);
   inspect(context);return {text:JSON.stringify(commands)};
  });
 };
 try{
  await mocked(await activate(game.id),[appointment('Loop Delivery Manager','manager',['manage','analysis','repository_review']),{action:'ready'}]);
  const manager=(await child(game.id)).find(n=>n.name==='Loop Delivery Manager');
  // Reproduce the live scope-only delegation and show that it is not coding authority.
  await mocked(await activate(game.id),[{action:'grant_scope',nodeId:manager.id,paths:scopePaths},{action:'ready'}]);
  assert.equal((await node(manager.id)).tools.includes('development'),false);
  let s=await activate(game.id);
  await mocked(s,[{action:'replace_leader',nodeId:manager.id,reason:'First bounded leadership correction'},{action:'ready'}]);
  s=await activate(game.id);
  await reject(()=>mocked(s,[{action:'replace_leader',nodeId:manager.id,reason:'Repeat without execution'},{action:'ready'}],ctx=>{
   assert.ok(ctx.latestReplacementDecisions.some(d=>d.decision.some(c=>c.action==='replace_leader')));
  }),/Repeated leadership replacement/);
  assert.equal((await db.query('select count(*)::int n from project_organization_leadership where node_id=$1',[manager.id])).rows[0].n,2);
  await mocked(s,[amend(await node(manager.id)),{action:'ready'}]);
  await mocked(await activate(manager.id),[appointment('Loop Supervisor','supervisor',['manage','analysis','repository_review']),{action:'ready'}]);
  const supervisor=(await child(manager.id))[0];
  await mocked(await activate(manager.id),[amend(supervisor),{action:'grant_scope',nodeId:supervisor.id,paths:scopePaths},{action:'ready'}]);
  await mocked(await activate(supervisor.id),['Coder','Writer','Reviewer'].map(name=>appointment('Loop '+name,'worker',name==='Coder'?['analysis','development']:['analysis'])).concat({action:'ready'}));
  const workers=await child(supervisor.id),coder=workers.find(n=>n.name==='Loop Coder'),writer=workers.find(n=>n.name==='Loop Writer'),reviewer=workers.find(n=>n.name==='Loop Reviewer');
  await mocked(await activate(supervisor.id),workers.map(n=>({action:'grant_scope',nodeId:n.id,paths:scopePaths})).concat({action:'ready'}));
  s=await activate(supervisor.id);
  const forged=[{action:'resolve',exceptionId:randomUUID(),assignmentId:randomUUID(),evidence:'Invented success'}];
  await reject(()=>mocked(s,forged),/authenticated completed assignment evidence/);
  await reject(()=>decide(s,forged),/authenticated subordinate evidence/);
  await reject(()=>mocked(s,[{action:'dependency',nodeId:coder.id,dependsOn:'not-a-uuid'}]),/immediate reporting/);
  await reject(()=>mocked(s,[{action:'dependency',nodeId:coder.id,dependsOn:coder.id}]),/cannot depend on itself/);
  await reject(()=>mocked(s,[{action:'close'}]),/Project Director|incomplete|closure/i);
  // Exercise a genuine failed management mission and the owner recovery boundary.
  await db.query('savepoint paused_recovery');
  const fail={detail:'Synthetic invalid evidence command retained',managementCommandRejection:{code:'exception_evidence'}};
  await db.query("select commit_mission_work($1,$2,$3,'[]','failed','blocked',null)",[s.job,s.lease,fail]);
  await db.query('reset role');
  // This shared fixture wraps many sessions in one transaction. Model a fresh
  // post-ratification mission timestamp, as the live scheduler creates it.
  await db.query('update agent_missions set created_at=clock_timestamp() where id=$1',[s.mission]);
  await db.query('set role service_role');
  await db.query("select control_work_project($1,$2,$3,'pause','Preserve remaining mission allowance')",[project,actor,chat]);
  const immutable=async()=>{
   const out={};for(const table of ['project_organization_nodes','project_organization_decisions','project_organization_leadership','project_organization_exceptions','project_organization_scope_grants','agent_missions']){
    const filter=table==='project_organization_leadership'?'node_id in (select id from project_organization_nodes where project_id=$1)':table==='project_organization_scope_grants'?'node_id in (select id from project_organization_nodes where project_id=$1)':'project_id=$1';
    out[table]=(await db.query('select to_jsonb(t) r from '+table+' t where '+filter+' order by to_jsonb(t)::text',[project])).rows;
   }
   out.assignments=(await db.query('select to_jsonb(j) r from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1 order by j.id',[project])).rows;
   out.limits=(await db.query('select deadline,max_missions,token_allowance,approved_hash,approval_hash,spec,active_mission_id from work_projects where id=$1',[project])).rows[0];return out;
  };
  const before=await immutable(),newRelease='d'.repeat(40);
  const args=[owner,project,newRelease,release,scopeHash,s.mission];
  const resume=(a=args)=>db.query('select project_org_resume_management($1,$2,$3,$4,$5,$6) r',a);
  for(const [i,value] of [[0,randomUUID()],[1,randomUUID()],[2,null],[2,'bad'],[2,release],[3,'f'.repeat(40)],[4,null],[4,'f'.repeat(64)],[5,randomUUID()]]){
   const bad=[...args];bad[i]=value;await reject(()=>resume(bad),/owner approval|evidence or authority/);
  }
  await reject(()=>db.query("select control_work_project($1,$2,$3,'resume')",[project,actor,chat]),/blocked or expired/);
  // Model the already audited #1047 receipt chain, rather than assuming the
  // immutable window's original SHA still equals the active release.
  await db.query('savepoint prior_release_chain');await db.query('reset role');
  const intermediate='e'.repeat(40);
  await db.query("insert into project_scoped_root_retry_receipts(source_mission_id,project_id,window_id,owner_id,decision_id,prior_release_sha,release_sha,scope_hash,cutoff) select $2,a.project_id,a.window_id,a.owner_id,a.continuation_decision_id,a.continuation_release_sha,$3,a.approved_scope,a.deadline from project_provider_execution a where a.project_id=$1",[project,s.mission,intermediate]);
  await db.query('update project_provider_execution set continuation_release_sha=$2 where project_id=$1',[project,intermediate]);
  await db.query("update agent_missions set project_evidence=jsonb_set(project_evidence,'{providerContinuationRelease}',to_jsonb($2::text)) where id=$1",[s.mission,intermediate]);
  await db.query('set role service_role');
  assert.equal((await db.query('select project_provider_continued($1) ok',[project])).rows[0].ok,true);
  await resume([owner,project,newRelease,intermediate,scopeHash,s.mission]);
  assert.equal((await db.query('select project_provider_continued($1) ok',[project])).rows[0].ok,true);
  assert.equal((await db.query('select project_org_management_resume_release(window_id,$2) ok from project_provider_execution where project_id=$1',[project,newRelease])).rows[0].ok,true);
  await db.query('rollback to savepoint prior_release_chain');await db.query('release savepoint prior_release_chain');
  await db.query('savepoint recovery_atomicity');await resume();await db.query('rollback to savepoint recovery_atomicity');await db.query('release savepoint recovery_atomicity');
  assert.equal((await db.query('select count(*)::int n from project_management_resume_receipts where project_id=$1',[project])).rows[0].n,0);
  await resume();assert.deepEqual(await immutable(),before,'Recovery retains exact history, identity, scope, limits and blocked pointer');
  assert.equal((await db.query('select project_provider_continued($1) ok',[project])).rows[0].ok,true);
  assert.equal((await db.query('select project_org_management_resume_release(window_id,$2) ok from project_provider_execution where project_id=$1',[project,newRelease])).rows[0].ok,true);
  assert.equal((await db.query('select project_org_management_resume_release(window_id,$2) ok from project_provider_execution where project_id=$1',[project,release])).rows[0].ok,false);
  await reject(()=>resume(),/evidence or authority/);
  await reject(()=>db.query('delete from project_management_resume_receipts'),/permission denied/);
  await db.query('savepoint receipt_immutable');await db.query('reset role');
  await reject(()=>db.query("update project_management_resume_receipts set release_sha=repeat('e',40)"),/append-only/);
  await db.query('rollback to savepoint receipt_immutable');await db.query('release savepoint receipt_immutable');
  await db.query('set role authenticated');await reject(()=>resume(),/permission denied/);await db.query('reset role');await db.query('set role service_role');
  // Feed only invalid model decisions through the normal scheduler. Existing
  // per-node failure bounds must stop at the root, never spend the whole limit.
  const initialCount=(await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n;
  let bounded=false,created=0;
  for(let i=0;i<24;i++){
   const lease=randomUUID();await db.query('reset role');
   await db.query("update work_projects set lease=$2,lease_until=clock_timestamp()+interval '5 minutes' where id=$1",[project,lease]);
   await db.query('set role service_role');
   const scheduled=(await db.query('select project_org_schedule($1,$2) r',[project,lease])).rows[0].r;
   if(scheduled.blocked){assert.match(scheduled.blocked,/bounded retry/);bounded=true;break;}
   if(!scheduled.missionId){assert.equal(scheduled.waiting,true);continue;}
   created++;
   await db.query('reset role');
   await db.query('update agent_missions set created_at=clock_timestamp() where id=$1',[scheduled.missionId]);
   // Keep unrelated synthetic suites out of this claim race; rollback restores them.
   await db.query("update agent_missions set status='blocked' where id<>$1 and status='running'",[scheduled.missionId]);
   await db.query('set role service_role');
   await db.query('savepoint stale_claim');
   const stale=(await db.query('select claim_mission_work_release($1) c',[release])).rows[0].c;
   assert.notEqual(stale?.mission.id,scheduled.missionId);
   await db.query('rollback to savepoint stale_claim');await db.query('release savepoint stale_claim');
   const claimed=(await db.query('select claim_mission_work_release($1) c',[newRelease])).rows[0].c;
   assert.equal(claimed?.mission.id,scheduled.missionId,'Corrected release claim: '+JSON.stringify({actual:claimed?.mission.id,kind:claimed?.mission.project_kind,project:claimed?.mission.project_id,expected:scheduled.missionId}));
   const next={mission:claimed.mission.id,job:claimed.job.id,lease:claimed.job.lease,node:scheduled.nodeId};
   let failure;
   try{await mocked(next,[{action:'dependency',nodeId:randomUUID(),dependsOn:'malformed'}]);assert.fail('Invalid model command admitted');}
   catch(error){assert.equal(error.evidence?.code,'immediate_reporting_authority');failure=error.evidence;}
   assert.equal((await db.query("select commit_mission_work($1,$2,$3,'[]','failed','blocked',null) ok",[next.job,next.lease,{detail:failure.reason,managementCommandRejection:failure}])).rows[0].ok,true);
  }
  assert.equal(bounded,true);assert.ok(created<=8,'Existing four-level hierarchy stops within eight invalid calls');
  assert.equal((await db.query('select count(*)::int n from agent_missions where project_id=$1',[project])).rows[0].n,initialCount+created);
  console.log('MANAGEMENT_INVALID_COMMAND_BOUND_PASS: '+created+' additional missions; no replacement or failure-count reset');
  await db.query('rollback to savepoint paused_recovery');await db.query('release savepoint paused_recovery');
  const smart=(role,paths)=>({objective:role+' bounded deliverable',deliverable:role+' evidence',instruction:'Complete only the approved milestone contract',parentObjective:supervisor.objective,capability:'analysis',acceptance:[{criterion:'Approved browser contract passes',evidence:'Same source verification'}],inventory:[{item:'Approved milestone',contextChars:1000}],estimate:{basis:'declared_inventory',rationale:'One bounded deliverable',uncertainty:'Verification required',tokens:1000,seconds:30},tokens:2000,maxAssignments:2,deadline,paths});
  const command={action:'commission_package',workerId:coder.id,writerId:writer.id,reviewerId:reviewer.id,milestoneIndex:0,objective:'Implement the approved game',deliverables:['Approved game and tests'],interfaces:[],dependencies:[],acceptance:['Approved browser contract passes'],paths:scopePaths,deadline,maxAttempts:2,tasks:{development:smart('development',['app/milestone-3-tic-tac-toe/page.tsx']),compose:smart('compose',[]),review:smart('review',[])}};
  for(const paths of [scopePaths,['app/unauthorized.tsx'],['../escape.ts'],['app/milestone-3-tic-tac-toe/*.tsx']])await reject(()=>mocked(s,[{...command,tasks:{...command.tasks,development:smart('development',paths)}}]),/bounded file inventory|scope/);
  await mocked(s,[command]);
  const packages=(await db.query('select * from project_work_packages where project_id=$1',[project])).rows;
  assert.equal(packages.length,1);assert.equal(packages[0].manager_id,supervisor.id);assert.equal(packages[0].worker_id,coder.id);
  assert.ok(calls>=12);
  console.log('MANAGEMENT_LOOP_RECOVERY_POSTGRES_PASS: real context/client/SQL chain; replacement loop denied; negative commands fail closed; owner resume preserves history and limits; one bounded worker package, no dispatch');
 }finally{await db.query('rollback to savepoint management_loop_fixture');await db.query('release savepoint management_loop_fixture');await db.query('set role service_role');}
}
