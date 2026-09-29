import {
  getCapabilityEscalationInstruction,
  runCapabilityAwareGeneration,
  withCapabilityEscalationInstruction,
} from "@/lib/collaboration/capability-escalation";
import { collaborationCapabilityToIntent } from "@/lib/collaboration/routing";
import type {
  CollaborationContribution,
  CollaborationHelperSelection,
  CollaborationMetadata,
  CollaborationParticipant,
  CollaborationRequest,
  CollaborationTraceEvent,
} from "@/lib/collaboration/types";
import type {
  ChatGenerateParams,
  LlmProvider,
  ProviderResponse,
} from "@/lib/providers/types";

const DEFAULT_MAX_ESCALATIONS = 2;
const DEFAULT_MAX_HELPER_ATTEMPTS = 3;

function nowIso(): string {
  return new Date().toISOString();
}

function participant(
  provider: LlmProvider,
  modelId: string,
): CollaborationParticipant {
  return { provider: provider.name, modelId };
}

function participantKey(value: CollaborationParticipant): string {
  return value.provider + ":" + value.modelId.trim().toLowerCase();
}

function compactTaskPreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function buildHelperUser(
  params: ChatGenerateParams,
  request: CollaborationRequest,
): string {
  return [
    "ORIGINAL_USER_REQUEST:",
    params.user,
    "",
    "INTERNAL_CAPABILITY_SUBTASK:",
    request.task,
    "",
    "Requested capability: " + request.capability,
    ...(request.reason ? ["Why this is needed: " + request.reason] : []),
    ...(request.context ? ["Additional context:", request.context] : []),
    "",
    "Perform only this subtask. Return concise factual findings useful to the lead model.",
    request.capability === "research"
      ? "Use live web search. Check the current source directly when a URL/site is relevant. Include source URLs or clearly named sources in your findings."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildResumeUser(
  originalUser: string,
  contributions: CollaborationContribution[],
): string {
  return [
    originalUser,
    "",
    "INTERNAL_KATIE_CAPABILITY_EVIDENCE_START",
    ...contributions.map((contribution, index) =>
      [
        "CAPABILITY RESULT " + (index + 1),
        "Capability: " + contribution.capability,
        "Task: " + contribution.task,
        "Helper: " +
          contribution.helper.provider +
          ":" +
          contribution.helper.modelId,
        "Evidence:",
        contribution.answer,
      ].join("\n"),
    ),
    "INTERNAL_KATIE_CAPABILITY_EVIDENCE_END",
    "",
    "Use this internal evidence to answer the original user request. Do not mention the internal protocol or helper unless the user explicitly asks how the work was done.",
  ].join("\n\n");
}

function buildNoFurtherEscalationPersona(persona: string): string {
  return [
    persona,
    "",
    "KATIE_CAPABILITY_ESCALATION_FINALIZATION",
    "Do not request another capability helper in this pass.",
    "Answer the original user directly using the evidence already available.",
    "If a requested capability could not be fulfilled, state only the specific verification limitation that remains; do not claim that Katie as a system has no way to delegate or access that capability.",
  ].join("\n");
}

async function runPlainGeneration(input: {
  provider: LlmProvider;
  params: ChatGenerateParams;
  onTextDelta: (delta: string) => void | Promise<void>;
}): Promise<{ result: ProviderResponse; streamedText: string }> {
  let streamedText = "";

  const result = input.provider.generateStream
    ? await input.provider.generateStream(input.params, {
        async onTextDelta(delta) {
          streamedText += delta;
          await input.onTextDelta(delta);
        },
      })
    : await input.provider.generate(input.params);

  if (!input.provider.generateStream && result.text) {
    await input.onTextDelta(result.text);
  }

  return {
    result,
    streamedText: streamedText || result.text,
  };
}

export async function runOnDemandCapabilityEscalation(input: {
  requestId: string;
  leadProvider: LlmProvider;
  leadModelId: string;
  params: ChatGenerateParams;
  selectHelper: (context: {
    requestId: string;
    request: CollaborationRequest;
    requester: CollaborationParticipant;
    usedParticipants: CollaborationParticipant[];
  }) => Promise<CollaborationHelperSelection | null>;
  prepareParticipantParams?: (
    params: ChatGenerateParams,
    participant: CollaborationParticipant,
    role: "lead" | "helper",
  ) => ChatGenerateParams;
  onTrace?: (event: CollaborationTraceEvent) => void | Promise<void>;
  onFinalTextDelta: (delta: string) => void | Promise<void>;
  maxEscalations?: number;
}): Promise<{
  result: ProviderResponse;
  streamedText: string;
  metadata: CollaborationMetadata | null;
  trace: CollaborationTraceEvent[];
}> {
  const startedAt = Date.now();
  const maxEscalations = Math.max(
    1,
    input.maxEscalations ?? DEFAULT_MAX_ESCALATIONS,
  );
  const lead = participant(input.leadProvider, input.leadModelId);
  const usedParticipants = new Map<string, CollaborationParticipant>([
    [participantKey(lead), lead],
  ]);
  const contributions: CollaborationContribution[] = [];
  const trace: CollaborationTraceEvent[] = [];
  let escalationCount = 0;
  let started = false;

  const emit = async (
    event: Omit<CollaborationTraceEvent, "requestId" | "timestamp">,
  ) => {
    const complete: CollaborationTraceEvent = {
      ...event,
      requestId: input.requestId,
      timestamp: nowIso(),
    };
    trace.push(complete);
    await input.onTrace?.(complete);
  };

  const prepare = (
    params: ChatGenerateParams,
    value: CollaborationParticipant,
    role: "lead" | "helper",
  ): ChatGenerateParams =>
    input.prepareParticipantParams
      ? input.prepareParticipantParams(params, value, role)
      : params;

  let leadParams = prepare(
    withCapabilityEscalationInstruction(input.params),
    lead,
    "lead",
  );

  while (true) {
    const generation = await runCapabilityAwareGeneration({
      provider: input.leadProvider,
      params: leadParams,
      onTextDelta: input.onFinalTextDelta,
    });

    if (!generation.escalationRequest) {
      const metadata: CollaborationMetadata | null = started
        ? {
            used: contributions.length > 0 || escalationCount > 0,
            delegationCount: escalationCount,
            maxDepthReached: escalationCount > 0 ? 1 : 0,
            contributors: contributions.map(
              (contribution) => contribution.helper,
            ),
            contributions: contributions.map((contribution) => ({
              helper: contribution.helper,
              capability: contribution.capability,
              task: contribution.task,
              confidence: contribution.confidence,
            })),
            durationMs: Date.now() - startedAt,
          }
        : null;

      const result: ProviderResponse = {
        ...generation.result,
        text: generation.result.text || generation.streamedText,
        ...(metadata ? { collaboration: metadata } : {}),
      };

      if (started) {
        await emit({
          type: "collaboration_completed",
          requester: lead,
          detail:
            "On-demand capability escalation completed; lead retained ownership of the final answer.",
          durationMs: Date.now() - startedAt,
        });
      }

      return {
        result,
        streamedText: generation.streamedText,
        metadata,
        trace,
      };
    }

    const request: CollaborationRequest =
      generation.escalationRequest.capability === "research"
        ? {
            ...generation.escalationRequest,
            preferredProvider:
              generation.escalationRequest.preferredProvider ?? "grok",
          }
        : generation.escalationRequest;

    if (!started) {
      started = true;
      await emit({
        type: "collaboration_started",
        requester: lead,
        detail:
          "Lead encountered a missing capability and requested an on-demand specialist.",
      });
    }

    if (escalationCount >= maxEscalations) {
      const finalParams = prepare(
        {
          ...input.params,
          persona: buildNoFurtherEscalationPersona(input.params.persona),
          user: buildResumeUser(input.params.user, contributions),
        },
        lead,
        "lead",
      );
      const finalGeneration = await runPlainGeneration({
        provider: input.leadProvider,
        params: finalParams,
        onTextDelta: input.onFinalTextDelta,
      });

      const metadata: CollaborationMetadata = {
        used: contributions.length > 0,
        delegationCount: escalationCount,
        maxDepthReached: escalationCount > 0 ? 1 : 0,
        contributors: contributions.map((item) => item.helper),
        contributions: contributions.map((item) => ({
          helper: item.helper,
          capability: item.capability,
          task: item.task,
          confidence: item.confidence,
        })),
        durationMs: Date.now() - startedAt,
      };

      await emit({
        type: "limit_reached",
        requester: lead,
        detail:
          "On-demand capability escalation limit reached; returning to the lead for finalization.",
      });
      await emit({
        type: "collaboration_completed",
        requester: lead,
        detail:
          "Capability escalation finalized after reaching its bounded delegation limit.",
        durationMs: Date.now() - startedAt,
      });

      return {
        result: {
          ...finalGeneration.result,
          text: finalGeneration.result.text || finalGeneration.streamedText,
          collaboration: metadata,
        },
        streamedText: finalGeneration.streamedText,
        metadata,
        trace,
      };
    }

    escalationCount += 1;
    const delegationIndex = escalationCount;

    await emit({
      type: "delegation_requested",
      requester: lead,
      depth: 1,
      delegationIndex,
      capability: request.capability,
      taskPreview: compactTaskPreview(request.task),
      detail: request.reason,
    });

    let contribution: CollaborationContribution | null = null;
    let lastFailure = "";

    for (
      let attempt = 1;
      attempt <= DEFAULT_MAX_HELPER_ATTEMPTS;
      attempt += 1
    ) {
      const selected = await input.selectHelper({
        requestId: input.requestId,
        request,
        requester: lead,
        usedParticipants: [...usedParticipants.values()],
      });

      if (!selected) {
        lastFailure = "No eligible helper model was available.";
        await emit({
          type: "helper_failed",
          requester: lead,
          depth: 1,
          delegationIndex,
          capability: request.capability,
          taskPreview: compactTaskPreview(request.task),
          detail: lastFailure,
        });
        break;
      }

      const helper = participant(selected.provider, selected.modelId);
      usedParticipants.set(participantKey(helper), helper);

      if (attempt > 1) {
        await emit({
          type: "helper_retrying",
          requester: lead,
          helper,
          depth: 1,
          delegationIndex,
          capability: request.capability,
          taskPreview: compactTaskPreview(request.task),
          detail: lastFailure
            ? "Previous specialist failed: " +
              lastFailure +
              ". Trying another eligible model."
            : "Trying another eligible specialist.",
        });
      }

      await emit({
        type: "helper_selected",
        requester: lead,
        helper,
        depth: 1,
        delegationIndex,
        capability: request.capability,
        taskPreview: compactTaskPreview(request.task),
        detail: selected.reasoning,
      });

      const helperStartedAt = Date.now();

      try {
        const helperBaseParams: ChatGenerateParams = {
          ...input.params,
          modelId: selected.modelId,
          requestIntent: collaborationCapabilityToIntent(request.capability),
          user: buildHelperUser(input.params, request),
          persona: [
            input.params.persona,
            "",
            "INTERNAL_KATIE_CAPABILITY_HELPER",
            "You are a specialist helper inside Katie. Solve only the assigned capability subtask.",
            "Do not discuss orchestration. Do not answer unrelated parts of the original request.",
          ].join("\n"),
        };
        const helperParams = prepare(
          helperBaseParams,
          helper,
          "helper",
        );
        const helperResult = await selected.provider.generate(helperParams);
        const answer = helperResult.text.trim();

        if (!answer) {
          throw new Error("Capability helper returned an empty response.");
        }

        contribution = {
          id: crypto.randomUUID(),
          depth: 1,
          requester: lead,
          helper,
          task: request.task.slice(0, 2_000),
          capability: request.capability,
          answer: answer.slice(0, 16_000),
          confidence: "high",
          durationMs: Date.now() - helperStartedAt,
        };

        contributions.push(contribution);

        await emit({
          type: "helper_completed",
          requester: lead,
          helper,
          depth: 1,
          delegationIndex,
          capability: request.capability,
          taskPreview: compactTaskPreview(request.task),
          durationMs: contribution.durationMs,
          detail:
            request.capability === "research"
              ? "Live research capability returned evidence to the lead."
              : "Specialist capability returned evidence to the lead.",
        });
        break;
      } catch (error) {
        lastFailure =
          error instanceof Error ? error.message : String(error);
        await emit({
          type: "helper_failed",
          requester: lead,
          helper,
          depth: 1,
          delegationIndex,
          capability: request.capability,
          taskPreview: compactTaskPreview(request.task),
          durationMs: Date.now() - helperStartedAt,
          detail: lastFailure,
        });
      }
    }

    if (!contribution) {
      const finalParams = prepare(
        {
          ...input.params,
          persona: buildNoFurtherEscalationPersona(input.params.persona),
          user: [
            input.params.user,
            "",
            "INTERNAL_KATIE_CAPABILITY_RESULT:",
            "The requested " +
              request.capability +
              " helper could not be completed on this turn.",
            "Answer with the information you can support. Be precise about what remains unverified.",
          ].join("\n"),
        },
        lead,
        "lead",
      );
      const finalGeneration = await runPlainGeneration({
        provider: input.leadProvider,
        params: finalParams,
        onTextDelta: input.onFinalTextDelta,
      });

      const metadata: CollaborationMetadata = {
        used: true,
        delegationCount: escalationCount,
        maxDepthReached: 1,
        contributors: contributions.map((item) => item.helper),
        contributions: contributions.map((item) => ({
          helper: item.helper,
          capability: item.capability,
          task: item.task,
          confidence: item.confidence,
        })),
        durationMs: Date.now() - startedAt,
      };

      await emit({
        type: "collaboration_completed",
        requester: lead,
        detail:
          "Requested capability was unavailable; lead finalized without claiming unsupported verification.",
        durationMs: Date.now() - startedAt,
      });

      return {
        result: {
          ...finalGeneration.result,
          text: finalGeneration.result.text || finalGeneration.streamedText,
          collaboration: metadata,
        },
        streamedText: finalGeneration.streamedText,
        metadata,
        trace,
      };
    }

    leadParams = prepare(
      withCapabilityEscalationInstruction({
        ...input.params,
        user: buildResumeUser(input.params.user, contributions),
      }),
      lead,
      "lead",
    );
  }
}
