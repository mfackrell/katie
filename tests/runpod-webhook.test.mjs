import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const receipt = '12345678-1234-1234-1234-123456789abc';
const proof = 'a'.repeat(64);
const hash = createHash('sha256').update(proof).digest('hex');
const source = readFileSync('supabase/functions/katie-runpod-result-webhook/index.ts', 'utf8');
function harness(options = {}) {
  let handler;
  const calls = [], patches = [], logs = [];
  const row = { id: receipt, runpod_job_id: 'provider-123', status: 'queued', callback_token_hash: hash, ...options.row };
  const env = { SUPABASE_URL: 'https://storage.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock-key', ...options.env };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: {}, Request, Response, URL, TextEncoder, crypto: webcrypto, AbortSignal,
    console: { log: (...v) => logs.push(v), warn: (...v) => logs.push(v), error: (...v) => logs.push(v) },
    Deno: { env: { get: name => env[name] }, serve: fn => { handler = fn; } },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if(url.includes('/runpod_synthetic_validation?')) {
        const filters=new URL(url).searchParams;
        assert.equal(filters.get('slot'),options.row?.chat_request_id==='synthetic-wp4-retest'?'eq.wp4-retest':'eq.wp4');
        assert.equal(filters.get('actor_id'),'eq.'+receipt);
        assert.equal(filters.get('cleaned_at'),'is.null');
        const marker=JSON.parse(init.body);
        assert.equal(marker.callback_receipt_id,receipt);
        assert.equal(marker.callback_provider_id,'provider-123');
        return Response.json(options.markerFailure ? [] : [marker]);
      }
      if (init.method !== 'PATCH') return Response.json(options.lookup ?? [row], { status: options.lookupStatus ?? 200 });
      const patch = JSON.parse(init.body); patches.push(patch);
      const filters = new URL(url).searchParams;
      assert.equal(new URL(url).searchParams.get('id'), 'eq.' + receipt);
      options.beforePatch?.(row, patches.length);
      const matches = filters.get('status') === 'eq.' + row.status &&
        filters.get('runpod_job_id') === (row.runpod_job_id ? 'eq.' + row.runpod_job_id : 'is.null') &&
        (!filters.has('error_code') || filters.get('error_code') === 'eq.' + row.error_code);
      if (!matches || options.race) return Response.json([]);
      Object.assign(row, patch);
      return Response.json([row], { status: options.saveStatus ?? 200 });
    },
  });
  return { calls, patches, logs, row, send: async (body = {}, query = `receipt=${receipt}&proof=${proof}`, method = 'POST', raw) => {
    const result = await handler(new Request('https://callback.invalid/?' + query, { method, ...(method === 'POST' ? { body: raw ?? JSON.stringify({ id: 'provider-123', status: 'COMPLETED', output: { choices: [{ message: { role: 'assistant', content: ' Analysis ' } }] }, ...body }) } : {}) }));
    return { status: result.status, body: await result.json(), headers: result.headers };
  } };
}

test('method and malformed authentication fail before storage access', async () => {
  const h = harness();
  assert.equal((await h.send({}, '', 'GET')).status, 405);
  for (const query of ['', `receipt=${receipt}`, `receipt=bad&proof=${proof}`, `receipt=${receipt}&proof=bad`]) assert.equal((await h.send({}, query)).status, 401);
  assert.equal(h.calls.length, 0);
});
test('wrong, absent, and cross-receipt proofs cannot write; provider identity is bound', async () => {
  for (const row of [{ callback_token_hash: null }, { callback_token_hash: 'b'.repeat(64) }]) {
    const h = harness({ row }); assert.equal((await h.send()).status, 401); assert.equal(h.patches.length, 0);
  }
  const h = harness();
  assert.equal((await h.send({}, `receipt=${receipt}&proof=${'b'.repeat(64)}`)).status, 401);
  assert.equal((await h.send({ id: 'different-job' })).status, 409);
  assert.equal(h.patches.length, 0);
});
test('terminal capture excludes original input, signed URL, and unknown output fields', async () => {
  const h = harness(); const signed = 'https://private.invalid/source?token=secret';
  const result = await h.send({ input: { video_url: signed }, webhook: signed, output: { input: signed, source: signed, model: 'qwen', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: ' Analysis ', input: signed } }], usage: { prompt_tokens: 4, completion_tokens: 8 } }, delayTime: 10, executionTime: 20 });
  assert.deepEqual(result.body, { status: 'completed', saved: true });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(h.patches[0].analysis_text, 'Analysis'); assert.equal(h.patches[0].input_tokens, 4);
  assert.equal(h.patches[0].inference_ms, 20);
  assert.ok(!JSON.stringify(h.patches).includes(signed)); assert.ok(!JSON.stringify(result.body).includes(signed)); assert.deepEqual(h.logs, []);
  assert.ok(!('attachment_path' in h.patches[0])); assert.ok(!('actor_id' in h.patches[0]));
});
test('valid replay acknowledges terminal state without rewriting; invalid replay is rejected', async () => {
  const h = harness(); await h.send();
  assert.deepEqual((await h.send()).body, { status: 'completed', saved: true, already_terminal: true });
  assert.equal((await h.send({}, `receipt=${receipt}&proof=${'b'.repeat(64)}`)).status, 401);
  assert.equal((await h.send({ id: 'different-job' })).status, 409);
  assert.equal(h.patches.length, 1);
});
test('conditional patch handles concurrent terminal completion and fast callback before registration', async () => {
  const terminal = harness({ beforePatch: row => { row.status = 'completed'; } });
  assert.deepEqual((await terminal.send()).body, { status: 'completed', saved: true, already_terminal: true });
  assert.equal(terminal.patches.length, 1);
  const h = harness({ row: { runpod_job_id: null, status: 'pending' } });
  assert.equal((await h.send()).status, 200); assert.equal(h.row.runpod_job_id, 'provider-123');
});
test('all deployed terminal mappings, empty analysis, truncation and array output', async () => {
  for (const [state, status, error] of [['FAILED', 'failed', 'RUNPOD_FAILED'], ['CANCELLED', 'cancelled', null], ['TIMED_OUT', 'timed_out', null], ['COMPLETED', 'failed', 'COMPLETED_WITHOUT_ANALYSIS']]) {
    const h = harness(); await h.send({ status: state, output: {} });
    assert.equal(h.row.status, status); assert.equal(h.row.error_code, error);
  }
  const h = harness(); await h.send({ output: [{ choices: [{ message: { content: 'x'.repeat(250001) } }] }] });
  assert.equal(h.row.analysis_text.length, 250000);
  const active = harness(); assert.equal((await active.send({ status: 'IN_PROGRESS' })).status, 409); assert.equal(active.patches.length, 0);
});
test('invalid payload, size, unavailable storage and persistence failures fail closed', async () => {
  assert.equal((await harness().send({}, undefined, 'POST', '{')).body.error, 'invalid_payload');
  assert.equal((await harness().send({}, undefined, 'POST', 'x'.repeat(1000001))).status, 413);
  assert.equal((await harness().send({ id: 'bad' })).status, 400);
  assert.equal((await harness({ env: { SUPABASE_SERVICE_ROLE_KEY: '' } }).send()).status, 503);
  assert.equal((await harness({ lookup: [] }).send()).status, 404);
  assert.equal((await harness({ lookupStatus: 500 }).send()).body.error, 'job_lookup_failed');
  assert.equal((await harness({ saveStatus: 500 }).send()).body.error, 'persistence_failed');
  assert.equal((await harness({ env: { SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SECRET_KEYS: '{"default":"mock-secret"}' } }).send()).status, 200);
});
test('function configuration explicitly disables JWT only for proof-authenticated callback', () => {
  assert.match(readFileSync('supabase/config.toml', 'utf8'), /\[functions\.katie-runpod-result-webhook\]\s+verify_jwt = false/);
});

test('late authenticated callback can replace a local deadline, but not a provider timeout', async () => {
  for (const error_code of ['SUBMISSION_ACCEPTANCE_UNRESOLVED_DEADLINE', 'QWEN_FIFTEEN_MINUTE_DEADLINE', 'QWEN_DEADLINE_POLL_UNAVAILABLE']) {
    const h = harness({row: {status: 'timed_out', error_code, runpod_job_id: null}});
    assert.equal((await h.send()).body.status, 'completed');
    assert.equal(new URL(h.calls[1].url).searchParams.get('error_code'), 'eq.' + error_code);
  }
  const h = harness({row: {status: 'timed_out', error_code: 'RUNPOD_TIMED_OUT'}});
  assert.equal((await h.send()).body.already_terminal, true);
  assert.equal(h.patches.length, 0);
});

test('callback can recover a local 404 expiration without overwriting provider-terminal failure', async () => {
  const h = harness({row: {status: 'expired', error_code: 'RUNPOD_RESULT_EXPIRED_OR_NOT_FOUND'}});
  assert.equal((await h.send()).body.status, 'completed');
  assert.equal(new URL(h.calls[1].url).searchParams.get('error_code'), 'eq.RUNPOD_RESULT_EXPIRED_OR_NOT_FOUND');
});

test('callback retries registration and unresolved deadline transitions without losing analysis', async () => {
  for (const transition of [
    { status: 'queued', runpod_job_id: 'provider-123' },
    { status: 'timed_out', error_code: 'SUBMISSION_ACCEPTANCE_UNRESOLVED_DEADLINE' },
  ]) {
    const h = harness({ row: { status: 'pending', runpod_job_id: null },
      beforePatch: (row, attempt) => { if (attempt === 1) Object.assign(row, transition); } });
    assert.deepEqual((await h.send()).body, { status: 'completed', saved: true });
    assert.equal(h.patches.length, 2);
    assert.equal(h.row.analysis_text, 'Analysis');
    assert.equal(h.row.runpod_job_id, 'provider-123');
  }
});

test('conflicts are bounded and never falsely acknowledged', async () => {
  const h = harness({ race: true });
  const result = await h.send();
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: 'persistence_conflict' });
  assert.equal(h.patches.length, 3);
});

test('retry revalidates provider identity and callback proof', async () => {
  for (const [transition, status] of [
    [{ runpod_job_id: 'different-job', status: 'completed' }, 409],
    [{ callback_token_hash: 'b'.repeat(64), status: 'completed' }, 401],
  ]) {
    const h = harness({ beforePatch: row => Object.assign(row, transition) });
    assert.equal((await h.send()).status, status);
    assert.equal(h.patches.length, 1);
  }
});
test('synthetic callback provenance requires valid proof and matching identity, including poll-first races',async()=>{
  for(const status of ['queued','completed']) {
    const h=harness({row:{chat_request_id:'synthetic-wp4',actor_id:receipt,status}});
    assert.equal((await h.send()).status,200);
    assert.equal(h.calls.filter(c=>c.url.includes('/runpod_synthetic_validation?')).length,1);
  }
  for(const payload of [{id:'different-job'},{}]) {
    const h=harness({row:{chat_request_id:'synthetic-wp4',actor_id:receipt}});
    await h.send(payload,payload.id ? undefined : `receipt=${receipt}&proof=${'b'.repeat(64)}`);
    assert.equal(h.calls.filter(c=>c.url.includes('/runpod_synthetic_validation?')).length,0);
  }
  const h=harness({markerFailure:true,row:{chat_request_id:'synthetic-wp4',actor_id:receipt}});
  assert.equal((await h.send()).status,503);
  assert.equal(h.row.status,'completed'); // delivery result is retained for a callback retry
});

test('retest late expiry callback requires proof and binds only the new slot and actor',async()=>{
  const row={chat_request_id:'synthetic-wp4-retest',actor_id:receipt,status:'expired',error_code:'RUNPOD_RESULT_EXPIRED_OR_NOT_FOUND'};
  const h=harness({row});assert.equal((await h.send()).status,200);
  assert.equal(h.row.status,'completed');
  assert.equal(h.calls.filter(c=>c.url.includes('/runpod_synthetic_validation?')).length,1);
  const wrong=harness({row:{...row,callback_token_hash:'b'.repeat(64)}});
  assert.equal((await wrong.send()).status,401);assert.equal(wrong.patches.length,0);
  const cleaned=harness({row,markerFailure:true});assert.equal((await cleaned.send()).status,503);
});
