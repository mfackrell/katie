import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
// Disposable PostgreSQL only. These authenticated identities represent synthetic
// consent fixtures; they are never owner consent or production execution.
export async function assertOrdinaryAuthority(db,rival){
 await db.query('reset role');
 await db.query('alter table actors add column if not exists actor_kind text');
 await db.query(readFileSync('supabase/migrations/20261028193000_standalone_provider_attempt_ledger.sql','utf8'));
 await db.query(readFileSync('supabase/migrations/20261101160000_ordinary_developer_authority.sql','utf8'));
 const actor=randomUUID(),chat=randomUUID(),owner=randomUUID(),project=randomUUID(),repo=randomUUID();
 await db.query("insert into actors(id,name,actor_kind) values($1,'Ordinary synthetic owner','standard')",[actor]);
 await db.query("insert into chats(id,actor_id,title) values($1,$2,'First shortage synthetic fixture')",[chat,actor]);
 await db.query("insert into repo_sync_runs(id,repository_full_name) values($1,'mfackrell/katie')",[repo]);
 await db.query('select standalone_bind_scope($1,$2,$3)',[owner,actor,chat]);
 await db.query('set role service_role');
 const p=(await db.query('select create_work_project($1,$2,$3,$4,$5,$6) p',[project,'ordinary-'+project,actor,chat,'Synthetic original display repair',repo])).rows[0].p;
 const contract={path:'/pilot',scenarios:[{name:'Recovered',steps:[{action:'expectText',selector:'#state',value:'Recovered'}]}]},scope='a'.repeat(64),baseline='b'.repeat(40),contractHash='c'.repeat(64);
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
 await db.query('reset role');await db.query('set role authenticated');
 await assert.rejects(db.query(decide,args),/permission denied/);
 await db.query('reset role');await db.query('set role service_role');
 console.log('ORDINARY_INITIAL_AUTHORITY_POSTGRES_PASS: isolated synthetic consent, no benchmark provenance, atomic single initial approval, no execution grant');
}
