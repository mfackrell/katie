import { NextResponse } from "next/server";
import { runAdaptiveCollaboration } from "@/lib/collaboration/orchestrator";
import { selectCollaborationHelper } from "@/lib/collaboration/routing";
import { getRoutingRegistryByProvider } from "@/lib/models/registry";
import { getAvailableProviders } from "@/lib/providers";
import { chooseProvider } from "@/lib/router/master-router";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

export async function GET() {
  const requestId = `live-collab-${crypto.randomUUID()}`;
  const startedAt = Date.now();

  try {
    const providers = getAvailableProviders();
    if (providers.length < 2) {
      return NextResponse.json(
        {
          ok: false,
          requestId,
          error: "At least two configured providers are required for the live collaboration test.",
          providerCount: providers.length,
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const registrySnapshot = await getRoutingRegistryByProvider(providers);
    const leadDecision = await chooseProvider(
      "Perform a rigorous architecture verification using another AI model.",
      "Temporary Katie multi-model live integration test.",
      providers,
      {
        routingRequestId: `${requestId}:lead`,
        resolvedIntent: {
          intent: "architecture-review",
          preferredProvider: null,
          intentSource: "upstream",
          complexity: "high",
        },
        modelRegistrySnapshot: registrySnapshot,
      },
    );

    const collaboration = await runAdaptiveCollaboration({
      requestId,
      leadProvider: leadDecision.provider,
      leadModelId: leadDecision.modelId,
      providers,
      params: {
        name: "Katie",
        persona: [
          "This is a controlled integration test of Katie's adaptive multi-model collaboration.",
          "In your first collaboration-control pass, you MUST request exactly one verification helper from another model.",
          "Ask the helper to independently verify that the arithmetic statement 2 + 2 = 4 is correct.",
          "After the helper returns, proceed to final synthesis rather than requesting unnecessary extra helpers.",
          "The final user-facing answer should be brief and include the exact marker COLLABORATION_LIVE_TEST_OK if the helper confirms the statement.",
        ].join("\n"),
        summary: "",
        history: [],
        user: "Run the collaboration integration test exactly as instructed.",
        requestIntent: "architecture-review",
        modelId: leadDecision.modelId,
      },
      maxDelegations: 2,
      maxDepth: 1,
      maxContributionChars: 4_000,
      maxTotalContributionChars: 8_000,
      participantTimeoutMs: 90_000,
      async selectHelper(context) {
        return selectCollaborationHelper({
          requestId: context.requestId,
          request: context.request,
          requester: context.requester,
          providers,
          usedParticipants: context.usedParticipants,
          modelRegistrySnapshot: registrySnapshot,
          hasImages: false,
          hasVideoInput: false,
        });
      },
    });

    const markerPresent = collaboration.result.text.includes(
      "COLLABORATION_LIVE_TEST_OK",
    );
    const crossProviderUsed = collaboration.metadata.contributors.some(
      (contributor) =>
        contributor.provider !== leadDecision.provider.name,
    );
    const ok =
      collaboration.metadata.delegationCount >= 1 &&
      collaboration.metadata.contributors.length >= 1 &&
      markerPresent &&
      crossProviderUsed;

    console.info("[Collaboration Live Test]", {
      requestId,
      ok,
      lead: {
        provider: leadDecision.provider.name,
        modelId: leadDecision.modelId,
      },
      contributors: collaboration.metadata.contributors,
      delegationCount: collaboration.metadata.delegationCount,
      maxDepthReached: collaboration.metadata.maxDepthReached,
      markerPresent,
      crossProviderUsed,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        ok,
        requestId,
        lead: {
          provider: leadDecision.provider.name,
          modelId: leadDecision.modelId,
        },
        contributors: collaboration.metadata.contributors,
        delegationCount: collaboration.metadata.delegationCount,
        maxDepthReached: collaboration.metadata.maxDepthReached,
        markerPresent,
        crossProviderUsed,
        finalText: collaboration.result.text.slice(0, 1_000),
        trace: collaboration.trace.map((event) => ({
          type: event.type,
          depth: event.depth ?? null,
          capability: event.capability ?? null,
          requester: event.requester ?? null,
          helper: event.helper ?? null,
          detail: event.detail ?? null,
        })),
        durationMs: Date.now() - startedAt,
      },
      {
        status: ok ? 200 : 500,
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
      },
    );
  } catch (error) {
    console.error("[Collaboration Live Test] failed", {
      requestId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        ok: false,
        requestId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
      },
    );
  }
}
