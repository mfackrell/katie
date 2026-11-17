import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, contentText, normalizedText, pdfTextMatchesSource } from '../lib/documents/model';
import { generateDocx, documentPageStyle, PAGE, type Layout } from '../lib/documents/generate';
import { designAssessmentSchema, proposeDesignLayout, validDesign, DEFAULT_DESIGN } from '../lib/documents/design';
import { produceDocument, visualReportSchema, type VisualReport } from '../lib/documents/production';
import { renderDocument, rasterizePdf } from '../lib/documents/render';
import { launchWebsiteBrowser } from '../lib/research/website-evidence';
import mammoth from 'mammoth';
import { mkdirSync, writeFileSync } from 'node:fs';

const passPage = (page: number) => ({
  page, verdict: 'pass' as const, repair: 'none' as const,
  observations: 'Rendered text is legible, within margins and in the correct reading sequence.',
});
const improvementReport = (): VisualReport => ({
  pages: [passPage(1)],
  design: {
    verdict: 'repair',
    summary: 'Distinct sections and bullet groups are visually compressed, reducing executive scanability.',
    issues: [{page:1,category:'density',severity:'material',
      evidence:'Section titles and bullet lists have inadequate visible separation.'}],
    actions:['section-separation','list-rhythm'],
    comparison:'not_applicable',
  },
});
const acceptanceReport = (): VisualReport => ({
  pages: [passPage(1)],
  design: {
    verdict:'pass',
    summary:'The revised page has clearer hierarchy and section rhythm without reducing text size.',
    issues:[],actions:[],comparison:'improved',
  },
});

test('design feedback is a bounded semantic contract, not arbitrary CSS', () => {
  const spec = parseDocument('# Operating review\n\n## Findings\n\n- Collections recovered.\n\n- Reporting is current.', 1);
  const layout: Layout = {pages:[spec.blocks.map((_,i)=>i)],spacing:4};
  const heights = [35,26,25,25];
  const result = proposeDesignLayout(layout,spec,heights,improvementReport().design!);
  assert.ok(result?.design);
  assert.ok(result.design.sectionGap > DEFAULT_DESIGN.sectionGap);
  assert.ok(result.design.listGap > DEFAULT_DESIGN.listGap);
  assert.ok(validDesign(result));
  assert.equal(result.spacing,4);
  assert.deepEqual(result.pages,layout.pages);
  assert.equal(documentPageStyle(result).margin,PAGE.margin);
  assert.equal(validDesign({...layout,design:{...DEFAULT_DESIGN,lineScale:3}}),false);
  assert.equal(proposeDesignLayout(layout,spec,heights,{...improvementReport().design!,actions:[],verdict:'repair'}),null);
  assert.equal(proposeDesignLayout(layout,spec,heights,{...improvementReport().design!,issues:[],verdict:'repair'}),null);
  assert.throws(()=>designAssessmentSchema.parse({...improvementReport().design!,actions:['injected-css']}));
});

test('qualifying visual evidence produces a re-render, comparison and genuine PDF content preservation', {timeout:120000}, async () => {
  const spec = parseDocument(
    '# Executive portfolio\n\n## Selected experience\n\n**Controller and CFO leadership**\n\n' +
    Array.from({length:6},(_,i)=>'- Restored reporting and cash visibility for operating team '+(i+1)+'.').join('\n\n') +
    '\n\n## Education\n\nMBA and accounting degree.',1);
  const browser = await launchWebsiteBrowser();
  let calls = 0;
  let firstHeight = 0;
  let beforeImage: Buffer | undefined;
  try {
    const result = await produceDocument({spec,browser,deadlineMs:Date.now()+110000,inspect: async (rendered, attempt, context) => {
        calls++;
        assert.equal(rendered.inspection.findings.length,0);
        if (!context?.previous) {
          firstHeight = rendered.heights.reduce((a,b)=>a+b,0);
          beforeImage = rendered.images[0];
          return improvementReport();
        }
        assert.notDeepEqual(rendered.inspection.pageHashes,context.previous.inspection.pageHashes);
        assert.ok(rendered.heights.reduce((a,b)=>a+b,0) > firstHeight);
        assert.equal(attempt,1);
        return acceptanceReport();
      },
    });
    assert.equal(calls,2,'One baseline review and one confirmation: no unbounded paid calls');
    assert.equal(result.corrections,1);
    // Keep real PDF page rasters for independent visual inspection in CI.
    mkdirSync('test-artifacts/documents',{recursive:true});
    if (!beforeImage) throw new Error('The original design image was not rendered.');
    writeFileSync('test-artifacts/documents/design-before.png',beforeImage);
    writeFileSync('test-artifacts/documents/design-after.png',result.images[0]);

    assert.equal(result.inspection.visual,'passed');
    assert.deepEqual(result.inspection.findings,[]);
    assert.equal(result.inspection.pageCount,1);
    const raw = await (mammoth.extractRawText as unknown as (args:{buffer:Buffer})=>Promise<{value:string}>)({buffer:result.docx});
    assert.equal(normalizedText(raw.value),normalizedText(contentText(spec)));
    const parsed = await rasterizePdf(browser,result.pdf);
    assert.equal(pdfTextMatchesSource(parsed.text,contentText(spec),parsed.fragments),true);
  } finally {await browser.close();}
});

test('design rejection, malformed review and unavailable model preserve mechanically valid files', {timeout:120000}, async()=>{
  const spec = parseDocument('# Proposal\n\n## Scope\n\nThe services and fee schedule are described.',1);
  const browser=await launchWebsiteBrowser();
  try {
    const scenarios = [
      {name:'blocked', inspect:async()=>({ pages:[passPage(1)], design:{
        verdict:'blocked' as const,summary:'The page needs more visual polish before final presentation.',
        issues:[{page:1,category:'density' as const,severity:'material' as const,evidence:'Unbalanced separation between labels and body paragraphs.'}],
        actions:[],comparison:'not_applicable' as const,
      }})},
      {name:'page-blocked', inspect:async()=>({pages:[{
        ...passPage(1),verdict:'blocked' as const,repair:'none' as const,
        observations:'The page is technically readable but its composition needs professional polish.',
      }],design:{verdict:'pass' as const,
        summary:'No additional document-wide corrective actions can be justified.',
        issues:[],actions:[],comparison:'not_applicable' as const}})},
      {name:'unsupported', inspect:async()=>({pages:[passPage(1)],design:{...improvementReport().design!,actions:[]}})},
      {name:'invalid-enum-repair', inspect:async()=>visualReportSchema.parse({
        pages:[{...passPage(1),verdict:'repair',
          repair:'Remove an editorial heading and move two bullets together with the preceding section.'}],
        design:improvementReport().design,
      })},
      {name:'no-model', inspect:async():Promise<VisualReport>=>{throw new Error('No professional design model available.');}},
      {name:'missing-report', inspect:async()=>({pages:[passPage(1)]})},
    ];
    for(const scenario of scenarios){
      const produced=await produceDocument({
        spec,browser,deadlineMs:Date.now()+65000,
        inspect:scenario.inspect,
        canSkipDesignReviewError:async()=>true,
      });
      assert.equal(produced.inspection.pageCount,1,scenario.name);
      assert.deepEqual(produced.inspection.findings,[],scenario.name);
      assert.equal(produced.inspection.visual,'technical-only',scenario.name);
      assert.equal(normalizedText(produced.inspection.extractedText),normalizedText(contentText(spec)),scenario.name);
      assert.equal(produced.corrections,0,scenario.name);
      assert.ok(produced.docx.length>500 && produced.pdf.length>500,scenario.name);
    }
    const approval=Object.assign(new Error('Approval required'),{code:'standalone_approval_required'});
    await assert.rejects(produceDocument({
      spec,browser,deadlineMs:Date.now()+65000,
      inspect:async()=>{throw approval;},
      canSkipDesignReviewError:async()=>false,
    }),error=>error===approval,'Financial authorization must not be bypassed by aesthetic fallback.');
  } finally {await browser.close();}
});

test('unproven or regressed design revision returns the original validated bytes', {timeout:120000}, async()=>{
  const spec=parseDocument('# Executive portfolio\n\n## Operations\n\n' +
    Array.from({length:6},(_,i)=>'- Supported financial operations '+(i+1)+'.').join('\n\n'),1);
  const browser=await launchWebsiteBrowser();
  try {
    let calls=0;
    let originalHash:string|undefined;
    const produced=await produceDocument({spec,browser,deadlineMs:Date.now()+110000,
      inspect:async(rendered,_attempt,context)=>{
        calls++;
        if(!context?.previous){
          originalHash=rendered.inspection.pageHashes[0];
          return improvementReport();
        }
        return {...acceptanceReport(),design:{...acceptanceReport().design!,comparison:'regressed' as const}};
      },
    });
    assert.equal(calls,2);
    assert.equal(produced.inspection.pageHashes[0],originalHash);
    assert.equal(produced.inspection.visual,'technical-only');
    assert.equal(produced.corrections,0);
  } finally {await browser.close();}
});

test('different document structures preserve technical integrity without a required style preset', {timeout:120000}, async()=>{
  const specs = [
    parseDocument('# Finance report\n\n## Results\n\n| Metric | Actual |\n| --- | --- |\n| Cash | 100 |\n| Expenses | 65 |\n\n**Operating conclusion**\n\nCash generation remains positive.',1),
    parseDocument('# Service agreement\n\n## Deliverables\n\nSupplier will provide technical consulting services.\n\n**Payment terms**\n\nPayment is due under the signed statement of work.',1),
  ];
  const browser=await launchWebsiteBrowser();
  try {
    for (const spec of specs) {
      const layout={pages:[spec.blocks.map((_,i)=>i)],spacing:4};
      const bytes=await generateDocx(spec,layout);
      const rendered=await renderDocument(browser,bytes,spec);
      assert.equal(rendered.inspection.pageCount,1);
      assert.deepEqual(rendered.inspection.findings,[]);
      assert.ok(rendered.images[0].length>2500);
      mkdirSync('test-artifacts/documents',{recursive:true});
      writeFileSync(`test-artifacts/documents/design-${spec.title.toLowerCase().replace(/[^a-z0-9]+/g,'-')}.png`,rendered.images[0]);

    }
  } finally {await browser.close();}
});
