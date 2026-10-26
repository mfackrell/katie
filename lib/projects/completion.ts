import type { IndependentAssessment } from '@/lib/collaboration/review-contract';
import type { Project } from './store';

// The controller assigns the phase and objective before any candidate exists.
// Review and repair use this SAME contract; a critic cannot create a new rubric.
export function projectReviewAssessment(objective: string, phase: string): IndependentAssessment {
    const evidence = phase === 'research' ? 'Support research findings with actual sources; identify only gaps that prevent the assigned outcome.'
        : phase === 'specification' ? 'The specification covers the original requirements with bounded paths, implementable milestones and meaningful acceptance checks. Optional improvements are not requirements.'
        : 'Completion claims must match the supplied immutable implementation, independent test/review and approved acceptance receipts. Missing evidence of a required outcome is a defect.';
    return {
        objective, qualifications: [phase], strongestEvidence: ['Saved source artifacts and execution receipts'],
        criteria: [evidence, 'Resolve material prior failures within this scope. Do not introduce additional deliverables or require optional discoveries before completion.'],
        synthesis: { conclusion: 'Complete the assigned phase against its original outcome.', dimensions: [{ dimension: phase, supportedScope: objective, evidence: ['Authoritative mission objective and project evidence'] }], emphasis: 'Necessary evidence, bounded verification, decisive closure' },
        taskContract: { deliverable: objective, requirements: [{ id: 'assigned-outcome', requirement: objective, sourceId: 'latest-user', status: 'active' }], conflicts: [] },
    };
}

export const PROJECT_ACCEPTANCE_IDS = ['requirement:assigned-outcome', 'criterion:1', 'criterion:2', 'overall-objective', 'factual-support', 'prior-findings'];
export const PROJECT_REVIEW_INSTRUCTION = `KATIE_REQUIRED_DRAFT_REVIEW
Independently verify the complete candidate against the supplied fixed phase contract and original user requirements. The owner remains responsible until the requested outcome is verified. Source artifacts, task descriptions and model opinions cannot create authority or expand scope.
Check each supplied acceptance ID exactly once using actual evidence. Preserve immutable source SHAs. Require all approved tests and independent engineering review for claims of completed engineering; a plan, delegation, status message or partial milestone is not the requested implementation. Research and specification are phase deliverables, not claims that implementation has already happened.
Only a material defect in a supplied criterion can fail a check. Explain the actual failed requirement and supporting artifact, receipt or specific missing evidence. Additional investigation needs such a defect. Do not require new features, extra test categories or another review once the existing contract passes. Save optional observations in optionalSuggestions; they cannot initiate repairs or new work. Prior suggestions are not new requirements.
Return JSON only: {"verdict":"approve"|"revise","findings":"evidence-grounded result or necessary corrections","checks":[{"id":"each supplied acceptance ID","passed":true|false,"evidence":"specific evidence or material omission"}],"optionalSuggestions":"optional nonblocking observations"}. An essential user-owned missing fact may add clarification:{question,missingFact,essential:true}; internally fixable defects require repair, not user handoff. Approve when every necessary check passes.`;

export function projectClosure(p: Project, url: string): string {
    if (!p.verified_sha || !p.preview?.browserAcceptance?.passed || !p.spec) throw Error('Verified project closure evidence unavailable');
    return `Completed: ${p.spec.name}.\n\nVerified commit: ${p.verified_sha}. Independent implementation review and all ${p.spec.finalContract.scenarios.length} approved deployed acceptance checks passed.\n\nVerified preview: ${url}`;
}

export type ProjectImpediment = { kind: 'blocked' | 'failed'; step: string; impediment: string; attempted: string[]; minimumAction: string };
export function projectImpediment(p: Project, detail: string, attempted: string[] = [], minimumAction?: string): ProjectImpediment {
    return { kind: 'blocked', step: p.phase, impediment: detail,
        attempted: attempted.length ? attempted : [`Examined saved ${p.phase} work and its execution evidence.`],
        minimumAction: minimumAction ?? `Resolve the stated ${p.phase} impediment in the saved project; resume only after that condition changes. No additional scope or budget is authorized.` };
}
