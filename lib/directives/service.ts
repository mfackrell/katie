import {
  deactivateDirective,
  deactivateDirectivesForActor,
  listActiveDirectivesForActor,
  saveDirective,
  syncActorSystemPromptWithDirectives
} from "@/lib/data/persistence-store";
import { classifyDirectiveFallback, classifyDirectiveIntent, type DirectiveDecision } from "@/lib/directives/classifier";
import { normalizeDirectiveForCompare } from "@/lib/directives/extraction";
import type { DirectiveKind, PersistentDirective } from "@/lib/types/directives";

const DEFAULT_KIND: DirectiveKind = "preference";

type DirectiveProcessingResult = {
  handled: boolean;
  acknowledged: boolean;
  action: DirectiveDecision["action"];
  acknowledgement: string | null;
  usedFallback: boolean;
};

function findDirectiveMatch(directives: PersistentDirective[], directive?: string | null): PersistentDirective[] {
  if (!directive) {
    return directives;
  }

  const normalizedTarget = normalizeDirectiveForCompare(directive);
  return directives.filter((item) => normalizeDirectiveForCompare(item.directive).includes(normalizedTarget));
}

export async function processPersistentDirectiveMessage(params: {
  actorId: string;
  userId: string;
  message: string;
  classify?: (message: string) => Promise<DirectiveDecision | null>;
  fallbackClassify?: (message: string) => DirectiveDecision;
}): Promise<DirectiveProcessingResult> {
  const { actorId, userId, message, classify = classifyDirectiveIntent, fallbackClassify = classifyDirectiveFallback } = params;

  let decision = await classify(message);
  let usedFallback = false;

  if (!decision) {
    usedFallback = true;
    decision = fallbackClassify(message);
  }

  if (decision.action === "normal_message") {
    return {
      handled: false,
      acknowledged: false,
      action: "normal_message",
      acknowledgement: null,
      usedFallback
    };
  }

  if (decision.action === "persistent_directive_add") {
    await saveDirective({ actorId, userId, directive: decision.directive, kind: DEFAULT_KIND, scope: "actor" });
    console.log(`[Directive Action] saved directive for actor=${actorId}`);
    await syncActorSystemPromptWithDirectives(actorId, userId);
    console.log("[Directive Sync] updated managed prompt block");
    return {
      handled: true,
      acknowledged: true,
      action: decision.action,
      acknowledgement: "Got it. I'll remember that.",
      usedFallback
    };
  }

  if (decision.action === "persistent_directive_update") {
    const active = await listActiveDirectivesForActor(actorId, userId);
    const matches = findDirectiveMatch(active, decision.directive);
    await Promise.all(matches.map((item) => deactivateDirective(item.id)));
    await saveDirective({ actorId, userId, directive: decision.directive, kind: DEFAULT_KIND, scope: "actor" });
    console.log(`[Directive Action] updated directive for actor=${actorId}`);
    await syncActorSystemPromptWithDirectives(actorId, userId);
    console.log("[Directive Sync] updated managed prompt block");
    return {
      handled: true,
      acknowledged: true,
      action: decision.action,
      acknowledgement: "Understood. I updated that instruction.",
      usedFallback
    };
  }

  const active = await listActiveDirectivesForActor(actorId, userId);
  const matches = findDirectiveMatch(active, decision.directive);
  if (matches.length) {
    await Promise.all(matches.map((item) => deactivateDirective(item.id)));
  } else {
    await deactivateDirectivesForActor(actorId, userId);
  }
  console.log(`[Directive Action] removed directive for actor=${actorId} matches=${matches.length}`);
  await syncActorSystemPromptWithDirectives(actorId, userId);
  console.log("[Directive Sync] updated managed prompt block");
  return {
    handled: true,
    acknowledged: true,
    action: decision.action,
    acknowledgement: "Got it. I removed that instruction.",
    usedFallback
  };
}
