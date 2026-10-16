import { isTerminologyClarification } from "@/lib/chat/task-progress";
import type { ResponsePurpose } from "@/lib/router/model-intent";

export type ResponsePolicy = {
  purpose: ResponsePurpose;
  requiresSubstantiveProcessing: boolean;
  reason: string;
  generationInstruction: string | null;
};

const CONVERSATION_INSTRUCTION = [
  "NEXT RESPONSE: a brief conversational answer or clarification, normally under 150 words.",
  "Answer the user's current question. Acknowledge any facts supplied, explain unfamiliar terms plainly, and ask at most one necessary follow-up.",
  "Not knowing a term does not establish a lack of experience doing the underlying work. Preserve any unanswered factual question.",
  "Keep the active substantive task pending. Do not silently begin, resume, rewrite, or verify an application answer, report, analysis, code, or other deliverable in this response.",
  "Earlier saved drafts and task instructions are background; they do not override the current conversational question.",
].join("\n");

// Detect direct production instructions before accepting a conversational
// classifier result. Message length and low complexity cannot waive review.
function explicitlyRequestsDeliverable(message: string): boolean {
  const clauses = message.split(/(?:[\n.!?;,]|\b(?:and then|and|then|but|also)\s+)/i);
  const production = /^(?:(?:yes|no|ok(?:ay)?|sure)\s+)?(?:(?:please|now|can you|could you|would you|will you|go ahead and|i want you to|i need you to|i'd like you to)\s+)*(?:write|draft|rewrite|revise|redraft|prepare|create|build|implement|fix|analy[sz]e|evaluate|assess|investigate|compare|calculate|research|review|verify|retry|finish|complete|produce|generate|design|develop|make)\b/i;
  const requestedArtifact = /^(?:(?:please|can you|could you|would you)\s+)?(?:give|provide|share|show)\s+(?:me\s+)?(?:(?:my|your|our|the|a|an|some|one|two|three|four|five|\d+)\s+)?(?:(?:final|revised|completed|updated|relevant|work)\s+)*(?:draft|application|analysis|report|code|implementation|proposal|cover letter|recommendations|examples?)\b/i;
  return clauses.some(clause => production.test(clause.trim()) || requestedArtifact.test(clause.trim())) ||
    /^(?:please\s+)?(?:do it|go ahead|proceed|continue|try again)[.!\s]*$/i.test(message.trim());
}

const ACKNOWLEDGMENT = /^(?:(?:great|perfect|okay|ok|yes|sure)[,.!]?\s+)?(?:thanks(?: a lot)?|thank you(?: very much)?|got it|understood|that makes sense|makes sense)[.!\s]*$/i;
const GREETING = /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|how are you|what'?s up)(?:[ ,]+(?:katie|kat))?[?!.\s]*$/i;
const BARE_CONFIRMATION = /^(?:yes|no|yep|nope|okay|ok|sure|correct|right)[.!\s]*$/i;
const SUBSTANTIVE_INTENTS = new Set([
  "marketing-analysis", "rewrite", "emotional-analysis", "news-summary", "web-search",
  "code-review", "technical-debugging", "architecture-review", "code-generation",
  "assistant-reflection", "safety-sensitive-vision", "vision-analysis", "multimodal-reasoning", "image-generation",
]);

function policy(purpose: ResponsePurpose, reason: string): ResponsePolicy {
  return {
    purpose,
    requiresSubstantiveProcessing: purpose === "deliverable",
    reason,
    generationInstruction: purpose === "conversation" ? CONVERSATION_INSTRUCTION : null,
  };
}

/**
 * One output-based decision gates both collaboration and required review.
 * The existing intent classifier supplies its contextual judgment; deterministic
 * guards keep explicit work requests substantive when that signal is missing or
 * inconsistent. A terse answer alone is never evidence that review is optional.
 */
export function decideResponsePolicy(input: {
  message: string;
  responsePurpose?: ResponsePurpose | null;
  intent?: string | null;
  hasAttachments?: boolean;
  requiresTools?: boolean;
  hasPendingDeliverable?: boolean;
  explicitReviewRetry?: boolean;
}): ResponsePolicy {
  if (input.explicitReviewRetry) return policy("deliverable", "explicit_saved_review_retry");
  if (input.hasAttachments || input.requiresTools) return policy("deliverable", "attachment_or_tool_work");
  if (explicitlyRequestsDeliverable(input.message)) return policy("deliverable", "explicit_deliverable_request");

  // A question about what was asked pauses production even when the same
  // message also answers a different part of a multi-part clarification.
  if (isTerminologyClarification(input.message)) return policy("conversation", "terminology_clarification");
  const message = input.message.trim();
  if (ACKNOWLEDGMENT.test(message) || GREETING.test(message)) return policy("conversation", "acknowledgment_or_greeting");
  if (BARE_CONFIRMATION.test(message)) {
    return input.hasPendingDeliverable
      ? policy("deliverable", "confirmation_of_pending_work")
      : policy("conversation", "standalone_confirmation");
  }

  // Purpose is independent of domain: a routine rewrite is still a deliverable,
  // while a contextual clarification may mention code or financial analysis.
  if (input.responsePurpose) return policy(input.responsePurpose, "contextual_response_purpose");
  if (input.hasPendingDeliverable) return policy("deliverable", "pending_work_conservative_fallback");
  if (input.intent && SUBSTANTIVE_INTENTS.has(input.intent)) return policy("deliverable", "substantive_intent_fallback");
  return policy("deliverable", "uncertain_output_conservative_fallback");
}

/**
 * A conversational plan cannot authorize an unexpected substantive answer.
 * Inspect the completed, buffered text before publishing it. This is a
 * conservative backstop, not a quality judgment or another model call.
 */
export function shouldEscalateConversationResponse(input: {
  policy: ResponsePolicy;
  responseText: string;
  usedTools?: boolean;
}): boolean {
  if (input.policy.purpose !== "conversation") return false;
  if (input.usedTools) return true;
  const text = input.responseText.trim();
  if (!text) return false;
  if (text.split(/\s+/).length > 160) return true;
  if (/```|~~~/.test(text)) return true;
  if (/(?:^|\n)\s*\|[^\n]+\|\s*\n\s*\|?\s*:?-{3,}/.test(text)) return true;
  if ((text.match(/(?:^|\n)\s*#{1,6}\s+\S/g) ?? []).length >= 2) return true;
  if ((text.match(/(?:^|\n)\s*\d+[.)]\s+\S/g) ?? []).length >= 3) return true;
  if (/\b(?:here(?:'s| is| are)|below is)\s+(?:(?:your|the|a|an)\s+)?(?:(?:final|revised|completed|updated|full)\s+)?(?:draft|application|cover letter|proposal|report|analysis|implementation|code|plan|answer for submission)\b/i.test(text)) return true;
  if (/\bplease accept my application\b|\b(?:three|four|five|several|[3-5])\s+(?:relevant\s+|work\s+)?examples follow\b/i.test(text)) return true;
  if (/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:cover letter|application (?:answer|response)|executive summary|implementation plan|unverified draft)\b/i.test(text)) return true;
  if (/^(?:dear\s+(?:hiring|recruiting|selection)\b|i have\s+(?:over\s+|more than\s+)?\d+\s+years of experience\b|for\s+\d+\s+years,)/i.test(text)) return true;
  if (/^(?:i|we)\s+(?:led|owned|managed|directed|restored|built|oversaw|served)\b/i.test(text)) return true;
  return false;
}
