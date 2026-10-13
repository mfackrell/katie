import type { Message } from "@/lib/types/chat";

/**
 * Task progress is a source-linked conversation ledger, not another model's
 * assessment of the user's qualifications or business objective.
 * Earlier assistant text is preserved ONLY as the question the user answered.
 */
export type TaskQuestion = {
  id: string;
  assistantMessageId: string;
  index: number;
  text: string;
};
export type AnsweredTaskQuestion = TaskQuestion & {
  userMessageId: string;
  answer: string;
  exactNumberedMatch: boolean;
};
export type UserTurnIntent = "new_task" | "revision" | "feedback" | "answer" | "continuation";

export type TaskProgressState = {
  version: 1;
  objective: { text: string; userMessageId: string } | null;
  /** Firsthand overarching project/context, separate from the active question. */
  projectContext?: { text: string; userMessageId: string } | null;
  stage: "working" | "awaiting_user_answer" | "answers_received";
  nextAction: "continue_original_goal" | "await_user_answers" | "advance_after_answers";
  pending: TaskQuestion[];
  answered: AnsweredTaskQuestion[];
  lastAssistantMessageId: string | null;
  lastUserMessageId: string | null;
  /** Advisory classification of the latest user turn; user text remains authoritative. */
  lastUserIntent?: UserTurnIntent;
};

type ProgressMessage = Pick<Message, "id" | "role" | "content">;
const MAX_ANSWERED = 18;
const MAX_QUESTIONS = 8;

export function extractAssistantQuestions(content: string, assistantMessageId: string): TaskQuestion[] {
  const lines = content.slice(-3500).split(/\n/).map(s => s.trim()).filter(Boolean);
  const items: TaskQuestion[] = [];
  for (const line of lines) {
    if (line.length > 450 || !line.includes("?")) continue;
    // Only ordinary user-facing questions, not whole previous assistant claims.
    const stripped = line.replace(/^[-*]\s*/, "").replace(/^\d{1,2}[.)-]\s*/, "");
    const questionEnd = stripped.indexOf("?");
    const question = stripped.slice(0, questionEnd + 1).trim();
    if (question.length < 12 || question.length > 350) continue;
    const match = line.match(/^(\d{1,2})[.)-]\s*/);
    const index = match ? Number(match[1]) : items.length + 1;
    if (!Number.isInteger(index) || index < 1 || index > MAX_QUESTIONS) continue;
    if (items.some(item => item.index === index)) continue;
    items.push({ id: assistantMessageId + ":" + index, assistantMessageId, index, text: question });
  }
  return items.slice(-MAX_QUESTIONS);
}

export function splitNumberedAnswers(input: string): Map<number, string> {
  const matches = [...input.matchAll(/(?:^|\s)([1-8])\s*(?:[.)]\s*|-\s*(?!\d))/g)];
  const answers = new Map<number, string>();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const index = Number(match[1]);
    const value = input.slice((match.index ?? 0) + match[0].length, i + 1 < matches.length ? matches[i + 1].index : undefined).trim();
    if (value && !answers.has(index)) answers.set(index, value);
  }
  return answers;
}

/**
 * Distinguish instruction from feedback using the user's request, not verbs
 * quoted inside a long assessment. This is an advisory continuity signal,
 * never a replacement for the actual user message.
 */
/** Pull an explicit current question out of a corrective turn, without
 * discarding the user's full message from the actual conversation evidence.
 * Unlike ordinary "no" replies, "no, answer this question: ..." is a new task.
 */
export function explicitCurrentQuestion(message: string): string | null {
  const match = message.trim().match(/^(?:no[.,!]\s*|instead[,:]?\s*|please\s+)?(?:answer|respond to|address)\s+(?:this|the following)\s+question\s*:\s*([\s\S]+)$/i);
  return match?.[1]?.trim() || null;
}

export function classifyUserTurn(message: string): Exclude<UserTurnIntent, "answer"> {
  const text = (explicitCurrentQuestion(message) ?? message).trim().replace(/^#{1,6}\s*/, "");
  const opening = text.slice(0, 600);

  // An explicit "feedback only" boundary must not become another draft request.
  if (/^(?:this is |just |only )?(?:feedback only|only feedback|feedback,? not (?:a )?(?:rewrite|revision)|for feedback only)\b/i.test(opening) ||
      /^\s*(?:my |this is my )?(?:evaluation|assessment|feedback) of\b[\s\S]{0,160}\b(?:do not|don't)\s+(?:rewrite|revise|redraft)\b/i.test(opening) ||
      /^(?:this is feedback|feedback only)\b[\s\S]{0,140}\b(?:do not|don't)\s+(?:rewrite|revise|redraft)\b/i.test(opening)) {
    return "feedback";
  }

  // A direct instruction to revise is distinct from criticism or analysis of
  // past revisions. Only imperative lines count, not quoted examples.
  const explicitRevision = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:(?:please|now|go ahead and|can you|could you|would you|i want you to|i need you to)\s+)?(?:rewrite|revise|redraft|polish|edit|rework)\b/i;
  if (explicitRevision.test(text.slice(0, 1400)) ||
      /^(?:please\s+)?(?:make|produce|give me)\s+(?:another|a new|a revised|a better)\s+(?:draft|version|answer|response)\b/i.test(text)) {
    return "revision";
  }

  // New standalone requests use leading imperatives, including common
  // application screening questions such as "Please describe your experience".
  if (/^(?:new (?:task|topic|question|project|engagement)\b|(?:please\s+)?(?:write|draft|build|create|find|investigate|analy[sz]e|review|implement|compare|summari[sz]e|research|design|fix|describe|explain|provide|prepare|evaluate|assess|share|list|outline)\b)/i.test(text) &&
      !/^(?:try again|continue|go ahead|ok|yes|no)\b/i.test(text)) {
    return "new_task";
  }

  // Screening prompts frequently request examples without beginning with a
  // traditional drafting verb. Treat them as their own deliverables, not as
  // replies to unrelated previous questions.
  if (/^(?:please\s+)?(?:give\s+me|tell\s+me\s+about)\s+(?:(?:\d+\s*(?:to|-|–)\s*\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|some|a\s+few)\s+)?(?:examples?|instances?|cases?|relevant\s+experience|your\s+experience|my\s+experience)\b/i.test(text)) {
    return "new_task";
  }

  // A report about an answer is not an instruction to rewrite that answer.
  if (/^(?:(?:my|our)\s+)?(?:evaluation|assessment|feedback|critique)\b/i.test(text) ||
      /^\d+(?:\.\d+)?\s*\/\s*10\b/i.test(text) ||
      /^(?:this is|here is|here's)\s+(?:my\s+)?(?:feedback|evaluation|assessment)\b/i.test(text) ||
      /^what(?:'s| is)\s+(?:improved|better|worse|wrong|working|still missing)\b/i.test(text) ||
      /^(?:one phrase is|(?:that|this|your|the) (?:paragraph|sentence|phrase|wording|draft|response|answer) (?:is|was|seems|reads))\b/i.test(text) ||
      /^where (?:her|his|your|Katie's) (?:thinking|writing|reasoning)\b/i.test(text)) {
    return "feedback";
  }
  return "continuation";
}

export function emptyTaskProgress(): TaskProgressState {
  return { version: 1, objective: null, stage: "working", nextAction: "continue_original_goal", pending: [], answered: [], lastAssistantMessageId: null, lastUserMessageId: null };
}

export function applyUserToTaskProgress(
  previous: TaskProgressState,
  input: { messageId: string; text: string },
): TaskProgressState {
  if (previous.lastUserMessageId === input.messageId) return previous;
  const text = input.text.trim();
  if (!text) return previous;
  const currentQuestion = explicitCurrentQuestion(text) ?? text;
  // Keep the overarching user-supplied project distinct from a changing
  // sequence of narrower questions. A wholly different project may supersede
  // this context, but ordinary subquestions do not erase it.
  const startsNewProject = /^(?:new|different|switch(?:ing)?\s+to\s+(?:a\s+)?)(?:\s+project|\s+engagement)\b/i.test(text);
  const projectContext = startsNewProject
    ? {text: currentQuestion.slice(0, 4000), userMessageId: input.messageId}
    : (previous.projectContext ?? previous.objective ?? {text: currentQuestion.slice(0, 4000), userMessageId: input.messageId});
  const pending = previous.pending;
  const numbered = splitNumberedAnswers(text);
  const intent = classifyUserTurn(text);
  const isAnswer = pending.length > 0 && intent === "continuation";
  if (!isAnswer) {
    return {
      ...previous,
      projectContext,
      ...(intent === "new_task" || !previous.objective ? { objective: { text: currentQuestion.slice(0, 2000), userMessageId: input.messageId } } : {}),
      pending: intent === "new_task" || intent === "revision" ? [] : previous.pending,
      answered: intent === "new_task" ? [] : previous.answered,
      stage: "working",
      nextAction: "continue_original_goal",
      lastUserMessageId: input.messageId,
      lastUserIntent: intent,
    };
  }
  const answered: AnsweredTaskQuestion[] = [];
  const remaining: TaskQuestion[] = [];
  for (const question of pending) {
    const specific = numbered.get(question.index);
    if (specific) {
      answered.push({ ...question, userMessageId: input.messageId, answer: specific.slice(0, 1300), exactNumberedMatch: true });
    } else if (numbered.size === 0 && pending.length === 1) {
      answered.push({ ...question, userMessageId: input.messageId, answer: text.slice(0, 1300), exactNumberedMatch: false });
    } else if (numbered.size === 0) {
      // Don't invent a mapping for an unnumbered answer to multiple questions.
      answered.push({ ...question, userMessageId: input.messageId, answer: text.slice(0, 1300), exactNumberedMatch: false });
    } else {
      remaining.push(question);
    }
  }
  return {
    ...previous,
    projectContext,
    pending: remaining,
    answered: [...previous.answered, ...answered].slice(-MAX_ANSWERED),
    stage: "answers_received",
    nextAction: "advance_after_answers",
    lastUserMessageId: input.messageId,
    lastUserIntent: "answer",
  };
}

export function applyAssistantToTaskProgress(
  previous: TaskProgressState,
  input: { messageId: string; text: string },
): TaskProgressState {
  if (previous.lastAssistantMessageId === input.messageId) return previous;
  const pending = extractAssistantQuestions(input.text, input.messageId);
  return { ...previous, pending, stage: pending.length ? "awaiting_user_answer" : "working", nextAction: pending.length ? "await_user_answers" : "continue_original_goal", lastAssistantMessageId: input.messageId };
}

/** Reconstruct a partial ledger from durable chat messages if the cache was absent. */
export function rebuildTaskProgress(history: ProgressMessage[]): TaskProgressState {
  let state = emptyTaskProgress();
  for (const message of history) {
    if (message.role === "user") state = applyUserToTaskProgress(state, { messageId: message.id, text: message.content });
    else if (message.role === "assistant") state = applyAssistantToTaskProgress(state, { messageId: message.id, text: message.content });
  }
  return state;
}

/** Recover unrecorded turns after an interrupted request or a second device. */
export function syncTaskProgress(previous: TaskProgressState | null, history: ProgressMessage[]): TaskProgressState {
  if (!previous) return rebuildTaskProgress(history);
  const userCursor = history.findIndex(item => item.id === previous.lastUserMessageId);
  const assistantCursor = history.findIndex(item => item.id === previous.lastAssistantMessageId);
  const cursor = Math.max(userCursor, assistantCursor);
  if (cursor < 0) {
    const recent = rebuildTaskProgress(history);
    return {
      ...recent,
      objective: recent.objective ?? previous.objective,
      projectContext: previous.projectContext ?? previous.objective ?? recent.projectContext,
      answered: [...previous.answered, ...recent.answered]
        .filter((item, index, array) => array.findIndex(other => other.id === item.id && other.userMessageId === item.userMessageId) === index)
        .slice(-MAX_ANSWERED),
    };
  }
  let state = previous;
  for (const entry of history.slice(cursor + 1)) {
    if (entry.role === "user") state = applyUserToTaskProgress(state, { messageId: entry.id, text: entry.content });
    else if (entry.role === "assistant") state = applyAssistantToTaskProgress(state, { messageId: entry.id, text: entry.content });
  }
  return state;
}

export function formatTaskProgress(progress: TaskProgressState): string {
  const completed = progress.answered.slice(-10).map(item => ({
    assistantQuestionSource: item.assistantMessageId,
    userAnswerSource: item.userMessageId,
    question: item.text,
    answer: item.answer,
    exactNumberedMatch: item.exactNumberedMatch,
  }));
  return [
    "KATIE_DURABLE_TASK_PROGRESS (scoped to this actor and chat)",
    "This record links prior assistant QUESTIONS to subsequent user ANSWERS. The user's answers are authoritative. Assistant questions only explain what was being answered: do NOT adopt other assistant statements as facts or constraints.",
    "A follow-up answer advances an existing task. Do not restart the original assessment, re-ask answered questions, or turn confirmations into another generic summary. Complete the next useful step for the user's goal, subject to explicit new instructions.",
    "Do not treat this record as a permanent instruction. A user's explicit new request overrides old progress; a cached objective is provisional.",
    "PARENT PROJECT CONTEXT (firsthand, advisory; only applicable if the current question refers to the same project): " + JSON.stringify(progress.projectContext ?? null),
    "CURRENT QUESTION OR DELIVERABLE (authoritative for this turn, distinct from the parent project): " + JSON.stringify(progress.objective),
    "Interpret generic requests for relevant experience or examples against the full applicable parent project, not against a narrower question asked earlier. Prior question-specific evidence priorities, exclusions and example sets expire with their original deliverable; factual corrections remain valid.",
    "Latest user turn type (advisory; verify against literal user request): " + (progress.lastUserIntent ?? "unspecified"),
    "When the user provides feedback/evaluation without requesting a revised artifact, engage with the feedback and do not silently generate another draft. Remember lessons appropriately without treating quoted criticism as a new instruction.",
    "When the user expressly asks for revision, revise the existing work. A new application question such as 'Please describe...' is a separate requested deliverable. User text takes precedence over this heuristic.",
    "Current stage: " + progress.stage,
    "Next appropriate action: " + progress.nextAction,
    "Answered questions with source IDs: " + JSON.stringify(completed),
    "Still unanswered questions: " + JSON.stringify(progress.pending),
    "If a material unknown remains, ask only one targeted question that is genuinely needed; otherwise move the task forward.",
    "END_KATIE_DURABLE_TASK_PROGRESS",
  ].join("\n");
}

