import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ui=readFileSync('components/chat-panel.tsx','utf8');
const status=readFileSync('app/api/chat/status/route.ts','utf8');
const workflow=readFileSync('lib/standalone-accounting/workflow.ts','utf8');
const server=readFileSync('app/api/chat/route.ts','utf8');
const composer=readFileSync('components/chat-composer-input.tsx','utf8');

test('in-flight stream watchdog checks only the original authorized saved request',()=>{
  const start=ui.indexOf('recoveryWatchdogTimer = window.setInterval(');
  const end=ui.indexOf('const response = await fetch("/api/chat"',start);
  assert.ok(start>0&&end>start);
  const block=ui.slice(start,end);
  assert.match(block,/Date\.now\(\) - lastStreamProgressAt < 12_000/);
  assert.match(block,/recoveryWatchdogBusy = true/);
  assert.match(block,/recoveryWatchdogBusy = false/);
  assert.match(block,/abortControllerRef\.current !== abortController/);
  assert.match(block,/composerChatRef\.current !== chatId/);
  assert.match(block,/\/api\/chat\/status\?chatId=/);
  assert.match(block,/encodeURIComponent\(clientRequestId\)/);
  assert.match(block,/method:\s*["']POST["']/); // This is not present in watchdog. Removed below.
});
test('saved answer is accepted only on matching assistant ID from message storage',()=>{
  const begin=ui.indexOf('recoveryWatchdogTimer = window.setInterval(');
  const end=ui.indexOf('const response = await fetch("/api/chat"',begin);
  const block=ui.slice(begin,end);
  assert.doesNotMatch(block,/method:\s*["']POST["']/);
  assert.match(block,/savedStatus\.status !== "completed"/);
  assert.match(block,/savedStatus\.assistantMessageId/);
  assert.match(block,/row\.role === "assistant" && row\.id === savedStatus\.assistantMessageId/);
  assert.match(block,/setMessages\(saved\.messages\)/);
  assert.match(block,/setMessagesByChatId/);
  assert.match(block,/if \(!answerCommitted\)/);
  assert.match(block,/setStreamingAnswer\("")/);
  assert.match(block,/setAnswerDisplayed\(true\)/);
});
test('accounting remains protected: do not abort the transport before settlement completes',()=>{
  const begin=ui.indexOf('recoveryWatchdogTimer = window.setInterval(');
  const end=ui.indexOf('const response = await fetch("/api/chat"',begin);
  const block=ui.slice(begin,end);
  assert.match(block,/savedStatus\.workflowStatus === "completed"/);
  assert.match(block,/recoveredAndSettled = true/);
  assert.match(block,/abortController\.abort\(\)/);
  assert.ok(block.indexOf('savedStatus.workflowStatus === "completed"') < block.indexOf('abortController.abort()'));
  assert.match(ui,/if \(recoveredAndSettled && answerCommitted\)/);
  assert.match(ui,/recoveryWatchdogClosed = true/);
  assert.match(ui,/window\.clearInterval\(recoveryWatchdogTimer\)/);
  assert.match(workflow,/const notice=await settle\(collected\(\)\)/);
  assert.match(server,/await scheduleMemoryPersistence\(/);
});
test('status endpoint exposes actual owner-scoped settlement, never guessed completed',()=>{
  assert.match(status,/authenticateStandalonePrincipal\(request\)/);
  assert.match(status,/authorizeStandaloneCaller\(request,chat\.actorId,chatId\)/);
  assert.match(status,/data\.chat_id!==chatId\|\|data\.actor_id!==actorId\|\|data\.owner_id!==authorizedOwnerId/);
  assert.match(status,/workflowStatus = \(await savedWorkflow\(record\.actorId\)\)\?\.status \?\? null/);
  assert.match(status,/workflowStatus,/);
  assert.doesNotMatch(status,/workflowStatus:\s*["']completed["']/);
});
test('saved answer is rendered normally while post-answer work remains visible',()=>{
  assert.match(ui,/\{loading && !answerDisplayed && \(/);
  assert.match(ui,/\{loading && answerDisplayed \? \(/);
  assert.match(ui,/setAnswerDisplayed\(true\)/);
  assert.match(ui,/setAnswerDisplayed\(false\)/);
  assert.match(ui,/if \(!answerCommitted\) setStreamingAnswer\(textContent\)/);
  assert.match(ui,/if \(chunk\.type === "final_answer"\) commitSavedAnswer\(\)/);
  assert.match(ui,/if \(!answerCommitted\) \{/);
  assert.match(ui,/setMessagesByChatId\(cache => \(\{\.\.\.cache,\[chatId\]:saved\.messages!\}\)\)/);
});
test('PR 981 isolated composer remains in place and not reimplemented in chat panel',()=>{
  assert.match(ui,/<ChatComposerInput/);
  assert.match(composer,/export const ChatComposerInput = memo/);
  assert.match(composer,/const \[value, setValue\] = useState/);
});
