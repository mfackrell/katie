import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function load(file, imports) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }}).outputText, {exports, require: name => imports[name] ?? {}, Date, setTimeout, clearTimeout,
    console: {info() {}, error() {}}});
  return exports;
}
test('stale synthesis lease sends measured evidence to generator and required reviewer', async () => {
  const timing = load('lib/uploads/video-timing.ts', {});
  const evidence = load('lib/chat/video-evidence.ts', {'@/lib/uploads/video-timing': timing});
  const response = load('lib/chat/video-response.ts', {});
  const observations = evidence.buildVideoConversationEvidence({
    runpodText: 'A red field switches to blue at 0.3 seconds. A white square stays centered. The clip ends at 1.6 seconds.',
    grokText: 'A red field becomes blue and the white square stays centered.',
    timing: {version: 1, durationSeconds: 2, sampleSeconds: [0.666667, 1.25]},
  });
  const state = {status: 'processing', video_reply_provider: 'anthropic', video_reply_model: 'claude-test',
    video_synthesis_state: 'processing', video_synthesis_started_at: new Date(Date.now() - 300000).toISOString()};
  const generated = [], reviewed = [];
  const provider = {name: 'anthropic', generate: async params => {
    generated.push(params.user);
    return {provider: 'anthropic', model: 'claude-test', text: 'The 2.0-second clip changes from red to blue while the white square stays centered.'};
  }};
  const db = {from(table) {
    let patch;
    const q = {select() {return q;}, eq() {return q;}, in() {return q;}, is() {return q;},
      lt() {return q;}, order() {return q;}, limit() {return q;}, update(value) {patch = value; return q;},
      async maybeSingle() {
        if (patch) {Object.assign(state, patch); return {data: {request_id: 'request'}};}
        return {data: table === 'chat_requests' ? {...state} : {created_at: new Date().toISOString()}};
      }, then(resolve) {if (patch) Object.assign(state, patch); return Promise.resolve({data: [], error: null}).then(resolve);},
    };
    return q;
  }};
  const conversation = load('lib/runpod/video-conversation.ts', {
    '@/lib/runpod/durable-results': {resultStore: () => db},
    '@/lib/providers': {getAvailableProviders: () => [provider]},
    '@/lib/chat/video-response': response,
    '@/lib/data/persistence-store': {parseMessageContent: content => ({text: content})},
    '@/lib/memory/assemble-context': {assembleContext: async () => ({persona: 'Katie', summary: '', reviewMode: 'always'})},
    '@/lib/collaboration/required-review': {runRequiredDraftReview: async input => {
      reviewed.push(input.params.user); return {result: input.draft, audit: {}};
    }},
  });
  const result = await conversation.finalizeContextualVideoReply({requestId: 'request', actorId: 'actor',
    chatId: 'chat', assistantMessageId: 'assistant', question: 'Describe the clip', observations});
  assert.equal(result.status, 'ready');
  assert.equal(generated.length, 1);
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0], generated[0]);
  assert.match(reviewed[0], /measured duration: 2s/);
  assert.match(reviewed[0], /does not establish the exact onset/);
  assert.match(reviewed[0], /not independent corroboration/);
  assert.match(reviewed[0], /white square/);
  assert.equal(state.video_synthesis_state, 'completed');
});

test('actual route assessment preserves attachments and source context after every task choice', () => {
  const timing = load('lib/uploads/video-timing.ts', {});
  const evidence = load('lib/chat/video-evidence.ts', {'@/lib/uploads/video-timing': timing});
  const route = readFileSync('app/api/chat/route.ts', 'utf8');
  const start = route.indexOf('assessmentParams: {');
  const end = route.indexOf('\n                leadProvider:', start);
  const attachments = [{fileName: 'same.mp4', fileId: 'one'}, {fileName: 'same.mp4', fileId: 'two'}];
  timing.registerVideoTiming(attachments[0], {version: 1, durationSeconds: 2, sampleSeconds: [0.5]});
  const original = {user: 'Ordinary createParams context\nOriginal task', attachments, images: ['original image']};
  for (const video of [true, false]) for (const choice of ['ordinary', 'saved', 'clarification']) {
    const pending = choice === 'clarification' ? {pending: {sourceTurns: ['Original request'], question: 'Which detail?'}} : null;
    const assessment = vm.runInNewContext('({' + route.slice(start, end) + '})', {
      ...evidence, createParams: () => original, result: {model: 'offline'},
      hasVideoInput: video, attachments, isVideoAttachment: () => true,
      savedDraftOriginalTask: choice === 'saved' ? 'Saved original task' : null,
      pendingReviewClarification: pending, message: 'Unknown',
      reviewSourceParams: {user: 'Candidate draft and prior assistant framing'},
    }).assessmentParams;
    assert.equal(assessment.attachments, attachments);
    assert.equal(assessment.images, original.images);
    const chosen = choice === 'ordinary' ? original.user : choice === 'saved' ? 'Saved original task'
      : 'This turn answers a previous clarification about the still-active deliverable. Original user turns: ["Original request"]\nKatie asked: Which detail?\nThe user replied: Unknown\nContinue the original task with only facts the user has provided; if they say the missing information is unknown, do not demand it again.';
    if (video) {
      assert.ok(assessment.user.startsWith(chosen + '\nVideo 1'));
      assert.match(assessment.user, /measured duration: 2s/);
      assert.match(assessment.user, /Video 2 .*two[\s\S]*No server-verified timing/);
    } else assert.equal(assessment.user, chosen);
    assert.ok(!assessment.user.includes('Candidate draft'));
    assert.ok(!assessment.user.includes('prior assistant framing'));
  }
});
