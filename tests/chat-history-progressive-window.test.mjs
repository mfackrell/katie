import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const store = readFileSync('lib/data/persistence-store.ts','utf8');
const api = readFileSync('app/api/messages/route.ts','utf8');
const panel = readFileSync('components/chat-panel.tsx','utf8');
const begin = store.indexOf('export async function getMessageHistoryPage(');
const end = store.indexOf('\n\n/**\n * Restore messages', begin);
assert.ok(begin >= 0 && end > begin, 'bounded history implementation is present');
const body = ts.transpileModule(store.slice(begin,end).replace('export async function','async function'), {
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}
}).outputText;

const rows = Array.from({length:1537},(_,i)=>({
  id: String(i).padStart(8,'0')+'-0000-4000-8000-000000000000',
  chat_id:'chat',actor_id:'actor',role:i%2?'assistant':'user',
  created_at:new Date(1793500000000 + Math.floor(i/2)*1000).toISOString(),
  content:'message-'+i,
}));
function fixture(){
  const calls=[];
  const client={from(table){
    assert.equal(table,'messages');
    const q={};
    const builder={
      select(){return builder;},
      eq(){return builder;},
      or(v){q.cursor=v;return builder;},
      order(k,o){(q.orders??=[]).push([k,o.ascending]);return builder;},
      limit(n){q.limit=n;return builder;},
      async returns(){
        calls.push({...q});
        let sorted=[...rows].sort((a,b)=> b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
        if(q.cursor){
          const m=q.cursor.match(/^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]*)\)$/);
          assert.ok(m,'stable cursor query');
          sorted=sorted.filter(x=>x.created_at<m[1]||(x.created_at===m[2]&&x.id<m[3]));
        }
        return {data:sorted.slice(0,q.limit),error:null};
      }
    };
    return builder;
  }};
  const ctx=vm.createContext({
    getSupabaseAdminClient:()=>client,
    parseMessageContent:content=>({text:content}),
    toMessage:r=>({id:r.id,createdAt:r.created_at,content:r.content}),
  });
  vm.runInContext(body+'\nglobalThis.load=getMessageHistoryPage;',ctx);
  return {load:ctx.load,calls};
}
test('initial 10 and older 20 pages return all messages in order with no gaps or duplicate timestamp ties',async()=>{
 const {load,calls}=fixture();
 let page=await load('chat',10);
 assert.equal(page.messages.length,10);
 assert.equal(page.messages[0].content,'message-1527');
 assert.equal(page.messages.at(-1).content,'message-1536');
 assert.equal(page.hasMore,true);
 const seen=[...page.messages];
 while(page.hasMore){
   const oldest=page.messages[0];
   page=await load('chat',20,{createdAt:oldest.createdAt,id:oldest.id});
   seen.unshift(...page.messages);
 }
 assert.equal(seen.length,1537);
 assert.equal(new Set(seen.map(r=>r.id)).size,1537);
 assert.equal(seen[0].content,'message-0');
 assert.equal(seen.at(-1).content,'message-1536');
 assert.equal(calls[0].limit,11);
 assert.equal(calls[1].limit,21);
 for(const call of calls) assert.deepEqual(call.orders,[['created_at',false],['id',false]]);
});
test('initial chat UI opts into server pagination and renders only visible history',()=>{
 assert.match(api,/getMessageHistoryPage\(chatId, Number\(pageLimitRaw\)/);
 assert.match(panel,/&limit=10/);
 assert.match(panel,/messages\.slice\(-visibleHistoryCount\)\.map/);
 assert.match(panel,/beforeCreatedAt: oldest\.createdAt/);
 assert.match(panel,/setVisibleHistoryCount\(current => current \+ page\.messages!\.length\)/);
 assert.match(panel,/pendingHistoryScrollAnchor/);
 assert.match(panel,/onScroll=\{event =>/);
 assert.match(api,/const messages = historyPage\?\.messages \?\? await getMessages\(chatId\)/);
});
