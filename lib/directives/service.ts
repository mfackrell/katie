import { extractDirectiveCandidate, isDirectiveRemovalRequest } from "@/lib/directives/extraction";
import {
  deactivateDirectivesForActor,
  saveDirective,
  syncActorSystemPromptWithDirectives,
} from "@/lib/data/persistence-store";
import type { DirectiveKind } from "@/lib/types/directives";

const DEFAULT_KIND: DirectiveKind = "preference";

export async function processPersistentDirectiveMessage(params: {
  actorId: string;
  userId: string;
  message: string;
}): Promise<{ acknowledged: boolean; action: "saved" | "removed" | "none" | "ambiguous" }> {
  const { actorId, userId, message } = params;

  if (isDirectiveRemovalRequest(message)) {
    const count = await deactivateDirectivesForActor(actorId, userId);
    if (count > 0) {
      await syncActorSystemPromptWithDirectives(actorId, userId);
      return { acknowledged: true, action: "removed" };
    }
    return { acknowledged: false, action: "none" };
  }

  const candidate = extractDirectiveCandidate(message);
  if (!candidate) {
    return { acknowledged: false, action: "none" };
  }

  if (candidate.confidence !== "high") {
    return { acknowledged: false, action: "ambiguous" };
  }

  const { created } = await saveDirective({
    actorId,
    userId,
    directive: candidate.directive,
    kind: DEFAULT_KIND,
    scope: "actor",
  });

  if (created) {
    await syncActorSystemPromptWithDirectives(actorId, userId);
  }

  return { acknowledged: true, action: "saved" };
}
