import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual chat effect, including its timer and cleanup, so a
// stopped polling loop cannot hide behind a passing server-delivery test.
const source=readFileSync('components/chat-panel.tsx','utf8');
const start=source.indexOf('  useEffect(()=>{',source.indexOf('const projectProgressSignature'));
const end=source.indexOf('\n  async function approveProject',start);
const effect=ts.transpileModule(source.slice(start,end),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
function chat({status=null,loading=false}={}){
 let tick,cleanup,current=[],cache={},requests=0,pending;
 const receipt={id:'receipt',content:'Executive assigned operations to its independent agent team.'};
 const answer={id:'answer',content:'Specialist completed and passed independent review.'};
 const document={visibilityState:'visible',addEventListener(){},removeEventListener(){}};
 const context={actorId:'actor',chatId:'chat',loading,projectProgressSignature:'',document,
  window:{setInterval(fn){tick=fn;return 1;},clearInterval(){tick=null;},addEventListener(){},removeEventListener(){}},
  useEffect(fn){cleanup=fn();},setProjectApproval(){},setProjectApprovalError(){},
  setMessages(fn){current=fn(current);},setMessagesByChatId(fn){cache=fn(cache);},
  async fetch(){requests++;if(pending)await pending;return {ok:true,json:async()=>({status,approval:null,messages:requests===1?[receipt]:[receipt,answer]})};}
 };
 vm.runInNewContext(effect,context);
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 return {flush,async poll(){tick?.();await flush();},get messages(){return current;},get cache(){return cache;},
  get requests(){return requests;},hide(){document.visibilityState='hidden';},leave(){cleanup?.();},
  pause(promise){pending=promise;}};
}
for(const status of [null,'completed','stopped']){
 test(`Executive result appears on a later timer tick with project status ${status}`,async()=>{
  const ui=chat({status});await ui.flush();
  assert.deepEqual(Array.from(ui.messages,m=>m.id),['receipt']);
  await ui.poll();
  assert.deepEqual(Array.from(ui.messages,m=>m.id),['receipt','answer']);
  await ui.poll();
  assert.equal(ui.messages.filter(m=>m.id==='answer').length,1);
  assert.deepEqual(ui.cache.chat,ui.messages);
 });
}
test('background chat synchronization stops while hidden or streaming',async()=>{
 const ui=chat();await ui.flush();ui.hide();await ui.poll();assert.equal(ui.requests,1);
 const streaming=chat({loading:true});await streaming.poll();assert.equal(streaming.requests,0);
});
test('leaving the chat discards an in-flight background response',async()=>{
 const ui=chat();await ui.flush();let release;
 ui.pause(new Promise(resolve=>{release=resolve;}));
 await ui.poll();ui.leave();release();await ui.flush();
 assert.deepEqual(Array.from(ui.messages,m=>m.id),['receipt']);
});
