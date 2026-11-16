import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source=readFileSync('lib/data/persistence-store.ts','utf8');
const start=source.indexOf('export async function getMessages(');
const end=source.indexOf('export async function getRecentMessages(',start);
assert.ok(start>0&&end>start);
const implementation=source.slice(start,end);
const js=ts.transpileModule(implementation.replace('export async function','async function'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},
}).outputText;

function runFixture(count,failedOffset=-1){
 const records=Array.from({length:count},(_,i)=>({
  id:`message-${String(i+1).padStart(5,'0')}`,actor_id:'actor',chat_id:'chat',
  role:i%2===0?'user':'assistant',content:`turn ${i+1}`,
  created_at:new Date(1793500000000+i*1000).toISOString(),
 }));
 const calls=[];
 const client={
  from(table){
   assert.equal(table,'messages');
   const query={};
   const builder={
    select(columns){assert.match(columns,/created_at/);return builder;},
    eq(k,v){assert.equal(k,'chat_id');assert.equal(v,'chat');return builder;},
    order(key,opts){(query.orders??=[]).push([key,opts.ascending]);return builder;},
    range(start,end){query.start=start;query.end=end;calls.push({...query});return builder;},
    async returns(){
     if(query.start===failedOffset)return {data:null,error:{message:'fixture page outage'}};
     return {data:records.slice(query.start,query.end+1),error:null};
    },
   };
   return builder;
  },
 };
 const context=vm.createContext({
  getSupabaseAdminClient:()=>client,
  parseMessageContent:content=>({text:content}),
  toMessage:row=>({id:row.id,chatId:row.chat_id,role:row.role,content:row.content,createdAt:row.created_at}),
 });
 vm.runInContext(js+'\n globalThis.getMessagesForTest=getMessages;',context);
 return {call:()=>context.getMessagesForTest('chat'),calls,records};
}

test('history beyond 1000 messages includes the exact newest exchange without duplication',async()=>{
 const f=runFixture(1002);
 const result=await f.call();
 assert.equal(result.length,1002);
 assert.equal(result.at(-2).content,'turn 1001');
 assert.equal(result.at(-1).content,'turn 1002');
 assert.equal(new Set(result.map(m=>m.id)).size,1002);
 assert.deepEqual(f.calls.map(c=>[c.start,c.end]),[[0,499],[500,999],[1000,1499]]);
 for(const c of f.calls)assert.deepEqual(c.orders,[['created_at',true],['id',true]]);
});

test('exact page boundary, short conversation and zero messages are complete',async()=>{
 for(const count of [0,1,499,500,501,999,1000,1001,1500]){
  const f=runFixture(count);
  const result=await f.call();
  assert.equal(result.length,count);
  if(count)assert.equal(result.at(-1).content,`turn ${count}`);
  assert.equal(f.calls.length,Math.floor(count/500)+1);
 }
});

test('later page failure throws instead of silently replacing the UI with partial history',async()=>{
 const f=runFixture(1002,1000);
 await assert.rejects(f.call(),/Failed to load messages for chat chat: fixture page outage/);
 assert.equal(f.calls.length,3);
});
