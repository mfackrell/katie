import type { Browser } from 'playwright-core';
import { z } from 'zod';
import { generateDocx, paginate, PAGE, DocumentPageFitError, documentPageStyle, type Layout } from './generate';
import { documentSchema, type DocumentSpec, type Inspection } from './model';
import { renderDocument, type RenderedDocument } from './render';
import { designAssessmentSchema, proposeDesignLayout, validDesign } from './design';

export const visualReportSchema = z.object({ pages: z.array(z.object({
  page: z.number().int().positive(), verdict: z.enum(['pass', 'repair', 'blocked']),
  observations: z.string().min(15).max(1500),
  repair: z.enum(['none', 'increase_spacing', 'repaginate']),
}).strict()).min(1).max(PAGE.maxPages), design: designAssessmentSchema.optional() }).strict();
export type VisualReport = z.infer<typeof visualReportSchema>;
export type VisualInspector = (rendered: RenderedDocument, attempt: number, context?: { previous?: RenderedDocument; layout: Layout }) => Promise<VisualReport>;
export type ProductionResult = { docx: Buffer; pdf: Buffer; images: Buffer[]; inspection: Inspection; corrections: number; attempts: Array<{ findings: Inspection['findings']; visual?: VisualReport }> };

/** The first overfull layout is only a measuring pass, not an acceptable PDF.
 * Reading-order differences caused by clipping can be rechecked once after
 * pagination. A clean-layout mismatch or any post-reflow mismatch is fatal. */
export function shouldStopForReadingOrder(findings: Inspection['findings'], attempt: number, additionalMeasuringPass = false): boolean {
  if (!findings.some(f => f.rule === 'reading-order')) return false;
  return (attempt !== 0 && !additionalMeasuringPass) || !findings.some(f => f.rule === 'overflow' || f.rule === 'page-count');
}

/** A failed exact two-page fit may try a genuinely smaller *layout footprint*,
 * never smaller text or reduced factual content. A second fit failure is final. */
export function shouldTryCompactLayout(error: unknown, attempt: number, spec: DocumentSpec, layout: Layout): boolean {
  return error instanceof DocumentPageFitError && attempt === 0 && spec.targetPages === 2 && !layout.compact;
}

/** Reusable, provider-independent workflow. Tests must supply an inspector of actual rendered bytes. */
export async function produceDocument(input: {
  spec: DocumentSpec; browser: Browser; inspect: VisualInspector; deadlineMs: number;
  initialLayout?: Layout;
  /** Production requires a document-wide design critique; older fixture callbacks remain compatible. */
  requireDesignAssessment?: boolean;
}): Promise<ProductionResult> {
  const spec = documentSchema.parse(input.spec);
  let layout: Layout = input.initialLayout ?? { pages: [spec.blocks.map((_, i) => i)], spacing: 4 };
  const indices = layout.pages.flat();
  if (JSON.stringify(indices) !== JSON.stringify(spec.blocks.map((_, i) => i)) || !Number.isFinite(layout.spacing) || layout.spacing < 2 || layout.spacing > 12 || !validDesign(layout)) throw new Error('Invalid document layout.');
  const attempts: ProductionResult['attempts'] = [];
  let designCorrections = 0;
  let previousDesign: RenderedDocument | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (Date.now() >= input.deadlineMs) throw new Error('Document production deadline reached. No delivery claimed.');
    const docx = await generateDocx(spec, layout);
    const rendered = await renderDocument(input.browser, docx, spec, layout);
    const record: ProductionResult['attempts'][number] = { findings: rendered.inspection.findings }; attempts.push(record);
    if (!record.findings.length) {
      const visual = visualReportSchema.parse(await input.inspect(rendered, attempt, { previous: previousDesign, layout })); record.visual = visual;
      if (visual.pages.length !== rendered.images.length || new Set(visual.pages.map(p => p.page)).size !== rendered.images.length || visual.pages.some(p => p.page > rendered.images.length))
        throw new Error('Visual inspection did not evaluate every rendered page.');
      if (visual.design?.issues.some(issue => issue.page > rendered.images.length))
        throw new Error('Document design review referenced an unrendered page. No files delivered.');
      if (input.requireDesignAssessment && !visual.design)
        throw new Error('Professional document-design assessment was omitted. No files delivered.');
      if (previousDesign) {
        if (rendered.inspection.pageHashes.every((h,i)=>h===previousDesign!.inspection.pageHashes[i]))
          throw new Error('Document design repair produced unchanged rendered pages. No files delivered.');
        if (visual.design?.comparison !== 'improved')
          throw new Error('Document design revision did not demonstrate improvement. No files delivered.');
      }
      const pagesPass = visual.pages.every(p => p.verdict === 'pass' && p.repair === 'none');
      if (pagesPass && (!visual.design || visual.design.verdict === 'pass')) {
        rendered.inspection.visual = 'passed';
        return { docx, pdf: rendered.pdf, images: rendered.images, inspection: rendered.inspection, corrections: attempt, attempts };
      }
      for (const p of visual.pages.filter(p => p.verdict !== 'pass'))
        record.findings.push({ rule: 'visual', page: p.page, detail: p.observations });
      if (visual.pages.some(p => p.verdict === 'blocked' || p.verdict === 'repair' && p.repair === 'none') ||
          visual.design?.verdict === 'blocked')
        throw new Error('Document inspection found a defect outside bounded automatic repair. No files delivered.');

      // A design repair is meaningful only with a material, page-grounded
      // finding and a supported safe intent. One failed or repeated critique
      // does not cause an unbounded model call or arbitrary CSS changes.
      if (visual.design?.verdict === 'repair') {
        if (designCorrections >= 2)
          throw new Error('Professional document design did not converge within two revisions. No files delivered.');
        const next = proposeDesignLayout(layout, spec, rendered.heights, visual.design);
        if (!next) throw new Error('No safe, material document design adjustment is available. No files delivered.');
        previousDesign = rendered;
        layout = next;
        designCorrections++;
        continue;
      }
      if (visual.pages.some(p => p.repair === 'increase_spacing')) {
        const spacing = Math.min(10, layout.spacing + 2);
        if (spacing === layout.spacing)
          throw new Error('Document spacing repair made no progress. No files delivered.');
        layout = { ...layout, spacing };
        continue;
      }

    }
    // An intentionally overfull initial page can produce a truncated or reordered
    // intermediate PDF. Try the normal, bounded pagination repair ONCE before
    // requiring exact text fidelity on the re-rendered final candidate.
    // No PDF can be delivered unless the final inspection has zero findings.
    if (shouldStopForReadingOrder(record.findings, attempt, Boolean(layout.compact && layout.pages.length === 1 && spec.targetPages !== 1))) {
      const expected = rendered.inspection.extractedText;
      // Record only bounded diagnostic counts, never private document text.
      console.warn('[Document Fidelity] final reading-order mismatch', {
        attempt, sourceChars: spec.blocks.reduce((n, b) => n + (b.kind === 'table' ? b.rows.flat().join(' ').length : b.text.length), 0),
        extractedChars: expected.length, pages: rendered.images.length,
        findings: record.findings.map(f => f.rule),
      });
      throw new Error('Text fidelity or ATS reading-order validation failed. No files delivered.');
    }
    const capacity = (PAGE.height - 2 * documentPageStyle(layout).margin - 12) * 96 / 72;
    const minimum = Math.max(1, Math.ceil(rendered.heights.reduce((a, b) => a + b, 0) / capacity));
    const pages = spec.targetPages ?? Math.min(PAGE.maxPages, minimum);
    try {
      const next = paginate(spec, rendered.heights, pages, layout.spacing, layout.compact, layout.design);
      if (!record.findings.length && JSON.stringify(next) === JSON.stringify(layout))
        throw new Error('Document repagination made no measurable progress. No files delivered.');
      layout = next;
    } catch (error) {
      if (!shouldTryCompactLayout(error, attempt, spec, layout)) throw error;
      console.info('[DocumentLayout] trying compact 11-point layout after standard fit failed', {
        blocks: spec.blocks.length, targetPages: 2, marginPt: 36,
      });
      // A new measuring pass is essential: line spacing and available text width
      // changed, so standard-layout heights cannot be reused for pagination.
      layout = { pages: [spec.blocks.map((_, i) => i)], spacing: 2, compact: true };
    }
  }
  throw new Error('Document failed bounded technical/design acceptance after six passes. No files delivered.');
}
