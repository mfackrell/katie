import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { launchWebsiteBrowser } from '../lib/research/website-evidence';
import { parseDocument, contentText, normalizedText, pdfTextMatchesSource } from '../lib/documents/model';
import { generateDocx, paginate, PAGE, documentPageStyle, type Layout } from '../lib/documents/generate';
import { renderDocument, rasterizePdf } from '../lib/documents/render';
import { produceDocument } from '../lib/documents/production';

const ROOT = 'test-artifacts/documents/phase1';
const fixtures = [
  { name: 'executive-resume', path: 'fixtures/documents/phase1-executive-resume.md', pages: 2 },
  { name: 'financial-report', path: 'fixtures/documents/phase1-financial-report.md', pages: undefined },
  { name: 'business-agreement', path: 'fixtures/documents/phase1-business-agreement.md', pages: undefined },
] as const;
function hash(bytes: Buffer | string) { return createHash('sha256').update(bytes).digest('hex'); }

test('PHASE1: actual offline Katie DOCX, Chromium PDF, glyphs, pagination, and measurable layout', { timeout: 240000 }, async () => {
  mkdirSync(ROOT, { recursive: true });
  const browser = await launchWebsiteBrowser();
  try {
    for (const fixture of fixtures) {
      const source = readFileSync(fixture.path, 'utf8');
      const spec = parseDocument(source, fixture.pages);
      assert.ok(spec.blocks.length >= 12, fixture.name + ': multi-block representative document is required');
      const onePage: Layout = { pages: [spec.blocks.map((_, i) => i)], spacing: 4 };
      const initialDocx = await generateDocx(spec, onePage);
      const first = await renderDocument(browser, initialDocx, spec, onePage);
      // renderDocument.heights is measured from actual docx-preview DOM blocks.
      // paginate() uses their simple sum; its capacity assumes a flat rectangle.
      const blockHeightPx = first.heights.reduce((a, b) => a + b, 0);
      const standardCapacityPx = (PAGE.height - 2 * documentPageStyle().margin - 12) * 96 / 72;
      const estimatedMinPages = Math.max(1, Math.ceil(blockHeightPx / standardCapacityPx));
      let candidatePartition: number[][] | null = null;
      try {
        const count = fixture.pages ?? Math.min(8, estimatedMinPages);
        candidatePartition = paginate(spec, first.heights, count).pages;
      } catch { /* Failure is recorded explicitly below; no silent reclassification. */ }
      const produced = await produceDocument({
        spec, browser, deadlineMs: Date.now() + 100000,
        // Deterministic, nonbillable reviewer explicitly BLOCKS the visual design.
        // This tests that mechanically valid output may nevertheless be returned.
        inspect: async rendered => ({
          pages: rendered.images.map((_, i) => ({
            page: i + 1, verdict: 'pass' as const, repair: 'none' as const,
            observations: 'Mechanical page checks only; professional design has not been approved.',
          })),
          design: {
            verdict: 'blocked' as const,
            summary: 'Independent professional design acceptance is intentionally withheld in this baseline.',
            issues: [{ page: 0, category: 'balance' as const, severity: 'material' as const,
              evidence: 'This is a diagnostic blocked verdict, not a finding that the rendered page is aesthetically accepted.' }],
            actions: [], comparison: 'not_applicable' as const,
          },
        }),
      });
      assert.deepEqual(produced.inspection.findings, [], fixture.name + ': no mechanical errors may be delivered');
      assert.equal(produced.inspection.visual, 'technical-only',
        'Blocked visual critique must not be mislabeled as professional approval');
      if (fixture.pages) assert.equal(produced.inspection.pageCount, fixture.pages,
        fixture.name + ': explicit page count must survive into the actual generator');
      const word = await mammoth.extractRawText({ buffer: produced.docx });
      assert.equal(normalizedText(word.value), normalizedText(contentText(spec)),
        fixture.name + ': DOCX source text changed');
      const extracted = await rasterizePdf(browser, produced.pdf);
      assert.equal(pdfTextMatchesSource(extracted.text, contentText(spec), extracted.fragments), true,
        fixture.name + ': PDF source glyphs changed');
      const archive = await JSZip.loadAsync(produced.docx);
      const documentXml = await archive.file('word/document.xml')!.async('string');
      const fontSizes = [...documentXml.matchAll(/<w:sz\b[^>]*\bw:val="(\d+)"/g)].map(m => Number(m[1]));
      assert.ok(fontSizes.length > 0, fixture.name + ': missing explicit text sizes');
      assert.ok(Math.min(...fontSizes) >= 22, fixture.name + ': direct run font smaller than 11pt');
      const sectionCount = [...documentXml.matchAll(/<w:sectPr\b/g)].length;
      assert.ok(sectionCount >= 1, fixture.name + ': missing section definitions');
      writeFileSync(`${ROOT}/${fixture.name}.docx`, produced.docx);
      writeFileSync(`${ROOT}/${fixture.name}.pdf`, produced.pdf);
      for (let i = 0; i < produced.images.length; i++)
        writeFileSync(`${ROOT}/${fixture.name}-page-${i + 1}.png`, produced.images[i]);
      writeFileSync(`${ROOT}/${fixture.name}.json`, JSON.stringify({
        fixture: fixture.name, source_sha256: hash(source), source_character_count: contentText(spec).length,
        source_blocks: spec.blocks.map(b => b.kind), required_pages: spec.targetPages ?? null,
        initial_pdf_pages: first.inspection.pageCount,
        initial_findings: first.inspection.findings.map(f => f.rule),
        per_block_measured_heights_px: first.heights.map(x => Number(x.toFixed(3))),
        measured_total_block_heights_px: Number(blockHeightPx.toFixed(3)),
        mathematical_capacity_px: Number(standardCapacityPx.toFixed(3)), estimated_min_pages: estimatedMinPages,
        estimated_partitions: candidatePartition, actual_pdf_pages: produced.inspection.pageCount,
        actual_docx_sections: sectionCount, min_explicit_run_halfpoints: Math.min(...fontSizes),
        visual_acceptance: produced.inspection.visual, visual_verdict_intentionally_blocked: true,
        browser_pdf_sha256: hash(produced.pdf), docx_sha256: hash(produced.docx),
        pending_professional_design_acceptance: true,
      }, null, 2));
    }
    // Deliberately force three Word sections on a two-page-intended synthetic resume.
    // This is a mechanism reproduction, NOT evidence that paginate() chose three
    // sections on this synthetic content itself.
    const source = readFileSync(fixtures[0].path, 'utf8');
    const spec = parseDocument(source, 2);
    const cuts = [0, Math.floor(spec.blocks.length / 3), Math.floor(2 * spec.blocks.length / 3), spec.blocks.length];
    const parts = [0,1,2].map(i => Array.from({length:cuts[i+1]-cuts[i]}, (_,j)=>cuts[i]+j));
    const forced = await generateDocx(spec, {pages:parts,spacing:4});
    const forcedRendered = await renderDocument(browser, forced, spec);
    assert.ok(forcedRendered.inspection.pageCount >= 3,
      'Section-per-partition reproduction must show forced page starts');
    writeFileSync(`${ROOT}/forced-sections.docx`, forced);
    writeFileSync(`${ROOT}/forced-sections.pdf`, forcedRendered.pdf);
    for(let i=0;i<forcedRendered.images.length;i++)
      writeFileSync(`${ROOT}/forced-sections-page-${i+1}.png`, forcedRendered.images[i]);
    writeFileSync(`${ROOT}/forced-sections.json`, JSON.stringify({
      explicit_target_pages: 2, imposed_sections: 3, actual_browser_pages: forcedRendered.inspection.pageCount,
      inspection_findings: forcedRendered.inspection.findings, known_structural_defect_reproduced: true,
      not_accepted_as_correct_layout: true,
    },null,2));
  } finally { await browser.close(); }
});
