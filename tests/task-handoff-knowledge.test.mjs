import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID, webcrypto } from 'node:crypto';
const native=createRequire(import.meta.url);
function modules(overrides={}){
 const cache=new Map();
 const load=name=>{
  if(name in overrides)return overrides[name];
  if(!name.startsWith('@/')&&!name.startsWith('/')&&!name.startsWith('.'))return native(name);
  let path=name.startsWith('@/')?resolve(name.slice(2)):resolve(name);
  if(path.endsWith('.mjs'))return native(path);
  if(!path.endsWith('.ts'))path=existsSync(path+'.ts')?path+'.ts':resolve(path,'index.ts');
  if(cache.has(path))return cache.get(path);
  const exports={};cache.set(path,exports);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code,{exports,require:n=>n.startsWith('.')?load(resolve(dirname(path),n)):load(n),process,Buffer,Date,console,Set,Map,URL,URLSearchParams,TextEncoder,TextDecoder,Request,Response,Headers,ReadableStream,AbortController,AbortSignal,File,Blob,fetch,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval},{filename:path});
  return exports;
 };
 return load;
}
const source={id:'original-E',chatId:'chat-E',role:'user',content:'Fictional candidate only, not Mark: Atlas consolidated six subsidiaries and reduced reporting preparation from eight days to three.',createdAt:'2026-10-21T18:53:07.252+00:00'};
const entry={key:'fixture.atlas',category:'fact',source:'user-stated',confidence:'high',value:'The fictional candidate consolidated six Atlas subsidiaries and reduced reporting preparation from eight days to three.',evidenceMessageIds:[source.id],evidenceQuotes:[{messageId:source.id,quote:source.content}]};
const capsule={entry,sourceMessages:[source]};
function knowledgeFixture({inherited=false,missingSource=false,selectionFails=false,verificationFails=false,existing=false,invalidInherited=false}={}) {
 const queries=[],verified=[],contexts=[];
 const binding={sourceActorId:'source-actor',sourceChatId:'chat-F',projectId:'project-F'};
 const db={from(table){const filters=[];const q={select:()=>q,lt:()=>q,order:()=>q,limit:()=>q,eq:(k,v)=>{filters.push([k,v]);return q;},in:(k,v)=>{filters.push([k,v]);return q;},maybeSingle:async()=>{
  queries.push({table,filters});
  if(filters.some(([key])=>key==='task_id'))return{data:existing?{knowledge:[capsule],source_actor_id:binding.sourceActorId,source_chat_id:binding.sourceChatId,project_id:binding.projectId}:null,error:null};
  return{data:inherited?{knowledge:invalidInherited?[{entry,sourceMessages:[{...source,role:'assistant'}]}]:[capsule]}:null,error:null};
 },then(resolve){queries.push({table,filters});resolve({data:missingSource?[]:[{id:source.id,chat_id:source.chatId,role:source.role,content:source.content,created_at:source.createdAt}],error:null});}};return q;}};
 const load=modules({
  '@/lib/data/supabase/admin':{getSupabaseAdminClient:()=>db},
  '@/lib/data/persistence-store':{getChatById:async()=>({actorId:binding.sourceActorId}),getLongTermMemory:async()=>({entries:inherited?[]:[entry]}),parseMessageContent:content=>({text:content})},
  '@/lib/chat/task-progress-store':{loadTaskProgress:async()=>({projectContext:{userMessageId:binding.projectId,text:'Application F: consolidation and faster reporting'},objective:{text:'One strongest example'},workProduct:{text:'Atlas example draft, retrieval hint only'}})},
  '@/lib/memory/long-term-editor':{selectTaskMemoryKeys:async(context,available)=>{contexts.push(context);if(selectionFails)throw new Error('selection unavailable');assert.equal(available.length,1);return[entry.key];},verifyTaskMemorySupport:async(entries,messages)=>{verified.push({entries,messages});if(verificationFails||messages.length!==1)throw new Error('source verification failed');}},
 });
 return{api:load('@/lib/agents/task-handoff-knowledge'),queries,verified,contexts,binding};
}

test('F handoff selects Atlas knowledge from E and freezes its owned original USER evidence separately',async()=>{
 const f=knowledgeFixture();
 const result=await f.api.prepareTaskHandoffKnowledge(f.binding,'Continue application F','new-task');
 assert.deepEqual(JSON.parse(JSON.stringify(result)),[capsule]);
 assert.match(f.contexts[0],/Application F/);
 assert.equal(f.verified[0].messages[0].id,'original-E');
 assert.match(f.verified[0].messages[0].content,/Fictional candidate only, not Mark/);
 const sourceQuery=f.queries.find(query=>query.table==='messages');
 assert.ok(sourceQuery.filters.some(([key,value])=>key==='actor_id'&&value==='source-actor'));
 assert.ok(sourceQuery.filters.some(([key,value])=>key==='role'&&value==='user'));
});

test('repeated specialist handoff reuses only inherited capsule without reading foreign live messages',async()=>{
 const f=knowledgeFixture({inherited:true});
 assert.deepEqual(JSON.parse(JSON.stringify(await f.api.prepareTaskHandoffKnowledge(f.binding,'Continue F'))),[capsule]);
 assert.equal(f.queries.some(query=>query.table==='messages'),false);
 assert.equal(f.verified[0].messages[0].id,'original-E');
 const receipt=f.queries.find(query=>query.table==='agent_task_context_handoffs');
 assert.ok(receipt.filters.some(([key,value])=>key==='project_id'&&value==='project-F'));
});

for(const option of ['missingSource','selectionFails','verificationFails','invalidInherited'])test(`knowledge handoff fails visibly for ${option}`,async()=>{
 const f=knowledgeFixture({[option]:true,...(option==='invalidInherited'?{inherited:true}:{})});
 await assert.rejects(f.api.prepareTaskHandoffKnowledge(f.binding,'Continue F'));
});

test('idempotent retry returns immutable knowledge without reselecting from changed live state',async()=>{
 const f=knowledgeFixture({existing:true,selectionFails:true});
 assert.deepEqual(JSON.parse(JSON.stringify(await f.api.prepareTaskHandoffKnowledge(f.binding,'Continue F','existing-task'))),[capsule]);
 assert.equal(f.contexts.length,0);
 assert.equal(f.verified.length,0);
});

test('managed turns render source qualifications as reference knowledge, never parent history',async()=>{
 const f=knowledgeFixture({existing:true});
 const result=await f.api.loadTaskHandoffKnowledgeContext({id:'task',actor_id:'target',chat_id:'target-chat'});
 assert.match(result,/REFERENCE EVIDENCE ONLY/);
 assert.match(result,/never replace the active task contract/);
 assert.match(result,/Fictional candidate only, not Mark/);
 assert.equal(f.queries.some(query=>query.table==='messages'),false);
 assert.match(readFileSync('lib/memory/assemble-context.ts','utf8'),/loadTaskHandoffKnowledgeContext\(managedTask\)/);
});
