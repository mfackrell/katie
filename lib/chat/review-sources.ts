import type { SourceTurn } from "@/lib/collaboration/review-contract";
import type { TaskProgressState } from "@/lib/chat/task-progress";

/**
 * Review source text is evidence, not the generation prompt. In particular,
 * saved drafts, resume instructions and observed media must never replace the
 * literal latest user turn in the source/citation ledger.
 */
export function buildReviewSourceTurns(input: {
  history: Array<{ role: string; content: string }>;
  latestMessage: string;
  progress?: TaskProgressState;
  /** Only from a continuation already matched to the active task/question. */
  savedSourceTurns?: SourceTurn[];
}): SourceTurn[] {
  const historical = input.history.filter(turn => turn.role === "user").map(turn => turn.content);
  const texts: string[] = [];
  const addMissing = (text?: string) => {
    if (!text?.trim() || text === input.latestMessage || texts.includes(text) || historical.includes(text)) return;
    texts.push(text);
  };
  for (const turn of input.savedSourceTurns ?? []) {
    // Legacy audits could contain a generated resumption wrapper as a user
    // source. It is not firsthand evidence and must not be perpetuated.
    if (/^\s*(?:This turn answers a previous clarification|INTERNAL REVIEW TASK\b|KATIE_RESUME_PENDING_COMPLETION\b)/i.test(turn.text)) continue;
    addMissing(turn.text);
  }
  addMissing(input.progress?.projectContext?.text);
  addMissing(input.progress?.objective?.text);
  if(input.progress?.workProduct?.projectId===input.progress?.projectContext?.userMessageId){
    for(const request of input.progress?.workProduct?.requestSources ?? []) addMissing(request.text);
    addMissing(input.progress?.workProduct?.request.text);
  }
  // Keep the real historical turns verbatim and in order, including repeated
  // factual corrections. Only recovered context above is deduplicated.
  texts.push(...historical);
  return [
    ...texts.map((text, index) => ({ id: `turn-${index + 1}`, text })),
    { id: "latest-user", text: input.latestMessage },
  ];
}
