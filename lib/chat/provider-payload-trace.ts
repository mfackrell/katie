import type { Message } from "@/lib/types/chat";
import type { ProviderPayloadCaptureTrace } from "@/lib/providers/types";

type Input = {
  actorId: string;
  chatId: string;
  requestId: string;
  historySource: "stm" | "recent_messages";
  shortTermMemory: Record<string, unknown>;
  recentMessages: Message[];
  history: Message[];
  summary: string;
};

/** Metadata-only trace of selected sources. No message bodies are duplicated here. */
export function buildProviderPayloadCaptureTrace(input: Input): ProviderPayloadCaptureTrace {
  const excludedTurns: ProviderPayloadCaptureTrace["excludedTurns"] = [];
  let pendingUser: Message | null = null;
  let lastCompletedAssistantId: string | null = null;
  for (const turn of input.recentMessages) {
    if (turn.role === "user") {
      if (pendingUser) {
        excludedTurns.push({ id: pendingUser.id, role: "user", reason: "superseded-unpaired-user" });
      }
      pendingUser = turn;
      continue;
    }
    if (turn.role !== "assistant") continue;
    if (!pendingUser) {
      excludedTurns.push({ id: turn.id, role: "assistant", reason: "orphan-assistant" });
      continue;
    }
    if (turn.model === "katie-local") {
      excludedTurns.push({ id: pendingUser.id, role: "user", reason: "local-diagnostic-pair" });
      excludedTurns.push({ id: turn.id, role: "assistant", reason: "local-diagnostic-pair" });
    } else {
      lastCompletedAssistantId = turn.id;
    }
    pendingUser = null;
  }
  if (pendingUser) excludedTurns.push({ id: pendingUser.id, role: "user", reason: "awaiting-assistant" });

  const exchanges = Array.isArray(input.shortTermMemory.exchanges) ? input.shortTermMemory.exchanges : [];
  const lastExchange = exchanges.at(-1) as { assistant?: { id?: unknown } } | undefined;
  const stmLastAssistantId = typeof lastExchange?.assistant?.id === "string" ? lastExchange.assistant.id : null;

  return {
    actorId: input.actorId,
    chatId: input.chatId,
    requestId: input.requestId,
    historySource: input.historySource,
    stmVersion: typeof input.shortTermMemory.version === "number" ? input.shortTermMemory.version : null,
    stmExchangeCount: exchanges.length,
    stmLastAssistantId,
    persistedLastCompletedAssistantId: lastCompletedAssistantId,
    stmMatchesPersistedTail: stmLastAssistantId !== null && stmLastAssistantId === lastCompletedAssistantId,
    historyTurns: input.history.map(turn => ({ id: turn.id, role: turn.role as "user" | "assistant", createdAt: turn.createdAt })),
    recentPersistedTurns: input.recentMessages.map(turn => ({ id: turn.id, role: turn.role, createdAt: turn.createdAt })),
    excludedTurns,
    intermediateSummaryChars: input.summary.length,
  };
}
