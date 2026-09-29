import {
  getFinalSynthesisInstruction,
  getHelperCollaborationInstruction,
  getLeadCollaborationInstruction,
  parseHelperControlDecision,
  parseLeadControlDecision,
} from "@/lib/collaboration/protocol";
import type {
  CollaborationContribution,
  CollaborationEngineOptions,
  CollaborationEngineResult,
  CollaborationMetadata,
  CollaborationParticipant,
  CollaborationRequest,
  CollaborationTraceEvent,
  HelperControlDecision,
} from "@/lib/collaboration/types";
import type { ChatGenerateParams, LlmProvider, ProviderResponse } from "@/lib/providers/types";

const DEFAULT_MAX_DELEGATIONS = 5;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_CONTRIBUTION_CHARS = 12_000;
const DEFAULT_MAX_TOTAL_CONTRIBUTION_CHARS = 48_000;
const DEFAULT_PARTICIPANT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOTAL_DURATION_MS = 240_000;
const MIN_CONTROL_TIME_MS = 5_000;
const MAX_HELPER_CONTROL_PASSES = 3;

function nowIso(): string {
  return new Date().toISOString();
}

function participant(provider: LlmProvider, modelId: string): CollaborationParticipant {
  return { provider: provider.name, modelId };
}

function participantKey(value: CollaborationParticipant): string {
  return `${value.provider}:${value.modelId.trim().toLowerCase()}`;
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 80))}\n[Contribution clipped by Katie collaboration budget]`;
}

function compactTaskPreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function buildContributionBlock(contributions: CollaborationContribution[]): string {
  if (!contributions.length) {
    return "No helper contributions yet.";
  }

  return contributions
    .map((contribution, index) => {
      const caveats = contribution.caveats?.length
        ? `\nCaveats: ${contribution.caveats.join("; ")}`
        : "";
      return [
        `CONTRIBUTION ${index + 1}`,
        `Helper: ${contribution.helper.provider}:${contribution.helper.modelId}`,
        `Capability: ${contribution.capability}`,
        `Assigned task: ${contribution.task}`,
        `Confidence: ${contribution.confidence ?? "unspecified"}`,
        `Answer:\n${contribution.answer}${caveats}`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildLeadControlUser(
  params: ChatGenerateParams,
  contributions: CollaborationContribution[],
  notes: string[],
  delegationCount: number,
  maxDelegations: number,
): string {
  return [
    "ORIGINAL_USER_REQUEST:",
    params.user,
    "",
    "AVAILABLE_HELPER_CONTRIBUTIONS:",
    buildContributionBlock(contributions),
    ...(notes.length ? ["", "ORCHESTRATOR_NOTES:", ...notes] : []),
    "",
    `Delegation budget used: ${delegationCount}/${maxDelegations}.`,
    "Return only the collaboration-control JSON required by your system instructions.",
  ].join("\n");
}

function buildHelperControlUser(
  params: ChatGenerateParams,
  request: CollaborationRequest,
  nestedContributions: CollaborationContribution[],
  notes: string[],
  depth: number,
): string {
  return [
    "ORIGINAL_USER_REQUEST:",
    params.user,
    "",
    "YOUR_ASSIGNED_SUBPROBLEM:",
    request.task,
    "",
    `Requested capability: ${request.capability}`,
    ...(request.reason ? [`Why the requester wants help: ${request.reason}`] : []),
    ...(request.context ? ["Additional context:", request.context] : []),
    "",
    `Current helper depth: ${depth}`,
    "",
    "RESULTS FROM ANY NESTED HELPERS:",
    buildContributionBlock(nestedContributions),
    ...(notes.length ? ["", "ORCHESTRATOR_NOTES:", ...notes] : []),
    "",
    "Return only the collaboration-control JSON required by your system instructions.",
  ].join("\n");
}

function buildFinalUser(
  params: ChatGenerateParams,
  synthesisBrief: string,
  contributions: CollaborationContribution[],
): string {
  return [
    params.user,
    "",
    "INTERNAL_KATIE_COLLABORATION_CONTEXT_START",
    "Lead synthesis brief:",
    synthesisBrief,
    "",
    "Helper contributions:",
    buildContributionBlock(contributions),
    "INTERNAL_KATIE_COLLABORATION_CONTEXT_END",
    "",
    "Now provide the complete user-facing answer to the original request.",
  ].join("\n");
}

function withPersona(params: ChatGenerateParams, modelId: string, instruction: string): ChatGenerateParams {
  return {
    ...params,
    modelId,
    persona: `${params.persona}\n\n${instruction}`,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function runAdaptiveCollaboration(
  options: CollaborationEngineOptions,
): Promise<CollaborationEngineResult> {
  const maxDelegations = Math.max(1, options.maxDelegations ?? DEFAULT_MAX_DELEGATIONS);
  const maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxContributionChars = Math.max(
    1_000,
    options.maxContributionChars ?? DEFAULT_MAX_CONTRIBUTION_CHARS,
  );
  const maxTotalContributionChars = Math.max(
    maxContributionChars,
    options.maxTotalContributionChars ?? DEFAULT_MAX_TOTAL_CONTRIBUTION_CHARS,
  );
  const participantTimeoutMs = Math.max(
    5_000,
    options.participantTimeoutMs ?? DEFAULT_PARTICIPANT_TIMEOUT_MS,
  );
  const maxTotalDurationMs = Math.max(
    30_000,
    options.maxTotalDurationMs ?? DEFAULT_MAX_TOTAL_DURATION_MS,
  );
  const collaborationStartedAt = Date.now();
  const finalSynthesisReserveMs = Math.min(
    90_000,
    Math.max(30_000, Math.floor(maxTotalDurationMs / 3)),
  );
  const remainingTotalMs = () =>
    Math.max(0, maxTotalDurationMs - (Date.now() - collaborationStartedAt));
  const remainingBeforeFinalMs = () =>
    Math.max(0, remainingTotalMs() - finalSynthesisReserveMs);

  const lead = participant(options.leadProvider, options.leadModelId);
  const trace: CollaborationTraceEvent[] = [];
  const contributions: CollaborationContribution[] = [];
  const usedParticipants = new Map<string, CollaborationParticipant>([
    [participantKey(lead), lead],
  ]);
  const leadNotes: string[] = [];
  let delegationCount = 0;
  let maxDepthReached = 0;
  let totalContributionChars = 0;

  const emit = async (
    event: Omit<CollaborationTraceEvent, "requestId" | "timestamp">,
  ): Promise<void> => {
    const complete: CollaborationTraceEvent = {
      ...event,
      requestId: options.requestId,
      timestamp: nowIso(),
    };
    trace.push(complete);
    await options.onTrace?.(complete);
  };

  await emit({
    type: "collaboration_started",
    requester: lead,
    detail: "Lead model entered adaptive collaboration control.",
  });

  const prepareParams = (
    params: ChatGenerateParams,
    participantValue: CollaborationParticipant,
    role: "lead-control" | "helper-control" | "final-synthesis",
  ): ChatGenerateParams =>
    options.prepareParticipantParams
      ? options.prepareParticipantParams(params, participantValue, role)
      : params;

  const callControl = async (
    provider: LlmProvider,
    modelId: string,
    params: ChatGenerateParams,
    label: string,
  ): Promise<ProviderResponse> => {
    const remaining = remainingBeforeFinalMs();
    if (remaining < MIN_CONTROL_TIME_MS) {
      throw new Error(
        `${label} skipped because Katie reserved the remaining collaboration time for final synthesis.`,
      );
    }

    return withTimeout(
      provider.generate({ ...params, modelId }),
      Math.min(participantTimeoutMs, remaining),
      label,
    );
  };

  const resolveHelper = async (
    request: CollaborationRequest,
    requester: CollaborationParticipant,
    depth: number,
  ): Promise<CollaborationContribution | null> => {
    maxDepthReached = Math.max(maxDepthReached, depth);

    if (remainingBeforeFinalMs() < MIN_CONTROL_TIME_MS) {
      await emit({
        type: "limit_reached",
        depth,
        requester,
        capability: request.capability,
        taskPreview: compactTaskPreview(request.task),
        detail: "Collaboration time budget is reserved for final synthesis.",
      });
      return null;
    }

    if (delegationCount >= maxDelegations) {
      await emit({
        type: "limit_reached",
        depth,
        requester,
        capability: request.capability,
        taskPreview: compactTaskPreview(request.task),
        detail: "Global collaboration delegation limit reached.",
      });
      return null;
    }

    if (depth > maxDepth) {
      await emit({
        type: "limit_reached",
        depth,
        requester,
        capability: request.capability,
        taskPreview: compactTaskPreview(request.task),
        detail: "Collaboration depth limit reached.",
      });
      return null;
    }

    delegationCount += 1;
    const delegationIndex = delegationCount;
    await emit({
      type: "delegation_requested",
      depth,
      delegationIndex,
      requester,
      capability: request.capability,
      taskPreview: compactTaskPreview(request.task),
      detail: request.reason,
    });

    const selected = await options.selectHelper({
      requestId: options.requestId,
      request,
      requester,
      depth,
      usedParticipants: [...usedParticipants.values()],
    });

    if (!selected) {
      await emit({
        type: "helper_failed",
        depth,
        delegationIndex,
        requester,
        capability: request.capability,
        taskPreview: compactTaskPreview(request.task),
        detail: "No eligible helper model was available.",
      });
      return null;
    }

    const helper = participant(selected.provider, selected.modelId);
    usedParticipants.set(participantKey(helper), helper);
    await emit({
      type: "helper_selected",
      depth,
      delegationIndex,
      requester,
      helper,
      capability: request.capability,
      taskPreview: compactTaskPreview(request.task),
      detail: selected.reasoning,
    });

    const startedAt = Date.now();
    const nestedContributions: CollaborationContribution[] = [];
    const helperNotes: string[] = [];

    try {
      let decision: HelperControlDecision | null = null;

      for (let controlPass = 0; controlPass < MAX_HELPER_CONTROL_PASSES; controlPass += 1) {
        const helperParams = prepareParams(
          withPersona(
            {
              ...options.params,
              user: buildHelperControlUser(
                options.params,
                request,
                nestedContributions,
                helperNotes,
                depth,
              ),
            },
            selected.modelId,
            getHelperCollaborationInstruction(),
          ),
          helper,
          "helper-control",
        );

        const response = await callControl(
          selected.provider,
          selected.modelId,
          helperParams,
          `Collaboration helper ${helper.provider}:${helper.modelId}`,
        );

        decision = parseHelperControlDecision(response.text);

        if (!decision) {
          const raw = response.text.trim();
          if (raw) {
            decision = {
              action: "answer",
              answer: raw,
              confidence: "medium",
              caveats: ["Helper returned an unstructured response; Katie treated it as advisory."],
            };
          } else {
            throw new Error("Helper returned an empty control response.");
          }
        }

        if (decision.action === "answer") {
          break;
        }

        const nested = await resolveHelper(decision.request, helper, depth + 1);
        if (nested) {
          nestedContributions.push(nested);
        } else {
          helperNotes.push(
            "Requested nested delegation was unavailable or exceeded the collaboration budget. Solve the assigned subproblem directly with the information available.",
          );
        }
        decision = null;
      }

      if (!decision || decision.action !== "answer") {
        throw new Error("Helper did not produce an answer within its control-pass limit.");
      }

      const remainingTotalBudget = Math.max(
        0,
        maxTotalContributionChars - totalContributionChars,
      );
      const answerBudget = Math.min(maxContributionChars, remainingTotalBudget);
      const answer =
        answerBudget > 0
          ? clip(decision.answer, answerBudget)
          : "[Additional helper output omitted because the collaboration evidence budget was exhausted.]";
      totalContributionChars += answer.length;

      const contribution: CollaborationContribution = {
        id: crypto.randomUUID(),
        depth,
        requester,
        helper,
        task: clip(request.task, 2_000),
        capability: request.capability,
        answer,
        confidence: decision.confidence,
        caveats: decision.caveats,
        durationMs: Date.now() - startedAt,
      };

      await emit({
        type: "helper_completed",
        depth,
        delegationIndex,
        requester,
        helper,
        capability: request.capability,
        taskPreview: compactTaskPreview(request.task),
        durationMs: contribution.durationMs,
        detail: decision.confidence ? `confidence=${decision.confidence}` : undefined,
      });
      return contribution;
    } catch (error) {
      await emit({
        type: "helper_failed",
        depth,
        delegationIndex,
        requester,
        helper,
        capability: request.capability,
        taskPreview: compactTaskPreview(request.task),
        durationMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  let synthesisBrief =
    "Answer the user's original request directly using your own analysis and any useful helper contributions.";

  for (let leadPass = 0; leadPass <= maxDelegations; leadPass += 1) {
    if (remainingBeforeFinalMs() < MIN_CONTROL_TIME_MS) {
      synthesisBrief =
        "The collaboration time budget is nearly exhausted. Produce the strongest complete answer now using the evidence already collected.";
      await emit({
        type: "limit_reached",
        requester: lead,
        detail: "Collaboration time budget reached; forcing final synthesis.",
      });
      break;
    }

    const leadParams = prepareParams(
      withPersona(
        {
          ...options.params,
          user: buildLeadControlUser(
            options.params,
            contributions,
            leadNotes,
            delegationCount,
            maxDelegations,
          ),
        },
        options.leadModelId,
        getLeadCollaborationInstruction(),
      ),
      lead,
      "lead-control",
    );

    const response = await callControl(
      options.leadProvider,
      options.leadModelId,
      leadParams,
      `Collaboration lead ${lead.provider}:${lead.modelId}`,
    );

    const decision = parseLeadControlDecision(response.text);
    if (!decision) {
      synthesisBrief = response.text.trim()
        ? clip(
            `The lead control response was unstructured. Treat this as a preliminary internal draft and produce a clean final answer:\n${response.text.trim()}`,
            10_000,
          )
        : synthesisBrief;
      await emit({
        type: "lead_ready",
        requester: lead,
        detail: "Lead returned unstructured control output; proceeding to final synthesis.",
      });
      break;
    }

    if (decision.action === "ready") {
      synthesisBrief = clip(decision.synthesisBrief, 12_000);
      await emit({
        type: "lead_ready",
        requester: lead,
        detail: "Lead indicated that available context is sufficient for final synthesis.",
      });
      break;
    }

    const contribution = await resolveHelper(decision.request, lead, 1);
    if (contribution) {
      contributions.push(contribution);
    } else {
      leadNotes.push(
        `Delegation request could not be fulfilled: ${compactTaskPreview(decision.request.task)}. Continue without that helper or request a different specialist if budget remains.`,
      );
    }

    if (delegationCount >= maxDelegations) {
      synthesisBrief =
        "The collaboration budget is exhausted. Produce the strongest complete answer using your own analysis and the helper contributions already collected.";
      await emit({
        type: "limit_reached",
        requester: lead,
        detail: "Lead collaboration delegation budget exhausted; forcing final synthesis.",
      });
      break;
    }
  }

  await emit({
    type: "final_synthesis_started",
    requester: lead,
    detail: `Synthesizing with ${contributions.length} helper contribution(s).`,
  });

  const finalParams = prepareParams(
    withPersona(
      {
        ...options.params,
        user: buildFinalUser(options.params, synthesisBrief, contributions),
      },
      options.leadModelId,
      getFinalSynthesisInstruction(),
    ),
    lead,
    "final-synthesis",
  );

  let streamedText = "";
  const finalTimeoutMs = Math.max(
    MIN_CONTROL_TIME_MS,
    Math.min(participantTimeoutMs * 2, remainingTotalMs()),
  );
  const finalResult = options.leadProvider.generateStream
    ? await withTimeout(
        options.leadProvider.generateStream(finalParams, {
          async onTextDelta(delta) {
            streamedText += delta;
            await options.onFinalTextDelta?.(delta);
          },
        }),
        finalTimeoutMs,
        `Collaboration final synthesis ${lead.provider}:${lead.modelId}`,
      )
    : await withTimeout(
        options.leadProvider.generate(finalParams),
        finalTimeoutMs,
        `Collaboration final synthesis ${lead.provider}:${lead.modelId}`,
      );

  const finalText = finalResult.text || streamedText;
  if (!finalText.trim()) {
    throw new Error("Collaboration final synthesis returned an empty response.");
  }

  if (!streamedText && finalText) {
    await options.onFinalTextDelta?.(finalText);
    streamedText = finalText;
  }

  const metadata: CollaborationMetadata = {
    used: contributions.length > 0 || delegationCount > 0,
    delegationCount,
    maxDepthReached,
    contributors: [...usedParticipants.values()].filter(
      (value) => participantKey(value) !== participantKey(lead),
    ),
    contributions: contributions.map((contribution) => ({
      helper: contribution.helper,
      capability: contribution.capability,
      task: contribution.task,
      confidence: contribution.confidence,
    })),
    durationMs: Date.now() - collaborationStartedAt,
  };

  const result: ProviderResponse = {
    ...finalResult,
    text: finalText,
    collaboration: metadata,
  };

  await emit({
    type: "collaboration_completed",
    requester: lead,
    detail: `delegations=${delegationCount}; contributions=${contributions.length}; maxDepth=${maxDepthReached}`,
    durationMs: Date.now() - collaborationStartedAt,
  });

  return {
    result,
    streamedText,
    metadata,
    trace,
  };
}
