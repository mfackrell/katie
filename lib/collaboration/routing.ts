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

export async function selectCollaborationHelper(input: {
  requestId: string;
  request: CollaborationRequest;
  requester: CollaborationParticipant;
  providers: LlmProvider[];
  usedParticipants: CollaborationParticipant[];
  modelRegistrySnapshot?: Map<LlmProvider["name"], RegistryRoutingModel[]>;
  actorId?: string;
  actorRoutingProfile?: ActorRoutingProfile;
}): Promise<CollaborationHelperSelection | null> {
  if (!input.providers.length) {
    return null;
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

  const firstPool = preferredProvider
    ? [preferredProvider]
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
      console.warn("[Collaboration] helper routing attempt failed", {
        requestId: input.requestId,
        requester: input.requester,
        capability: input.request.capability,
        suffix,
        reason: error instanceof Error ? error.message : String(error),
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
