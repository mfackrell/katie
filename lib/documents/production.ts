import type { Browser } from 'playwright-core';
import { z } from 'zod';
import { generateDocx, paginate, PAGE, type Layout } from './generate';
import { documentSchema, type DocumentSpec, type Inspection } from './model';
import { renderDocument, type RenderedDocument } from './render';

export const visualReportSchema = z.object({ pages: z.array(z.object({
  page: z.number().int().positive(), verdict: z.enum(['pass', 'repair', 'blocked']),
  observations: z.string().min(15).max(1500),
  repair: z.enum(['none', 'increase_spacing', 'repaginate']),
}).strict()).min(1).max(PAGE.maxPages) }).strict();
export type VisualReport = z.infer<typeof visualReportSchema>;
export type VisualInspector = (rendered: RenderedDocument, attempt: number) => Promise<VisualReport>;
export type ProductionResult = { docx: Buffer; pdf: Buffer; images: Buffer[]; inspection: Inspection; corrections: number; attempts: Array<{ findings: Inspection['findings']; visual?: VisualReport }> };

/** The first overfull layout is only a measuring pass, not an acceptable PDF.
 * Reading-order differences caused by clipping can be rechecked once after
 * pagination. A clean-layout mismatch or any post-reflow mismatch is fatal. */
export function shouldStopForReadingOrder(findings: Inspection['findings'], attempt: number): boolean {
  if (!findings.some(f => f.rule === 'reading-order')) return false;
  return attempt !== 0 || !findings.some(f => f.rule === 'overflow' || f.rule === 'page-count');
}

/** Reusable, provider-independent workflow. Tests must supply an inspector of actual rendered bytes. */
export async function produceDocument(input: {
  spec: DocumentSpec; browser: Browser; inspect: VisualInspector; deadlineMs: number;
  initialLayout?: Layout;
}): Promise<ProductionResult> {
  const spec = documentSchema.parse(input.spec);
  let layout: Layout = input.initialLayout ?? { pages: [spec.blocks.map((_, i) => i)], spacing: 4 };
  const indices = layout.pages.flat();
  if (JSON.stringify(indices) !== JSON.stringify(spec.blocks.map((_, i) => i)) || !Number.isFinite(layout.spacing) || layout.spacing < 2 || layout.spacing > 12) throw new Error('Invalid document layout.');
  const attempts: ProductionResult['attempts'] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    if (Date.now() >= input.deadlineMs) throw new Error('Document production deadline reached. No delivery claimed.');
    const docx = await generateDocx(spec, layout);
    const rendered = await renderDocument(input.browser, docx, spec);
    const record: ProductionResult['attempts'][number] = { findings: rendered.inspection.findings }; attempts.push(record);
    if (!record.findings.length) {
      const visual = visualReportSchema.parse(await input.inspect(rendered, attempt)); record.visual = visual;
      if (visual.pages.length !== rendered.images.length || new Set(visual.pages.map(p => p.page)).size !== rendered.images.length || visual.pages.some(p => p.page > rendered.images.length))
        throw new Error('Visual inspection did not evaluate every rendered page.');
      if (visual.pages.every(p => p.verdict === 'pass' && p.repair === 'none')) {
        rendered.inspection.visual = 'passed';
        return { docx, pdf: rendered.pdf, images: rendered.images, inspection: rendered.inspection, corrections: attempt, attempts };
      }
      for (const p of visual.pages.filter(p => p.verdict !== 'pass')) record.findings.push({ rule: 'visual', page: p.page, detail: p.observations });
      if (visual.pages.some(p => p.verdict === 'blocked' || p.verdict === 'repair' && p.repair === 'none'))
        throw new Error('Visual inspection found a defect outside safe automatic formatting repair. No files delivered.');
      if (visual.pages.some(p => p.repair === 'increase_spacing')) {
        layout = { ...layout, spacing: Math.min(10, layout.spacing + 2) }; continue;
      }
    }
    // An intentionally overfull initial page can produce a truncated or reordered
    // intermediate PDF. Try the normal, bounded pagination repair ONCE before
    // requiring exact text fidelity on the re-rendered final candidate.
    // No PDF can be delivered unless the final inspection has zero findings.
    if (shouldStopForReadingOrder(record.findings, attempt)) {
      const expected = rendered.inspection.extractedText;
      // Record only bounded diagnostic counts, never private document text.
      console.warn('[Document Fidelity] final reading-order mismatch', {
        attempt, sourceChars: spec.blocks.reduce((n, b) => n + (b.kind === 'table' ? b.rows.flat().join(' ').length : b.text.length), 0),
        extractedChars: expected.length, pages: rendered.images.length,
        findings: record.findings.map(f => f.rule),
      });
      throw new Error('Text fidelity or ATS reading-order validation failed. No files delivered.');
    }
    const minimum = Math.max(1, Math.ceil(rendered.heights.reduce((a, b) => a + b, 0) / ((PAGE.height - 2 * PAGE.margin - 12) * 96 / 72)));
    const pages = spec.targetPages ?? Math.min(PAGE.maxPages, minimum);
    layout = paginate(spec, rendered.heights, pages, layout.spacing);
  }
  throw new Error('Document failed acceptance after three formatting corrections. No files delivered.');
}
