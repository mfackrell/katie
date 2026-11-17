import type { ActorRoutingProfile } from "@/lib/types/chat";
import type { LlmProvider, FileReference, ChatGenerateParams } from "@/lib/providers/types";
import type { RoutingHint, RoutingMode } from "@/lib/router/model-intent";
import { chooseProvider, type ResolvedRoutingIntent, type RoutingDecision } from "@/lib/router/master-router";
import { filterHealthyProviders } from "@/lib/router/provider-error";
import { getAttachmentSupportForProvider } from "@/lib/chat/video-routing";
import { isReviewedCrossProviderContextCandidate } from "@/lib/standalone-accounting/context-upgrade";
import type { PricingSnapshot } from "@/lib/standalone-accounting/pricing";

type Candidate = { providerName: LlmProvider["name"]; modelId: string };

/** Invoked only after the existing same-provider context upgrade fails.
 * This cannot authorize spending; the selected model still passes the normal
 * full-request accounting gate before provider generation. */
export async function chooseCrossProviderContextRecovery(input: {
  message: string;
  conversationContext: string;
  providers: LlmProvider[];
  failedProviderNames: ReadonlySet<LlmProvider["name"]>;
  previousAttempts: Candidate[];
  otherExcluded: Candidate[];
  pricing: PricingSnapshot;
  inputTokens: number;
  outputAllowance: number;
  attachments: FileReference[];
  resolvedIntent: ResolvedRoutingIntent;
  routingMode: RoutingMode;
  routingRequestParams: (intent: ResolvedRoutingIntent) => Promise<Omit<ChatGenerateParams, "modelId">>;
  routingRequestId: string;
  actorId: string;
  actorRoutingProfile?: ActorRoutingProfile;
  routingHints: RoutingHint[];
  routingTraceEnabled?: boolean;
}): Promise<RoutingDecision | null> {
  const excludedCandidates = [...input.previousAttempts, ...input.otherExcluded];
  const excludedKeys = new Set(excludedCandidates.map(item =>
    `${item.providerName}:${item.modelId.trim().toLowerCase()}`));
  const candidateAllowed = (providerName: LlmProvider["name"], modelId: string) =>
    !excludedKeys.has(`${providerName}:${modelId.trim().toLowerCase()}`) &&
    getAttachmentSupportForProvider(providerName, input.attachments).supported &&
    isReviewedCrossProviderContextCandidate({
      provider: providerName, model: modelId, pricing: input.pricing,
      inputTokens: input.inputTokens, outputAllowance: input.outputAllowance,
    });
  const availableProviders = filterHealthyProviders(input.providers, new Set(input.failedProviderNames));
  // If no reviewed, priceable model can carry the unchanged request, do
  // not spend an LLM control-plane call or silently pick a weaker model.
  if (!availableProviders.some(provider =>
    input.pricing.models.some(price => price.provider === provider.name &&
      candidateAllowed(provider.name, price.model)))) return null;

  const decision = await chooseProvider(
    input.message,
    [
      input.conversationContext,
      `Pre-dispatch context admission failed. Full unchanged input and output allowance require at least ${input.inputTokens + input.outputAllowance} reviewed context tokens.`,
    ].join("\n"),
    availableProviders,
    {
      hasImages: false,
      hasVideoInput: false,
      actorId: input.actorId,
      actorRoutingProfile: input.actorRoutingProfile,
      routingHints: input.routingHints,
      routing_mode: input.routingMode,
      routingRequestParams: input.routingRequestParams,
      routingTraceEnabled: input.routingTraceEnabled,
      routingRequestId: input.routingRequestId,
      resolvedIntent: {...input.resolvedIntent, intentSource: "upstream"},
      excludedCandidates,
      candidateAllowed,
      rerouteContext: {
        reason: "provider-error",
        failed_candidates: excludedCandidates.map(item => ({
          provider: item.providerName, model: item.modelId,
        })),
      },
    },
  );
  // An LLM decision is mandatory for cross-provider recovery. The deterministic
  // router fallback cannot silently change the requested response model.
  return decision.explainer?.selected_source === "llm-primary" &&
    candidateAllowed(decision.provider.name, decision.modelId) ? decision : null;
}
