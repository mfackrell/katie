import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import mammoth from 'mammoth';
import sharp from 'sharp';
import { launchWebsiteBrowser } from '../lib/research/website-evidence';
import { qualifyDocument, QUALIFIED_PAGES } from '../lib/documents/qualification';
import { contentText, documentSchema, normalizedText, parseDocument, pdfTextMatchesSource } from '../lib/documents/model';
import { documentRequest, answeredDocumentRequest, isDocumentCapabilityDenial, SAVED_DOCUMENT_EXPORT_PROMPT } from '../lib/documents/intent';
import { savedDocumentContent } from '../lib/documents/saved-source';
import { createDocumentStore, hash, documentLinks } from '../lib/documents/storage';
import { createDocumentDownload } from '../lib/documents/download';
import { resolveDocumentDownload } from '../lib/documents/client-download';
import { produceDocument, shouldStopForReadingOrder, shouldTryCompactLayout } from '../lib/documents/production';
import { generateDocx, paginate, DocumentPageFitError, documentPageStyle } from '../lib/documents/generate';
import { renderDocument } from '../lib/documents/render';
import { deliverDocument } from '../lib/documents/service';
import { isLikelyProviderRefusal, runWithRefusalFallback } from '../lib/router/refusal-detection';
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

test('PDF.js EOL fragment alignment preserves exact ordered glyphs', () => {
  const joined = (parts: Array<{str:string;hasEOL:boolean}>) =>
    parts.map(part=>part.str+(part.hasEOL ? '\n' : '')).join('');

  const source = 'Led financial forecasting across teams.';
  const wrapped = [
    { str: 'Led finan', hasEOL: true },
    { str: 'cial forecasting', hasEOL: true },
    { str: 'across teams.', hasEOL: false },
  ];
  assert.equal(pdfTextMatchesSource(joined(wrapped), source), false,
    'The old string-only check cannot distinguish artificial line breaks from word spaces.');
  assert.equal(pdfTextMatchesSource(joined(wrapped), source, wrapped), true);

  const wrappedHyphen = [
    { str: 'Led family-', hasEOL: true },
    { str: 'owned financial', hasEOL: true },
    { str: 'reporting.', hasEOL: false },
  ];
  assert.equal(pdfTextMatchesSource(joined(wrappedHyphen),
    'Led family-owned financial reporting.', wrappedHyphen), true);

  const listSource = 'Experience\nManaged budgets\nReduced expenses.';
  const bullets = [
    { str: 'Experience', hasEOL: true },
    { str: '• Managed budgets', hasEOL: true },
    { str: '• Reduced expenses.', hasEOL: false },
  ];
  assert.equal(pdfTextMatchesSource(joined(bullets), listSource, bullets), true);

  const invalid = [
    {str:'Led finan',hasEOL:true},
    {str:'cial forecasts',hasEOL:true},
    {str:'across teams.',hasEOL:false},
  ];
  assert.equal(pdfTextMatchesSource(joined(invalid), source, invalid), false,
    'Changed letters fail even when only PDF line endings differ.');
  const unsupportedWhitespace = [{str:'Led finan cial forecasting across teams.',hasEOL:false}];
  assert.equal(pdfTextMatchesSource(joined(unsupportedWhitespace), source, unsupportedWhitespace), false,
    'An arbitrary inserted space is not an EOL artifact.');
  const missing = [{str:'Led financial forecasting teams.',hasEOL:false}];
  assert.equal(pdfTextMatchesSource(joined(missing), source, missing), false);
  const reordered = [{str:'Financial led forecasting across teams.',hasEOL:false}];
  assert.equal(pdfTextMatchesSource(joined(reordered), source, reordered), false);
  const duplicated = [{str:'Led financial financial forecasting across teams.',hasEOL:false}];
  assert.equal(pdfTextMatchesSource(joined(duplicated), source, duplicated), false);

  const renderCode = readFileSync('lib/documents/render.ts','utf8');
  assert.match(renderCode,/pdfTextMatchesSource\(raster\.text, contentText\(spec\), raster\.fragments\)/);
  assert.match(renderCode,/hasEOL:Boolean\(item\.hasEOL\)/);
  assert.match(renderCode,/sameOrderedGlyphs/);
});

test('PDF line-wrap hyphen extraction does not falsely fail ATS text fidelity', () => {
  const source = 'Led a family-owned business with e-commerce and multi-entity reporting.';
  const pdfExtract = 'Led a family-\nowned business with e-\ncommerce and multi-entity reporting.';
  assert.equal(pdfTextMatchesSource(pdfExtract, source), true);
  assert.equal(pdfTextMatchesSource(source, source), true);
  assert.equal(pdfTextMatchesSource('Led a family-owned business with e-commerce.', source), false, 'missing words remain fatal');
  assert.equal(pdfTextMatchesSource('Led a family-owned company with e-commerce and multi-entity reporting.', source), false, 'changed content remains fatal');
  assert.equal(pdfTextMatchesSource('Led an e-commerce business with family-owned and multi-entity reporting.', source), false, 'reordering remains fatal');
});

test('authenticated document links are same-origin, strictly scoped and format-checked', () => {
  const actor='22222222-2222-4222-8222-222222222222';
  const chat='33333333-3333-4333-8333-333333333333';
  const receipt='a'.repeat(64);
  const origin='https://katie.example.test';
  const url='/api/documents/download?actorId='+actor+'&chatId='+chat+'&id='+receipt+'&format=pdf';
  const pdf=resolveDocumentDownload(url,origin);
  assert.equal(pdf?.filename,'document.pdf');
  assert.equal(pdf?.mime,'application/pdf');
  assert.equal(pdf?.path,url);
  const docx=resolveDocumentDownload(url.replace('format=pdf','format=docx'),origin);
  assert.equal(docx?.filename,'document.docx');
  assert.equal(docx?.mime,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  for(const href of [
    'https://attacker.example/api/documents/download?'+url.split('?')[1],
    '//attacker.example/api/documents/download?'+url.split('?')[1],
    url.replace('format=pdf','format=zip'),
    url+'&format=pdf',
    url+'&ownerId=attacker',
    url+'#fragment',
    url.replace(receipt,'abc'),
    url.replace(actor,'not-a-uuid'),
    '/api/documents/qualification?'+url.split('?')[1],
  ]) assert.equal(resolveDocumentDownload(href,origin),null,href);
  // A plain browser navigation cannot attach the owner's bearer header.
  // The Markdown link must use the explicit authenticated client download.
  const renderer=readFileSync('components/assistant-markdown.tsx','utf8');
  assert.match(renderer,/ownerSessionBearer/);
  assert.match(renderer,/credentials:"same-origin"/);
  assert.match(renderer,/redirect:"error"/);
  assert.match(renderer,/resolveDocumentDownload\(href,window\.location\.origin\)/);
  assert.doesNotMatch(renderer,/location\.href\s*=\s*.*token/);
});

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

test('initial overfull pagination may retry once, but final PDF fidelity always fails closed', () => {
  const reading = { rule: 'reading-order' as const, page: 0, detail: 'Mismatch' };
  const overflow = { rule: 'overflow' as const, page: 1, detail: 'First page clipped' };
  const pageCount = { rule: 'page-count' as const, page: 0, detail: 'Too many pages' };
  const whitespace = { rule: 'whitespace' as const, page: 1, detail: 'Empty' };
  assert.equal(shouldStopForReadingOrder([reading], 0), true, 'never accept an otherwise clean PDF with mismatched text');
  assert.equal(shouldStopForReadingOrder([reading, whitespace], 0), true, 'whitespace alone cannot excuse a fidelity mismatch');
  assert.equal(shouldStopForReadingOrder([reading, overflow], 0), false, 'first pass can repaginate clipped text');
  assert.equal(shouldStopForReadingOrder([reading, pageCount], 0), false, 'first pass can repaginate incorrect page count');
  assert.equal(shouldStopForReadingOrder([reading, overflow], 1), true, 'mismatch after repair must stop delivery');
  assert.equal(shouldStopForReadingOrder([overflow], 0), false);
  assert.equal(shouldStopForReadingOrder([], 1), false);
});

test('two-page 11pt compact layout preserves content when standard pagination cannot fit', async () => {
  // 50 blocks whose measured heights exceed standard two-page capacity,
  // but fit within two 0.5-inch-margin compact pages without changing type size.
  const spec = documentSchema.parse({
    title: 'Anonymous layout stress fixture', targetPages: 2,
    blocks: Array.from({ length: 50 }, (_, i) => ({ kind: 'paragraph' as const, text: `Synthetic financial reporting line ${i + 1}.` })),
  });
  const heights = Array(50).fill(37.3);
  assert.throws(() => paginate(spec, heights, 2, 4), DocumentPageFitError);
  const compact = paginate(spec, heights, 2, 2, true);
  assert.deepEqual(compact.pages.map(p => p.length), [25, 25]);
  assert.deepEqual(compact.pages.flat(), spec.blocks.map((_, i) => i));
  assert.equal(documentPageStyle(compact).lineTwips, 240);
  assert.equal(documentPageStyle(compact).margin, 36);
  assert.equal(shouldTryCompactLayout(new DocumentPageFitError(2), 0, spec, { pages: [spec.blocks.map((_, i) => i)], spacing: 4 }), true);
  assert.equal(shouldTryCompactLayout(new DocumentPageFitError(2), 1, spec, compact), false);
  assert.equal(shouldTryCompactLayout(new DocumentPageFitError(2), 0, { ...spec, targetPages: 3 }, compact), false);
  const reading = { rule: 'reading-order' as const, page: 0, detail: 'Unfinished first-page measurement' };
  const overflow = { rule: 'overflow' as const, page: 1, detail: 'Overfull measuring page' };
  assert.equal(shouldStopForReadingOrder([reading, overflow], 1, true), false);
  assert.equal(shouldStopForReadingOrder([reading], 1, true), true);
  // Confirm that the real DOCX/PDF renderer honors the compact margins, not
  // just the pagination arithmetic. The source text remains unchanged.
  const small = parseDocument('# Financial report\n\n- Reviewed reconciliations and improved cash forecasting.', 1);
  const layout = { pages: [small.blocks.map((_, i) => i)], spacing: 2, compact: true as const };
  const browser = await launchWebsiteBrowser();
  try {
    const bytes = await generateDocx(small, layout);
    const rendered = await renderDocument(browser, bytes, small, layout);
    assert.equal(rendered.inspection.pageCount, 1);
    assert.deepEqual(rendered.inspection.findings, []);
    assert.equal(normalizedText(rendered.inspection.extractedText), normalizedText(contentText(small)));
  } finally { await browser.close(); }
});

test('anonymous 850-word resume-shaped fixture completes genuine two-page production without dropping blocks', { timeout: 120000 }, async () => {
  // Block shapes and sizes mirror a challenging two-page executive resume.
  // Synthetic words only: no private resumes or user text in tests/artifacts.
  const shape: Array<[number, number, number]> = [
    [1,13,2],[0,65,8],[2,7,1],[0,557,76],[2,80,9],[0,75,8],[0,71,9],
    [-1,231,32],[-1,181,21],[-1,100,14],[-1,180,27],[-1,283,38],
    [0,75,8],[0,65,11],[-1,147,25],[-1,134,19],[-1,158,25],[-1,166,16],
    [0,37,5],[0,34,5],[-1,121,17],[-1,108,14],[-1,198,21],
    [0,84,10],[0,38,4],[-1,127,19],[-1,192,20],[2,30,3],
    [0,83,13],[0,350,37],[-1,262,28],[-1,152,19],[-1,258,34],
    [-1,144,14],[-1,177,21],[-1,190,22],[2,28,5],[0,54,10],
    [-1,142,16],[0,89,14],[-1,199,24],[-1,101,16],
    [0,44,8],[-1,194,25],[0,83,14],[-1,159,18],
    [2,9,1],[0,22,3],[0,83,10],
  ];
  const syntheticWords = (chars: number, count: number) => {
    const letters = chars - count + 1, perWord = Math.floor(letters / count), rest = letters % count;
    return Array.from({ length: count }, (_, i) => {
      const size = perWord + (i < rest ? 1 : 0);
      const stem = ['management', 'forecasting', 'accounting', 'operations', 'financial'][i % 5];
      return stem.repeat(Math.ceil(size / stem.length)).slice(0, size);
    }).join(' ');
  };
  const spec = documentSchema.parse({
    title: 'Synthetic executive resume', targetPages: 2,
    blocks: shape.map(([kind, chars, words]) => ({
      ...(kind > 0 ? { kind: 'heading' as const, level: kind as 1 | 2 } :
        kind < 0 ? { kind: 'bullet' as const } : { kind: 'paragraph' as const }),
      text: syntheticWords(chars, words),
    })),
  });
  assert.equal(spec.blocks.length, 49);
  assert.ok(contentText(spec).split(/\s+/).length >= 800);
  const browser = await launchWebsiteBrowser();
  try {
    const produced = await produceDocument({ spec, browser, deadlineMs: Date.now() + 110000,
      inspect: async rendered => ({ pages: rendered.images.map((_, i) => ({
        page: i + 1, verdict: 'pass' as const, repair: 'none' as const,
        observations: 'Synthetic raster inspected by the deterministic acceptance fixture.' })) }),
    });
    assert.equal(produced.inspection.pageCount, 2);
    assert.deepEqual(produced.inspection.findings, []);
    assert.equal(produced.inspection.visual, 'passed');
    assert.equal(normalizedText(produced.inspection.extractedText), normalizedText(contentText(spec)));
    assert.ok(produced.corrections <= 3);
  } finally { await browser.close(); }
});

test('explicit saved source export preserves approved document text without a drafting model', () => {
  assert.deepEqual(documentRequest(SAVED_DOCUMENT_EXPORT_PROMPT),{});
  const resume='# Executive resume\n\n## Experience\n- Restructured finance and improved reporting.';
  const editorial='\n\n---\n\n**Changes made:** Reviewer notes are not document content.';
  assert.equal(savedDocumentContent({role:'assistant',content:resume+editorial}),resume);
  assert.equal(savedDocumentContent({role:'assistant',content:resume}),resume);
  assert.throws(()=>savedDocumentContent({role:'user',content:resume}),/Select a saved assistant/);
  assert.throws(()=>savedDocumentContent({role:'assistant',content:'Katie could not complete this request.'}),/not a usable/);
  assert.throws(()=>savedDocumentContent({role:'assistant',content:"I cannot create, render, or deliver Word and PDF files."}),/not a usable/);
  // Inspect actual chat wiring: explicit message ID, actor/chat-scoped DB lookup,
  // and no provider.generate for draft text in the selected-source branch.
  const route=readFileSync('app/api/chat/route.ts','utf8');
  const panel=readFileSync('components/chat-panel.tsx','utf8');
  assert.match(route,/documentSourceMessageId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
  assert.match(route,/getMessageById\(chatId,documentSourceMessageId\)/);
  assert.match(route,/selectedDocumentSource=savedDocumentContent\(original\)/);
  assert.match(route,/selectedDocumentSource\s*\?\s*\{provider:provider\.name, model:modelId, text:selectedDocumentSource\}\s*:\s*await provider\.generate\(finalParams\)/);
  assert.match(route,/!pendingVideoAssistantMessageId && !selectedDocumentSource/);
  assert.match(route,/selectedDocumentSource \? false/);
  assert.match(panel,/documentSourceMessageId,/);
  assert.match(panel,/setInput\(SAVED_DOCUMENT_EXPORT_PROMPT\)/);
  assert.match(panel,/Export this saved response as Word and PDF/);
});

test('document capability disclaimers reroute before rendering and never become document text', async () => {
  const disclaimer = "I can't create, render, or download actual Word or PDF files. That's outside my technical capabilities.\n\nHere are manual options.";
  assert.equal(isDocumentCapabilityDenial(disclaimer), true);
  // Exact shape of the Nov 2 production failure (request 0be4ad18):
  // metadata preceded the refusal, causing the earlier anchored check to miss.
  const timestamped = '[Message timestamp: 2026-10-31T22:04:12.509Z]\n\nI cannot create, generate, render, inspect or deliver actual Word documents, PDFs, or download links.\n\nI am a text-based AI without file tools.';
  assert.equal(isDocumentCapabilityDenial(timestamped), true);
  assert.equal(isDocumentCapabilityDenial('[Timestamp: 2026-11-02T13:24:40Z]\n\n' + disclaimer), true);
  assert.equal(isDocumentCapabilityDenial('[Generated at: 2026-11-02T13:24:40Z]\n\n' + disclaimer), true);
  assert.equal(isDocumentCapabilityDenial('[Message timestamp: 2026-11-02T13:24:40Z]\n\n# Executive Summary\n\n- Accurate source facts.'), false);
  assert.equal(isDocumentCapabilityDenial('[Message timestamp: 2026-11-02T13:24:40Z]\n\nI cannot create prohibited or unsafe PDF materials.'), false);
  assert.equal(isDocumentCapabilityDenial('Sorry, I cannot generate Word documents because I have no file tools.'), true);
  assert.equal(isDocumentCapabilityDenial('As a text-based AI, I cannot produce a PDF document myself.'), true);
  assert.equal(isDocumentCapabilityDenial('# Memo\n\nI cannot create the documents until compliance approves the records.'), false);
  assert.equal(isDocumentCapabilityDenial('CLARIFICATION_REQUIRED: Which version should I use?'), false);
  assert.equal(isDocumentCapabilityDenial('# Executive Summary\n\n- Reduced costs.'), false);
  assert.equal(isDocumentCapabilityDenial('I cannot create prohibited or unsafe PDF materials.'), false);
  const routes = readFileSync('app/api/chat/route.ts','utf8');
  assert.match(routes, /Boolean\(documentProduction\) && isDocumentCapabilityDenial\(generationResult.text/);
  const calls: string[] = [];
  const selected = await runWithRefusalFallback({
    attempts: ['initial', 'alternate'], shouldRetryRefusal: true,
    runAttempt: async candidate => {
      calls.push(candidate);
      return { provider: 'anthropic', model: candidate, text: candidate === 'initial' ? timestamped : '# Executive Summary\n\n- Produced accurate reporting.' };
    },
    detectRefusal: reply => isDocumentCapabilityDenial(reply.text) || isLikelyProviderRefusal(reply, reply.provider),
  });
  assert.deepEqual(calls, ['initial','alternate']);
  assert.match(selected.result.text, /Executive Summary/);
  const context = { userId: scope.ownerId, actorId: scope.actorId, chatId: scope.chatId, requestId: scope.requestId };
  await assert.rejects(runWithStandaloneAccounting(context, () => deliverDocument({
    result: { provider: 'anthropic', model: 'refusal', text: timestamped },
    provider: { name: 'anthropic', listModels: async()=>[], generate: async()=>{ throw new Error('Should not call a paid model'); } },
    params: { name: 'Document specialist', persona: '', summary: '', history: [], user: 'Produce a Word file', modelId: 'refusal' },
    actorId: scope.actorId, chatId: scope.chatId, requestId: scope.requestId,
    deadlineMs: Date.now()+30_000,
  })), /did not supply document content/);
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
