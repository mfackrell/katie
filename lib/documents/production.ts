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

/**
 * Compare real browser renderings before inserting any hard Word sections.
 * Compactness may save a page but never shrinks the explicit 11pt text.
 * An explicit page cap always wins over page minimization.
 * The comparison is deterministic and incurs no model/API costs.
 */
export async function chooseInitialComposition(
  spec: DocumentSpec, browser: Browser, deadlineMs: number,
): Promise<Layout> {
  const indices=spec.blocks.map((_,i)=>i);
  const candidates: Layout[]=[
    {pages:[indices],spacing:4},
    {pages:[indices],spacing:2},
    {pages:[indices],spacing:2,compact:true},
  ];
  const viable: Array<{layout:Layout;pages:number;order:number}>=[];
  for(let i=0;i<candidates.length;i++){
    if(Date.now()>=deadlineMs-1000)break;
    try {
      const docx=await generateDocx(spec,candidates[i]);
      const actual=await renderDocument(browser,docx,spec,candidates[i]);
      const hard=actual.inspection.findings.filter(f=>
        !(f.rule==='whitespace'&&f.detail==='Page uses less than one quarter of its content area.'));
      if(hard.length===0 && (!spec.targetPages || actual.inspection.pageCount===spec.targetPages))
        viable.push({layout:candidates[i],pages:actual.inspection.pageCount,order:i});
    } catch { /* A candidate is never approved without a valid rendered artifact. */ }
  }
  if(!viable.length) return candidates[0]; // Existing measured recovery remains mandatory.
  viable.sort((a,b)=>a.pages-b.pages||a.order-b.order);
  return viable[0].layout;
}

/** 
 * Mechanics decide whether a document may be delivered. Design review selects
 * between mechanically valid candidates and must never revoke the baseline.
 * Provider/accounting failures remain the caller's responsibility to classify.
 */
export async function produceDocument(input: {
  spec: DocumentSpec; browser: Browser; inspect: VisualInspector; deadlineMs: number;
  initialLayout?: Layout;
  /** Strict owner instruction: do not deliver technically valid but unapproved design. */
  requireProfessionalAcceptance?: boolean;
  /** Only explicitly safe, non-accounting presentation failures may be ignored. */
  canSkipDesignReviewError?: (error: unknown) => Promise<boolean>;
}): Promise<ProductionResult> {
  const spec = documentSchema.parse(input.spec);
  let layout: Layout = input.initialLayout ?? await chooseInitialComposition(spec,input.browser,input.deadlineMs);
  const indices = layout.pages.flat();
  if (JSON.stringify(indices) !== JSON.stringify(spec.blocks.map((_, i) => i)) ||
      !Number.isFinite(layout.spacing) || layout.spacing < 2 || layout.spacing > 12 ||
      !validDesign(layout)) throw new Error('Invalid document layout.');
  const attempts: ProductionResult['attempts'] = [];
  let lastValid: ProductionResult | null = null;
  let previousDesign: RenderedDocument | undefined;
  let designCorrections = 0;
  const accept = (result:ProductionResult):ProductionResult => {
    if(input.requireProfessionalAcceptance && result.inspection.visual !== 'passed')
      throw new Error('Professional visual design was not accepted. No files delivered.');
    return result;
  };

  // Receipt validation permits at most three corrections. The first few
  // passes may establish a technically valid pagination before optional design.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (Date.now() >= input.deadlineMs) {
      if (lastValid) return accept(lastValid);
      throw new Error('Document production deadline reached. No delivery claimed.');
    }

    let docx: Buffer, rendered: RenderedDocument;
    try {
      docx = await generateDocx(spec, layout);
      rendered = await renderDocument(input.browser, docx, spec, layout);
    } catch (error) {
      // A proposed aesthetic refinement is not allowed to destroy files that
      // already passed the independent mechanical checks.
      if (lastValid) return accept(lastValid);
      throw error;
    }

    // After establishing a mechanically valid page count, expand a condensed
    // composition within that same count. This is bounded, based on actual
    // rendered output and never modifies body font or source. Failed
    // refinements are discarded; the previously valid bytes remain.
    if (!input.initialLayout && rendered.inspection.findings.every(f =>
      f.rule === 'whitespace' &&
      f.detail === 'Page uses less than one quarter of its content area.'
    ) && layout.spacing < 8 && Date.now() < input.deadlineMs - 4000) {
      for (const candidateSpacing of [layout.spacing + 2, layout.spacing + 4]) {
        if (candidateSpacing > 8 || Date.now() >= input.deadlineMs - 4000) break;
        const trialLayout: Layout = { ...layout, spacing: candidateSpacing };
        try {
          const trialDocx = await generateDocx(spec,trialLayout);
          const trial = await renderDocument(input.browser,trialDocx,spec,trialLayout);
          const violations = trial.inspection.findings.filter(f=>!(f.rule==='whitespace' &&
            f.detail==='Page uses less than one quarter of its content area.'));
          if (violations.length || trial.inspection.pageCount!==rendered.inspection.pageCount) break;
          if (trial.heights.reduce((a,b)=>a+b,0) <= rendered.heights.reduce((a,b)=>a+b,0)) break;
          layout=trialLayout; docx=trialDocx; rendered=trial;
        } catch { break; }
      }
    }

    // Underutilization is presentation feedback; a completely empty page,
    // clipping, overlap, incorrect page count and text-fidelity errors remain
    // technical defects that must never be delivered.
    const mechanical = rendered.inspection.findings.filter(f =>
      !(f.rule === 'whitespace' && f.detail === 'Page uses less than one quarter of its content area.'));
    rendered.inspection.findings = mechanical;
    const record: ProductionResult['attempts'][number] = { findings: [...mechanical] };
    attempts.push(record);

    if (mechanical.length) {
      if (lastValid) return accept(lastValid);
      // Keep the original mandatory layout/fidelity recovery behavior. The
      // first overfull page is only a measuring pass, never delivered.
      if (shouldStopForReadingOrder(mechanical, attempt,
          Boolean(layout.compact && layout.pages.length === 1 && spec.targetPages !== 1))) {
        console.warn('[Document Fidelity] final reading-order mismatch', {
          attempt,
          sourceChars: spec.blocks.reduce((n, b) => n + (b.kind === 'table' ? b.rows.flat().join(' ').length : b.text.length), 0),
          extractedChars: rendered.inspection.extractedText.length,
          pages: rendered.images.length,
          findings: mechanical.map(f => f.rule),
        });
        throw new Error('Text fidelity or ATS reading-order validation failed. No files delivered.');
      }
      const capacity = (PAGE.height - 2 * documentPageStyle(layout).margin - 12) * 96 / 72;
      const minimum = Math.max(1, Math.ceil(rendered.heights.reduce((a, b) => a + b, 0) / capacity));
      const pages = spec.targetPages ?? Math.min(PAGE.maxPages, minimum);
      try {
        const next = paginate(spec, rendered.heights, pages, layout.spacing, layout.compact, layout.design);
        if (JSON.stringify(next) === JSON.stringify(layout))
          throw new Error('Document repagination made no measurable progress. No files delivered.');
        layout = next;
      } catch (error) {
        if (!shouldTryCompactLayout(error, attempt, spec, layout)) throw error;
        console.info('[DocumentLayout] trying compact 11-point layout after standard fit failed', {
          blocks: spec.blocks.length, targetPages: 2, marginPt: 36,
        });
        layout = { pages: [spec.blocks.map((_, i) => i)], spacing: 2, compact: true };
      }
      continue;
    }

    // Persist the most recent mechanically accepted candidate in memory before
    // making any optional model request. Storage/authentication still validates
    // these exact bytes, page hashes and identity before delivery.
    const candidate: ProductionResult = {
      docx, pdf: rendered.pdf, images: rendered.images,
      inspection: { ...rendered.inspection, findings: [], visual: 'technical-only' },
      corrections: attempt, attempts: [...attempts],
    };
    if (!lastValid) lastValid = candidate;
    if (previousDesign &&
        rendered.inspection.pageHashes.length === previousDesign.inspection.pageHashes.length &&
        rendered.inspection.pageHashes.every((h, i) => h === previousDesign!.inspection.pageHashes[i])) {
      console.info('[DocumentDesign] no changed raster after optional repair; retaining validated document');
      return accept(lastValid);
    }

    let visual: VisualReport;
    try {
      visual = visualReportSchema.parse(
        await input.inspect(rendered, attempt, { previous: previousDesign, layout }),
      );
      if (visual.pages.length !== rendered.images.length ||
          new Set(visual.pages.map(p => p.page)).size !== rendered.images.length ||
          visual.pages.some(p => p.page > rendered.images.length) ||
          visual.design?.issues.some(issue => issue.page > rendered.images.length))
        throw new Error('Design review did not evaluate the correct rendered pages.');
    } catch (error) {
      if (input.canSkipDesignReviewError && !(await input.canSkipDesignReviewError(error))) throw error;
      // The design model may be unavailable, unpriced, invalid or time out;
      // its failure never invalidates the independently verified DOCX/PDF.
      console.warn('[DocumentDesign] optional critique unavailable; preserving validated document', {
        type: error instanceof Error ? error.name : 'unknown',
      });
      return accept(lastValid);
    }
    record.visual = visual;

    // An unproven or regressed proposal is not a reason to discard the
    // mechanically valid original. Only a verified improvement can replace it.
    if (previousDesign && visual.design?.comparison !== 'improved') {
      console.info('[DocumentDesign] comparison did not verify improvement; preserving validated document');
      return accept(lastValid);
    }
    if (visual.design?.verdict === 'blocked' ||
        visual.pages.some(p => p.verdict === 'blocked' ||
          (p.verdict === 'repair' && p.repair === 'none'))) {
      console.info('[DocumentDesign] unresolved cosmetic critique; preserving validated document');
      return accept(lastValid);
    }

    if (previousDesign) lastValid = candidate;
    const pagesPass = visual.pages.every(p => p.verdict === 'pass' && p.repair === 'none');
    if (pagesPass && visual.design?.verdict !== 'repair') {
      if (visual.design?.verdict === 'pass') candidate.inspection.visual = 'passed';
      return accept(candidate);
    }

    // At most two optional corrections. No model-driven text changes, margin
    // violations or unchecked reflow. Stop trying when a safe action is absent.
    if (designCorrections >= 2 || attempt >= 3) return accept(lastValid);
    if (visual.design?.verdict === 'repair') {
      const next = proposeDesignLayout(layout, spec, rendered.heights, visual.design);
      if (!next) return accept(lastValid);
      previousDesign = rendered;
      layout = next;
      designCorrections++;
      continue;
    }
    if (visual.pages.some(p => p.repair === 'increase_spacing')) {
      const spacing = Math.min(10, layout.spacing + 2);
      if (spacing === layout.spacing) return accept(lastValid);
      previousDesign = rendered;
      layout = { ...layout, spacing };
      designCorrections++;
      continue;
    }
    return accept(lastValid);
  }
  if (lastValid) return accept(lastValid);
  throw new Error('Document failed mandatory technical validation. No files delivered.');
}
