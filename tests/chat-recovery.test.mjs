import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync('components/chat-panel.tsx', 'utf8');
const section = source.slice(source.indexOf('class TerminalChatError'), source.indexOf('function readBlobAsDataUrl'));
function polling(fetch) {
 const ctx = vm.createContext({ fetch, Date, Error, MOBILE_RECOVERY_WINDOW_MS: 1000, waitForRecoveryPoll: async () => {} });
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
