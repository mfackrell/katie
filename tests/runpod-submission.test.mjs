import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
const chatId = '12345678-1234-1234-1234-123456789abc';
const params = {chatId, attachmentPath: `chats/${chatId}/${chatId}.source`, question: 'Describe it'};
function harness(fault = '', syntheticValidation = false) {
  let row, posts = 0, writes = 0, policy;
  const client = {
    storage: {from: () => ({createSignedUrl: async () => fault === 'before' ? {error: true} : {data: {signedUrl: 'https://private.invalid/?secret'}}})},
    from: () => {
      let mode, patch, filters = [];
      const q = {
        insert: value => {mode = 'insert'; patch = value; return q;},
        update: value => {mode = 'update'; patch = value; return q;},
        in: (k,values) => {filters.push([k,values]); return q;},
        select: () => q, eq: (k,v) => {filters.push([k,v]); return q;},
        single: () => execute(), maybeSingle: () => execute(),
      };
      async function execute() {
        if (mode === 'insert') {
          if (row) return {error: {code: '23505'}};
          row = {id: chatId, runpod_job_id: null, ...patch}; return {data: {id: chatId}};
        }
        if (mode === 'update') {
          writes++;
          if ((fault === 'registration' && writes === 1) || fault === 'cleanup') return {error: true};
          if (!filters.every(([k,v]) => Array.isArray(v) ? v.includes(row[k]) : row[k] === v)) return {data: null};
          Object.assign(row, patch); return {data: {...row}};
        }
        return {data: {...row}};
      }
      return q;
    },
  };
  const exports = {}, logs = [];
  vm.runInNewContext(ts.transpileModule(readFileSync('lib/runpod/durable-results.ts','utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, {
    exports, Buffer, process: {env: {SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock', RUNPOD_API_KEY: 'mock'}}, AbortSignal, Date,
    console: {warn: (...args) => logs.push(args), info: (...args) => logs.push(args)}, require: name => name === 'node:crypto' ? crypto : name === '@supabase/supabase-js' ? {createClient: () => client} : name.includes('video-scene-prompts') ? {buildRunpodVideoScenePrompt: x => x} : {},
    fetch: async (url, init) => {
      if (url.includes("/status/")) {
        if (fault === "pollrace") Object.assign(row, {status: "completed", analysis_text: "webhook evidence"});
        return Response.json({id: "provider-123", status: "IN_PROGRESS"});
      }
      posts++;
      policy = JSON.parse(init.body).policy;
      if (fault === 'timeout') throw new Error('timeout');
      if (fault === 'webhook') Object.assign(row, {status: 'completed', runpod_job_id: 'provider-123', analysis_text: 'callback result'});
      if (fault === 'rejected') return new Response('', {status: 400});
      if (fault === 'server') return new Response('', {status: 503});
      return Response.json(fault === 'unknown' ? {} : {id: 'provider-123'});
    },
  });
  return {logs, refresh: () => exports.refreshRunpodJob(client, {id: chatId, runpod_job_id: "provider-123", endpoint_id: "yafwsm98e8m9lv", status: "queued"}), submit: () => exports.submitSavedVideo({...params,...(syntheticValidation ? {syntheticValidation:true} : {})}), get row(){return row;}, get posts(){return posts;}, get policy(){return policy;}};
}
test('synthetic workload policy is bounded while normal submissions retain existing policy', async()=>{
  const normal=harness();await normal.submit();assert.equal(normal.policy,undefined);
  const synthetic=harness('',true);await synthetic.submit();await synthetic.submit();
  assert.equal(synthetic.policy.executionTimeout,60000);assert.equal(synthetic.policy.ttl,900000);assert.equal(synthetic.posts,1);
});
test('pre-POST failure and explicit rejection remain distinct, durable and non-repeating', async () => {
  for (const [fault,code,posts] of [['before','SUBMISSION_PRE_POST_FAILED',0],['rejected','SUBMISSION_REJECTED',1]]) {
    const h = harness(fault); await h.submit(); await h.submit();
    assert.equal(h.row.status,'failed'); assert.equal(h.row.error_code,code); assert.equal(h.posts,posts);
  }
});
test('ambiguous timeout, server failure and accepted unknown ID retain proof and never repost', async () => {
  for (const fault of ['timeout','server','unknown']) {
    const h = harness(fault); const first = await h.submit(); const hash = h.row.callback_token_hash;
    const retry = await h.submit(); assert.equal(retry.id, first.id);
    assert.equal(h.posts,1); assert.equal(h.row.status,'pending');
    assert.equal(h.row.error_code,'SUBMISSION_ACCEPTANCE_UNKNOWN'); assert.equal(h.row.callback_token_hash,hash);
    assert.ok(!JSON.stringify(h.row).includes('secret'));
  }
});
test('accepted registration write failure retains known ID for polling', async () => {
  const h = harness('registration'); await h.submit(); await h.submit();
  assert.equal(h.posts,1); assert.equal(h.row.runpod_job_id,'provider-123'); assert.equal(h.row.status,'queued');
});
test('webhook-first completion is returned and never overwritten by registration', async () => {
  const h = harness('webhook'); const result = await h.submit();
  assert.equal(result.status,'completed'); assert.equal(h.row.analysis_text,'callback result');
});
test('failed recovery write surfaces failure and retry still cannot issue another POST', async () => {
  const h = harness('cleanup'); await assert.rejects(h.submit(), /recovery write failed/);
  await h.submit(); assert.equal(h.posts,1); assert.equal(h.row.status,'pending');
});
test('concurrent local retries claim only one provider submission', async () => {
  const h = harness(); await Promise.all([h.submit(), h.submit()]); assert.equal(h.posts,1);
});

test('stale poll observes concurrent callback completion without replacing evidence', async () => {
  const h = harness('pollrace'); await h.submit(); const result = await h.refresh();
  assert.equal(result.status, 'completed'); assert.equal(h.row.analysis_text, 'webhook evidence');
});

test('synthetic failures keep identifiers and signed URLs out of logs', async () => {
  for (const fault of ['before', 'rejected', 'timeout', 'server', 'unknown', 'registration']) {
    const h = harness(fault, true);
    await h.submit();
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0][0], '[RunPod Synthetic Submission] receipt retained');
    assert.ok(['pre_post_failure', 'rejected', 'acceptance_uncertain'].includes(h.logs[0][1].outcome));
    assert.equal(Object.keys(h.logs[0][1]).length, 1);
    assert.doesNotMatch(JSON.stringify(h.logs), /12345678|provider-123|secret|private.invalid|Describe it/);
    const normal = harness(fault);
    await normal.submit();
    assert.equal(normal.logs[0][1].receiptId, chatId);
    assert.equal(normal.logs[0][1].status, normal.row.status);
  }
});
