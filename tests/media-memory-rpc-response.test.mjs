import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';

function loadModule(path, values = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, console, AbortController, setTimeout, clearTimeout, performance, ...values });
  return exports;
}
function client(response) {
  const calls = [];
  const admin = loadModule('lib/data/supabase/admin.ts', {
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://database.invalid', SUPABASE_SERVICE_ROLE_KEY: 'offline-only' } },
    URL,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return response(calls.length);
    },
  });
  return { admin, calls };
}

test('actual admin RPC client accepts HTTP 204 from a void database function', async () => {
  const h = client(() => new Response(null, { status: 204 }));
  const result = await h.admin.getSupabaseAdminClient().rpc('save_media_evidence', {});
  assert.equal(result.error, null);
  assert.equal(result.data, null);
  assert.equal(h.calls.length, 1);
});
test('successful empty RPC bodies are not JSON errors', async () => {
  for (const body of ['', ' \n\t']) {
    const h = client(() => new Response(body, { status: 200 }));
    const result = await h.admin.getSupabaseAdminClient().rpc('save_media_evidence', {});
    assert.equal(result.error, null);
    assert.equal(result.data, null);
  }
});
test('normal JSON RPC results retain arrays, objects, scalars and null', async () => {
  for (const expected of [[], [{ body: 'saved evidence' }], { indexed: 3 }, 0, false, null]) {
    const h = client(() => Response.json(expected));
    const result = await h.admin.getSupabaseAdminClient().rpc('search_media_evidence', {});
    assert.equal(result.error, null);
    assert.equal(JSON.stringify(result.data), JSON.stringify(expected));
  }
});
test('RPC HTTP errors, malformed nonempty JSON, and network failures remain failures', async () => {
  for (const response of [
    () => new Response('database unavailable', { status: 503 }),
    () => new Response('not-json', { status: 200 }),
    () => { throw new Error('network unavailable'); },
  ]) {
    const h = client(response);
    const result = await h.admin.getSupabaseAdminClient().rpc('save_media_evidence', {});
    assert.equal(result.data, null);
    assert.ok(result.error?.message);
  }
});
test('actual media indexer continues from discovery through complete text and all chunks after void RPC success', async () => {
  const h = client(() => new Response(null, { status: 204 }));
  const evidence = loadModule('lib/media-memory/evidence.ts', {
    require: name => {
      if (name === '@/lib/data/supabase/admin') return h.admin;
      if (name === 'node:crypto') return crypto;
      throw new Error(`Unexpected runtime dependency: ${name}`);
    },
  });
  await evidence.indexReference({ actorId: 'actor', chatId: 'chat', id: 'attachment',
    fileName: 'report.txt', mimeType: 'text/plain', observedSummary: 'Discovery summary',
    summaryCoverage: 'sampled', summaryModel: 'saved-model', createdAt: '2026-10-14T00:00:00Z',
  }, {
    extractedText: 'Complete source text with distinctive checkout evidence',
    extractionCoverage: 'full',
    extractedChunks: [{ index: 0, text: 'First canonical part' }, { index: 1, text: 'Final canonical part' }],
  });
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.calls.map(call => call.body.p_text), [
    'Discovery summary', 'Complete source text with distinctive checkout evidence',
    'First canonical part', 'Final canonical part',
  ]);
  assert.deepEqual(h.calls.map(call => call.body.p_version), ['saved-model', 'text-v1', 'chunk-v1:0', 'chunk-v1:1']);
  assert.ok(h.calls.every(call => call.url.endsWith('/rpc/save_media_evidence')));
});
