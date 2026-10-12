import type { AnswerReview, IndependentAssessment } from "@/lib/collaboration/review-contract";

/** Persisted in the original chat_requests.review_audit row, scoped to its actor and chat. */
export type PendingReviewClarification = {
  question: string;
  reason: string;
  deliverable: string;
  candidate: string;
  requirementIds: string[];
  createdAt: string;
  resolvedAt?: string;
  resumedByRequestId?: string;
};

export function createReviewClarification(input: {
  assessment: IndependentAssessment;
  review: AnswerReview;
  candidate: string;
  now?: string;
}): PendingReviewClarification {
  const requirements = input.assessment.taskContract.requirements;
  const failed = input.review.checks.filter(check => !check.passed);
  const blocked = failed.filter(check => check.id.startsWith("requirement:"));
  const requirementIds = blocked.map(check => check.id.slice("requirement:".length));
  const requirement = requirements.find(item => item.status === "active" && requirementIds.includes(item.id));
  const explicitQuestion = input.review.clarification?.question?.trim();
  const question = explicitQuestion || (requirement
    ? `Before I finalize ${input.assessment.taskContract.deliverable}, can you clarify this outstanding requirement: ${requirement.requirement}? If those details aren't available, say "unknown" and I'll finish using only verified information.`
    : `I have saved your draft, but the final review still has an unresolved issue. ${input.review.findings.slice(0, 480)} Can you clarify how to handle this, or tell me to proceed using only the facts already verified?`);
  return {
    question,
    reason: input.review.findings,
    deliverable: input.assessment.taskContract.deliverable,
    candidate: input.candidate,
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
    `QUESTION ASKED: ${pending.question}`,
    `LAST REVIEW FINDINGS: ${pending.reason}`,
    `SAVED WORKING DRAFT (not automatically approved; correct it as needed):\n${pending.candidate}`,
    `LATEST USER RESPONSE:\n${latestUserReply}`,
    "Return the complete finished deliverable whenever the user's answer permits it.",
  ].join("\n\n");
}
