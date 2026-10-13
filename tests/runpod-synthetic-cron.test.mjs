import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function harness({ enabled = 'true', authorized = true, initial = {}, fault = '', race = false } = {}) {
  let state = { status: 'pending', livePass: false, elapsedSeconds: 60, ...initial };
  let starts = 0, posts = 0, cleanups = 0, reads = 0, claimed = state.status !== 'not_started';
  const logs = [], exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('app/api/internal/runpod-results/synthetic-cron/route.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, process: { env: { RUNPOD_SYNTHETIC_VALIDATION_ENABLED: enabled } },
    console: { info: (...args) => logs.push(JSON.parse(JSON.stringify(args))) },
    require: name => {
      if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      if (name.endsWith('/durable-results')) return { assertCronAuth: () => authorized };
      if (name.endsWith('/synthetic-validation')) return {
        syntheticStatus: async () => { reads++; if (fault === 'status') throw Error('secret'); return race && reads <= 2 ? {status:'not_started',livePass:false} : {...state}; },
        startSyntheticValidation: async () => {
          starts++;
          if (claimed) return {status:'already_claimed'};
          claimed = true; posts++; state = {...state,status:'pending'};
          if (fault === 'start') throw Error('secret');
          return {status:'submitted',receiptId:'sensitive-id'};
        },
        cleanupSyntheticValidation: async () => {
          cleanups++;
          if (fault === 'cleanup') throw Error('secret');
          state = {...state,status:'cleaned',livePass:false};
          return {status:'cleaned'};
        },
      };
      throw Error(name);
    },
  });
  return { run: () => exports.GET({}), logs, get counts() { return {starts,posts,cleanups,reads}; } };
}

test('cron requires authentication and exact enable flag before any synthetic access', async () => {
  for (const options of [{authorized:false}, {enabled:null}, {enabled:'false'}, {enabled:'TRUE'}]) {
    const h = harness(options), response = await h.run();
    assert.equal(response.status, options.authorized === false ? 401 : 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(h.counts, {starts:0,posts:0,cleanups:0,reads:0});
    assert.equal(h.logs.length, 0);
  }
});
test('unclaimed concurrent ticks and retries submit only once through singleton helper', async () => {
  const h = harness({initial:{status:'not_started'},race:true});
  await Promise.all([h.run(),h.run()]); await h.run();
  assert.equal(h.counts.posts, 1); assert.equal(h.counts.starts, 2);
});
test('pending claim is observed without submission and untrusted values and IDs are redacted', async () => {
  const h = harness({initial:{receiptId:'sensitive-id',providerStatus:'https://secret',fallbackStage:'token-secret',callbackProvenance:'proof-secret',content:'user-content'}});
  const response = await h.run(), body = await response.json();
  assert.equal(h.counts.starts, 0); assert.equal(h.counts.cleanups, 0);
  assert.equal(body.observation.provider,'unknown');
  assert.equal(body.observation.livePass,false);
  assert.doesNotMatch(JSON.stringify([body,h.logs]), /secret|sensitive-id|user-content/);
});
test('live pass evidence is logged before cleanup and cleanup never overwrites its result', async () => {
  const h = harness({initial:{status:'pipeline_pass',livePass:true,elapsedSeconds:1199,callbackProvenance:'authenticated_matching_callback',providerStatus:'completed',fallbackStage:'completed',deliveredCount:1}});
  const body = await (await h.run()).json();
  assert.equal(body.observation.livePass,true); assert.equal(h.counts.cleanups,0);
  assert.equal(h.logs[0][1].delivery,'delivered');
  const deadline = harness({initial:{status:'pipeline_pass',livePass:true,elapsedSeconds:1200}});
  const cleaned = await (await deadline.run()).json(); await deadline.run();
  assert.equal(cleaned.observation.livePass,true);
  assert.equal(deadline.logs[0][1].livePass,true);
  assert.deepEqual(deadline.logs[1],['[WP4 synthetic cleanup]',{status:'cleaned'}]);
  assert.equal(deadline.logs.length,2); assert.equal(deadline.counts.cleanups,1);
  assert.equal(deadline.counts.starts,0);
});
test('deadline cleans pending runs and repeated cleaned ticks are inert', async () => {
  for (const initial of [{status:'deadline_exceeded',elapsedSeconds:1200},{status:'pending',elapsedSeconds:1201}]) {
    const h = harness({initial});
    assert.equal((await (await h.run()).json()).status,'cleaned'); await h.run();
    assert.equal(h.counts.cleanups,1); assert.equal(h.counts.starts,0);
  }
});
test('failures redact exceptions, retain consumed claim, and retry failed cleanup', async () => {
  for (const fault of ['status','start','cleanup']) {
    const h = harness({fault,initial:{status:fault === 'start' ? 'not_started':'deadline_exceeded'}});
    const response = await h.run(); assert.equal(response.status,503);
    assert.doesNotMatch(await response.text(),/secret/);
    await h.run();
    if (fault === 'start') { assert.equal(h.counts.posts,1); assert.equal(h.counts.starts,1); }
    if (fault === 'cleanup') assert.equal(h.counts.cleanups,2);
  }
});
test('temporary cron schedule is exactly once per minute', () => {
  const config = JSON.parse(readFileSync('vercel.json','utf8'));
  assert.deepEqual(config.crons.filter(c => c.path === '/api/internal/runpod-results/synthetic-cron'),
    [{path:'/api/internal/runpod-results/synthetic-cron',schedule:'* * * * *'}]);
});
