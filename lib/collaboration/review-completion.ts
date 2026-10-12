import type { AnswerReview, IndependentAssessment, SourceTurn } from "@/lib/collaboration/review-contract";

/** Persisted in the original chat_requests.review_audit row, scoped to its actor and chat. */
export type PendingReviewClarification = {
  question: string;
  reason: string;
  deliverable: string;
  candidate: string;
  requirementIds: string[];
  sourceTurns?: SourceTurn[];
  createdAt: string;
  resolvedAt?: string;
  resumedByRequestId?: string;
};

export function createReviewClarification(input: {
  assessment: IndependentAssessment;
  review: AnswerReview;
  candidate: string;
  sourceTurns?: SourceTurn[];
  now?: string;
}): PendingReviewClarification | null {
  // The reviewer must explicitly establish that a user-owned fact is essential.
  // A failed requirement is NOT permission to invent a clarification question.
  if (input.review.clarification?.essential !== true) return null;
  const question = input.review.clarification.question.trim();
  const missingFact = input.review.clarification.missingFact.trim();
  if (!question || !missingFact || !question.includes("?")) return null;
  const requirements = input.assessment.taskContract.requirements;
  const failed = input.review.checks.filter(check => !check.passed);
  const blocked = failed.filter(check => check.id.startsWith("requirement:"));
  const requirementIds = blocked.map(check => check.id.slice("requirement:".length));
  // Do not copy the task-contract requirement back to the user as a question.
  // The reviewer must supply a precise, evidence-based request for a missing fact.
  const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (requirements.some(r => normalized(question).replace(/^(can you clarify|please clarify|could you clarify) /, "") === normalized(r.requirement))) return null;
  return {
    question,
    reason: `Missing essential user fact: ${missingFact}. ${input.review.findings}`,
    deliverable: input.assessment.taskContract.deliverable,
    candidate: input.candidate,
    sourceTurns: input.sourceTurns,
    requirementIds,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

/** This context is for the lead model ONLY. Do not pass the prior draft to the independent assessor. */
export function buildReviewResumptionContext(pending: PendingReviewClarification, latestUserReply: string): string {
  return [
    "KATIE_RESUME_PENDING_COMPLETION",
    "The user is responding to a clarification that interrupted an existing task. You own the original deliverable; resume it rather than replying with a standalone acknowledgment.",
    "Preserve verified facts and all prior work. Treat a reply of 'unknown', 'I don't know', or 'use what you have' as permission to finish with only verified information, not as a reason to ask for the same facts again.",
    "If the latest message explicitly starts a different task or cancels the old one, honor that instead. Never fabricate the missing values.",
    "Do not include requests to the user or review commentary inside the final deliverable.",
    `ORIGINAL DELIVERABLE: ${pending.deliverable}`,
    `ORIGINAL AUTHORITATIVE USER TURNS: ${JSON.stringify(pending.sourceTurns ?? [])}`,
    `QUESTION ASKED: ${pending.question}`,
    `LAST REVIEW FINDINGS: ${pending.reason}`,
    `SAVED WORKING DRAFT (not automatically approved; correct it as needed):\n${pending.candidate}`,
    `LATEST USER RESPONSE:\n${latestUserReply}`,
    "Return the complete finished deliverable whenever the user's answer permits it.",
  ].join("\n\n");
}
