import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import mammoth from 'mammoth';
import sharp from 'sharp';
import { launchWebsiteBrowser } from '../lib/research/website-evidence';
import { qualifyDocument, QUALIFIED_PAGES } from '../lib/documents/qualification';
import { contentText, documentSchema, normalizedText, parseDocument } from '../lib/documents/model';
import { documentRequest, answeredDocumentRequest } from '../lib/documents/intent';
import { createDocumentStore, hash, documentLinks } from '../lib/documents/storage';
import { createDocumentDownload } from '../lib/documents/download';
import { produceDocument } from '../lib/documents/production';
import { generateDocx } from '../lib/documents/generate';
import { renderDocument } from '../lib/documents/render';
import { deliverDocument } from '../lib/documents/service';
import { getAccountingScope, runWithStandaloneAccounting } from '../lib/standalone-accounting/context';
import type { LlmProvider } from '../lib/providers/types';

const fixture = documentSchema.parse(JSON.parse(readFileSync('fixtures/documents/executive-resume.json', 'utf8')));
const scope = { ownerId: '11111111-1111-4111-8111-111111111111', actorId: '22222222-2222-4222-8222-222222222222', chatId: '33333333-3333-4333-8333-333333333333', requestId: 'fixture-request' };
const other = '44444444-4444-4444-8444-444444444444';
function storageFixture() {
  const files = new Map<string, Blob>(); let fail = false, publicBucket = false;
  return { files, fail: () => { fail = true; }, expose: () => { publicBucket = true; },
    storage: {
      getBucket: async () => ({ data: { public: publicBucket }, error: null }),
      createBucket: async () => ({ data: {}, error: null }),
      from: () => ({
        upload: async (path: string, body: Uint8Array, options: { contentType: string }) => {
          if (fail || files.has(path)) return { error: { message: 'upload rejected' } };
          files.set(path, new Blob([new Uint8Array(body)], { type: options.contentType })); return { error: null };
        },
        download: async (path: string) => ({ data: files.get(path) ?? null, error: files.has(path) ? null : { message: 'missing' } }),
      }),
    } as unknown as Parameters<typeof createDocumentStore>[0],
  };
}

test('document routing is explicit and ordinary text requests remain inert', () => {
  assert.deepEqual(documentRequest('Produce a professionally formatted two-page Word document and PDF'), { pages: 2 });
  assert.deepEqual(documentRequest('Create a summary of this PDF as a Word document'), {});
  for (const value of ['Hello Katie', 'Explain how PDF works', 'Review this PDF', "Don't create a PDF", 'Create a cash forecast in chat',
    'Summarize this PDF and give me the key risks', 'Review the attached PDF and make recommendations', 'Explain how to create a PDF', 'Make recommendations about the PDF']) assert.equal(documentRequest(value), null, value);
  const route = readFileSync('app/api/chat/route.ts', 'utf8');
  assert.match(route, /if \(reviewMode === "always" \|\| documentProduction\) return/);
  assert.match(route, /if \(documentProduction && !reviewHasPendingClarification\)/);
  assert.match(route, /await import\('@\/lib\/documents\/service'\)/);
  assert.match(route, /documentProduction \? DOCUMENT_REVIEW_GUIDANCE/);
  assert.match(route, /documentRequest\(savedDraftReviewTask\(pendingReviewClarification.pending\)/);
  const progress = { lastUserIntent: 'answer', objective: { text: 'Create a two-page Word document', userMessageId: 'task' }, answered: [{ taskId: 'task', userMessageId: 'current' }] };
  assert.deepEqual(answeredDocumentRequest(progress, 'current'), { pages: 2 });
  assert.equal(answeredDocumentRequest(progress, 'unrelated'), null);
  assert.equal(answeredDocumentRequest({ ...progress, lastUserIntent: 'new_task' }, 'current'), null);
});

test('specialist delivery inspects actual pages inside accounting scope and stops at an approval block', { timeout: 120000 }, async () => {
  const files = new Map<string, Buffer>(); let uploads = 0, visualCalls = 0, rejectInspection = true;
  const storageServer = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://local').pathname;
    response.setHeader('content-type', 'application/json');
    if (path === '/storage/v1/bucket/katie-attachments') { response.end(JSON.stringify({ id: 'katie-attachments', name: 'katie-attachments', public: false })); return; }
    const key = path.replace(/^\/storage\/v1\/object\/(?:authenticated\/)?katie-attachments\//, '');
    if (request.method === 'POST' && path.startsWith('/storage/v1/object/')) {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (files.has(key)) { response.writeHead(409); response.end(JSON.stringify({ error: 'duplicate' })); return; }
      uploads++; files.set(key, Buffer.concat(chunks)); response.end(JSON.stringify({ Key: key })); return;
    }
    if (files.has(key)) { response.setHeader('content-type', 'application/octet-stream'); response.end(files.get(key)); return; }
    response.writeHead(404); response.end(JSON.stringify({ error: 'missing' }));
  }).listen(0, '127.0.0.1');
  await once(storageServer, 'listening'); const address = storageServer.address(); assert.ok(address && typeof address !== 'string');
  const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL, oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${address.port}`; process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-role';
  const blocked = Object.assign(new Error('Fixture approval required'), { code: 'standalone_approval_required' });
  const provider: LlmProvider = { name: 'anthropic', listModels: async () => ['fixture-model'], generate: async params => {
    visualCalls++;
    const accounting = getAccountingScope(); assert.equal(accounting?.kind, 'standalone');
    if (accounting?.kind !== 'standalone') throw new Error('missing accounting');
    assert.equal(accounting.context.userId, scope.ownerId); assert.equal(accounting.context.actorId, scope.actorId);
    assert.match(accounting.context.activity!, /^document-visual-/);
    assert.deepEqual(params.images?.map(image => hash(Buffer.from(image.split(',')[1], 'base64'))), QUALIFIED_PAGES);
    assert.equal(params.history.length, 0); assert.equal(params.summary, '');
    if (rejectInspection) throw blocked;
    return { provider: 'anthropic', model: 'fixture-model', text: JSON.stringify({ pages: QUALIFIED_PAGES.map((_, i) => ({ page: i + 1, verdict: 'pass', repair: 'none', observations: 'Raster bytes exactly match the independently reviewed synthetic fixture baseline.' })) }) };
  } };
  const markdown = fixture.blocks.map(block => block.kind === 'heading' ? '#'.repeat(block.level) + ' ' + block.text : block.kind === 'bullet' ? '- ' + block.text : block.kind === 'paragraph' ? block.text : '').join('\n\n');
  const input = { result: { provider: 'anthropic' as const, model: 'fixture-model', text: markdown }, provider,
    params: { name: 'BTG Application Specialist', persona: '', summary: '', history: [], user: 'Produce a two-page Word document and PDF', modelId: 'fixture-model' },
    actorId: scope.actorId, chatId: scope.chatId, requestId: scope.requestId, targetPages: 2, deadlineMs: Date.now() + 100000 };
  try {
    await assert.rejects(deliverDocument(input), /authorized conversation/);
    const context = { userId: scope.ownerId, actorId: scope.actorId, chatId: scope.chatId, requestId: scope.requestId };
    await assert.rejects(runWithStandaloneAccounting(context, () => deliverDocument(input)), error => error === blocked);
    assert.equal(uploads, 0, 'approval block cannot upload or publish files');
    rejectInspection = false;
    const result = await runWithStandaloneAccounting(context, () => deliverDocument(input));
    assert.match(result.text, /Created and inspected 2 pages/); assert.match(result.text, /format=docx/); assert.match(result.text, /format=pdf/);
    assert.equal(uploads, 3); assert.equal(visualCalls, 2);
    assert.ok([...files.keys()].every(path => path.startsWith(`chats/${scope.chatId}/document-`)));
  } finally {
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
    await new Promise<void>((resolve, reject) => storageServer.close(error => error ? reject(error) : resolve()));
  }
});

test('bounded document grammar preserves supplied content and rejects executable layouts', () => {
  const doc = parseDocument('# Jordan Avery\n\n## Experience\n- Improved **monthly reporting**.\n\n| Measure | Value |\n| --- | --- |\n| Years | 10 |', 2);
  assert.equal(contentText(doc), 'Jordan Avery\nExperience\nImproved monthly reporting.\nMeasure Value Years 10');
  assert.throws(() => parseDocument('```html\n<script>x</script>\n```'));
  assert.throws(() => parseDocument('# Title', 99));
});

test('real two-page DOCX/PDF request, rendering, inspection, correction and secure HTTP delivery', { timeout: 120000 }, async () => {
  const browser = await launchWebsiteBrowser();
  try {
    const produced = await qualifyDocument(browser, Date.now() + 90000);
    assert.equal(produced.inspection.pageCount, 2);
    assert.deepEqual(produced.inspection.findings, []);
    assert.equal(produced.inspection.visual, 'passed');
    assert.equal(produced.corrections, 1);
    assert.ok(produced.attempts[0].findings.some(f => f.rule === 'overflow'));
    assert.deepEqual(produced.images.map(hash), QUALIFIED_PAGES);
    const extracted = await (mammoth.extractRawText as unknown as (input: { buffer: Buffer }) => Promise<{ value: string }>)({ buffer: produced.docx });
    assert.equal(normalizedText(extracted.value), normalizedText(contentText(fixture)));
    assert.equal(normalizedText(produced.inspection.extractedText), normalizedText(contentText(fixture)));
    for (const image of produced.images) {
      const metadata = await sharp(image).metadata(); assert.equal(metadata.format, 'png');
      assert.equal(metadata.width, 918); assert.equal(metadata.height, 1188);
    }
    mkdirSync('test-artifacts/documents', { recursive: true });
    writeFileSync('test-artifacts/documents/executive-resume.docx', produced.docx);
    writeFileSync('test-artifacts/documents/executive-resume.pdf', produced.pdf);
    produced.images.forEach((bytes, i) => writeFileSync(`test-artifacts/documents/page-${i + 1}.png`, bytes));
    writeFileSync('test-artifacts/documents/inspection.json', JSON.stringify({ inspection: produced.inspection, attempts: produced.attempts }, null, 2));

    const fixtureStorage = storageFixture(), store = createDocumentStore(fixtureStorage.storage);
    const receipt = await store.save(scope, produced, produced.inspection, produced.corrections);
    assert.deepEqual(await store.save(scope, produced, produced.inspection, produced.corrections), receipt, 'same validated artifact reuses receipt');
    assert.match(documentLinks(receipt), /Download Word document/);
    const download = createDocumentDownload({
      authenticate: async request => { if (request.headers.get('authorization') !== 'Bearer fixture-session') throw new Error('unauthenticated'); return { id: scope.ownerId, isAnonymous: true }; },
      authorize: async (_request, actorId, chatId) => { if (actorId !== scope.actorId || chatId !== scope.chatId) throw new Error('not owned'); },
      chat: async chatId => chatId === scope.chatId ? { actorId: scope.actorId } : null,
      store: () => store,
    });
    const server = createServer(async (request, response) => {
      const answer = await download(new Request(`http://localhost${request.url}`, { headers: { authorization: request.headers.authorization ?? '' } }));
      response.writeHead(answer.status, Object.fromEntries(answer.headers)); response.end(Buffer.from(await answer.arrayBuffer()));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/documents/download?actorId=${scope.actorId}&chatId=${scope.chatId}&id=${receipt.id}`;
    try {
      for (const format of ['docx', 'pdf'] as const) {
        const response = await fetch(`${base}&format=${format}`, { headers: { authorization: 'Bearer fixture-session' } });
        assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), receipt.files[format].mime);
        assert.match(response.headers.get('content-disposition')!, new RegExp(`document\\.${format}`));
        assert.match(response.headers.get('cache-control')!, /no-store/);
        assert.equal(hash(Buffer.from(await response.arrayBuffer())), receipt.files[format].sha256);
      }
      assert.equal((await fetch(`${base}&format=pdf`)).status, 403);
      assert.equal((await fetch(`${base.replace(scope.actorId, other)}&format=pdf`, { headers: { authorization: 'Bearer fixture-session' } })).status, 403);
      assert.equal((await fetch(`${base.replace(scope.chatId, other)}&format=pdf`, { headers: { authorization: 'Bearer fixture-session' } })).status, 403);
      await assert.rejects(store.read({ ...scope, ownerId: other }, receipt.id, 'pdf'), /access denied/);
      await assert.rejects(store.read({ ...scope, actorId: other }, receipt.id, 'pdf'), /access denied/);
      fixtureStorage.files.set(`chats/${scope.chatId}/document-${receipt.id}.pdf`, new Blob(['corrupt']));
      assert.equal((await fetch(`${base}&format=pdf`, { headers: { authorization: 'Bearer fixture-session' } })).status, 403);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    const failed = storageFixture(); failed.fail();
    await assert.rejects(createDocumentStore(failed.storage).save(scope, produced, produced.inspection, produced.corrections), /upload failed/);
    const exposed = storageFixture(); exposed.expose();
    await assert.rejects(createDocumentStore(exposed.storage).save(scope, produced, produced.inspection, produced.corrections), /Private/);
    await assert.rejects(store.save(scope, produced, { ...produced.inspection, visual: 'pending' }, 1), /Unvalidated/);
  } finally { await browser.close(); }
});

test('real renderer supports tables and fails closed on missing visual coverage', { timeout: 90000 }, async () => {
  const browser = await launchWebsiteBrowser();
  try {
    const spec = parseDocument('# Operating Review\n\nA concise operating summary.\n\n| Measure | Value |\n| --- | --- |\n| Collections | 100 |\n| Payments | 80 |', 1);
    const docx = await generateDocx(spec, { pages: [spec.blocks.map((_, i) => i)], spacing: 4 });
    const rendered = await renderDocument(browser, docx, spec);
    assert.equal(rendered.inspection.pageCount, 1);
    assert.deepEqual(rendered.inspection.findings, []);
    await assert.rejects(produceDocument({ spec, browser, deadlineMs: Date.now() + 45000, inspect: async () => ({ pages: [] }) }));
    await assert.rejects(produceDocument({ spec: { ...fixture, targetPages: 1 }, browser, deadlineMs: Date.now() + 45000, inspect: async () => { throw new Error('must never reach vision'); } }), /cannot fit/);
  } finally { await browser.close(); }
});
