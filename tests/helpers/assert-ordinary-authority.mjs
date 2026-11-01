import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {lifecycleProposalFromSnapshot} from '../../scripts/benchmark/lifecycle-owner-proposal.mjs';
// Disposable PostgreSQL only. These authenticated identities represent synthetic
// consent fixtures; they are never owner consent or production execution.
export async function assertOrdinaryAuthority(db,rival){
 await db.query('reset role');
 await db.query('alter table actors add column if not exists actor_kind text');
 await db.query(readFileSync('supabase/migrations/20261022093000_separate_project_resource_estimates.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261028193000_standalone_provider_attempt_ledger.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261101160000_ordinary_developer_authority.sql','utf8'));
 const actor=randomUUID(),chat=randomUUID(),owner=randomUUID(),project=randomUUID(),repo=randomUUID();
 await db.query("insert into actors(id,name,actor_kind) values($1,'Ordinary synthetic owner','standard')",[actor]);
 await db.query("insert into chats(id,actor_id,title) values($1,$2,'First shortage synthetic fixture')",[chat,actor]);
 await db.query("insert into repo_sync_runs(id,repository_full_name) values($1,'mfackrell/katie')",[repo]);
 await db.query('select standalone_bind_scope($1,$2,$3)',[owner,actor,chat]);
 await db.query('set role service_role');
 const p=(await db.query('select create_work_project($1,$2,$3,$4,$5,$6) p',[project,'ordinary-'+project,actor,chat,'Synthetic original display repair',repo])).rows[0].p;
 const contract={path:'/pilot',scenarios:[{name:'Recovered',steps:[{action:'expectText',selector:'#state',value:'Recovered'}]}]},scope='a'.repeat(64),baseline=process.env.KATIE_TEST_ORDINARY_HOST==='1'?'0015bcdb8ac9ad94b7c74d1a4cd76737903b1319':'b'.repeat(40),contractHash='c'.repeat(64);
 const spec={name:'Synthetic display',summary:'Repair displayed state',requirements:['Display Recovered'],allowedPaths:['app/pilot/'],milestones:[{title:'Display',instruction:'Implement approved display',contract}],finalContract:contract};
 // Declare a frozen fixture before approval; the actual scope approval RPC owns
 // the transition. No production scope or records are imported or changed.
 await db.query("update work_projects set status='awaiting_approval',phase='approval',spec=$2,baseline_sha=$3,approval_hash=$4,repository_full_name='mfackrell/katie' where id=$1",[project,spec,baseline,scope]);
 await db.query("select control_work_project($1,$2,$3,'approve',p_hash=>$4)",[project,actor,chat,scope]);
 let claim;for(let i=0;i<10;i++){claim=(await db.query('select claim_work_project() p')).rows[0].p;if(claim?.id===project)break;}
 assert.equal(claim?.id,project);
 assert.equal((await db.query("select finish_work_project($1,$2,'child',$3) ok",[project,claim.lease,{kind:'development',objective:'Synthetic approved display repair',evidence:{syntheticOnly:true}}])).rows[0].ok,true);
 const mission=(await db.query('select active_mission_id id from work_projects where id=$1',[project])).rows[0].id;
 const job=(await db.query("select * from mission_assignments where mission_id=$1 and role='development'",[mission])).rows[0];
 const agent=(await db.query('select * from managed_agents where id=$1',[job.agent_id])).rows[0],taskChat=randomUUID();
 await db.query("insert into chats(id,actor_id,title) values($1,$2,'Synthetic developer')",[taskChat,agent.actor_id]);
 await db.query("insert into agent_tasks(id,agent_id,actor_id,chat_id,snapshot,definition_version,kind,initial_input,input,repository_id,repository_full_name,request_id,status,external) values($1::uuid,$2,$3,$4,$5,$6,'development','Frozen display scope','Frozen display scope',$7,'mfackrell/katie',$1::text,'blocked','{}')",[job.id,agent.id,agent.actor_id,taskChat,agent.config,agent.version,repo]);
 const limits={cumulativeTokens:180000,developmentTokens:120000,developmentCalls:15,completionTokens:60000,completionCalls:4,assessmentTokens:60000,assessmentCalls:4,perCallMicrousd:500000,ceilingMicrousd:2000000,durationSeconds:3600};
 const prepared=(await db.query('select developer_prepare_initial($1,$2) p',[owner,job.id])).rows[0].p;
 assert.equal(prepared.proposal.version,'ordinary-native-authorization-v1');
 assert.equal(prepared.proposal.binding.taskId,job.id);
 assert.equal((await db.query('select developer_next_initial_task($1,$2) id',[owner,chat])).rows[0].id,job.id);
 assert.equal((await db.query('select developer_next_initial_task($1,$2) id',[randomUUID(),chat])).rows[0].id,null);
 const rejected=(await db.query('select developer_decide_initial($1,$2,$3,$4) d',[owner,job.id,prepared.id,'rejected'])).rows[0].d;
 assert.equal(rejected.decision,'rejected');
 assert.equal((await db.query('select count(*)::int n from benchmark_native_spending_approvals where task_id=$1',[job.id])).rows[0].n,0);
 assert.equal((await db.query('select status from agent_tasks where id=$1',[job.id])).rows[0].status,'blocked');
 const offer='select developer_offer_initial($1,$2,$3,$4) p';
 await assert.rejects(db.query(offer,[randomUUID(),job.id,limits,'gpt-5.3-codex']),/binding denied/);
 const proposal=(await db.query(offer,[owner,job.id,limits,'gpt-5.3-codex'])).rows[0].p;
 assert.equal(proposal.proposal.current.nativeAuthorityEstablished,false);
 const before=(await db.query('select count(*)::int n from benchmark_full_continuations')).rows[0].n;
 const decide='select developer_decide_initial($1,$2,$3,$4) d',args=[owner,job.id,proposal.id,'approved'];
 await assert.rejects(db.query(decide,[randomUUID(),...args.slice(1)]),/owner proposal/);
 const decisions=await Promise.all([db.query(decide,args),rival.query(decide,args)]);
 assert.equal(decisions[0].rows[0].d.developer_approval_id,decisions[1].rows[0].d.developer_approval_id);
 const approved=(await db.query('select * from benchmark_native_spending_approvals where id=$1',[decisions[0].rows[0].d.developer_approval_id])).rows[0];
 assert.equal(approved.trial_id,null);assert.equal(approved.continuation_id,null);assert.equal(approved.previous_developer_approval_id,null);
 assert.deepEqual(approved.developer_authority.limits,limits);assert.equal(approved.max_tokens,'180000');
 assert.equal((await db.query('select count(*)::int n from benchmark_full_continuations')).rows[0].n,before);
 assert.equal((await db.query('select count(*)::int n from benchmark_execution_grants where account_id=$1',[approved.account_id])).rows[0].n,0);
 await assert.rejects(db.query('update benchmark_native_spending_approvals set max_tokens=max_tokens+1 where id=$1',[approved.id]),/immutable/);
 await assert.rejects(db.query("update benchmark_mission_bindings set baseline_sha=$2 where mission_id=$1",[mission,'f'.repeat(40)]),/immutable/);
 const release='e'.repeat(40),digest=randomBytes(32).toString('hex');
 const claims=await Promise.all([db,rival].map(c=>c.query('select developer_claim_dispatch($1,$2) ok',[approved.id,release])));
 assert.equal(claims.filter(r=>r.rows[0].ok).length,1);
 const grantArgs=[approved.id,job.id,digest,release];
 const grants=await Promise.allSettled([db.query('select developer_issue_execution_grant($1,$2,$3,$4) g',grantArgs),rival.query('select developer_issue_execution_grant($1,$2,$3,$4) g',[approved.id,job.id,randomBytes(32).toString('hex'),release])]);
 assert.equal(grants.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(grants));
 const grant=grants.find(r=>r.status==='fulfilled').value.rows[0].g;
 const token=(await db.query('select token_digest from benchmark_execution_grants where id=$1',[grant.grantId])).rows[0].token_digest;
 const reserve='select developer_native_reserve($1,$2,$3,$4,$5,$6) id';
 for(let i=0;i<11;i++){
  const call=(await db.query(reserve,[token,project,grant.executionEpoch,randomUUID(),'gpt-5.3-codex',100])).rows[0].id;
  const linked=(await db.query('select legacy_mission_call_id id from benchmark_budget_calls where id=$1',[call])).rows[0].id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-ordinary-'+call,{input_tokens:3,output_tokens:2,total_tokens:5}]);
 }
 await assert.rejects(db.query(reserve,[token,project,grant.executionEpoch,randomUUID(),'gpt-5.3-codex',100]),/protected completion/);
 const snapshot=(await db.query('select benchmark_lifecycle_snapshot($1) s',[job.id])).rows[0].s;
 assert.equal(snapshot.authorityKind,'ordinary-developer');assert.equal(snapshot.position.developmentConsumedCalls,11);assert.equal(snapshot.position.completionCalls,4);
 assert.equal(snapshot.snapshot.calls.length,11);assert.equal(snapshot.snapshot.exposures.length,11);
 // SQL boundary fixture supplies a synthetic completed workflow/checkpoint.
 // Actual host and route qualification must independently prove that evidence.
 await db.query("update agent_tasks set status='blocked',external=external||jsonb_build_object('receipt',jsonb_build_object('outcome','BLOCKED','run_id',131)) where id=$1",[job.id]);
 const hostFixture=process.env.KATIE_TEST_ORDINARY_HOST==='1'?await (await import('./qualify-lifecycle-continuation.mjs')).createLifecycleCheckpoint(db,{authorityKind:'ordinary-developer',task:job.id,project,mission,account:approved.account_id,grant:(await db.query('select * from benchmark_execution_grants where id=$1',[grant.grantId])).rows[0]}):null;
 const current=(await db.query('select benchmark_lifecycle_snapshot($1) s',[job.id])).rows[0].s;
 const record=hostFixture?.record??{taskId:job.id,projectId:project,originalBaselineSha:baseline,approvedScopeHash:scope,approvedScope:{contractHash:current.binding.contractHash},checkpointSha:'d'.repeat(40),phase:'repair'};
 const plan=lifecycleProposalFromSnapshot({snapshot:current,record,observations:hostFixture?.observations??[]});assert.equal(plan.state,'awaiting_owner_approval',JSON.stringify(plan));
 const checkpoint=hostFixture?.checkpoint??{...record,scopeHash:scope,runId:'131',approvalId:approved.id,grantId:grant.grantId,releaseSha:release};
 const amendmentOffer=(await db.query('select benchmark_lifecycle_offer($1,$2,$3) o',[job.id,plan.proposal,checkpoint])).rows[0].o;
 const amendmentArgs=[owner,job.id,amendmentOffer.id,'approved',release];
 const amended=await Promise.all([db,rival].map(c=>c.query('select benchmark_lifecycle_decide($1,$2,$3,$4,$5) d',amendmentArgs)));
 assert.equal(amended[0].rows[0].d.approvalId,amended[1].rows[0].d.approvalId);
 const child=(await db.query('select * from benchmark_native_spending_approvals where id=$1',[amended[0].rows[0].d.approvalId])).rows[0];
 assert.equal(child.previous_developer_approval_id,approved.id);assert.equal(child.account_id,approved.account_id);assert.equal(child.trial_id,null);assert.equal(child.continuation_id,null);
 assert.equal(child.developer_authority.limits.developmentCalls,hostFixture?19:17);
 assert.equal((await db.query('select count(*)::int n from benchmark_full_continuations')).rows[0].n,before);
 assert.deepEqual((await db.query('select benchmark_lifecycle_snapshot($1) s',[job.id])).rows[0].s.snapshot.calls,current.snapshot.calls);
 assert.equal((await db.query('select benchmark_effective_account_cap($1) cap',[approved.account_id])).rows[0].cap,child.max_tokens);
 if(hostFixture){
  assert.equal((await db.query('select developer_claim_dispatch($1,$2) ok',[child.id,release])).rows[0].ok,true);
  await (await import('./qualify-lifecycle-continuation.mjs')).qualifyLifecycleContinuation(db,{authorityKind:'ordinary-developer',task:job.id,project,mission,account:approved.account_id},hostFixture,{approval_id:child.id,release_sha:release});
  return;
 }
 // The committed amendment must be usable by the same admission boundary.
 assert.equal((await db.query('select developer_gateway_execution_live($1,$2,$3) ok',[token,project,grant.executionEpoch])).rows[0].ok,false,'superseded grant stopped');
 assert.equal((await db.query('select developer_claim_dispatch($1,$2) ok',[child.id,release])).rows[0].ok,true);
 const nextToken=randomBytes(32).toString('hex');
 const nextGrant=(await db.query('select developer_issue_execution_grant($1,$2,$3,$4) g',[child.id,job.id,nextToken,release])).rows[0].g;
 // Full contract mutations invalidate live admission even if the scope hash is unchanged.
 const savedBinding=(await db.query('select binding b from project_runs where mission_id=$1',[mission])).rows[0].b;
 await db.query("update project_runs set binding=jsonb_set(binding,'{contract,tampered}','true'::jsonb) where mission_id=$1",[mission]);
 assert.equal((await db.query('select binding b from project_runs where mission_id=$1',[mission])).rows[0].b.contract.tampered,true);
 await assert.rejects(db.query(reserve,[nextToken,project,nextGrant.executionEpoch,randomUUID(),'gpt-5.3-codex',100]),/authority|live|grant|admission|binding/i);
 await db.query('update project_runs set binding=$2 where mission_id=$1',[mission,savedBinding]);
 const attempts=await Promise.allSettled([db,rival,db].map(c=>c.query(reserve,[nextToken,project,nextGrant.executionEpoch,randomUUID(),'gpt-5.3-codex',100])));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,2,'three concurrent reservations admit exactly two remaining native slots');
 assert.equal(attempts.filter(r=>r.status==='rejected').length,1);
 for(const result of attempts.filter(r=>r.status==='fulfilled')){
  const call=result.value.rows[0].id;
  const linked=(await db.query('select legacy_mission_call_id id from benchmark_budget_calls where id=$1',[call])).rows[0].id;
  await db.query('select benchmark_reconcile_provider_usage($1,$2,$3,true)',[linked,'synthetic-ordinary-'+call,{input_tokens:3,output_tokens:2,total_tokens:5}]);
 }
 const after=(await db.query('select benchmark_lifecycle_snapshot($1) s',[job.id])).rows[0].s;
 assert.equal(after.position.developmentConsumedCalls,13);assert.equal(after.position.completionCalls,4);
 assert.deepEqual(after.snapshot.calls.filter(c=>current.snapshot.calls.some(old=>old.id===c.id)),current.snapshot.calls);
 await db.query('reset role');await db.query('set role authenticated');
 await assert.rejects(db.query(decide,args),/permission denied/);
 await db.query('reset role');await db.query('set role service_role');
 console.log('ORDINARY_INITIAL_AUTHORITY_POSTGRES_PASS: isolated synthetic consent, no benchmark provenance, atomic first amendment, exact two-slot reservation, preserved eleven historical calls and four completion reserves');
}
