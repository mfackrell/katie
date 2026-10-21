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
  /** Stable user-message IDs; absent only on ledgers written before binding. */
  projectId?: string;
  taskId?: string;
};
export type AnsweredTaskQuestion = TaskQuestion & {
  userMessageId: string;
  answer: string;
  exactNumberedMatch: boolean;
  /** A literal partial fact does not close the question it relates to. */
  partial?: boolean;
};
export type UserTurnIntent = "new_task" | "revision" | "feedback" | "answer" | "clarification" | "conversation" | "continuation";

export type ProjectTransition = {
  action: "new" | "resume" | "ambiguous";
  projectId?: string;
  /** Exact current user wording supporting a change, never attachment text. */
  sourceQuote?: string;
  clarification?: string;
};
export type ProjectSnapshot = {
  sourceChatId?: string;
  updatedAt?: string;
  projectContext: { text: string; userMessageId: string };
  objective: { text: string; userMessageId: string } | null;
  pending: TaskQuestion[];
  answered: AnsweredTaskQuestion[];
};
export type TaskProgressState = {
  version: 1;
  projects?: ProjectSnapshot[];
  projectClarification?: string;
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

export type ProgressMessage = Pick<Message, "id" | "role" | "content">;
const MAX_QUESTIONS = 8;

function explicitlyStartsProject(text: string): boolean {
  return /^(?:(?:new|different)\s+(?:project|engagement)|switch(?:ing)?\s+to\s+(?:a\s+)?(?:new\s+|different\s+)?(?:project|engagement))\b/i.test(text.trim().replace(/^#{1,6}\s*/, ""));
}

/** A pasted role brief is a project boundary even without the words "new project". */
export function isProjectBrief(message: string): boolean {
  const text = message.trim().replace(/^#{1,6}\s*/, "");
  if (explicitlyStartsProject(text)) return true;
  const heading = text.split(/\n/).find(line => line.trim())?.replace(/^[#*\s]+|[*\s]+$/g, "").slice(0, 240) ?? "";
  // A screening prompt mentioning a job title still belongs to its parent project.
  if (/^(?:please\b|(?:can|could|would)\s+you\b|i\b|we\b|my\b|your\b|what\b|how\b|why\b|(?:write|draft|describe|share|give|list|explain|rewrite|revise|compare)\b)/i.test(heading)) return false;
  const role = /\b(?:cfo|ceo|coo|cto|chief\s+\w+\s+officer|controller|advisor|consultant|director|manager|engineer|designer|analyst|specialist|head\s+of)\b/i.test(heading);
  const employer = /\b(?:for\s+(?:a|an|the)|pe[- ]backed|private[ -]equity|company|business|client|position|engagement)\b/i.test(heading);
  const structuredBody = text.length > 200 && /(?:^|\n)\s*(?:#{1,6}\s*)?(?:project\s+(?:overview|description|details)|(?:role|job)\s+(?:overview|description)|responsibilities|requirements|qualifications|location|duration|our\s+client)\b/im.test(text);
  return role && (employer || structuredBody);
}

/** Unfamiliar terminology is not an assertion that the underlying fact is absent. */
export function isTerminologyClarification(message: string): boolean {
  const text = message.trim().replace(/[‘’]/g, "'");
  const definitionPhrase = (phrase: string) => phrase.trim().split(/\s+/).length <= 10 &&
    !/\b(?:wrong|best|risks?|next|recommend\w*|strateg(?:y|ies)|plans?|should|happening|happened|going|fails?|failed|failing|broken|cost|status|why|how|whether|my|our|this|your)\b/i.test(phrase);
  const plainDefinition = text.match(/(?:^|[.!?]\s+)(?:(?:can|could|would)\s+you\s+(?:please\s+)?explain\s+)?what(?:'s|\s+is|\s+are)\s+([^.!?\n]{1,120})\?/i);
  const unfamiliar = text.match(/\b(?:do\s*not|don'?t)\s+(?:know|understand)\s+what\s+([^.!?\n]{1,100})\s+(?:is|are|means?)\b/i);
  const directUnknown = text.match(/\b(?:do\s*not|don'?t)\s+understand\s+([^.!?\n]{1,100})(?:[.!?]|$)/i);
  return Boolean(unfamiliar && definitionPhrase(unfamiliar[1])) ||
    /\b(?:do\s*not|don'?t)\s+(?:know|understand)\s+(?:the\s+)?(?:term|word|phrase|concept)\b/i.test(text) ||
    Boolean(directUnknown && definitionPhrase(directUnknown[1])) ||
    /\b(?:not\s+familiar|unfamiliar)\s+with\b/i.test(text) ||
    /\bwhat\s+(?:do|did)\s+you\s+mean\b/i.test(text) ||
    /\bwhat\s+(?:does|do)\s+[^.!?\n]{1,100}\s+mean\b/i.test(text) ||
    Boolean(plainDefinition && definitionPhrase(plainDefinition[1])) ||
    /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:define\b|explain\s+(?:(?:the\s+)?(?:term|word|phrase|concept)\b|what\s+you\s+mean\b))/i.test(text);
}

function explicitDeliverableInstruction(text: string): boolean {
  return /(?:^|\n|[.!?]\s+|\b(?:and|then|but)\s+)(?:(?:please|now|go ahead and|can you|could you|would you)\s+)?(?:write|draft|build|create|prepare|produce|rewrite|revise|redraft|implement)\b/i.test(text);
}

function partialFactsFromClarification(text: string): string {
  return text.split(/(?<=[.!?])\s+|,\s*(?=(?:i|we)\s+(?:do\s*not|don'?t)\s+(?:know|understand))|\s+(?:but|and)\s+(?=(?:i|we|what)\b)/i)
    .filter(clause => !isTerminologyClarification(clause) && /(?:\b(?:i|we)\s+(?:(?:do\s*not|don'?t)\s+have|have|had|led|did|never|am|are)\b|^no\b[^.!?]{0,120}\bexperience\b)/i.test(clause))
    .join(" ").trim();
}

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

  // Bare yes/no can answer a factual question. Social acknowledgments cannot.
  if (/^(?:(?:great|perfect|okay|ok|yes|sure)[,.!]?\s+)?(?:thanks(?: a lot)?|thank you(?: very much)?|got it|understood|that makes sense|makes sense)[.!\s]*$/i.test(text) ||
    /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|how are you|what'?s up)(?:[ ,]+(?:katie|kat))?[?!.\s]*$/i.test(text)) return "conversation";

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

  // A definition detour keeps the current question open. A combined request
  // such as "explain it, then draft the application" can still request work.
  if (isTerminologyClarification(text) && !explicitDeliverableInstruction(text)) return "clarification";
  if (isProjectBrief(text)) return "new_task";

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

/** Persist original project sources outside lossy conversation summaries. */
function checkpointProject(state: TaskProgressState, changed = false): TaskProgressState {
  if (!state.projectContext) return state;
  const prior = state.projects?.find(project =>
    project.projectContext.userMessageId === state.projectContext!.userMessageId);
  const sourceChatId = prior?.sourceChatId;
  const updatedAt = changed ? new Date(Math.max(Date.now(), Date.parse(prior?.updatedAt ?? "") + 1 || 0)).toISOString() : prior?.updatedAt;
  const snapshot: ProjectSnapshot = {
    ...(sourceChatId ? {sourceChatId} : {}),
    ...(updatedAt ? {updatedAt} : {}),
    projectContext: state.projectContext, objective: state.objective,
    pending: state.pending, answered: state.answered,
  };
  return { ...state, projects: [...(state.projects ?? []).filter(project =>
    project.projectContext.userMessageId !== state.projectContext!.userMessageId), snapshot] };
}

export function mergeTaskProjects(state: TaskProgressState, projects: ProjectSnapshot[]): TaskProgressState {
  // A copied project never outranks a later edit simply because it is local.
  // Importing does not select a different project. Equal versions favor local state.
  const byId = new Map<string, ProjectSnapshot>();
  for (const project of [...projects, ...(checkpointProject(state).projects ?? [])]) {
    const id = project.projectContext.userMessageId;
    const prior = byId.get(id);
    if (!prior || (project.updatedAt ?? "") >= (prior.updatedAt ?? "")) byId.set(id, project);
  }
  const current = state.projectContext ? byId.get(state.projectContext.userMessageId) : undefined;
  return { ...state, ...(current ? {projectContext: current.projectContext,
    objective: current.objective, pending: current.pending, answered: current.answered} : {}),
    projects: [...byId.values()] };
}

export function taskProjectCatalog(state: TaskProgressState): Array<{ id: string; text: string; sourceChatId?: string }> {
  return (checkpointProject(state).projects ?? []).map(project => ({
    id: project.projectContext.userMessageId, text: project.projectContext.text, sourceChatId: project.sourceChatId,
  }));
}

export function applyUserToTaskProgress(
  previous: TaskProgressState,
  input: { messageId: string; text: string; projectRelation?: "new_project" | "same_project"; projectTransition?: ProjectTransition },
): TaskProgressState {
  if (previous.lastUserMessageId === input.messageId) return previous;
  const state = checkpointProject(previous);
  const transition = input.projectTransition;
  const turnIntent = classifyUserTurn(input.text);
  // A greeting must not become a synthetic project that legitimizes a later
  // otherwise ambiguous application question.
  if (!state.projectContext && !transition && turnIntent === "conversation") {
    return { ...state, lastUserMessageId: input.messageId, lastUserIntent: "conversation" };
  }
  if (!state.projectContext && !transition && (state.projects?.length ?? 0) > 0 &&
      turnIntent !== "conversation" && !isProjectBrief(input.text)) {
    return { ...state, lastUserMessageId: input.messageId,
      projectClarification: "Which saved project should I continue?" };
  }
  if (transition?.action === "ambiguous") {
    return { ...state, lastUserMessageId: input.messageId, projectClarification:
      transition.clarification?.trim() || "Which saved project should this request continue?" };
  }
  const quote = transition?.sourceQuote?.trim();
  const sourced = Boolean(quote && input.text.includes(quote));
  if (transition && (transition.action === "new" || transition.action === "resume") && !sourced) {
    return { ...state, lastUserMessageId: input.messageId,
      projectClarification: "Which project should this request address? I could not verify the proposed change against your message." };
  }
  if (transition?.action === "resume") {
    const target = state.projects?.find(project => project.projectContext.userMessageId === transition.projectId);
    if (!target) return { ...state, lastUserMessageId: input.messageId,
      projectClarification: "Which saved project do you want to resume? The proposed project could not be found." };
    // Resuming is a control transition, never an answer to an old pending question.
    return checkpointProject({ ...state, ...target, projectClarification: undefined,
      objective: {text:input.text,userMessageId:input.messageId},
      lastUserMessageId: input.messageId, lastAssistantMessageId: null,
      lastUserIntent: "continuation", stage: target.pending.length ? "awaiting_user_answer" : "working",
      nextAction: target.pending.length ? "await_user_answers" : "continue_original_goal" });
  }
  // A routing hint alone is not authoritative evidence that a parent changed.
  const relation = transition?.action === "new" ? "new_project"
    : transition?.action === "resume" ? "same_project"
    : input.projectRelation === "new_project" ? undefined : input.projectRelation;
  const next = applyUserTurn({ ...state, projectClarification: undefined }, { ...input, projectRelation: relation });
  return checkpointProject(next, true);
}

function applyUserTurn(
  previous: TaskProgressState,
  input: { messageId: string; text: string; projectRelation?: "new_project" | "same_project" },
): TaskProgressState {
  if (previous.lastUserMessageId === input.messageId) return previous;
  const text = input.text.trim();
  if (!text) return previous;
  const currentQuestion = explicitCurrentQuestion(text) ?? text;
  // Keep the overarching user-supplied project distinct from a changing
  // sequence of narrower questions. A wholly different project may supersede
  // this context, but ordinary subquestions do not erase it.
  const startsNewProject = input.projectRelation === "new_project" || explicitlyStartsProject(text) ||
    (input.projectRelation !== "same_project" && isProjectBrief(text) &&
      currentQuestion !== (previous.projectContext ?? previous.objective)?.text);
  const projectContext = startsNewProject
    ? {text: currentQuestion, userMessageId: input.messageId}
    : (previous.projectContext ?? previous.objective ?? {text: currentQuestion, userMessageId: input.messageId});
  const pending = previous.pending;
  const numbered = splitNumberedAnswers(text);
  const intent = startsNewProject ? "new_task" : classifyUserTurn(text);
  if (intent === "clarification" && pending.length) {
    const answered: AnsweredTaskQuestion[] = [];
    const remaining: TaskQuestion[] = [];
    for (const question of pending) {
      const specific = numbered.get(question.index);
      if (specific && !isTerminologyClarification(specific)) {
        answered.push({ ...question, userMessageId: input.messageId, answer: specific, exactNumberedMatch: true });
        continue;
      }
      // Keep compound questions open. Preserve any explicit partial fact as a
      // literal statement, never infer "no experience" from "what does it mean".
      const partial = partialFactsFromClarification(specific ?? (numbered.size === 0 && pending.length === 1 ? text : ""));
      if (partial) answered.push({ ...question, userMessageId: input.messageId, answer: partial, exactNumberedMatch: Boolean(specific), partial: true });
      remaining.push(question);
    }
    return {
      ...previous, projectContext, pending: remaining,
      answered: [...previous.answered, ...answered],
      stage: "awaiting_user_answer", nextAction: "await_user_answers",
      lastUserMessageId: input.messageId, lastUserIntent: "clarification",
    };
  }
  const isAnswer = pending.length > 0 && intent === "continuation";
  if (!isAnswer) {
    return {
      ...previous,
      projectContext,
      ...(intent === "new_task" || !previous.objective ? { objective: { text: currentQuestion, userMessageId: input.messageId } } : {}),
      pending: intent === "new_task" || intent === "revision" ? [] : previous.pending,
      answered: startsNewProject ? [] : previous.answered,
      stage: intent === "conversation" && previous.pending.length ? "awaiting_user_answer" : "working",
      nextAction: intent === "conversation" && previous.pending.length ? "await_user_answers" : "continue_original_goal",
      lastUserMessageId: input.messageId,
      lastUserIntent: intent,
    };
  }
  const answered: AnsweredTaskQuestion[] = [];
  const remaining: TaskQuestion[] = [];
  for (const question of pending) {
    const specific = numbered.get(question.index);
    if (specific) {
      answered.push({ ...question, userMessageId: input.messageId, answer: specific, exactNumberedMatch: true });
    } else if (numbered.size === 0 && pending.length === 1) {
      answered.push({ ...question, userMessageId: input.messageId, answer: text, exactNumberedMatch: false });
    } else if (numbered.size === 0) {
      // Don't invent a mapping for an unnumbered answer to multiple questions.
      answered.push({ ...question, userMessageId: input.messageId, answer: text, exactNumberedMatch: false });
    } else {
      remaining.push(question);
    }
  }
  return {
    ...previous,
    projectContext,
    pending: remaining,
    answered: [...previous.answered, ...answered],
    stage: "answers_received",
    nextAction: "advance_after_answers",
    lastUserMessageId: input.messageId,
    lastUserIntent: "answer",
  };
}

export function applyAssistantToTaskProgress(
  previous: TaskProgressState,
  input: { messageId: string; text: string; responsePurpose?: "conversation" | "deliverable" },
): TaskProgressState {
  if (previous.lastAssistantMessageId === input.messageId) return previous;
  const questions = extractAssistantQuestions(input.text, input.messageId).map(question => ({
    ...question,
    ...(previous.objective ? {
      projectId: (previous.projectContext ?? previous.objective).userMessageId,
      taskId: previous.objective.userMessageId,
    } : {}),
  }));
  const preserveQuestions = input.responsePurpose === "conversation" ||
    (input.responsePurpose === undefined && (previous.lastUserIntent === "clarification" || previous.lastUserIntent === "conversation"));
  const normalized = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const pending = preserveQuestions
    ? [...previous.pending, ...questions]
      .filter((question, index, items) => items.findIndex(other => normalized(other.text) === normalized(question.text)) === index)
      .slice(0, MAX_QUESTIONS)
    : questions;
  return checkpointProject({ ...previous, pending, stage: pending.length ? "awaiting_user_answer" : "working", nextAction: pending.length ? "await_user_answers" : "continue_original_goal", lastAssistantMessageId: input.messageId }, true);
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
    // A recent role brief supersedes an old cached project. A window that
    // starts at a screening subquestion must retain the established project.
    const recentProjectIsExplicit = recent.projectContext && isProjectBrief(recent.projectContext.text);
    const changedProject = recentProjectIsExplicit && recent.projectContext?.userMessageId !== previous.projectContext?.userMessageId;
    const projectContext = recentProjectIsExplicit ? recent.projectContext : previous.projectContext ?? previous.objective ?? recent.projectContext;
    const recoverProjectBinding = <T extends TaskQuestion>(question: T): T =>
      projectContext && (!question.projectId || question.projectId === recent.projectContext?.userMessageId)
        ? { ...question, projectId: projectContext.userMessageId }
        : question;
    return {
      ...recent,
      projects: [...(checkpointProject(previous).projects ?? []), ...(recent.projects ?? [])]
        .filter((item, index, all) => !all.slice(index + 1).some(other => other.projectContext.userMessageId === item.projectContext.userMessageId)),
      objective: recent.objective ?? previous.objective,
      projectContext,
      pending: recent.pending.map(recoverProjectBinding),
      answered: [...(changedProject ? [] : previous.answered), ...recent.answered.map(recoverProjectBinding)]
        .filter((item, index, array) => array.findIndex(other => other.id === item.id && other.userMessageId === item.userMessageId) === index)
        ,
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
  const completed = progress.answered.map(item => ({
    assistantQuestionSource: item.assistantMessageId,
    userAnswerSource: item.userMessageId,
    question: item.text,
    answer: item.answer,
    exactNumberedMatch: item.exactNumberedMatch,
    ...(item.partial ? { partial: true } : {}),
  }));
  return [
    "KATIE_DURABLE_TASK_PROGRESS (scoped to this actor and chat)",
    "This record links prior assistant QUESTIONS to subsequent user ANSWERS. The user's answers are authoritative. Assistant questions only explain what was being answered: do NOT adopt other assistant statements as facts or constraints.",
    "A follow-up answer advances an existing task. Do not restart the original assessment, re-ask answered questions, or turn confirmations into another generic summary. Complete the next useful step for the user's goal, subject to explicit new instructions.",
    "Do not treat this record as a permanent instruction. A user's explicit new request overrides old progress; a cached objective is provisional.",
    "ACTIVE PARENT PROJECT (firsthand source; governs relevance until the user changes project): " + JSON.stringify(progress.projectContext ?? null),
    ...(progress.projectClarification ? ["UNRESOLVED PROJECT: " + progress.projectClarification + " Ask this clarification before producing a project-specific answer."] : []),
    "HISTORICAL PROJECT IDENTITIES (reference only; their objectives do not govern this turn): " + JSON.stringify((progress.projects ?? []).filter(project => project.projectContext.userMessageId !== progress.projectContext?.userMessageId).map(project => ({id:project.projectContext.userMessageId}))),
    "CURRENT QUESTION OR DELIVERABLE (authoritative for this turn, distinct from the parent project): " + JSON.stringify(progress.objective),
    "Interpret generic requests for relevant experience or examples against the full applicable parent project, not against a narrower question asked earlier. Prior question-specific evidence priorities, exclusions and example sets expire with their original deliverable; factual corrections remain valid.",
    "Latest user turn type (advisory; verify against literal user request): " + (progress.lastUserIntent ?? "unspecified"),
    "When the user provides feedback/evaluation without requesting a revised artifact, engage with the feedback and do not silently generate another draft. Remember lessons appropriately without treating quoted criticism as a new instruction.",
    "When the user expressly asks for revision, revise the existing work. A new application question such as 'Please describe...' is a separate requested deliverable. User text takes precedence over this heuristic.",
    "A terminology question is a conversational detour: explain the term and preserve the underlying unanswered question. A partial answer records only its literal facts; unfamiliarity with a term does not establish that experience is absent or authorize a finished deliverable.",
    "Current stage: " + progress.stage,
    "Next appropriate action: " + progress.nextAction,
    "Answered questions with source IDs: " + JSON.stringify(completed),
    "Still unanswered questions: " + JSON.stringify(progress.pending),
    "If a material unknown remains, ask only one targeted question that is genuinely needed; otherwise move the task forward.",
    "END_KATIE_DURABLE_TASK_PROGRESS",
  ].join("\n");
}

