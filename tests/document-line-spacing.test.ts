import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { documentLineSpacing, generateDocx, type Layout } from '../lib/documents/generate';
import { parseDocument, contentText, pdfTextMatchesSource } from '../lib/documents/model';
import { renderDocument, rasterizePdf } from '../lib/documents/render';
import { launchWebsiteBrowser } from '../lib/research/website-evidence';

const root='test-artifacts/documents/line-spacing';
test('line heights explicitly scale with font size instead of a global 12pt rule',()=>{
  assert.deepEqual(documentLineSpacing(22,{compact:true}),{line:264,lineRule:'exact'});
  assert.deepEqual(documentLineSpacing(22),{line:276,lineRule:'exact'});
  assert.deepEqual(documentLineSpacing(38,{compact:true}),{line:456,lineRule:'exact'});
  assert.deepEqual(documentLineSpacing(27,{compact:true}),{line:324,lineRule:'exact'});
  assert.deepEqual(documentLineSpacing(23,{compact:true}),{line:276,lineRule:'exact'});
  assert.ok(documentLineSpacing(38,{compact:true},1.1).line>=456);
  for(const font of [0,21,NaN,Infinity])assert.throws(()=>documentLineSpacing(font));
  for(const scale of [0.9,NaN,Infinity,2.01])assert.throws(()=>documentLineSpacing(22,{},scale));
});

test('paragraphs, table cells and default styles carry explicit safe line rules without changing text',async()=>{
  const spec=parseDocument('# Readable Heading\n\n## Supporting Section\n\nBody text with symbols: $10 and →.\n\n- First supporting item\n\n| Metric | Actual |\n| --- | --- |\n| Cash | $100 |');
  const layout:Layout={pages:[spec.blocks.map((_,i)=>i)],spacing:4,compact:true};
  const bytes=await generateDocx(spec,layout),zip=await JSZip.loadAsync(bytes);
  for(const path of ['word/document.xml','word/styles.xml']){
    const complete=await zip.file(path)!.async('string');
    // Built-in unused FootnoteText/EndnoteText styles are not generated content.
    const xml=path.endsWith('styles.xml') ? complete.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/)![0] : complete;
    const spacings=[...xml.matchAll(/<w:spacing\b[^>]*w:line="(\d+)"[^>]*>/g)];
    assert.ok(spacings.length>0);
    for(const [tag,line] of spacings){assert.match(tag,/w:lineRule="exact"/);assert.ok(Number(line)>=264);}
  }
  const xml=await zip.file('word/document.xml')!.async('string');
  assert.match(xml,/w:line="456"/,'Large heading must have 22.8pt leading, not 12pt');
  assert.match(xml,/w:line="264"/,'Body must have 13.2pt compact leading');
  assert.equal(spec.targetPages,undefined,'No page requirement is fabricated');
});

test('large multiline headings stay within margins in actual PDF with complete glyphs and 11pt body', {timeout:90000},async()=>{
  const browser=await launchWebsiteBrowser();
  try{
    const source='# A Large Multiline Professional Heading That Must Stay Entirely Inside the Printable Margins and Never Clip Descenders\n\n## Supporting Context\n\nAccents and descenders: ÁÉÎÖÜ gjpqy. Content must remain readable.\n\n- Complete supporting accomplishment.\n\n| Item | Amount |\n| --- | --- |\n| Alpha | $100 |';
    const spec=parseDocument(source);
    const layout:Layout={pages:[spec.blocks.map((_,i)=>i)],spacing:4,compact:true,
      design:{sectionGap:1,listGap:1,lineScale:1.1,hierarchy:1.1}};
    const docx=await generateDocx(spec,layout),rendered=await renderDocument(browser,docx,spec,layout);
    assert.deepEqual(rendered.inspection.findings,[],'Large heading and all text must remain inside printable margins');
    const pdf=await rasterizePdf(browser,rendered.pdf);
    assert.equal(pdfTextMatchesSource(pdf.text,contentText(spec),pdf.fragments),true);
    for(const page of pdf.fontMeasurements)assert.ok(page.minimumPt!==null && page.minimumPt>=11,'No rounded-up font acceptance');
    mkdirSync(root,{recursive:true});writeFileSync(root+'/large-heading.source.md',source);writeFileSync(root+'/large-heading.docx',docx);writeFileSync(root+'/large-heading.pdf',rendered.pdf);
    rendered.images.forEach((image,i)=>writeFileSync(root+'/large-heading-page-'+(i+1)+'.png',image));
    writeFileSync(root+'/large-heading.json',JSON.stringify({required_pages:null,semantic_source:contentText(spec),blocks:spec.blocks,minimum_body_pt:11,margin_pt:36},null,2));
  }finally{await browser.close();}
});
