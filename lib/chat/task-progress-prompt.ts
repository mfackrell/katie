import type { Message } from "@/lib/types/chat";
import {
  classifyUserTurn,
  formatTaskProgress,
  isProjectBrief,
  type TaskProgressState,
} from "@/lib/chat/task-progress";

export type TaskProgressPromptInput = {
  message: string;
  currentUserMessageId: string;
  history: ReadonlyArray<Pick<Message, "id" | "role">>;
  progress: TaskProgressState;
  responsePurpose: "conversation" | "deliverable";
  managedTask: boolean;
  explicitProjectControl: boolean;
  explicitSavedProjectReference: boolean;
  pendingReviewContinuation: boolean;
  projectRelation?: "same_project" | "new_project";
};

export type TaskProgressPromptSelection = {
  text: string;
  reason: string;
};

/** Distinguish a real user-owned work assignment from a synthetic conversational objective. */
function hasProjectWorkAnchor(text: string): boolean {
  if (isProjectBrief(text)) return true;
  return /^(?:(?:please|can you|could you|would you|i need you to|i want you to|we need to)\s+)?(?:build|create|design|develop|implement|fix|repair|complete|finish|prepare|draft|write|analy[sz]e|evaluate|assess|research|review|investigate|calculate|reconcile|produce|plan)\b/i.test(text.trim())
    || /\b(?:project|engagement|assignment|deliverable|application|resume|résumé)\b/i.test(text.slice(0, 400));
}

/**
 * An ordinary greeting can become a synthetic project in older ledgers.
 * It never becomes authoritative work solely because a model labels a later
 * conversational answer as a task continuation.
 */
function isConversationalProjectOrigin(text: string): boolean {
  const plain = text.trim().replace(/^(?:good|great|okay|ok|nice|indeed)[.!?,\s]+/i, "").trim();
  // Older conversational uploads could be promoted to a synthetic project
  // after their observed-media wrapper was appended to the first user turn.
  // This is historical evidence, not an explicit work assignment.
  if (/^(?:ok(?:ay)?\\s*,?\\s*)?(?:fine[.!]?\\s*)?how about (?:this|that|one)\\?/i.test(text) &&
      /FRESH USER-SUPPLIED SOURCE EVIDENCE/.test(text)) return true;
  return classifyUserTurn(text) === "conversation" || classifyUserTurn(plain) === "conversation";
}

/** For unlabeled project follow-ups, require something grounded in the parent scope. */
function explicitlyReferencesCurrentWork(message: string, parent: string): boolean {
  if (/^(?:(?:please|now)\s+)?(?:continue|resume|proceed|go ahead|finish|complete|do it|try again)\b/i.test(message)) return true;
  if (/\b(?:that|this|our|my|the)\s+(?:project|engagement|assignment|application|draft|report|plan|work|task|deliverable|answer)\b/i.test(message)) return true;
  // An application screening question can reference the active role without
  // repeating its company/title; it still requires an established project.
  if (/\b(?:relevant|your|my)\s+(?:experience|examples|qualifications)\b/i.test(message)) return true;
  const stop = new Set("the and for with from this that these those your what which about have would could please into need want work make now then will been were when how who our their they you me my a an is are was to of in on by it as at or".split(" "));
  const terms = new Set((parent.toLowerCase().match(/[a-z0-9]{5,}/g) ?? []).filter(word => !stop.has(word)));
  return (message.toLowerCase().match(/[a-z0-9]{5,}/g) ?? []).some(word => terms.has(word) && !stop.has(word));
}

/**
 * Select only current-task evidence for the ANSWERING provider. Do not delete
 * or rewrite the durable ledger; it remains available for the next relevant
 * request and for the independent reviewer.
 */
export function selectTaskProgressPrompt(input: TaskProgressPromptInput): TaskProgressPromptSelection {
  const render = (reason: string): TaskProgressPromptSelection => ({
    reason,
    text: formatTaskProgress(input.progress, true, {
      history: input.history,
      currentUserMessageId: input.currentUserMessageId,
    }),
  });
  const omit = (reason: string): TaskProgressPromptSelection => ({ text: "", reason });
  // Managed development and explicitly selected project work have authoritative
  // task scope independent of a casual-response model classification.
  if (input.managedTask) return render("managed_task");
  if (input.explicitProjectControl || input.explicitSavedProjectReference) return render("explicit_project");
  if (input.responsePurpose === "conversation") return omit("conversation");
  if (input.pendingReviewContinuation) return render("bound_review_continuation");
  // A bare upload is evidence supplied this turn, not authorization to revive
  // the prior conversational project's objective; the router may call it a
  // same-project deliverable based solely on stale task metadata.
  if (/^\s*\[(?:image|images|file|files|video|audio)\]\s*$/i.test(input.message) ||
      classifyUserTurn(input.message) === "conversation")
    return omit("ordinary_or_upload_only_turn");

  const parent = input.progress.projectContext;
  if (!parent || parent.userMessageId === input.currentUserMessageId)
    return omit("no_prior_work_anchor");
  if (isConversationalProjectOrigin(parent.text))
    return omit("synthetic_conversation_project");

  if (input.projectRelation === "new_project") return omit("different_project");
  // Verified continuity outranks vocabulary heuristics. A real user-owned task
  // need not begin with "build", "draft", "project", etc.
  if (input.projectRelation === "same_project") return render("confirmed_same_project");

  const intent = input.progress.lastUserIntent ?? classifyUserTurn(input.message);
  if (intent === "answer" &&
      input.progress.answered.some(item =>
        item.userMessageId === input.currentUserMessageId &&
        (!item.projectId || item.projectId === parent.userMessageId)))
    return render("source_linked_answer");
  if (intent === "revision" && input.progress.workProduct?.projectId === parent.userMessageId)
    return render("active_work_revision");
  // Only unbound, heuristic follow-ups require a recognizable work anchor.
  // A source-linked answer or a confirmed same-project route does not.
  if (!hasProjectWorkAnchor(parent.text)) return omit("no_confirmed_work_anchor");
  if (intent === "new_task" && explicitlyReferencesCurrentWork(input.message, parent.text))
    return render("scoped_work_request");
  if (intent === "continuation" &&
      /^(?:(?:please|now)\s+)?(?:continue|resume|proceed|go ahead|finish|complete|do it|try again)\b/i.test(input.message) &&
      Boolean(input.progress.workProduct || input.progress.pending.length || input.progress.answered.length))
    return render("explicit_work_continuation");

  return omit("not_relevant_to_current_request");
}
