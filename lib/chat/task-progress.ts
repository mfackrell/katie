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
export type TaskProgressState = {
  version: 1;
  objective: { text: string; userMessageId: string } | null;
  stage: "working" | "awaiting_user_answer" | "answers_received";
  pending: TaskQuestion[];
  answered: AnsweredTaskQuestion[];
  lastAssistantMessageId: string | null;
  lastUserMessageId: string | null;
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
  const matches = [...input.matchAll(/(?:^|\s)([1-8])\s*[-.)]\s*/g)];
  const answers = new Map<number, string>();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const index = Number(match[1]);
    const value = input.slice((match.index ?? 0) + match[0].length, i + 1 < matches.length ? matches[i + 1].index : undefined).trim();
    if (value && !answers.has(index)) answers.set(index, value);
  }
  return answers;
}

function newTaskRequested(message: string): boolean {
  return /(?:^|\n)\s*(?:new (?:task|topic|question)\b|(?:please\s+)?(?:write|draft|build|create|find|investigate|analy[sz]e|review|implement|compare|summari[sz]e|research|design|fix)\b)/i.test(message) &&
    !/^\s*(?:try again|continue|go ahead|ok|yes|no)\b/i.test(message);
}

export function emptyTaskProgress(): TaskProgressState {
  return { version: 1, objective: null, stage: "working", pending: [], answered: [], lastAssistantMessageId: null, lastUserMessageId: null };
}

export function applyUserToTaskProgress(
  previous: TaskProgressState,
  input: { messageId: string; text: string },
): TaskProgressState {
  if (previous.lastUserMessageId === input.messageId) return previous;
  const text = input.text.trim();
  if (!text) return previous;
  const pending = previous.pending;
  const numbered = splitNumberedAnswers(text);
  const isAnswer = pending.length > 0 && !newTaskRequested(text);
  if (!isAnswer) {
    return {
      ...previous,
      ...(newTaskRequested(text) || !previous.objective ? { objective: { text: text.slice(0, 2000), userMessageId: input.messageId } } : {}),
      pending: newTaskRequested(text) ? [] : previous.pending,
      stage: "working",
      lastUserMessageId: input.messageId,
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
    pending: remaining,
    answered: [...previous.answered, ...answered].slice(-MAX_ANSWERED),
    stage: "answers_received",
    lastUserMessageId: input.messageId,
  };
}

export function applyAssistantToTaskProgress(
  previous: TaskProgressState,
  input: { messageId: string; text: string },
): TaskProgressState {
  if (previous.lastAssistantMessageId === input.messageId) return previous;
  const pending = extractAssistantQuestions(input.text, input.messageId);
  return { ...previous, pending, stage: pending.length ? "awaiting_user_answer" : "working", lastAssistantMessageId: input.messageId };
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
    "Provisional original objective: " + JSON.stringify(progress.objective),
    "Current stage: " + progress.stage,
    "Answered questions with source IDs: " + JSON.stringify(completed),
    "Still unanswered questions: " + JSON.stringify(progress.pending),
    "If a material unknown remains, ask only one targeted question that is genuinely needed; otherwise move the task forward.",
    "END_KATIE_DURABLE_TASK_PROGRESS",
  ].join("\n");
}
