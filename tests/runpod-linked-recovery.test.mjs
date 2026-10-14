import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
const uuid = n => `12345678-1234-1234-1234-${String(n).padStart(12, '0')}`;
const actor = uuid(1), source = uuid(2), target = uuid(3), assistant = uuid(4);
const requestId = 'linked-recovery';
const params = {chatId: source, targetChatId: target, actorId: actor, assistantMessageId: assistant,
  requestId, videoIndex: 0, videoTotal: 2, attachmentPath: `chats/${source}/${uuid(5)}.source`, question: 'Compare these videos', sourceFilename: 'first.mp4'};
function harness(faults = [], synthetic = false) {
  const requestId = synthetic ? 'synthetic-wp4-retest' : 'linked-recovery';
  const localParams = {...params, requestId, ...(synthetic ? {videoTotal:1,syntheticValidation:true} : {})};
  const tables = {chats: [{id: source, actor_id: actor}, {id: target, actor_id: actor}], video_analysis_jobs: [],
    messages: [{id: assistant, chat_id: target, actor_id: actor, role: 'assistant', content: `[Katie video analysis pending: ${requestId}] waiting`},
      {id: uuid(8), chat_id: target, actor_id: uuid(9), role: 'assistant', content: 'other actor'}],
    chat_requests: [{request_id: requestId, chat_id: target, actor_id: actor}]};
  let posts = 0, messageWrites = 0, failCleanup = false, failRegistration = false, webhook;
  const callbacks = [], recovered = [], timingReads = [], synthesisEvidence = [];
  const timing = {version: 1, durationSeconds: 2, sampleSeconds: [0.166667, 1.25]};
  const client = {storage: {from: () => ({createSignedUrl: async path => faults[path === params.attachmentPath ? 0 : 1] === 'before' ? {error: true} : {data: {signedUrl: 'https://private.invalid/?secret'}}})},
    from: table => {
      let mode = 'read', patch, filters = [], sort, cap;
      const q = {select: columns => {q.columns = columns; return q;}, insert: value => {mode = 'insert'; patch = value; return q;},
        update: value => {mode = 'update'; patch = value; return q;},
        eq: (k,v) => {filters.push(r => r[k] === v); return q;}, is: (k,v) => {filters.push(r => r[k] === v); return q;},
        in: (k,v) => {filters.push(r => v.includes(r[k])); return q;}, not: (k,op,v) => {filters.push(r => r[k] !== v); return q;},
        lt: (k,v) => {filters.push(r => r[k] < v); return q;}, gte: (k,v) => {filters.push(r => r[k] >= v); return q;},
        order: k => {sort = k; return q;}, limit: n => {cap = n; return q;},
        single: () => execute(true), maybeSingle: () => execute(true), then: (ok,bad) => execute().then(ok,bad)};
      async function execute(single = false) {
        if (mode === 'insert') {
          if (tables[table].some(r => r.submission_key === patch.submission_key)) return {error: {code: '23505'}};
          const row = {id: uuid(100 + tables[table].length), runpod_job_id: null, response_delivered_at: null,
            fallback_attempts: 0, submitted_at: new Date().toISOString(), ...patch};
          tables[table].push(row); return {data: {id: row.id}};
        }
        let rows = tables[table].filter(r => filters.every(f => f(r)));
        if (sort) rows.sort((a,b) => a[sort] < b[sort] ? -1 : 1);
        if (cap) rows = rows.slice(0,cap);
        if (mode === 'update') {
          if (failRegistration && patch.status === 'queued' && !patch.error_code) {failRegistration = false; return {error: true};}
          if (failCleanup && patch.error_code?.startsWith('SUBMISSION_')) {failCleanup = false; return {error: true};}
          rows.forEach(r => Object.assign(r,patch));
          if (table === 'messages') messageWrites += rows.length;
        }
        // Project selects so missing production columns cannot pass the regression.
        const project = r => q.columns ? Object.fromEntries(q.columns.split(',').map(k => [k,r[k]])) : {...r};
        return {data: single ? (rows[0] ? project(rows[0]) : null) : rows.map(project)};
      }
      return q;
    }};
  const load = (file, imports, extras = {}) => {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText,
      {exports, Buffer, Date, AbortSignal, console: {info(){},warn(){},error(){}}, process: {env: {SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', RUNPOD_API_KEY: 'mock', GROK_API_KEY: 'mock'}},
        require: name => imports[name] ?? {}, ...extras});
    return exports;
  };
  const durable = load('lib/runpod/durable-results.ts', {'node:crypto': crypto, '@supabase/supabase-js': {createClient: () => client},
    '@/lib/data/supabase/admin': {getSupabaseAdminClient: () => client}, '@/lib/chat/video-scene-prompts': {buildRunpodVideoScenePrompt: x => x}},
    {fetch: async (url,init) => {
      if(url.includes('/status/')) return Response.json({}, {status:404});
      assert.ok(url.endsWith('/run')); const index = posts++; callbacks.push(JSON.parse(init.body).webhook);
      if (faults[index] === 'cleanup') {failCleanup = true; throw Error('unknown acceptance');}
      if (faults[index] === 'unknown') throw Error('unknown acceptance');
      if (faults[index] === 'registration') failRegistration = true;
      return Response.json({id: `provider-${index}`});
    }});
  const orchestration = load('lib/runpod/video-orchestration.ts', {
    '@/lib/runpod/durable-results': durable,
    '@/lib/data/persistence-store': {parseMessageContent: content => ({text: content}), encodeMessageContent: x => x.content},
    '@/lib/uploads/video-timing': {formatVideoTiming: () => 'Measured duration: 2s', getVideoTiming: () => timing},
    '@/lib/uploads/stored-uploads': {readSavedVideoTiming: async (chat, id, owner) => {assert.equal(chat,source); assert.equal(owner,actor); timingReads.push(id); return timing;}, recoverSavedVideoFrames: async (chat, attachment, owner) => {assert.equal(chat,source); assert.equal(owner,actor); recovered.push(attachment.id); return {videoFrames: ['pixels']};}},
    '@/lib/providers/grok-provider': {GrokProvider: class {async listModels(){return ['grok-4.7'];} async generate(input){assert.match(input.user, /Measured duration: 2s/); return {text: 'A detailed independent frame analysis with real visual evidence.', model: 'grok-4.7'};}}},
    '@/lib/chat/video-scene-prompts': {buildGrokVideoScenePrompt: x => x},
    '@/lib/chat/video-evidence': {buildVideoConversationEvidence: x => {assert.equal(x.timing, timing); return [x.runpodText,x.grokText,'Measured duration: 2s'].filter(Boolean).join('\n');}},
    '@/lib/runpod/video-conversation': {finalizeContextualVideoReply: async x => {assert.match(x.observations, /Measured duration: 2s/); synthesisEvidence.push(x.observations); assert.equal(x.actorId,actor); assert.equal(x.chatId,target); assert.equal(x.assistantMessageId,assistant); return {status: 'ready',text: x.observations, model: 'conversation'};}},
  });
  const reconcile = load('app/api/internal/runpod-results/reconcile/route.ts', {
    'next/server': {NextResponse: {json: Response.json}}, '@/lib/runpod/durable-results': {...durable, assertCronAuth: () => true},
    '@/lib/runpod/video-delivery-reconciliation': {reconcileVideoDeliveries: async () => ({deliveryFailed: 0})},
  });
  load('supabase/functions/katie-runpod-result-webhook/index.ts', {}, {Request, Response, URL, TextEncoder, crypto: crypto.webcrypto,
    Deno: {env: {get: k => ({SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'mock'})[k]}, serve: fn => {webhook = fn;}},
    fetch: async (url,init) => {
      if(url.includes('/runpod_synthetic_validation?')) return Response.json([JSON.parse(init.body)]);
      const query = new URL(url).searchParams;
      const rows = tables.video_analysis_jobs.filter(r => ['id','status','runpod_job_id','error_code'].every(k => !query.has(k) || query.get(k) === (r[k] == null ? 'is.null' : 'eq.' + r[k])));
      if (init.method === 'PATCH') rows.forEach(r => Object.assign(r,JSON.parse(init.body)));
      return Response.json(rows);
    }});
  return {tables, recovered, timingReads, synthesisEvidence, submit: p => durable.submitSavedVideo(p ?? localParams), publish: () => orchestration.publishVideoChat(requestId),
    expire: () => durable.refreshRunpodJob(client,tables.video_analysis_jobs[0]),
    grok: () => orchestration.processNextGrokVideo(), deadline: () => reconcile.GET({}),
    callback: async (index,body = {}, wrongProof = false) => webhook(new Request(wrongProof ? callbacks[index].replace(/proof=[a-f0-9]+/, 'proof=' + 'b'.repeat(64)) : callbacks[index], {method:'POST', body: JSON.stringify({id:`provider-${index}`,status:'COMPLETED',output:{choices:[{message:{content:'Late original-video analysis with full visual evidence.'}}]},...body})})),
    get posts(){return posts;}, get messageWrites(){return messageWrites;}};
}
test('linked concurrent retries validate batch size and correlation without repeating POST', async () => {
  const h = harness(); await Promise.all([h.submit(),h.submit()]);
  for (const change of [{videoTotal:3}, {assistantMessageId:uuid(7)}, {targetChatId:source}, {question:'changed'}, {attachmentPath:`chats/${source}/${uuid(6)}.source`}]) {
    await assert.rejects(h.submit({...params,...change}), /correlation differs/);
  }
  await assert.rejects(h.submit({...params, actorId:uuid(9)}), /does not belong/);
  h.tables.chats.find(r => r.id === target).actor_id = uuid(9);
  await assert.rejects(h.submit(), /does not belong/);
  assert.equal(h.posts,1); assert.equal(h.tables.video_analysis_jobs.length,1);
});
test('linked partial submission and cleanup failures recover a complete batch once', async () => {
  for (const faults of [['registration','cleanup'], ['unknown','before']]) {
    const h = harness(faults); await h.submit();
    const second = {...params,videoIndex:1,attachmentPath:`chats/${source}/${uuid(6)}.source`,sourceFilename:'second.mp4'};
    if (faults[1] === 'cleanup') await assert.rejects(h.submit(second), /recovery write failed/); else await h.submit(second);
    await h.submit(second); await h.submit();
    assert.equal((await h.publish()).status,'analyzing');
    h.tables.video_analysis_jobs.forEach(r => {r.submitted_at = new Date(Date.now()-901000).toISOString();});
    // Known accepted job gets its real authenticated completion; unknown jobs hit the local deadline.
    if (faults[0] === 'registration') assert.equal((await h.callback(0)).status,200);
    await h.deadline(); await h.grok(); assert.equal(h.messageWrites,0); await h.grok();
    assert.equal((await h.publish()).status,'delivered'); assert.equal(h.messageWrites,1);
    const answer = h.tables.messages[0].content;
    assert.match(answer,/first.mp4/); assert.match(answer,/second.mp4/);
    assert.equal(h.tables.messages[1].content,'other actor'); assert.equal(h.tables.chat_requests[0].status,'completed');
    assert.equal(h.recovered.length,2); assert.ok(h.tables.video_analysis_jobs.every(r => r.response_delivered_at));
    const unknownIndex = faults[1] === 'cleanup' ? 1 : 0;
    const row = h.tables.video_analysis_jobs[unknownIndex], proof = row.callback_token_hash;
    assert.equal((await h.callback(unknownIndex,{},true)).status,401);
    assert.equal(row.status,'timed_out');
    assert.equal((await h.callback(unknownIndex)).status,200);
    assert.equal(row.status,'completed');
    assert.match(row.analysis_text,/Late original-video/);
    const terminalText = row.analysis_text;
    assert.equal((await h.callback(unknownIndex,{status:'FAILED'})).status,200);
    assert.equal(row.status,'completed');
    assert.equal(row.analysis_text,terminalText);
    // Once the unknown ID is bound, a different provider cannot overwrite it.
    assert.equal((await h.callback(unknownIndex,{id:'different-provider'})).status,409);
    assert.equal(row.callback_token_hash,proof);
    await h.publish(); await h.submit(); await h.submit(second);
    assert.equal(h.messageWrites,1); assert.equal(h.tables.messages[0].content,answer);
    assert.equal(h.posts,faults[1] === 'before' ? 1 : 2);
  }
});

test('retest queue 404 safely recovers one final answer; late callback and retries never repeat delivery or POST',async()=>{
  const h=harness([],true);await Promise.all([h.submit(),h.submit()]);
  assert.equal(h.posts,1);
  await h.expire();const row=h.tables.video_analysis_jobs[0];
  assert.equal(row.status,'expired');assert.equal(row.error_code,'RUNPOD_RESULT_EXPIRED_OR_NOT_FOUND');
  await h.grok();await h.publish();assert.equal(h.messageWrites,1);
  const answer=h.tables.messages[0].content;
  assert.match(answer,/independent frame analysis/);
  assert.equal(h.tables.messages[1].content,'other actor');
  assert.equal(h.tables.chat_requests[0].status,'completed');
  assert.equal((await h.callback(0,{},true)).status,401);
  assert.equal((await h.callback(0)).status,200);assert.equal(row.status,'completed');
  await h.grok();await h.publish();await h.submit();
  assert.equal(h.posts,1);assert.equal(h.messageWrites,1);assert.equal(h.tables.messages[0].content,answer);
});

test('delayed publish retries and Grok failure keep owner-checked measured timing without decoding', async () => {
  const h = harness([], true);
  await h.submit();
  const row = h.tables.video_analysis_jobs[0];
  Object.assign(row, {status:'completed', analysis_text:'The red background changes to blue around 0.3 seconds. A white square remains centered.', fallback_state:'failed', fallback_error_code:'OFFLINE_TEST'});
  // Delay final publication until the original placeholder is restored.
  const placeholder = h.tables.messages.shift();
  assert.equal((await h.publish()).status, 'awaiting_assistant_message');
  assert.equal(h.recovered.length, 0);
  h.tables.messages.unshift(placeholder);
  assert.equal((await h.publish()).status, 'delivered');
  assert.equal(h.timingReads.length, 2);
  assert.equal(h.synthesisEvidence.length, 2);
  for (const evidence of h.synthesisEvidence) {
    assert.match(evidence, /Measured duration: 2s/);
    assert.match(evidence, /white square/);
  }
  assert.equal(h.recovered.length, 0);
});
