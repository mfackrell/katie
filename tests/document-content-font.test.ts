import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { launchWebsiteBrowser } from '../lib/research/website-evidence';
import { parseDocument, contentText, normalizedText, pdfTextMatchesSource } from '../lib/documents/model';
import { generateDocx, PAGE } from '../lib/documents/generate';
import { renderDocument, rasterizePdf, MINIMUM_PDF_BODY_CSS_PX } from '../lib/documents/render';

const output = 'test-artifacts/documents/content-font';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
test('escaped punctuation and literal code preserve semantic text in actual DOCX and PDF with strict font floor', {timeout:90000}, async()=>{
  const source = '# Revenue \\$25\n\n**Details \\$30**\n\nBudget \\$40; literal `\\$x`, path `C:\\data\\file.txt`.\n\n- Forecast \\$50\n\n| Category | Amount |\n| --- | --- |\n| A\\|B | \\$60 |';
  const sourceHash=digest(source),spec=parseDocument(source,1);
  assert.equal(contentText(spec),'Revenue $25\nDetails $30\nBudget $40; literal \\$x, path C:\\data\\file.txt.\nForecast $50\nCategory Amount A|B $60');
  const browser=await launchWebsiteBrowser();
  try{
    const docx=await generateDocx(spec,{pages:[spec.blocks.map((_,i)=>i)],spacing:4});
    const rendered=await renderDocument(browser,docx,spec);
    const raw=await (mammoth.extractRawText as unknown as (input:{buffer:Buffer})=>Promise<{value:string}>)({buffer:docx});
    assert.equal(normalizedText(raw.value),normalizedText(contentText(spec)));
    assert.deepEqual(rendered.inspection.findings,[]);
    const pdf=await rasterizePdf(browser,rendered.pdf);
    assert.equal(pdfTextMatchesSource(pdf.text,contentText(spec),pdf.fragments),true);
    assert.equal(digest(source),sourceHash);
    assert.ok(pdf.fontMeasurements.every(p=>p.minimumPt!==null&&p.minimumPt>=11),'No rounding or tolerance below 11pt');
    const archive=await JSZip.loadAsync(docx),xml=await archive.file('word/document.xml')!.async('string');
    assert.ok(xml.includes('<w:sz w:val="22"'),'OOXML body remains exactly 11pt');
    const nominal=PAGE.font*96/72;
    assert.ok(MINIMUM_PDF_BODY_CSS_PX>nominal && MINIMUM_PDF_BODY_CSS_PX-nominal<0.01,'Correction is upward by less than 0.01 CSS px');
    mkdirSync(output,{recursive:true});
    writeFileSync(output+'/semantic.docx',docx);writeFileSync(output+'/semantic.pdf',rendered.pdf);
    rendered.images.forEach((image,i)=>writeFileSync(output+'/semantic-page-'+(i+1)+'.png',image));
    writeFileSync(output+'/semantic.json',JSON.stringify({sourceHash,semanticHash:digest(contentText(spec)),fonts:pdf.fontMeasurements,pages:rendered.inspection.pageCount,findings:rendered.inspection.findings},null,2));
  }finally{await browser.close();}
});

test('sub-minimum source typography and real PDF matrices are rejected, never rounded up by validation', {timeout:90000}, async()=>{
  const browser=await launchWebsiteBrowser();
  try{
    const spec=parseDocument('# Font floor\n\nA negative font specimen with 10-point body text.',1);
    const valid=await generateDocx(spec,{pages:[spec.blocks.map((_,i)=>i)],spacing:4});
    const z=await JSZip.loadAsync(valid);
    for(const path of ['word/document.xml','word/styles.xml']){
      const xml=await z.file(path)!.async('string');z.file(path,xml.replace(/w:val="22"/g,'w:val="20"'));
    }
    const bad=await renderDocument(browser,await z.generateAsync({type:'nodebuffer'}),spec);
    assert.ok(bad.inspection.findings.some(f=>f.rule==='font-size'),'A real 10pt DOCX must not be silently enlarged or accepted');
    const ctx=await browser.newContext();await ctx.route('**/*',r=>r.abort());const p=await ctx.newPage();
    const font=readFileSync('node_modules/@fontsource/arimo/files/arimo-latin-400-normal.woff2').toString('base64');
    await p.setContent('<style>@font-face{font-family:Probe;src:url(data:font/woff2;base64,'+font+')}</style><p style="font:11pt Probe">Quantized 11 point text</p>');
    await p.evaluate(()=>document.fonts.ready);const raw=await rasterizePdf(browser,await p.pdf());
    const min=raw.fontMeasurements[0].minimumPt!;
    assert.equal(raw.findings.some(f=>f.rule==='font-size'),min<11,'Classification uses unrounded actual PDF em, including 10.995pt');
    await ctx.close();
  }finally{await browser.close();}
});
