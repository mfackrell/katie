import type {
  CollaborationCapability,
  CollaborationHelperSelection,
  CollaborationParticipant,
  CollaborationRequest,
} from "@/lib/collaboration/types";
import type { RegistryRoutingModel } from "@/lib/models/registry";
import type { LlmProvider } from "@/lib/providers/types";
import { chooseProvider, type ResolvedRoutingIntent } from "@/lib/router/master-router";
import type { RequestIntent } from "@/lib/router/model-intent";
import type { ActorRoutingProfile } from "@/lib/types/chat";

export function collaborationCapabilityToIntent(
  capability: CollaborationCapability,
): RequestIntent {
  switch (capability) {
    case "coding":
      return "code-generation";
    case "debugging":
      return "technical-debugging";
    case "architecture":
      return "architecture-review";
    case "research":
      return "web-search";
    case "writing":
      return "rewrite";
    case "vision":
      return "vision-analysis";
    case "critique":
      return "assistant-reflection";
    case "verification":
    case "analysis":
    case "math":
    case "other":
    default:
      return "general-text";
  }
}

function providerForName(
  providers: LlmProvider[],
  name: LlmProvider["name"],
): LlmProvider | null {
  return providers.find((provider) => provider.name === name) ?? null;
}

function participantKey(participant: CollaborationParticipant): string {
  return `${participant.provider}:${participant.modelId.trim().toLowerCase()}`;
}

function buildResolvedIntent(
  request: CollaborationRequest,
): ResolvedRoutingIntent {
  return {
    intent: collaborationCapabilityToIntent(request.capability),
    preferredProvider: request.preferredProvider ?? null,
    intentSource: "upstream",
  };
}

/**
 * Quality-first selection only for the required independent reviewer.
 * Use verified high-reasoning models as an eligibility proxy, not a claim
 * about measured editorial accuracy. Fallback to the ordinary router if none.
 */
export function selectQualityFirstReviewer(input: {
  requester: CollaborationParticipant;
  providers: LlmProvider[];
  usedParticipants: CollaborationParticipant[];
  snapshot?: Map<LlmProvider["name"], RegistryRoutingModel[]>;
}): CollaborationHelperSelection | null {
  if (!input.snapshot) return null;
  const used = new Set(input.usedParticipants.map(participantKey));
  used.add(participantKey(input.requester));
  const eligible: Array<{ provider: LlmProvider; model: RegistryRoutingModel }> = [];
  for (const provider of input.providers) {
    if (provider.name === input.requester.provider) continue;
    for (const model of input.snapshot.get(provider.name) ?? []) {
      if (model.routing_eligibility !== "verified" || model.reasoning_tier !== "high" ||
          model.supports_text === false || used.has(provider.name + ":" + model.model_id.trim().toLowerCase())) continue;
      eligible.push({ provider, model });
    }
  }
  eligible.sort((a,b) =>
    (Number(b.model.confidence_score ?? 0) - Number(a.model.confidence_score ?? 0)) ||
    ((b.model.confidence_tier === "high" ? 1 : 0) - (a.model.confidence_tier === "high" ? 1 : 0)) ||
    a.provider.name.localeCompare(b.provider.name) || a.model.model_id.localeCompare(b.model.model_id));
  const picked = eligible[0];
  return picked ? {
    provider: picked.provider,
    modelId: picked.model.model_id,
    reasoning: "Required review quality-first: verified, high-reasoning, text-capable model from another provider; ranked by registry confidence. Actual editorial quality is not assumed measured.",
  } : null;
}

export async function selectCollaborationHelper(input: {
  requestId: string;
  request: CollaborationRequest;
  requester: CollaborationParticipant;
  providers: LlmProvider[];
  usedParticipants: CollaborationParticipant[];
  modelRegistrySnapshot?: Map<LlmProvider["name"], RegistryRoutingModel[]>;
  actorId?: string;
  actorRoutingProfile?: ActorRoutingProfile;
  hasImages?: boolean;
  hasVideoInput?: boolean;
}): Promise<CollaborationHelperSelection | null> {
  if (!input.providers.length) {
    return null;
  }

  const requiredReviewer = input.request.capability === "critique" &&
    input.request.task.startsWith("Independently review a completed response");
  if (requiredReviewer) {
    const qualityReviewer = selectQualityFirstReviewer({
      requester: input.requester,
      providers: input.providers,
      usedParticipants: input.usedParticipants,
      snapshot: input.modelRegistrySnapshot,
    });
    if (qualityReviewer) {
      console.info("[RequiredReview] selected quality-first reviewer", { requestId: input.requestId,
        provider: qualityReviewer.provider.name, model: qualityReviewer.modelId });
      return qualityReviewer;
    }
  }

  const usedKeys = new Set(input.usedParticipants.map(participantKey));
  const requesterKey = participantKey(input.requester);
  usedKeys.add(requesterKey);

  const preferredProvider = input.request.preferredProvider
    ? providerForName(input.providers, input.request.preferredProvider)
    : null;

  const crossProviderPool = input.providers.filter(
    (provider) => provider.name !== input.requester.provider,
  );
  const previouslyUsedHelperProviders = new Set(
    input.usedParticipants
      .filter((value) => participantKey(value) !== requesterKey)
      .map((value) => value.provider),
  );
  const diverseResearchPool =
    input.request.capability === "research"
      ? crossProviderPool.filter((provider) => !previouslyUsedHelperProviders.has(provider.name))
      : crossProviderPool;

  const firstPool = preferredProvider
    ? [preferredProvider]
    : diverseResearchPool.length
      ? diverseResearchPool
      : crossProviderPool.length
        ? crossProviderPool
        : input.providers;

  const excludedCandidates = input.usedParticipants.map((value) => ({
    providerName: value.provider,
    modelId: value.modelId,
  }));

  const route = async (
    providers: LlmProvider[],
    suffix: string,
    exclusions: Array<{ providerName: LlmProvider["name"]; modelId: string }>,
  ) => {
    if (!providers.length) {
      return null;
    }

    try {
      const decision = await chooseProvider(
        [
          input.request.task,
          input.request.context ? `Context: ${input.request.context}` : "",
          `Requested collaboration capability: ${input.request.capability}`,
        ]
          .filter(Boolean)
          .join("\n"),
        "Internal Katie collaboration helper selection.",
        providers,
        {
          routingRequestId: `${input.requestId}:collab:${suffix}`,
          resolvedIntent: buildResolvedIntent(input.request),
          modelRegistrySnapshot: input.modelRegistrySnapshot,
          actorId: input.actorId,
          actorRoutingProfile: input.actorRoutingProfile,
          excludedCandidates: exclusions,
          hasImages: Boolean(input.hasImages),
          hasVideoInput: Boolean(input.hasVideoInput),
        },
      );

      const selected: CollaborationParticipant = {
        provider: decision.provider.name,
        modelId: decision.modelId,
      };
      if (usedKeys.has(participantKey(selected))) {
        return null;
      }

      return {
        provider: decision.provider,
        modelId: decision.modelId,
        reasoning: decision.reasoning,
      } satisfies CollaborationHelperSelection;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const noEligibleCandidates =
        error instanceof Error && error.name === "NoEligibleRoutingCandidatesError";
      const log = noEligibleCandidates ? console.info : console.warn;
      log("[Collaboration] helper routing unavailable", {
        requestId: input.requestId,
        requester: input.requester,
        capability: input.request.capability,
        suffix,
        reason,
      });
      return null;
    }
  };

  const primary = await route(firstPool, "cross-provider", excludedCandidates);
  if (primary) {
    return primary;
  }

  // If cross-provider diversity is unavailable, allow another model from the
  // same provider, but never reuse the exact requester/used participant.
  return route(input.providers, "same-provider-fallback", excludedCandidates);
}

