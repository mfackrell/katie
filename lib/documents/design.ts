import { z } from 'zod';
import { PAGE, documentPageStyle, paginate, type Layout, type DesignControls } from './generate';
import type { DocumentSpec } from './model';

/** A document-wide critique, independent of PDF text and geometry checks.
 * Finite actions are semantic design intents, not untrusted CSS or code. */
export const designActionSchema = z.enum([
  'section-separation', 'list-rhythm', 'line-rhythm',
  'heading-hierarchy', 'page-balance',
  'compact-layout', 'natural-reflow', 'group-continuity',
]);
export type DesignAction = z.infer<typeof designActionSchema>;

export const designAssessmentSchema = z.object({
  verdict: z.enum(['pass', 'repair', 'blocked']),
  summary: z.string().min(15).max(1200),
  issues: z.array(z.object({
    page: z.number().int().min(0).max(PAGE.maxPages),
    category: z.enum(['hierarchy', 'density', 'balance', 'section-continuity', 'lists', 'other']),
    severity: z.enum(['minor', 'material']),
    evidence: z.string().min(12).max(500),
  }).strict()).max(8),
  actions: z.array(designActionSchema).max(2),
  comparison: z.enum(['not_applicable', 'improved', 'unchanged', 'regressed']),
}).strict().superRefine((report, ctx) => {
  const hasMaterial = report.issues.some(issue => issue.severity === 'material');
  if (report.verdict === 'pass' && (hasMaterial || report.actions.length))
    ctx.addIssue({code:'custom', message:'A design PASS cannot carry material problems or repair actions.'});
  if (report.verdict === 'repair' && (!hasMaterial || !report.actions.length))
    ctx.addIssue({code:'custom', message:'A design REPAIR requires material evidence and a bounded action.'});
  if (report.verdict === 'blocked' && report.actions.length)
    ctx.addIssue({code:'custom', message:'Blocked designs cannot request automatic repair actions.'});
});
export type DesignAssessment = z.infer<typeof designAssessmentSchema>;

export const DEFAULT_DESIGN: DesignControls = Object.freeze({
  sectionGap: 1,
  listGap: 1,
  lineScale: 1,
  hierarchy: 1,
});
const CEILINGS: DesignControls = {
  sectionGap: 1.85,
  listGap: 1.65,
  lineScale: 1.13,
  hierarchy: 1.15,
};

/** Owner constraints are immutable. Reject even an internal invalid design
 * profile rather than letting a model choose arbitrary font sizes or margins. */
export function validDesign(layout: Layout): boolean {
  if (!layout.design) return true;
  return Object.keys(layout.design).length === Object.keys(DEFAULT_DESIGN).length &&
    (Object.keys(layout.design) as Array<keyof DesignControls>).every(key =>
    Object.hasOwn(DEFAULT_DESIGN, key) &&
    typeof layout.design![key] === 'number' &&
    Number.isFinite(layout.design![key]) &&
    layout.design![key]! >= DEFAULT_DESIGN[key] &&
    layout.design![key]! <= CEILINGS[key]
  );
}

/** Apply material, evidence-backed directions using the measured page capacity.
 * Nothing here selects a template, changes text, alters page limits, or runs
 * provider code. Every proposal must be re-rendered and re-inspected. */
export function proposeDesignLayout(
  layout: Layout, spec: DocumentSpec, heights: readonly number[],
  assessment: DesignAssessment, renderedPageCount = layout.pages.length,
): Layout | null {
  if (assessment.verdict !== 'repair' ||
      !assessment.issues.some(issue => issue.severity === 'material') ||
      assessment.actions.length === 0 || !validDesign(layout) ||
      heights.length !== spec.blocks.length) return null;

  // These intents change actual pagination strategy, not untrusted CSS.
  // The producer must re-render and reject violations of page count, glyphs
  // or visual regression before replacing its last accepted candidate.
  if (assessment.actions.includes('natural-reflow') && layout.pages.length > 1)
    return { ...layout, pages: [spec.blocks.map((_,i)=>i)] };
  if (assessment.actions.includes('compact-layout') && !layout.compact)
    return { ...layout, pages: [spec.blocks.map((_,i)=>i)], spacing: 2, compact: true };
  if (assessment.actions.includes('group-continuity') && renderedPageCount > 1) {
    try {
      const grouped = paginate(spec, Array.from(heights), renderedPageCount, layout.spacing, layout.compact, layout.design);
      if (JSON.stringify(grouped.pages) !== JSON.stringify(layout.pages)) return grouped;
    } catch { /* The renderer remains authoritative; fall through to other bounded actions. */ }
  }
  const capacity = (PAGE.height - 2 * documentPageStyle(layout).margin - 12) * 96 / 72;
  // A global style change must fit the most crowded page; sum-of-pages slack
  // would incorrectly spend empty space on page 2 to overflow page 1.
  const pageSlack = layout.pages.map(indices =>
    capacity - indices.reduce((sum,i)=>sum + (heights[i] ?? 0),0));
  const remaining = Math.max(0,Math.min(...pageSlack));
  // Guard room for line wrapping and height-estimation error. Improvements
  // consume at most 60% of the tightest page's genuine spare space.
  let budget = Math.max(0, remaining * 0.6 - 12);
  const headings = spec.blocks.filter(b => b.kind === 'heading').length;
  const bullets = spec.blocks.filter(b => b.kind === 'bullet').length;
  const profile: DesignControls = { ...DEFAULT_DESIGN, ...layout.design };
  const start = { ...profile };
  const increase = (key: keyof DesignControls, requested: number, pxPerUnit: number) => {
    const proposed = Math.min(requested, CEILINGS[key] - profile[key]);
    if (proposed <= 0) return;
    // Geometry estimate is conservative; the actual DOCX/PDF renderer
    // remains the authority, and no overfull result is deliverable.
    const delta = Math.min(proposed, budget / Math.max(pxPerUnit, 1));
    if (delta < 0.02) return;
    profile[key] = Number((profile[key] + delta).toFixed(3));
    budget = Math.max(0, budget - delta * pxPerUnit);
  };

  for (const action of new Set(assessment.actions)) {
    if (action === 'section-separation')
      increase('sectionGap', 0.28, headings * 19);
    else if (action === 'list-rhythm')
      increase('listGap', 0.28, bullets * 5);
    else if (action === 'line-rhythm')
      increase('lineScale', 0.04, heights.reduce((a,b)=>a+b,0));
    else if (action === 'heading-hierarchy')
      increase('hierarchy', 0.07, headings * 45);
    else if (action === 'page-balance') {
      increase('sectionGap', 0.4, headings * 19);
      increase('listGap', 0.3, bullets * 5);
    }
  }

  return Object.keys(profile).some(key =>
    profile[key as keyof DesignControls] !== start[key as keyof DesignControls]
  ) ? { ...layout, design: profile } : null;
}

export function designReviewResponseIsActionable(report: DesignAssessment): boolean {
  return report.verdict === 'repair' &&
    report.actions.length > 0 &&
    report.issues.some(issue => issue.severity === 'material');
}
