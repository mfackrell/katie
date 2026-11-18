/** Best Answer: delivery receipts alone do not prove task-specific answer quality. */
type Feedback = {outcome?: string; source?: string; task_excerpt?: string | null; dimension?: string};
type CandidateEvidence = {quality?: {feedback?: {evidence?: Feedback[]}}};
const priorQualityClaim = /\b(?:proven|confirmed effective|previously demonstrated|established track record|stronger track record|superior prior results|prior performance (?:proves|confirms))\b/i;
export function bestAnswerClaimSupported(
  justification: string,
  alternatives: Array<{whyNotSelected: string}>,
  selectedEvidence?: CandidateEvidence
): boolean {
  const claims = [justification, ...alternatives.map(x => x.whyNotSelected)];
  // Explicit denials of proof must not themselves count as affirmative claims.
  const affirmative = claims.some(text => priorQualityClaim.test(text.replace(
    /\b(?:no evidence of|not|never|without|cannot claim|has not been)\s+(?:an?\s+)?(?:proven|established|demonstrated|confirmed)/gi,
    "unverified")));
  if (!affirmative) return true;
  // A prior generated message or a delivery PASS is not a quality measurement.
  // Require attributed positive task feedback with an identified source task.
  return Boolean(selectedEvidence?.quality?.feedback?.evidence?.some(row =>
    row.outcome === "positive" && Boolean(row.task_excerpt?.trim()) &&
    ["message_reaction", "adjacent_user_feedback", "internal_review"].includes(row.source ?? "")));
}
