import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {modules} from './load-project-modules.mjs';

// Deterministic management fixtures, actual PostgreSQL leases/transactions.
// This qualifies authority; it is not evidence of live inference autonomy.
export async function assertOrganizationalContractAmendments(db,rival,{project,owner,cutoff,recovery,job}){
 const sql=async(c,q,args)=>(await c.query(q,args)).rows[0]?.value;
 const rows=async()=> (await db.query('select * from project_organization_nodes where project_id=$1',[project.id])).rows;
 // The preceding generic-controller fixture substitutes its team. Restore the
 // original pinned team before testing the real game management scheduler.
 await db.query('reset role');await db.query('update work_projects set team=$2 where id=$1',[project.id,project.team]);await db.query('set role service_role');
 const initial=await rows(),root=initial.find(n=>n.kind==='project_director'),game=initial.find(n=>n.kind==='manager'&&n.area==='development'),qa=initial.find(n=>n.kind==='manager'&&n.area==='quality_assurance');
 assert.ok(game&&qa);assert.notEqual(game.id,qa.id);

 // Native PostgreSQL regression: assemble a real organization's decision
 // evidence without relying on fixture-only JavaScript objects or fake RPCs.
 // All queries are read-only and retain the original database evidence.
 await db.query('reset role');
 const {managementScope,selectManagementEvidenceIds,buildManagementDecisionContext}=modules()('@/lib/projects/management-context');
 const scope=managementScope(initial,root.id);
 const load=async(query,args=[])=> (await db.query(query,args)).rows;
 const current=await load('select objective,team,approved_hash,verified_sha,phase,deadline from work_projects where id=$1',[project.id]);
 assert.equal(current.length,1);
 const binds=await load('select assignment_id,node_id,created_at from project_organization_assignments where node_id=any($1::uuid[])',[scope.decisionIds]);
 const statusRows=binds.length?await load('select id,status,updated_at from mission_assignments where id=any($1::uuid[])',[binds.map(b=>b.assignment_id)]):[];
 const selected=selectManagementEvidenceIds(binds,statusRows,scope.decisionIds);
 const related=async(table,field,values)=>load('select * from '+table+' where '+field+'=any($1::uuid[])',[values]);
 const context=buildManagementDecisionContext({
  principalId:root.id,topology:initial,scopedNodes:initial.filter(n=>scope.contextIds.includes(n.id)),
  project:current[0],
  executionTeam:await related('managed_agents','id',project.team),
  exceptions:(await load('select * from project_organization_exceptions where project_id=$1',[project.id])),
  bindings:binds,statuses:statusRows,
  evidence:selected.length?await related('mission_assignments','id',selected):[],
  plans:await related('project_organization_plans','node_id',scope.contextIds),
  dependencies:await load('select * from project_organization_dependencies where project_id=$1',[project.id]),
  scopeGrants:await related('project_organization_scope_grants','node_id',scope.contextIds),
  workerContracts:await load('select * from project_worker_contracts where project_id=$1',[project.id]),
  workPackages:await load('select * from project_work_packages where project_id=$1',[project.id]),
  workPackageAttempts:await load('select * from project_work_package_attempts where package_id in (select id from project_work_packages where project_id=$1)',[project.id]),
  work:await load('select * from project_organization_work where project_id=$1',[project.id]),
 },48000);
 const scoped=JSON.parse(context);
 assert.ok(context.length<=48000);
 assert.equal(scoped.project.objective,current[0].objective);
 assert.deepEqual(scoped.organization.map(n=>n.id).sort(),[...scope.directIds].sort());
 assert.equal(scoped.principal.id,root.id);
 assert.equal(scoped.reporting.directReportIds.length,2);
 await db.query('set role service_role');

 const decision=await sql(db,'select id value from project_organization_decisions where assignment_id=$1',[job.id]);
 const release='d'.repeat(40),end=new Date(Date.now()+3600000).toISOString();
 const renew=(c=db,id=randomUUID(),who=owner,prior=cutoff,until=end,sha=release)=>sql(c,'select project_org_renew_continue($1,$2,$3,$4,$5,$6,$7) value',[who,project.id,sha,decision,prior,until,id]);
 const history=async()=> {await db.query('reset role');const result=(await db.query(`select
  (select jsonb_agg(to_jsonb(m) order by id) from agent_missions m where project_id=$1) missions,
  (select jsonb_agg(to_jsonb(j) order by j.id) from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1) assignments,
  (select jsonb_agg(to_jsonb(q) order by id) from project_provider_requests q where project_id=$1) requests,
  (select to_jsonb(r) from project_director_recoveries r where project_id=$1) recovery,
  (select jsonb_agg(to_jsonb(d) order by id) from project_organization_decisions d where project_id=$1) decisions`,[project.id])).rows[0];await db.query('set role service_role');return result;};
 const original=await history();
 const offer=await sql(db,'select project_org_owner_window_offer($1,$2) value',[owner,project.id]);
 assert.equal(offer.decisionId,decision);assert.equal(new Date(offer.maxCutoff).toISOString(),root.deadline.toISOString());
 assert.equal(await sql(db,'select project_org_owner_window_offer($1,$2) value',[randomUUID(),project.id]),null);
 await db.query('reset role');await db.query('set role authenticated');
 await assert.rejects(sql(db,'select project_org_owner_window_offer($1,$2) value',[owner,project.id]),/permission denied/);
 await assert.rejects(renew(),/permission denied/);await db.query('reset role');await db.query('set role service_role');
 const originalAdmission=await sql(db,'select continued_at::text value from project_provider_execution where project_id=$1',[project.id]);
 await db.query("update work_projects set status='blocked' where id=$1",[project.id]);
 await assert.rejects(renew(db,randomUUID(),randomUUID()),/Authenticated project owner/);
 await assert.rejects(renew(db,randomUUID(),owner,cutoff,new Date(Date.now()-1000).toISOString()),/Exact prior cutoff/);
 await assert.rejects(renew(db,randomUUID(),owner,cutoff,new Date(root.deadline.getTime()+1000).toISOString()),/Project Director authority/);
 await assert.rejects(renew(db,randomUUID(),owner,end),/Exact prior cutoff/);
 await assert.rejects(db.query('insert into project_execution_windows(id) values($1)',[randomUUID()]),/permission denied/);
 await assert.rejects(db.query('insert into project_organization_contract_changes(node_id) values($1)',[game.id]),/permission denied/);
 await db.query('reset role');
 await assert.rejects(db.query("update project_organization_nodes set tools=array['manage','analysis','development'] where id=$1",[game.id]),/exact authenticated authorization/);
 // A write failure after the first renewed contract rolls back the complete window.
 const last=[game.id,qa.id].sort().at(-1);
 await db.query(`create function fixture_contract_failure() returns trigger language plpgsql as $$begin if new.id=TG_ARGV[0]::uuid then raise exception 'Fixture second-contract write failed';end if;return new;end$$`);
 await db.query(`create trigger fixture_contract_failure before update of deadline on project_organization_nodes for each row execute function fixture_contract_failure('${last}')`);
 await db.query('set role service_role');
 await assert.rejects(renew(),/second-contract write failed/);
 assert.equal(await sql(db,'select count(*)::int value from project_execution_windows where project_id=$1',[project.id]),0);
 assert.equal(await sql(db,'select deadline::text value from work_projects where id=$1',[project.id]),(await db.query('select $1::timestamptz::text text',[cutoff])).rows[0].text);
 await db.query('reset role');await db.query('drop trigger fixture_contract_failure on project_organization_nodes');await db.query('drop function fixture_contract_failure()');await db.query('set role service_role');
 // Generic organizations without a recovery record use the same epoch gates.
 await db.query('begin');await db.query('reset role');
 await db.query('delete from project_director_recoveries where project_id=$1',[project.id]);
 await db.query('set local role service_role');
 const generic=await renew(db,randomUUID(),owner,cutoff,end,'c'.repeat(40));
 assert.equal(await sql(db,'select project_provider_continued($1) value',[project.id]),true);
 assert.equal(await sql(db,'select project_provider_continued_assignment($1) value',[job.id]),false);
 const genericLease=randomUUID();await db.query("update work_projects set lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[project.id,genericLease]);
 const gs=await sql(db,'select project_org_schedule($1,$2) value',[project.id,genericLease]);
 assert.ok(gs.missionId);assert.equal(await sql(db,"select project_evidence->>'providerContinuationWindow' value from agent_missions where id=$1",[gs.missionId]),generic.authorizationId);
 const gj=await sql(db,'select id value from mission_assignments where mission_id=$1',[gs.missionId]);
 assert.equal(await sql(db,'select project_provider_continued_assignment($1) value',[gj]),true);
 const legacy=(await db.query("select j.* from mission_assignments j join agent_missions m on m.id=j.mission_id where m.project_id=$1 and m.id<>$2 and m.project_evidence ? 'providerContinuationDecision' limit 1",[project.id,gs.missionId])).rows[0];
 assert.ok(legacy);assert.equal(await sql(db,'select project_provider_continued_assignment($1) value',[legacy.id]),false,'Same-release historical mission must not inherit the new owner window');
 await db.query('reset role');
 await db.query("update agent_missions set status='running' where id=$1",[legacy.mission_id]);
 await db.query('update work_projects set active_mission_id=$2 where id=$1',[project.id,legacy.mission_id]);
 await db.query("update mission_assignments set status='queued',attempts=0,lease=null,lease_until=null,available_at=now(),created_at='1800-01-01' where id=$1",[legacy.id]);
 await db.query('set local role service_role');
 assert.notEqual((await sql(db,'select claim_mission_work_release($1) value',['c'.repeat(40)]))?.job.id,legacy.id,'No generic no-recovery claimant bypass');
 await db.query('reset role');const forgedLease=randomUUID();
 await db.query("update mission_assignments set status='running',lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[legacy.id,forgedLease]);
 await db.query('set local role service_role');
 assert.equal(await sql(db,'select project_provider_request($1,$2,$3,$4,$5,null,null) value',[legacy.id,forgedLease,randomUUID(),'model-list','b'.repeat(64)]),false,'Restored old task cannot dispatch across a renewed window');
 assert.equal(await sql(db,'select project_provider_request($1,$2,$3,$4,$5,null,null) value',[job.id,randomUUID(),randomUUID(),'model-list','f'.repeat(64)]),false);
 await assert.rejects(sql(db,'select project_org_decide($1,$2,$3) value',[legacy.id,forgedLease,JSON.stringify([{action:'ready'}])]),/Current owner execution window/);
 await db.query('rollback');await db.query('set role service_role');
 // A narrower parent contract prevents renewal of a descendant inheriting the window.
 await db.query('begin');await db.query('reset role');
 const childAgent=(await db.query("select save_managed_agent(null,'{\"name\":\"Inherited manager\",\"instructions\":\"Manage bounded verification\",\"research\":false,\"development\":false,\"attachments\":false,\"reviewMode\":\"always\",\"maxActiveTasks\":1,\"maxInputChars\":16000}',false) a")).rows[0].a;
 await db.query("insert into project_organization_nodes(project_id,parent_id,agent_id,kind,name,objective,acceptance,tools,token_limit,deadline,depth,area,management_contract,management_level) values($1,$2,$3,'manager','Inherited manager','Verify bounded component','[\"Evidence\"]',array['manage','analysis'],1,$4,2,'development','{}','manager')",[project.id,game.id,childAgent.id,cutoff]);
 await db.query("update project_organization_nodes set status='accepted' where id=$1",[game.id]);
 await db.query('set local role service_role');await assert.rejects(renew(),/ancestor deadline/);await db.query('rollback');await db.query('set role service_role');
 // Let the actual fixture window expire; never rewrite historical cutoffs.
 const waitUntil=Date.now()+20000;
 while(!(await sql(db,'select $1::timestamptz<=clock_timestamp() value',[cutoff]))){assert.ok(Date.now()<waitUntil);await new Promise(r=>setTimeout(r,25));}
 // Uncertain provider outcomes cannot be hidden by a fresh owner window.
 await db.query('begin');await db.query('reset role');
 await db.query("insert into project_provider_requests(id,project_id,mission_id,assignment_id,worker_id,execution_attempt,operation,request_hash) values($1,$2,$3,$4,$5,'uncertain-window-fixture','model-list',$6)",[randomUUID(),project.id,recovery.missionId,job.id,job.agent_id,'f'.repeat(64)]);
 await db.query('set local role service_role');await assert.rejects(renew(),/resolved provider requests/);await db.query('rollback');await db.query('set role service_role');
 const first=randomUUID(),second=randomUUID();
 const race=await Promise.allSettled([renew(db,first),renew(rival,second)]);
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal(race.filter(x=>x.status==='rejected').length,1);
 const receipt=race.find(x=>x.status==='fulfilled').value;
 assert.equal(new Date(receipt.priorCutoff).toISOString(),new Date(cutoff).toISOString());assert.equal(new Date(receipt.cutoff).toISOString(),end);
 await assert.rejects(renew(db,receipt.authorizationId),/already consumed/);
 await db.query('reset role');
 await assert.rejects(db.query("update project_execution_windows set cutoff=cutoff+interval '1 second' where id=$1",[receipt.authorizationId]),/append-only/);
 await assert.rejects(db.query('delete from project_organization_contract_changes where window_id=$1',[receipt.authorizationId]),/append-only/);
 await db.query('set role service_role');
 await assert.rejects(renew(db,receipt.authorizationId,owner,cutoff,new Date(Date.parse(end)+1000).toISOString()),/already consumed/);
 const renewed=await rows();
 for(const node of [game,qa]){const next=renewed.find(n=>n.id===node.id);assert.equal(next.agent_id,node.agent_id);assert.equal(next.deadline.toISOString(),end);assert.deepEqual(next.tools,node.tools);}
 assert.equal(renewed.find(n=>n.id===root.id).deadline.toISOString(),root.deadline.toISOString());
 assert.deepEqual((await history()).recovery,original.recovery);
 assert.equal(await sql(db,'select continued_at::text value from project_provider_execution where project_id=$1',[project.id]),originalAdmission,'Renewal preserves the original continuation receipt');
 // Forged/stale audit rows cannot relax the identity guard or change other fields.
 for(const unrelated of [false,true]){
  await db.query('begin');await db.query('reset role');
  await db.query("insert into project_organization_contract_changes(project_id,node_id,decision_id,prior_deadline,deadline,prior_tools,tools,transaction_id) values($1,$2,$3,$4,$4,$5,$6,txid_current()-$7)",[project.id,game.id,decision,end,game.tools,[...game.tools,'development'],unrelated?0:1]);
  const update=unrelated?"update project_organization_nodes set tools=$2,objective='Unrelated forged objective' where id=$1":"update project_organization_nodes set tools=$2 where id=$1";
  await assert.rejects(db.query(update,[game.id,[...game.tools,'development']]),unrelated?/identity and delegated authority are immutable/:/exact authenticated authorization/);
  await db.query('rollback');await db.query('set role service_role');
 }
 const session=async expected=>{
  const lease=randomUUID();await db.query("update work_projects set lease=$2,lease_until=now()+interval '5 minutes' where id=$1",[project.id,lease]);
  const s=await sql(db,'select project_org_schedule($1,$2) value',[project.id,lease]);assert.equal(s.nodeId,expected.id);
  await db.query("update mission_assignments set created_at='1900-01-01' where mission_id=$1",[s.missionId]);
  const claim=await sql(db,'select claim_mission_work_release($1) value',[release]);assert.equal(claim?.mission.id,s.missionId);assert.notEqual(claim.job.id,job.id);
  return claim.job;
 };
 const decide=(j,commands)=>sql(db,'select project_org_decide($1,$2,$3::jsonb) value',[j.id,j.lease,JSON.stringify(commands)]);
 const amendment=(node,patch={})=>({action:'amend_delegation',nodeId:node.id,expectedTools:node.tools,expectedDeadline:end,tools:[...node.tools,'development'],reason:'Delegate the implementation capability already held by the immediate superior',...patch});
 let turn=await session(game);
 await assert.rejects(decide(turn,[amendment(game)]),/active direct subordinate/);
 await assert.rejects(decide(turn,[amendment(qa)]),/active direct subordinate/);
 await decide(turn,[{action:'appoint',kind:'worker',name:'Bounded analyst',area:'development',objective:'Inspect one component',acceptance:['Objective evidence'],tokens:1,deadline:end,paths:[],tools:['analysis']},{action:'exception',reason:'authority',detail:'Implementation requires delegated development authority from my immediate superior'},{action:'ready'}]);
 turn=await session(qa);await decide(turn,[{action:'ready'}]);
 turn=await session(root);
 await assert.rejects(decide(turn,[amendment(game,{expectedTools:['manage']})]),/Delegation changed/);
 await assert.rejects(decide(turn,[amendment(game,{expectedDeadline:cutoff})]),/Delegation changed/);
 await assert.rejects(decide(turn,[amendment(game,{tools:['manage','analysis','invalid']})]),/known delegated capabilities/);
 await assert.rejects(decide(turn,[amendment(qa)]),/Independent QA/);
 await assert.rejects(decide(turn,[amendment(game,{tools:['manage']})]),/descendant authority/);
 // Accepted component authority cannot be silently rewritten.
 await db.query('begin');await db.query('reset role');await db.query("update project_organization_nodes set status='accepted' where id=$1",[game.id]);await db.query('set local role service_role');
 await assert.rejects(decide(turn,[amendment(game)]),/active direct subordinate/);await db.query('rollback');await db.query('set role service_role');
 // A blocked but queued assignment still prevents contract changes.
 await db.query('begin');await db.query('reset role');
 const oldGameJob=(await db.query('select j.id,j.mission_id from mission_assignments j join project_organization_assignments b on b.assignment_id=j.id where b.node_id=$1 and j.id<>$2 limit 1',[game.id,turn.id])).rows[0];
 await db.query("update agent_missions set status='blocked' where id=$1",[oldGameJob.mission_id]);
 await db.query('update work_projects set active_mission_id=$2 where id=$1',[project.id,oldGameJob.mission_id]);
 await db.query("update mission_assignments set status='queued' where id=$1",[oldGameJob.id]);
 await db.query('update work_projects set active_mission_id=$2 where id=$1',[project.id,turn.mission_id]);
 await db.query('set local role service_role');await assert.rejects(decide(turn,[amendment(game)]),/Outstanding work/);await db.query('rollback');await db.query('set role service_role');
 // Ask the same existing director to verify its missing authority; do not replace it.
 await decide(turn,[{action:'reject',nodeId:game.id,findings:'The component cannot yet commission implementation under its current delegated capabilities'}]);
 turn=await session(game);
 const worker=(await rows()).find(n=>n.name==='Bounded analyst');
 await assert.rejects(decide(turn,[amendment(worker,{tools:['analysis','development']})]),/exceeds parent/);
 await decide(turn,[{action:'exception',reason:'authority',detail:'Confirmed implementation capability exceeds this directorate delegation'},{action:'ready'}]);
 turn=await session(root);
 await db.query('reset role');await db.query("update project_organization_nodes set completion_submission='{\"fixture\":\"pending\"}' where id=$1",[game.id]);await db.query('set role service_role');
 const commands=[amendment(game),{action:'ready'}];
 const grants=await Promise.allSettled([decide(turn,commands),sql(rival,'select project_org_decide($1,$2,$3::jsonb) value',[turn.id,turn.lease,JSON.stringify(commands)])]);
 assert.equal(grants.filter(x=>x.status==='fulfilled').length,1);assert.equal(grants.filter(x=>x.status==='rejected').length,1);
 const final=await rows();assert.equal(final.find(n=>n.id===game.id).completion_submission,null,'Pending submission must be verified again after amendment');
 assert.deepEqual((await db.query('select prior_submission from project_organization_contract_changes where node_id=$1 and decision_id is not null order by changed_at desc limit 1',[game.id])).rows[0].prior_submission,{fixture:'pending'});assert.ok(final.find(n=>n.id===game.id).tools.includes('development'));assert.ok(!final.find(n=>n.id===qa.id).tools.includes('development'));
 turn=await session(game);
 await assert.rejects(db.query('select project_org_assert_execution($1)',[game.agent_id]),/Management agents/);
 await decide(turn,[{action:'ready'}]);
 const after=await history();
 for(const key of ['missions','assignments','decisions']){const ids=new Set(original[key].map(x=>x.id));assert.deepEqual(after[key].filter(x=>ids.has(x.id)),original[key]);}
 assert.deepEqual(after.requests,original.requests);assert.deepEqual(after.recovery,original.recovery);
 assert.equal((await rows()).filter(n=>n.parent_id===root.id).length,2);
 console.log('ORGANIZATIONAL_CONTRACT_AMENDMENTS_POSTGRES_PASS: atomic owner window, duplicate/conflict/expiry/ancestor rejection, immutable history, both director identities, parent-only capability delegation, QA isolation and fresh subordinate scheduling');
}

export async function assertFirstRenewalAdmission(db,{project,owner,cutoff,job}){
 const decision=(await db.query('select id from project_organization_decisions where assignment_id=$1',[job.id])).rows[0].id;
 assert.equal((await db.query('select continued_at from project_provider_execution where project_id=$1',[project.id])).rows[0].continued_at,null);
 await db.query('begin');
 const result=(await db.query('select project_org_renew_continue($1,$2,$3,$4,$5,$6,$7) receipt',[owner,project.id,'e'.repeat(40),decision,cutoff,new Date(Date.now()+3600000).toISOString(),randomUUID()])).rows[0].receipt;
 assert.equal(result.existing,false);assert.equal(result.renewedManagementIds.length,2);
 assert.ok((await db.query('select continued_at from project_provider_execution where project_id=$1',[project.id])).rows[0].continued_at);
 await db.query('rollback');
 assert.equal((await db.query('select continued_at from project_provider_execution where project_id=$1',[project.id])).rows[0].continued_at,null);
}
