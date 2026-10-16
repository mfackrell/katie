import type { AnswerReview, IndependentAssessment, SourceTurn } from "@/lib/collaboration/review-contract";
import { classifyUserTurn } from "@/lib/chat/task-progress";

/** Persisted in the original chat_requests.review_audit row, scoped to its actor and chat. */
export type PendingReviewClarification = {
  question: string;
  reason: string;
  deliverable: string;
  candidate: string;
  requirementIds: string[];
  sourceTurns?: SourceTurn[];
  /** Message IDs bind saved work to one project, deliverable and visible question. */
  binding?: { projectId: string; taskId: string; questionMessageId: string };
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
/**
 * An affirmative response to a failed-verification prompt authorizes reviewing
 * the SAVED candidate, not writing a new answer or reviving the previous task.
 */
export function isSavedDraftVerificationRetry(pending: PendingReviewClarification, reply: string): boolean {
  if (!/retry verification with the saved draft/i.test(pending.question)) return false;
  return /^(?:yes|y|yes please|please do|please retry|retry|(?:please )?retry verification(?: with (?:the )?saved draft)?|go ahead|go ahead and retry|do it|sure|ok|okay)[.! ]*$/i.test(reply.trim());
}

/**
 * Recover the most recent original new-task request from the saved firsthand
 * user turns. Old audit rows can end with a synthetic "This turn answers..."
 * wrapper: that wrapper is not itself the requested deliverable.
 */
export function candidateForVerification(
  pending: PendingReviewClarification | null,
  reply: string,
  generated: string,
): string {
  return pending && isSavedDraftVerificationRetry(pending, reply)
    ? pending.candidate
    : generated;
}

export function savedDraftReviewTask(pending: PendingReviewClarification): string | null {
  for (const turn of [...(pending.sourceTurns ?? [])].reverse()) {
    const text = turn.text.trim();
    if (/^(?:this turn answers|internal review task|the user replied:)/i.test(text)) continue;
    if (classifyUserTurn(text) === "new_task") return text;
  }
  return null;
}

export function buildReviewResumptionContext(pending: PendingReviewClarification, latestUserReply: string): string {
  return [
    "KATIE_RESUME_PENDING_COMPLETION",
    "This saved clarification has been matched to the current project, task and assistant question. Continue only as far as the user's literal reply permits.",
    "Preserve verified facts and prior work. If the user explicitly says the requested fact is unavailable, record only that limitation; do not ask for the same fact again. Explicit permission such as 'use what you have' allows completion with verified information when no essential question remains.",
    "'I don't know what this term means' asks for an explanation. It does not establish absence of experience, answer the underlying factual question, or authorize completion. Explain unfamiliar terminology and keep the underlying question open; retain literal partial facts from mixed replies.",
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

