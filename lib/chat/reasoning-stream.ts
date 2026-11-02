export const DEFAULT_REASONING_CATEGORIES = ["Architecture", "Security", "Complexity", "Cost", "Reliability"] as const;

export type ReasoningCategoryState = {
  name: string;
  score: number | null;
  confidence: number | null;
  explanation: string;
  progress: number | null;
};

export type ReasoningStartEvent = {
  type: "reasoning_start";
  requestId: string;
  categories: string[];
  startedAt: string;
};

export type ReasoningUpdateEvent = {
  type: "reasoning_update";
  requestId: string;
  category: string;
  explanationDelta: string;
  score: number | null;
  confidence: number | null;
  progress: number | null;
  updatedAt: string;
};

export type ReasoningSnapshotEvent = {
  type: "reasoning_snapshot";
  requestId: string;
  categories: ReasoningCategoryState[];
  overallProgress: number;
  updatedAt: string;
};

export type FinalAnswerEvent = {
  type: "final_answer";
  requestId: string;
  answer: string;
  summaryScores: Array<{
    name: string;
    score: number | null;
    confidence: number | null;
  }>;
  completedAt: string;
};

export type ReasoningErrorEvent = {
  messageId?: string;
  type: "reasoning_error";
  requestId: string;
  message: string;
  recoverable: boolean;
};

export type ReasoningStreamEvent =
  | ReasoningStartEvent
  | ReasoningUpdateEvent
  | ReasoningSnapshotEvent
  | FinalAnswerEvent
  | ReasoningErrorEvent;

export type ReasoningUiState = {
  requestId: string | null;
  startedAt: string | null;
  categories: ReasoningCategoryState[];
  liveExplainer: string;
  overallProgress: number;
  finalAnswer: string | null;
  summaryScores: Array<{ name: string; score: number | null; confidence: number | null }>;
  error: { message: string; recoverable: boolean } | null;
  completedAt: string | null;
};

export function createReasoningUiState(): ReasoningUiState {
  return {
    requestId: null,
    startedAt: null,
    categories: [],
    liveExplainer: "",
    overallProgress: 0,
    finalAnswer: null,
    summaryScores: [],
    error: null,
    completedAt: null
  };
}

function upsertCategory(categories: ReasoningCategoryState[], nextCategory: ReasoningCategoryState): ReasoningCategoryState[] {
  const existingIndex = categories.findIndex((item) => item.name === nextCategory.name);
  if (existingIndex === -1) {
    return [...categories, nextCategory];
  }
  const clone = [...categories];
  clone[existingIndex] = nextCategory;
  return clone;
}

export function applyReasoningEvent(state: ReasoningUiState, event: ReasoningStreamEvent): ReasoningUiState {
  if (event.type === "reasoning_start") {
    return {
      ...createReasoningUiState(),
      requestId: event.requestId,
      startedAt: event.startedAt,
      categories: event.categories.map((name) => ({
        name,
        score: null,
        confidence: null,
        explanation: "",
        progress: null
      }))
    };
  }

  if (event.type === "reasoning_update") {
    const category = state.categories.find((item) => item.name === event.category) ?? {
      name: event.category,
      score: null,
      confidence: null,
      explanation: "",
      progress: null
    };

    const nextCategory: ReasoningCategoryState = {
      name: category.name,
      score: event.score ?? category.score,
      confidence: event.confidence ?? category.confidence,
      explanation: `${category.explanation}${event.explanationDelta}`,
      progress: event.progress ?? category.progress
    };

    return {
      ...state,
      requestId: event.requestId,
      categories: upsertCategory(state.categories, nextCategory),
      liveExplainer: `${state.liveExplainer}${event.explanationDelta}`
    };
  }

  if (event.type === "reasoning_snapshot") {
    return {
      ...state,
      requestId: event.requestId,
      categories: event.categories,
      liveExplainer: event.categories.map((entry) => entry.explanation).join("\n\n").trim(),
      overallProgress: event.overallProgress
    };
  }

  if (event.type === "final_answer") {
    return {
      ...state,
      requestId: event.requestId,
      finalAnswer: event.answer,
      summaryScores: event.summaryScores,
      completedAt: event.completedAt,
      overallProgress: 100
    };
  }

  return {
    ...state,
    requestId: event.requestId,
    error: {
      message: event.message,
      recoverable: event.recoverable
    }
  };
}

export class ReasoningStateAccumulator {
  private categories: ReasoningCategoryState[];
  private sentFinal = false;
  private updateIndex = 0;

  constructor(private readonly requestId: string, categories: string[]) {
    this.categories = categories.map((name) => ({
      name,
      score: null,
      confidence: null,
      explanation: "",
      progress: 0
    }));
  }

  start(now = new Date()): ReasoningStartEvent {
    return {
      type: "reasoning_start",
      requestId: this.requestId,
      categories: this.categories.map((item) => item.name),
      startedAt: now.toISOString()
    };
  }

  addDelta(delta: string, now = new Date()): ReasoningUpdateEvent | null {
    const trimmed = delta;
    if (!trimmed) {
      return null;
    }

    const index = this.updateIndex % this.categories.length;
    this.updateIndex += 1;
    const category = this.categories[index];
    category.explanation = `${category.explanation}${trimmed}`;

    const nextProgress = Math.min(95, Math.max(category.progress ?? 0, Math.round(category.explanation.length / 6)));
    category.progress = nextProgress;

    if (category.score === null && category.explanation.length >= 80) {
      category.score = Math.min(10, Math.max(1, Math.round(category.explanation.length / 40)));
      category.confidence = Math.min(0.95, Math.max(0.2, Number((category.explanation.length / 250).toFixed(2))));
    }

    return {
      type: "reasoning_update",
      requestId: this.requestId,
      category: category.name,
      explanationDelta: trimmed,
      score: category.score,
      confidence: category.confidence,
      progress: category.progress,
      updatedAt: now.toISOString()
    };
  }

  snapshot(now = new Date()): ReasoningSnapshotEvent {
    const overallProgress =
      this.categories.length > 0
        ? Math.round(this.categories.reduce((sum, item) => sum + (item.progress ?? 0), 0) / this.categories.length)
        : 0;

    return {
      type: "reasoning_snapshot",
      requestId: this.requestId,
      categories: this.categories.map((item) => ({ ...item })),
      overallProgress,
      updatedAt: now.toISOString()
    };
  }

  finalize(answer: string, now = new Date()): FinalAnswerEvent {
    if (this.sentFinal) {
      throw new Error("final_answer already emitted");
    }
    this.sentFinal = true;

    this.categories = this.categories.map((item) => ({
      ...item,
      progress: 100,
      score: item.score ?? (item.explanation.length > 0 ? 7 : null),
      confidence: item.confidence ?? (item.explanation.length > 0 ? 0.7 : null)
    }));

    return {
      type: "final_answer",
      requestId: this.requestId,
      answer,
      summaryScores: this.categories.map((item) => ({
        name: item.name,
        score: item.score,
        confidence: item.confidence
      })),
      completedAt: now.toISOString()
    };
  }

  error(message: string, recoverable: boolean): ReasoningErrorEvent {
    return {
      type: "reasoning_error",
      requestId: this.requestId,
      message,
      recoverable
    };
  }
}

/**
 * A narrow boundary for malformed conversational output. The observed provider
 * response started with a duration line followed by an editorial description
 * of the user's message. Normal conversational answers pass through unchanged.
 */
const EDITORIAL_OPENING = /^\s*\d{1,3}(?:\.\d{1,3})?s[ \t]*\r?\n[ \t]*\r?\n[ \t]*The user is\b/i;

export function resolveChatAnswer(raw: string): string | null {
  if (!EDITORIAL_OPENING.test(raw)) return raw;

  const explicit = /(?:^|\n)\s*(?:FINAL ANSWER|RESPONSE TO USER)\s*:\s*/gi;
  let match: RegExpExecArray | null;
  let answer: string | null = null;
  while ((match = explicit.exec(raw)) !== null) {
    const candidate = raw.slice(match.index + match[0].length).trim();
    if (candidate.length > 12 && !EDITORIAL_OPENING.test(candidate)) answer = candidate;
  }
  if (answer) return answer;

  // The incident's final answer directly followed an editorial sentence,
  // without a line break. Require that sentence AND an addressed reply.
  const boundary = /\bMatch (?:his|her|their) tone\b[^\n]{0,210}?[.!?](?=[A-Z][a-z])/gi;
  while ((match = boundary.exec(raw)) !== null) {
    if (match.index < 180) continue;
    const candidate = raw.slice(match.index + match[0].length).trim();
    if (candidate.length >= 12 && /\b(?:you|your|you're|you've)\b/i.test(candidate.slice(0,240))) {
      answer = candidate;
    }
  }
  return answer;
}

/** Delay the first streamed characters until the opening can be classified. */
export class ChatAnswerStreamBoundary {
  private pending = "";
  private state: "checking" | "ordinary" | "held" = "checking";

  write(delta: string): string {
    if (!delta || this.state === "held") return "";
    if (this.state === "ordinary") return delta;
    this.pending += delta;
    if (EDITORIAL_OPENING.test(this.pending)) {
      this.pending = "";
      this.state = "held";
      return "";
    }
    if (this.pending.length < 160) return "";
    const released = this.pending;
    this.pending = "";
    this.state = "ordinary";
    return released;
  }

  flushAccepted(): string {
    if (this.state !== "checking") return "";
    this.state = "ordinary";
    const released = this.pending;
    this.pending = "";
    return released;
  }
}
