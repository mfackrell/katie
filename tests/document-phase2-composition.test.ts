import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseDocument, contentText, normalizedText, pdfTextMatchesSource } from '../lib/documents/model';
import { resolveDurableDocumentRequest } from '../lib/documents/continuity';
import { generateDocx, paginate, PAGE, documentPageStyle, type Layout } from '../lib/documents/generate';
import { chooseInitialComposition, produceDocument } from '../lib/documents/production';
import { renderDocument } from '../lib/documents/render';
import { designAssessmentSchema, proposeDesignLayout } from '../lib/documents/design';
import { launchWebsiteBrowser } from '../lib/research/website-evidence';
import JSZip from 'jszip';

test('persisted explicit same-document constraints survive retries without borrowing from unrelated documents',()=>{
  const original={identity:'resume',pages:2,sourceUserMessageId:'user-1',
    sourceMessageId:'source-1',provenance:'current-user' as const};
  const retry=resolveDurableDocumentRequest('give me the same resume in Word and PDF again',{},original);
  assert.equal(retry.request?.pages,2);
  assert.equal(retry.contract?.sourceUserMessageId,'user-1');
  assert.equal(retry.contract?.provenance,'inherited-user');
  const different=resolveDurableDocumentRequest('give me a new agreement as PDF',{},original);
  assert.equal(different.request?.pages,undefined);
  const sourceChange=resolveDurableDocumentRequest('give me the resume as PDF again',{},original,'source-2');
  assert.equal(sourceChange.request?.pages,undefined);
  const override=resolveDurableDocumentRequest('give me a revised three-page resume as a PDF',{pages:3},original);
  assert.equal(override.request?.pages,3);
  assert.equal(override.contract?.provenance,'current-user');
  const noIdentity=resolveDurableDocumentRequest('export the document again',{},original);
  assert.equal(noIdentity.request?.pages,undefined);
});

test('rendered-page selection saves an entire page on report and agreement without changing body text or explicit page target', {timeout:180000},async()=>{
  const browser=await launchWebsiteBrowser();
  mkdirSync('test-artifacts/documents/phase2',{recursive:true});
  try {
    for(const name of ['financial-report','business-agreement']) {
      const markdown=readFileSync('fixtures/documents/phase1-'+name+'.md','utf8');
      const spec=parseDocument(markdown);
      const indices=spec.blocks.map((_,i)=>i);
      const standard: Layout={pages:[indices],spacing:4};
      const standardBytes=await generateDocx(spec,standard);
      const before=await renderDocument(browser,standardBytes,spec,standard);
      const selected=await chooseInitialComposition(spec,browser,Date.now()+45000);
      const chosenBytes=await generateDocx(spec,selected);
      const after=await renderDocument(browser,chosenBytes,spec,selected);
      assert.ok(after.inspection.pageCount < before.inspection.pageCount,
        name+': avoidable second page must be removed when same glyphs fit');
      assert.deepEqual(after.inspection.findings,[],name+': revised layout must be mechanically valid');
      // The render pipeline itself checks ordered glyphs using PDF fragment metadata.
      assert.equal(after.inspection.findings.some(f=>f.rule==='reading-order'),false);
      const originalZip=await JSZip.loadAsync(standardBytes);
      const afterZip=await JSZip.loadAsync(chosenBytes);
      const docxText=async(z:JSZip)=>((await z.file('word/document.xml')!.async('string'))
        .match(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g)??[]).length;
      assert.equal(await docxText(originalZip),await docxText(afterZip),'No source runs lost');
      writeFileSync('test-artifacts/documents/phase2/'+name+'-before.pdf',before.pdf);
      writeFileSync('test-artifacts/documents/phase2/'+name+'-after.pdf',after.pdf);
      before.images.forEach((b,i)=>writeFileSync('test-artifacts/documents/phase2/'+name+'-before-'+(i+1)+'.png',b));
      after.images.forEach((b,i)=>writeFileSync('test-artifacts/documents/phase2/'+name+'-after-'+(i+1)+'.png',b));
    }
  }finally{await browser.close();}
});

test('explicit two-page layout is never compacted to one page', {timeout:120000},async()=>{
  const browser=await launchWebsiteBrowser();
  try{
    const spec=parseDocument(readFileSync('fixtures/documents/phase1-executive-resume.md','utf8'),2);
    const selected=await chooseInitialComposition(spec,browser,Date.now()+55000);
    const bytes=await generateDocx(spec,selected);
    const actual=await renderDocument(browser,bytes,spec,selected);
    assert.equal(actual.inspection.pageCount,2);
    assert.deepEqual(actual.inspection.findings,[]);
  }finally{await browser.close();}
});

test('review can request executable natural reflow or compactness; impossible author actions remain invalid',()=>{
  const spec=parseDocument('# Report\n\n## Heading\n\nText under a heading.\n\n- One bullet\n\n- Two bullets.',2);
  const layout={pages:[[0,1,2],[3,4]],spacing:4};
  const report=(action:'natural-reflow'|'compact-layout'|'group-continuity')=>({
    verdict:'repair' as const,summary:'Actual page images demonstrate avoidable breaks and poor section continuity.',
    issues:[{page:1,category:'section-continuity' as const,severity:'material' as const,
      evidence:'The supporting paragraph is moved away from its heading.'}],
    actions:[action],comparison:'not_applicable' as const
  });
  const heights=spec.blocks.map(()=>25);
  const reflow=proposeDesignLayout(layout,spec,heights,report('natural-reflow'));
  assert.equal(reflow?.pages.length,1);
  const compact=proposeDesignLayout(layout,spec,heights,report('compact-layout'));
  assert.equal(compact?.compact,true);
  assert.equal(compact?.spacing,2);
  assert.throws(()=>designAssessmentSchema.parse({...report('natural-reflow'),actions:['css-injection']}));
});

test('professional quality required fails closed on blocked critique, whereas mechanical-only is clearly labeled', {timeout:120000},async()=>{
  const spec=parseDocument('# Engagement\n\n## Scope\n\nProfessional financial and operating support.',1);
  const browser=await launchWebsiteBrowser();
  const blocked=async(r: {images:Buffer[]})=>({
    pages:r.images.map((_,i)=>({page:i+1,verdict:'pass' as const,repair:'none' as const,
      observations:'The mechanically valid content remains readable in the produced PDF.'})),
    design:{verdict:'blocked' as const,
      summary:'Actual aesthetic acceptance was withheld because the composition is unapproved.',
      issues:[{page:1,category:'balance' as const,severity:'material' as const,
        evidence:'Independent professional visual quality was not established for this candidate.'}],
      actions:[],comparison:'not_applicable' as const}
  });
  try{
    await assert.rejects(produceDocument({spec,browser,deadlineMs:Date.now()+45000,
      inspect:blocked,requireProfessionalAcceptance:true}),/Professional visual design was not accepted/);
    const valid=await produceDocument({spec,browser,deadlineMs:Date.now()+45000,inspect:blocked});
    assert.equal(valid.inspection.visual,'technical-only');
    assert.deepEqual(valid.inspection.findings,[]);
  }finally{await browser.close();}
});
