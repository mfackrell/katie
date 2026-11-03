import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const route=readFileSync('app/api/chat/route.ts','utf8');
const panel=readFileSync('components/chat-panel.tsx','utf8');
const activity=readFileSync('components/reasoning-explainer-panel.tsx','utf8');
const workflow=readFileSync('lib/standalone-accounting/workflow.ts','utf8');

test('streamed answer tokens never masquerade as reasoning',()=>{
 const begin=route.indexOf('const enqueueDelta = (delta: string) => {');
 const end=route.indexOf('let pendingVideoAssistantMessageId',begin);
 assert.ok(begin>0&&end>begin);
 const enqueue=route.slice(begin,end);
 assert.match(enqueue,/emitChunk\(\{ type: "delta", text: visibleDelta \}\)/);
 assert.doesNotMatch(enqueue,/reasoningState\.addDelta|type:\s*["']reasoning_update["']/);
 assert.doesNotMatch(panel,/applyFallbackReasoningUpdate\(chunk\.text\)|applyFallbackReasoningFromDelta\(chunk\.text\)/);
 assert.match(route,/const reasoningState = new ReasoningStateAccumulator\(requestId, \[\]\)/);
 assert.doesNotMatch(panel,/<span>Live reasoning<\/span>/);
 assert.match(panel,/<span>Live activity<\/span>/);
});

test('progress messages reflect observable actions rather than text-length scores',()=>{
 assert.match(route,/type: "processing_update", stage, message/);
 for(const stage of ['context','generation','save','post_answer','memory']){
   assert.match(route,new RegExp('progress\\("'+stage+'"'));
 }
 assert.match(panel,/if \(chunk\.type === "processing_update"\)/);
 assert.match(panel,/recordProcessingUpdate\(chunk\.stage,chunk\.message\)/);
 assert.match(activity,/processingActivity\.map/);
 assert.doesNotMatch(activity,/Live response preview|streamingAnswer\.slice/);
});

test('saved content provides durable ID, followed by final answer event before followup work',()=>{
 const save=route.indexOf('await saveMessage(chatId, {\n              id: assistantMessageId');
 const content=route.indexOf('type: "content",\n              messageId: assistantMessageId',save);
 const final=route.indexOf('emitChunk(finalAnswerEvent)',content);
 const memory=route.indexOf('await scheduleMemoryPersistence(',final);
 assert.ok(save>0&&content>save&&final>content&&memory>final);
 assert.match(panel,/const commitSavedAnswer = \(\) =>/);
 assert.match(panel,/!savedAssistantMessageId \|\| !sawFinalReasoningAnswer/);
 assert.match(panel,/if \(chunk\.type === "final_answer"\) commitSavedAnswer\(\)/);
 assert.match(panel,/if \(trailingChunk\.type === "final_answer"\) commitSavedAnswer\(\)/);
 assert.match(panel,/id: savedAssistantMessageId,/);
 assert.match(panel,/current\.filter\(entry => entry\.id !== assistantMessage\.id\)/);
 assert.match(panel,/if \(!answerCommitted\) \{/);
});

test('post-answer processing and accounting remain durable and can report failures',()=>{
 assert.match(route,/progress\("memory", "Answer delivered; checking conversation memory\."/);
 assert.match(workflow,/const notice=await settle\(collected\(\)\)/);
 assert.match(workflow,/type:'processing_update',stage:'accounting'/);
 assert.match(workflow,/if\(notice&&!disconnected\)controller\.enqueue/);
 assert.match(panel,/if \(answerCommitted\) \{[\s\S]*?later workflow processing needs attention/);
 assert.match(panel,/clearPendingChatRequest\(chatId\);\n      setStatusMessage\("Response received\."\)/);
 assert.match(panel,/setStatusMessage\("Answer saved\. Finalizing memory and request accounting…"/);
});
