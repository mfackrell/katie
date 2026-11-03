import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Isolated PostgreSQL, after ordinary auth and Task4A owner guards.
// Exercises the actual original-project identity through real ordinary RPCs.
export async function verifyTask4aOrdinaryOwnerFence(db){
 await db.query('reset role');
 await db.query('begin');
 try{
 const actor=randomUUID(),chat=randomUUID(),owner=randomUUID(),repo=randomUUID(),
  pid='6d1c29f1-b31e-47a5-aabb-cbcf1326f388';
 const scope='a'.repeat(64),baseline='b'.repeat(40);
 await db.query("insert into actors(id,name,actor_kind) values($1,'Task4A original authorization test','standard')",[actor]);
 await db.query("insert into chats(id,actor_id,title) values($1,$2,'Task4A synthetic authority guard')",[chat,actor]);
 await db.query("insert into repo_sync_runs(id,repository_full_name) values($1,'mfackrell/katie')",[repo]);
 await db.query("select standalone_bind_scope($1,$2,$3)",[owner,actor,chat]);
 await db.query('set role service_role');
 await db.query('select create_work_project($1,$2,$3,$4,$5,$6)',[pid,'test-task4a-'+pid,actor,chat,'Original Task4A synthetic guard only',repo]);
 const contract={path:'/project-pilots/task4a-preview-probe/',scenarios:[{name:'initial state',steps:[{action:'expectText',selector:'#state',value:'Initial state'}]}]};
 const spec={name:'Task4A synthetic only',summary:'Original one-button project',requirements:['One button'],
  allowedPaths:['app/project-pilots/task4a-preview-probe/'],milestones:[{title:'Build',instruction:'Approved test only',contract}],finalContract:contract};
 await db.query("update work_projects set status='awaiting_approval',phase='approval',spec=$2,baseline_sha=$3,approval_hash=$4,repository_full_name='mfackrell/katie' where id=$1",[pid,spec,baseline,scope]);
 await db.query("select control_work_project($1,$2,$3,'approve',p_hash=>$4)",[pid,actor,chat,scope]);
 let claim;
 for(let i=0;i<10;i++){claim=(await db.query('select claim_work_project() p')).rows[0].p;if(claim?.id===pid)break;}
 assert.equal(claim?.id,pid,'Original synthetic project is claimable');
 assert.equal((await db.query("select finish_work_project($1,$2,'child',$3) ok",[pid,claim.lease,{kind:'development',objective:'Original Task4A synthetic approval guard',evidence:{syntheticOnly:true}}])).rows[0].ok,true);
 const mid=(await db.query('select active_mission_id id from work_projects where id=$1',[pid])).rows[0].id;
 const job=(await db.query("select * from mission_assignments where mission_id=$1 and role='development'",[mid])).rows[0];
 const managed=(await db.query('select * from managed_agents where id=$1',[job.agent_id])).rows[0];
 const taskChat=randomUUID();
 await db.query("insert into chats(id,actor_id,title) values($1,$2,'Synthetic developer')",[taskChat,managed.actor_id]);
 await db.query("insert into agent_tasks(id,agent_id,actor_id,chat_id,snapshot,definition_version,kind,initial_input,input,repository_id,repository_full_name,request_id,status,external) values($1::uuid,$2,$3,$4,$5,$6,'development','Frozen source','Frozen source',$7,'mfackrell/katie',$1::text,'blocked','{}')",[
  job.id,managed.id,managed.actor_id,taskChat,managed.config,managed.version,repo
 ]);
 const reject=async(thunk,pattern)=>{
  await db.query('savepoint deny');
  try{await assert.rejects(thunk(),pattern);}
  finally{await db.query('rollback to savepoint deny');await db.query('release savepoint deny');}
 };
 await reject(()=>db.query('select developer_initial_snapshot($1,$2)',[owner,job.id]),/TASK4A_ORDINARY_OWNER_ADMISSION_DENIED/);
 const limits={cumulativeTokens:180000,developmentTokens:120000,developmentCalls:12,completionTokens:60000,completionCalls:4,assessmentTokens:60000,assessmentCalls:4,perCallMicrousd:1680000,ceilingMicrousd:2520000,durationSeconds:86400};
 await reject(()=>db.query('select developer_offer_initial($1,$2,$3,$4)',[owner,job.id,limits,'gpt-5.3-codex']),/TASK4A_ORDINARY_OWNER_ADMISSION_DENIED/);
 const account=randomUUID();
 await db.query("insert into benchmark_budget_accounts(id,experiment_id,arm,owner_actor_id,cap_tokens,developer_project_id,developer_task_id) values($1,null,'developer',$2,180000,$3,$4)",[account,actor,pid,job.id]);
 const binding=(await db.query('select binding from project_runs where mission_id=$1',[mid])).rows[0].binding;
 await reject(()=>db.query("insert into benchmark_native_spending_approvals(owner_id,actor_id,chat_id,trial_id,account_id,repository,model,protocol_digest,max_tokens,deadline,project_id,mission_assignment_id,task_id,developer_authority) values($1,$2,$3,null,$4,'mfackrell/katie','gpt-5.3-codex',$5,180000,now()+interval '1 hour',$6,$7,$7,$8)",[
  owner,actor,chat,account,scope,pid,job.id,{version:'ordinary-developer-v1',scopeHash:scope,binding,limits}
 ]),/TASK4A_CONTINUATION_BOUND_APPROVAL_REQUIRED/);
 assert.equal((await db.query('select count(*)::int n from benchmark_native_spending_approvals where project_id=$1',[pid])).rows[0].n,0);
 console.log('TASK4A_ORDINARY_OWNER_FENCE_POSTGRES_PASS: original project cannot propose, approve, or insert unbound ordinary grant');
 }finally{
  await db.query('rollback');
  await db.query('reset role');
 }
}
