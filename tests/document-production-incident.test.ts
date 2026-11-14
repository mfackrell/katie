import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  documentRequest, retainedPdfExportFileId, retainedPdfDualFormatFileId, sourcePreservingPdfExportRequest,
  retainedPdfDualFormatRequest, requiresProfessionalDocumentAcceptance,
} from '../lib/documents/intent';
import { resolveDurableDocumentRequest } from '../lib/documents/continuity';
import { parseDocument } from '../lib/documents/model';
import { DEFAULT_DESIGN, designAssessmentSchema, proposeDesignLayout } from '../lib/documents/design';
import { createDocumentStore, documentLinks, hash, type DocumentScope } from '../lib/documents/storage';
import { PDF_RASTER_LIMITS, rasterizePdf, validatePdfRasterPageGeometry, withRasterDeadline } from '../lib/documents/render';

const scope: DocumentScope = {
  ownerId:'11111111-1111-4111-8111-111111111111',
  actorId:'22222222-2222-4222-8222-222222222222',
  chatId:'33333333-3333-4333-8333-333333333333',
  requestId:'incident-regression',
};

function storageFixture() {
  const files = new Map<string, Blob>();
  return { files, storage: {
    getBucket: async () => ({ data: { public: false }, error: null }),
    createBucket: async () => ({ data: {}, error: null }),
    from: () => ({
      upload: async (path: string, body: Uint8Array, options: { contentType: string }) => {
        if (files.has(path)) return { error: { message: 'exists' } };
        files.set(path, new Blob([new Uint8Array(body)], { type: options.contentType }));
        return { error: null };
      },
      download: async (path: string) => ({ data: files.get(path) ?? null, error: files.has(path) ? null : { message: 'missing' } }),
    }),
  } as unknown as Parameters<typeof createDocumentStore>[0] };
}

test('Nov 10 request is a new resume task with no invented page count and binds the one retained PDF', () => {
  const message='create a pdf of my resume';
  const request=documentRequest(message);
  assert.deepEqual(request, {});
  const previous={identity:'resume',pages:2,sourceUserMessageId:'older-user',sourceMessageId:'older-source',provenance:'current-user' as const};
  const resolved=resolveDurableDocumentRequest(message,request,previous,undefined);
  assert.equal(resolved.request?.pages, undefined);
  assert.equal(resolved.contract?.identity,'resume');
  assert.equal(resolved.contract?.provenance,'current-user');
  const fileId=retainedPdfExportFileId(message,[{fileId:'incident-pdf',mimeType:'application/pdf'}],id=>id==='incident-pdf');
  assert.equal(fileId,'incident-pdf');
  assert.equal(sourcePreservingPdfExportRequest(message),true);
});

test('same-document continuation inherits an explicit page count but a changed source does not', () => {
  const previous={identity:'resume',pages:2,sourceUserMessageId:'approved-user',sourceMessageId:'approved-source',provenance:'current-user' as const};
  const same=resolveDurableDocumentRequest('re-export the same resume as a PDF',{},previous,'approved-source');
  assert.equal(same.request?.pages,2);
  assert.equal(same.contract?.provenance,'inherited-user');
  const changed=resolveDurableDocumentRequest('re-export the same resume as a PDF',{},previous,'different-source');
  assert.equal(changed.request?.pages,undefined);
});

test('new document attachment selection is exact and editing requests do not masquerade as conversion', () => {
  assert.equal(retainedPdfExportFileId('create a pdf of my resume',[
    {fileId:'old',mimeType:'application/pdf'},{fileId:'new',mimeType:'application/pdf'},
  ],()=>true),null);
  assert.equal(retainedPdfExportFileId('create a pdf of my resume',[{fileId:'new',mimeType:'application/pdf'}],id=>id==='new'),'new');
  assert.equal(retainedPdfExportFileId('revise my resume and create a pdf',[{fileId:'new',mimeType:'application/pdf'}],()=>true),null);
  assert.equal(retainedPdfExportFileId('create a PDF cover letter based on my resume',[{fileId:'resume',mimeType:'application/pdf'}],()=>true),null,
    'a different requested document must draft from the source instead of returning it unchanged');
  assert.equal(retainedPdfExportFileId('create a one-page pdf of my resume',[{fileId:'resume',mimeType:'application/pdf'}],()=>true),null,
    'an explicit page constraint requires generation/clarification rather than unchecked source preservation');
  assert.equal(sourcePreservingPdfExportRequest('create a pdf of my resume'),true);
  assert.equal(sourcePreservingPdfExportRequest('export my resume as a pdf'),true);
  assert.equal(sourcePreservingPdfExportRequest('create a PDF cover letter based on my resume'),false);
  assert.equal(sourcePreservingPdfExportRequest('create a one-page pdf of my resume'),false);
  assert.equal(sourcePreservingPdfExportRequest('create a PDF of my resume and a Word document'),false);
  assert.equal(sourcePreservingPdfExportRequest('export my resume as PDF and DOCX'),false);
  assert.equal(retainedPdfDualFormatRequest('create a PDF of my resume and a Word document'),true);
  assert.equal(retainedPdfDualFormatRequest('export my resume as PDF and DOCX'),true);
  assert.equal(retainedPdfDualFormatFileId('create a PDF of my resume and a Word document',
    [{fileId:'resume',mimeType:'application/pdf'}],()=>true),'resume');
  assert.equal(retainedPdfDualFormatFileId('create a pdf of my resume',
    [{fileId:'resume',mimeType:'application/pdf'}],()=>true),null);
  assert.equal(retainedPdfExportFileId('create a pdf of my resume',[{fileId:'new',mimeType:'application/pdf'}],()=>false),null);
});

test('professional resume generation fails closed by policy while ordinary technical-only documents remain differentiated', () => {
  assert.equal(requiresProfessionalDocumentAcceptance('create my resume','resume'),true);
  assert.equal(requiresProfessionalDocumentAcceptance('export the quarterly report','financial-report'),true);
  assert.equal(requiresProfessionalDocumentAcceptance('make a plain text letter','letter'),false);
  assert.equal(requiresProfessionalDocumentAcceptance('make this letter professional quality','letter'),true);
});

test('source-preserved PDF receipts cannot silently change facts or expose a fabricated DOCX', async () => {
  const fixture=storageFixture(), store=createDocumentStore(fixture.storage);
  const source=Buffer.from('%PDF-1.7\nsource facts: seller-side EV $400M+; services revenue approx. $90M\n%%EOF');
  const changed=Buffer.from('%PDF-1.7\nsource facts: seller-side EV $600M+; services revenue approx. $100M\n%%EOF');
  assert.notEqual(hash(source),hash(changed));
  const inspection={pageCount:2,findings:[{page:1,rule:'font-size' as const,detail:'Source contains pre-existing 9pt body text.'}],extractedText:'source facts',pageHashes:['a'.repeat(64),'b'.repeat(64)],visual:'technical-only' as const};
  const receipt=await store.savePdfSource(scope,source,inspection);
  assert.equal(receipt.visualStatus,'source-preserved');
  assert.equal(receipt.files.docx,undefined);
  assert.equal(receipt.files.pdf.sha256,hash(source));
  assert.equal(hash((await store.read(scope,receipt.id,'pdf')).bytes),hash(source));
  assert.match(documentLinks(receipt),/unchanged; no document content was regenerated/);
  assert.doesNotMatch(documentLinks(receipt),/Professional design review passed/);
  assert.doesNotMatch(documentLinks(receipt),/Word document/);
  await assert.rejects(store.read(scope,receipt.id,'docx'),/Invalid artifact type/);
  await assert.rejects(store.read({...scope,ownerId:'44444444-4444-4444-8444-444444444444'},receipt.id,'pdf'),/access denied/);
});

test('group-continuity review creates an actionable forced-pagination alternative for natural multi-page reflow', () => {
  const spec=parseDocument(`# Executive Resume

## Engagement One
Role metadata
- Result one
- Result two
- Result three

## Engagement Two
Role metadata
- Result one
- Result two
- Result three

## Engagement Three
Role metadata
- Result one
- Result two
- Result three`);
  const natural={pages:[spec.blocks.map((_,i)=>i)],spacing:4,design:DEFAULT_DESIGN};
  const heights=spec.blocks.map(()=>145);
  const assessment=designAssessmentSchema.parse({verdict:'repair',summary:'Material section continuity defects split executive engagements across physical pages.',issues:[{page:1,category:'section-continuity',severity:'material',evidence:'An engagement heading is stranded from the bullets that explain the role.'}],actions:['group-continuity'],comparison:'not_applicable'});
  const next=proposeDesignLayout(natural,spec,heights,assessment,3);
  assert.ok(next);
  assert.equal(next.pages.length,3);
  assert.deepEqual(next.pages.flat(),spec.blocks.map((_,i)=>i));
  assert.notDeepEqual(next.pages,natural.pages);
});

test('route integration preserves exact source bytes before drafting and keeps admission/accounting wrapper intact', () => {
  const route=readFileSync('app/api/chat/route.ts','utf8');
  const bind=route.indexOf('resolveRetainedPdfExportFileId(message, attachments');
  const sentinel=route.indexOf("text: 'SOURCE_PDF_PRESERVED'");
  const providerCall=route.indexOf('candidate.provider.generate',sentinel);
  const sourceRead=route.indexOf('loadConversationAttachmentSource(sourceChatId');
  const sourceDelivery=route.indexOf('deliverRetainedPdfSource({');
  assert.ok(bind>0 && sentinel>bind && sourceRead>sentinel && sourceDelivery>sourceRead);
  assert.ok(providerCall===-1 || providerCall>sentinel,'retained-source guard must execute before provider drafting');
  assert.match(route,/runWithRefusalFallback/);
  assert.match(route,/executeStandaloneWorkflow/);
  assert.match(route,/let retainedPdfExportAttachment: ConversationAttachment \| null = null/);
  assert.match(route,/retainedPdfExportAttachment = retainedPdfExportFileId/);
  assert.match(route,/const generationAttempt = retainedPdfExportAttachment/);
  assert.doesNotMatch(route.slice(route.indexOf('runAttempt: async'), route.indexOf('result = generationAttempt.result')),
    /if \(retainedPdfExportAttachment\)/,
    'provider drafting callback must not capture the retained-PDF binding');
  assert.match(route,/typeof retainedPdfExportAttachment !== 'undefined'.*attachmentDecision\.clarification/);
});


test('PDF raster geometry rejects oversized MediaBox and malformed dimensions before allocation', () => {
  const letter=validatePdfRasterPageGeometry(612,792,0);
  assert.equal(letter.widthPx,918);
  assert.equal(letter.heightPx,1188);
  const legal=validatePdfRasterPageGeometry(612,1008,letter.totalPixels);
  assert.ok(legal.totalPixels < PDF_RASTER_LIMITS.maxTotalPixels);
  assert.doesNotThrow(()=>validatePdfRasterPageGeometry(842,595,0),'A4 landscape remains supported');
  assert.doesNotThrow(()=>validatePdfRasterPageGeometry(1008,612,0),'Legal landscape remains supported');
  assert.throws(()=>validatePdfRasterPageGeometry(300000,300000,0),/dimensions exceed rendering bounds/);
  for (const bad of [
    [Number.NaN,792],[Number.POSITIVE_INFINITY,792],[0,792],[-1,792],[612,Number.NaN],[612,0],
  ] as Array<[number,number]>) assert.throws(()=>validatePdfRasterPageGeometry(bad[0],bad[1],0),/Invalid PDF page geometry/);
  assert.throws(()=>validatePdfRasterPageGeometry(612,1008,PDF_RASTER_LIMITS.maxTotalPixels-1),
    /Document raster exceeds inspection budget/);
  const source=readFileSync('lib/documents/render.ts','utf8');
  const raster=source.slice(source.indexOf('export async function rasterizePdf'));
  assert.ok(raster.indexOf('validatePdfRasterPageGeometry(') >= 0);
  assert.ok(raster.indexOf('validatePdfRasterPageGeometry(') < raster.indexOf("createElement('canvas')"),
    'geometry and aggregate budgets must pass before canvas allocation');
});

test('PDF raster deadline is bounded and stalled inspection still closes its browser context', async () => {
  await assert.rejects(withRasterDeadline(new Promise<never>(()=>undefined),5),/timed out/);
  let closed=0;
  const browser={
    newContext: async()=>({
      route: async()=>undefined,
      newPage: async()=>({ evaluate: async()=>new Promise<never>(()=>undefined) }),
      close: async()=>{ closed++; },
    }),
  } as any;
  await assert.rejects(rasterizePdf(browser,Buffer.from('%PDF-1.7\n% stalled'),{deadlineMs:5}),/timed out/);
  assert.equal(closed,1,'raster failure must close the isolated browser context');
});
