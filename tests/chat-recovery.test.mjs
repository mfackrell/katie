import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync('components/chat-panel.tsx', 'utf8');
const section = source.slice(source.indexOf('class TerminalChatError'), source.indexOf('function readBlobAsDataUrl'));
function polling(fetch,{clock=Date}={}) {
 const ctx = vm.createContext({ fetch, Date:clock, Error, MOBILE_RECOVERY_WINDOW_MS: 1000, QWEN_RECOVERY_WINDOW_MS: 5000, QWEN_RECOVERY_POLL_INTERVAL_MS: 1000, MOBILE_RECOVERY_POLL_INTERVAL_MS: 10, waitForRecoveryPoll: async () => {} });
 vm.runInContext(ts.transpileModule(section + '\nglobalThis.poll = pollForPersistedAssistant;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
 return ctx.poll;
}
test('failed persisted request stops recovery immediately with exact server error', async () => {
 let calls=0;
 const poll=polling(async () => { calls++; return {ok:true,json:async()=>({status:'failed',error:'Google stopped this response (SAFETY).'})}; });
 await assert.rejects(poll('chat',{requestId:'req',startedAt:new Date().toISOString(),content:'test'}),/Google stopped/);
 assert.equal(calls,1);
});
test('temporary network failure still recovers a completed response', async () => {
 let calls=0;
 const poll=polling(async (url) => { if(++calls===1) throw new Error('network'); return {ok:true,json:async()=>url.includes('/status')?{status:'completed',assistantMessageId:'answer'}:{messages:[{id:'answer',role:'assistant',content:'done'}]}}; });
 assert.equal((await poll('chat',{requestId:'req',startedAt:new Date().toISOString(),content:'test'}))[0].content,'done');
 assert.equal(calls,3);
});
test('recovery retains the saved failure message id so the UI does not duplicate it', async () => {
 const poll=polling(async () => ({ok:true,json:async()=>({status:'failed',assistantMessageId:'failure-req',error:'Provider unavailable'})}));
 await assert.rejects(poll('chat',{requestId:'req',startedAt:new Date().toISOString(),content:'test'}),error=>error.messageId==='failure-req' && error.message==='Provider unavailable');
});

test('aged 404 receipt stays unverified instead of declaring a terminal failure', async () => {
  let calls = 0;
  const clock={now:(()=>{let t=0;return()=>t+=2;})(),parse:Date.parse};
  const poll=polling(async url=>{
    calls++;
    return url.includes('/status')
      ? {ok:false,status:404}
      : {ok:true,json:async()=>({messages:[]})};
  },{clock});
  const startedAt = new Date(Date.now() - 45_000).toISOString();
  assert.equal(await poll('chat',{requestId:'missing',startedAt,content:'resend me'},10),null);
  assert.ok(calls>=2);
});
test('temporary not-found during server admission does not abort recovery', async () => {
  let calls = 0;
  const poll = polling(async (url) => {
    calls++;
    if(calls === 1) return {ok:false,status:404};
    if(url.includes('/status')) return {ok:true,json:async()=>({status:'completed',assistantMessageId:'answer'})};
    return {ok:true,json:async()=>({messages:[{id:'answer',role:'assistant',content:'done'}]})};
  });
  const result = await poll('chat',{requestId:'pending',startedAt:new Date().toISOString(),content:'test'});
  assert.equal(result[0].content,'done');
  assert.equal(calls,4);
});

test('queued Qwen remains pending and recovers the saved answer without manual continuation', async () => {
 let statusChecks=0;
 const poll=polling(async url=>{
  if(url.includes('/status')){
   statusChecks++;
   return {ok:true,json:async()=>statusChecks===1
    ? {status:'processing',waitingForRunpod:true}
    : {status:'completed',assistantMessageId:'qwen-answer'}};
  }
  return {ok:true,json:async()=>({messages:[{id:'qwen-answer',role:'assistant',content:'Actual visual description delivered'}]})};
 });
 const result=await poll('chat',{requestId:'saved-qwen',startedAt:new Date().toISOString(),content:'describe the image',waitingForRunpod:true});
 assert.equal(result[0].content,'Actual visual description delivered');
 assert.equal(statusChecks,2);
});


test('durable paused workflow stops mobile recovery without polling again or inventing an answer', async () => {
 let calls=0;
 const poll=polling(async (url) => {
   calls++;
   assert.match(String(url), /\/api\/chat\/status/);
   return {ok:true,json:async()=>({status:'paused',error:'Saved request paused for accounting review. Open Status / Usage to continue.'})};
 });
 await assert.rejects(
   poll('chat',{requestId:'saved-uncertain',startedAt:new Date().toISOString(),content:'original request'}),
   error=>error.name==='PausedChatError'&&error.message.includes('Status / Usage'),
 );
 assert.equal(calls,1,'one status read ends the pending spinner; no POST or request replay');
});

test('saved reply is shown while the original workflow still settles, then completed without duplicate generation', async () => {
 const clock={now:(()=>{let t=0;return()=>t+=1;})(),parse:Date.parse};
 let statusReads=0,postCalls=0,previews=[];
 const poll=polling(async url=>{
  if(url.startsWith('/api/chat/status')){
   statusReads++;
   return {ok:true,json:async()=>statusReads===1
     ? {status:'processing',assistantMessageId:'saved-123',workflowStatus:'running'}
     : {status:'completed',assistantMessageId:'saved-123',workflowStatus:'completed'}};
  }
  if(url.startsWith('/api/messages'))return {ok:true,json:async()=>({messages:[
   {id:'user-123',role:'user',content:'question'},{id:'saved-123',role:'assistant',content:'answer'}
  ]})};
  postCalls++;
  throw Error('Unexpected request sent');
 },{clock});
 const saved=await poll('chat',{requestId:'request-123',startedAt:new Date().toISOString(),content:'question'},200,
   messages=>previews.push(messages.at(-1)?.id));
 assert.equal(saved.at(-1)?.id,'saved-123');
 assert.deepEqual(previews,['saved-123']);
 assert.equal(statusReads,2);
 assert.equal(postCalls,0);
});

test('a saved assistant answer is previewed but not marked settled when the workflow is still running', async () => {
 const clock={now:(()=>{let t=0;return()=>t+=2;})(),parse:Date.parse};
 let previews=0;
 const poll=polling(async url=>url.includes('/status')
  ? {ok:true,json:async()=>({status:'completed',assistantMessageId:'saved-456',workflowStatus:'running'})}
  : {ok:true,json:async()=>({messages:[{id:'saved-456',role:'assistant',content:'saved answer'}]})},
 {clock});
 const result=await poll('chat',{requestId:'req-456',startedAt:new Date().toISOString(),content:'hello'},20,()=>{previews++});
 assert.equal(result,null,'poll expiration must not imply final accounting');
 assert.equal(previews,1,'preview the exact saved response only once');
});

test('status processing without a saved assistant ID cannot attach a different assistant response', async () => {
 const clock={now:(()=>{let t=0;return()=>t+=2;})(),parse:Date.parse};
 let messageReads=0;
 const poll=polling(async url=>{
  if(url.includes('/messages')){messageReads++;return {ok:true,json:async()=>({messages:[{id:'unrelated',role:'assistant',content:'wrong'}]})};}
  return {ok:true,json:async()=>({status:'processing',assistantMessageId:null,workflowStatus:'running'})};
 },{clock});
 const saved=await poll('chat',{requestId:'req-x',startedAt:new Date().toISOString(),content:'hello'},10);
 assert.equal(saved,null);
 assert.equal(messageReads,0);
});

test('temporary status failure never recovers an adjacent assistant with the same user text', async () => {
 const clock={now:(()=>{let t=0;return()=>t+=2;})(),parse:Date.parse};
 const poll=polling(async url=>url.includes('/status')
  ? {ok:false,status:503}
  : {ok:true,json:async()=>({messages:[{id:'user',role:'user',content:'same text',createdAt:new Date().toISOString()},{id:'wrong',role:'assistant',content:'previous answer'}]})},
 {clock});
 assert.equal(await poll('chat',{requestId:'new-id',startedAt:new Date().toISOString(),content:'same text'},12),null);
});

test('durable paused workflow takes precedence over failed chat receipt and remains an accounting pause',async()=>{
 const poll=polling(async url=>({ok:true,json:async()=>({status:'failed',workflowStatus:'paused',error:'Review Status / Usage'})}));
 await assert.rejects(poll('chat',{requestId:'req-paused',startedAt:new Date().toISOString(),content:'test'}),
   err=>err.name==='PausedChatError'&&err.message.includes('Status / Usage'));
});

test('same owner session authenticates existing status and message reads',async()=>{
 const clock={now:(()=>{let t=0;return()=>t+=1;})(),parse:Date.parse};
 const authorizationHeaders=[];
 const poll=polling(async (url,opts)=>{
  authorizationHeaders.push(opts?.headers?.Authorization);
  return url.includes('/status')
   ? {ok:true,json:async()=>({status:'completed',assistantMessageId:'reply',workflowStatus:'completed'})}
   : {ok:true,json:async()=>({messages:[{id:'reply',role:'assistant',content:'verified'}]})};
 },{clock});
 const result=await poll('chat',{requestId:'r',startedAt:new Date().toISOString(),content:'question'},60,undefined,'owner-session');
 assert.equal(result[0].content,'verified');
 assert.deepEqual(authorizationHeaders,['Bearer owner-session','Bearer owner-session']);
});

test('UI retains pending receipt after stream interruption, controls duplicate sends and does not manufacture a failure',()=>{
 const tail=source.slice(source.indexOf('let terminalFailure = error instanceof TerminalChatError;'),
                         source.indexOf('function handleCancelRequest()'));
 assert.match(tail,/if \(isRecoverableStreamFailure\)/);
 assert.match(tail,/The polling window is not a terminal server outcome/);
 assert.match(tail,/setStatusMessage\(savedAnswerPreviewed[\s\S]*?return;/);
 assert.match(tail,/if \(!terminalFailure\) \{[\s\S]*?status remains unverified[\s\S]*?return;/);
 assert.match(source,/if \(readPendingChatRequest\(chatId\)\) \{[\s\S]*?do not resend/);
 assert.match(source,/Age alone cannot prove a saved request failed/);
 assert.doesNotMatch(source,/pendingAgeMs >/);
 assert.match(source,/savedStatus\.status === "completed" && savedStatus\.workflowStatus === "completed"/);
});
