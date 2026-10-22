import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function handoffKnowledgeFlow(db,make){
 const source=await make(),target=await make(),last=await make(),chat=randomUUID(),history=randomUUID(),id=randomUUID();
 const entry={key:'verified-outcome',value:'Reduced close duration by four days',source:'user',category:'experience',evidenceMessageIds:['knowledge-fact'],evidenceQuotes:['Reduced close duration by four days']};
 await db.query("insert into chats(id,actor_id,title) values($1,$3,'Active'),($2,$3,'Past')",[chat,history,source.actor_id]);
 await db.query('insert into actor_long_term_memory(actor_id,content) values($1,$2)',[source.actor_id,{entries:[entry]}]);
 await db.query("insert into messages(id,actor_id,chat_id,role,content) values('knowledge-fact',$1,$2,'user','Reduced close duration by four days'),('knowledge-parent',$1,$3,'user','New task'),('knowledge-work',$1,$3,'assistant','Prior deliverable'),('knowledge-request',$1,$3,'user','Keep it under 100 words'),('knowledge-latest',$1,$3,'assistant','What else?')",[source.actor_id,history,chat]);
 const state={version:1,projectContext:{userMessageId:'knowledge-parent',text:'Active task'},objective:{userMessageId:'knowledge-objective',text:'Review examples'},pending:[],answered:[],projects:[],lastAssistantMessageId:'knowledge-latest',workProduct:{projectId:'knowledge-parent',assistantMessageId:'knowledge-work',text:'Prior deliverable',request:{userMessageId:'knowledge-request',text:'Keep it under 100 words'}}};
 await db.query('insert into chat_task_progress(actor_id,chat_id,state) values($1,$2,$3)',[source.actor_id,chat,state]);
 const m=(await db.query("select id,role,content,created_at::text as \"createdAt\",chat_id as \"chatId\" from messages where id='knowledge-fact'")).rows[0];
 const knowledge=[{entry,sourceMessages:[m]}];
 const create=(taskId,items=knowledge,actor=source.actor_id,sourceChat=chat,agent=target.id)=>db.query('select create_agent_task_handoff_with_knowledge($1,$2,$3,$4,$5,$6,$7) result',[taskId,agent,'Review examples',actor,sourceChat,'knowledge-parent',JSON.stringify(items)]);
 const invalid=randomUUID();await assert.rejects(create(invalid,[{entry:{...entry,value:'Invented'},sourceMessages:[m]}]),/not owned or inherited/);
 assert.equal((await db.query('select count(*)::int n from agent_tasks where id=$1',[invalid])).rows[0].n,0,'failed capsule rolls task creation back');
 await assert.rejects(create(randomUUID(),[{entry,sourceMessages:[{...m,content:'Invented'}]}]),/exact owned/);
 await assert.rejects(create(randomUUID(),[{entry,sourceMessages:[{...m,role:'assistant'}]}]),/exact owned/);
 await db.query('set role service_role');
 const handed=(await create(id)).rows[0].result;
 await db.query('reset role');
 const receipt=(await db.query('select * from agent_task_context_handoffs where task_id=$1',[id])).rows[0];
 assert.deepEqual(receipt.knowledge,knowledge);assert.equal(receipt.state.projects[0].workProduct.assistantMessageId,'knowledge-work');
 for(const expected of ['knowledge-work','knowledge-request','knowledge-latest'])assert.ok(receipt.source_messages.some(m=>m.id===expected));
 assert.ok(!receipt.source_messages.some(m=>m.id==='knowledge-fact'),'professional evidence remains separate from active task sources');
 await db.query("update messages set content='Changed later' where id='knowledge-fact'");
 await db.query("update actor_long_term_memory set content='{}' where actor_id=$1",[source.actor_id]);
 await create(id,[]);assert.deepEqual((await db.query('select knowledge from agent_task_context_handoffs where task_id=$1',[id])).rows[0].knowledge,knowledge,'retry never rewrites capsule');
 const second=randomUUID();await create(second,knowledge,handed.actor_id,handed.chat_id,last.id);
 assert.deepEqual((await db.query('select knowledge from agent_task_context_handoffs where task_id=$1',[second])).rows[0].knowledge,knowledge,'inherited capsule does not reread foreign history');
 await assert.rejects(create(randomUUID(),[{entry,sourceMessages:[{...m,content:'Forged inherited'}]}],handed.actor_id,handed.chat_id,last.id),/not owned or inherited/);
 await assert.rejects(create(id,[],last.actor_id,chat),/identity conflict/);
 for(const role of ['anon','authenticated']){await db.query(`set role ${role}`);await assert.rejects(create(randomUUID()),/permission denied/);await db.query('reset role');}
}
