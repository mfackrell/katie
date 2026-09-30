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
import { collaborationCapabilityToIntent } from "@/lib/collaboration/routing";
import type { ChatGenerateParams, LlmProvider, ProviderResponse, ResearchEvidenceBundle } from "@/lib/providers/types";

const DEFAULT_MAX_DELEGATIONS = 5;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_CONTRIBUTION_CHARS = 12_000;
const DEFAULT_MAX_TOTAL_CONTRIBUTION_CHARS = 48_000;
const DEFAULT_PARTICIPANT_TIMEOUT_MS = 120_000;
const DEFAULT_RESEARCH_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOTAL_DURATION_MS = 240_000;
const MIN_CONTROL_TIME_MS = 5_000;
const MIN_RESEARCH_RETRY_TIME_MS = 45_000;
const MAX_HELPER_CONTROL_PASSES = 3;
const MAX_HELPER_CANDIDATE_ATTEMPTS = 3;
const MAX_RESEARCH_CANDIDATE_ATTEMPTS = 2;

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

function buildResearchEvidenceBlock(evidence: ResearchEvidenceBundle | undefined): string {
  if (!evidence) {
    return "";
  }

  const sources = evidence.sources.length
    ? evidence.sources
        .map((source, index) => {
          const details = [
            `SOURCE ${index + 1}: ${source.url}`,
            source.title ? `Title: ${source.title}` : "",
            source.snippet ? `Retrieved excerpt: ${source.snippet}` : "",
          ].filter(Boolean);
          return details.join("\n");
        })
        .join("\n\n")
    : "No structured source URLs were returned by the retrieval provider.";

  return [
    "SHARED_LIVE_RESEARCH_EVIDENCE:",
    `Retrieved by: ${evidence.retrievedBy.provider}:${evidence.retrievedBy.modelId}`,
    `Retrieved at: ${evidence.retrievedAt}`,
    sources,
  ].join("\n");
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
        ...(contribution.researchEvidence
          ? ["", buildResearchEvidenceBlock(contribution.researchEvidence)]
          : []),
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
    ...(request.capability === "research"
      ? [
          "",
          "RESEARCH REQUIREMENTS:",
          "Use live web retrieval. Open and inspect the relevant live URL(s), not just search-result snippets.",
          "Return a source-grounded evidence packet for the other models: page URLs, visible headings, important body copy, CTA labels, offers/pricing, trust elements, and any load/access limitations.",
          "Preserve exact short wording for important headings and CTAs when possible. Separate what was directly observed from inference.",
        ]
      : []),
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
  const researchTimeoutMs = Math.max(
    30_000,
    options.researchTimeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS,
  );
  const maxTotalDurationMs = Math.max(
    30_000,
    options.maxTotalDurationMs ?? DEFAULT_MAX_TOTAL_DURATION_MS,
  );
  const collaborationStartedAt = Date.now();
  const finalSynthesisReserveMs = Math.min(
    75_000,
    Math.max(45_000, Math.floor(maxTotalDurationMs / 4)),
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
  let independentMarketingCritiqueAttempted = false;

  const addContribution = (contribution: CollaborationContribution): void => {
    if (!contributions.some((existing) => existing.id === contribution.id)) {
      contributions.push(contribution);
    }
  };

  const getReusableResearchContribution = (): CollaborationContribution | null =>
    contributions.find(
      (contribution) =>
        contribution.capability === "research" && Boolean(contribution.answer.trim()),
    ) ?? null;

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
    timeoutMs = participantTimeoutMs,
  ): Promise<ProviderResponse> => {
    const remaining = remainingBeforeFinalMs();
    if (remaining < MIN_CONTROL_TIME_MS) {
      throw new Error(
        `${label} skipped because Katie reserved the remaining collaboration time for final synthesis.`,
      );
    }

    return withTimeout(
      provider.generate({ ...params, modelId }),
      Math.min(timeoutMs, remaining),
      label,
    );
  };

  const resolveHelper = async (
    request: CollaborationRequest,
    requester: CollaborationParticipant,
    depth: number,
  ): Promise<CollaborationContribution | null> => {
    maxDepthReached = Math.max(maxDepthReached, depth);

    if (request.capability === "research") {
      const reusableResearch = getReusableResearchContribution();
      if (reusableResearch) {
        leadNotes.push(
          "Current live research is already available. Reuse the existing evidence and do not request the same retrieval again.",
        );
        await emit({
          type: "research_evidence_reused",
          depth,
          requester,
          helper: reusableResearch.helper,
          capability: "research",
          taskPreview: compactTaskPreview(request.task),
          detail:
            "A successful live-research contribution already exists, so Katie reused it instead of issuing another fetch.",
        });
        return reusableResearch;
      }
    }

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

    const nestedContributions: CollaborationContribution[] = [];
    const helperNotes: string[] = [];
    let lastFailureDetail = "";

    const candidateAttemptLimit =
      request.capability === "research"
        ? MAX_RESEARCH_CANDIDATE_ATTEMPTS
        : MAX_HELPER_CANDIDATE_ATTEMPTS;

    for (
      let candidateAttempt = 1;
      candidateAttempt <= candidateAttemptLimit;
      candidateAttempt += 1
    ) {
      const minimumTimeNeeded =
        request.capability === "research" && candidateAttempt > 1
          ? MIN_RESEARCH_RETRY_TIME_MS
          : MIN_CONTROL_TIME_MS;
      if (remainingBeforeFinalMs() < minimumTimeNeeded) {
        await emit({
          type: "limit_reached",
          depth,
          delegationIndex,
          requester,
          capability: request.capability,
          taskPreview: compactTaskPreview(request.task),
          detail: "Helper retry stopped because Katie reserved the remaining time for final synthesis.",
        });
        return null;
      }

      const selected = await options.selectHelper({
        requestId: options.requestId,
        request,
        requester,
        depth,
        usedParticipants: [...usedParticipants.values()],
      });

      if (!selected) {
        const detail =
          candidateAttempt === 1
            ? "No eligible helper model was available."
            : "No additional eligible helper model was available after a helper failure.";
        await emit({
          type: "helper_failed",
          depth,
          delegationIndex,
          requester,
          capability: request.capability,
          taskPreview: compactTaskPreview(request.task),
          detail,
        });
        return null;
      }

      const helper = participant(selected.provider, selected.modelId);
      usedParticipants.set(participantKey(helper), helper);

      if (candidateAttempt > 1) {
        await emit({
          type: "helper_retrying",
          depth,
          delegationIndex,
          requester,
          helper,
          capability: request.capability,
          taskPreview: compactTaskPreview(request.task),
          detail: lastFailureDetail
            ? `Previous helper failed: ${lastFailureDetail}. Trying another eligible model.`
            : "Trying another eligible model for the same delegated task.",
        });
      }

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

      try {
        let decision: HelperControlDecision | null = null;
        let helperResearchEvidence: ResearchEvidenceBundle | undefined;
        const helperSpecificNotes = [...helperNotes];

        const controlPassLimit =
          request.capability === "research" ? 1 : MAX_HELPER_CONTROL_PASSES;
        for (let controlPass = 0; controlPass < controlPassLimit; controlPass += 1) {
          const isResearchPass = request.capability === "research";
          const helperParams = prepareParams(
            withPersona(
              {
                ...options.params,
                requestIntent: collaborationCapabilityToIntent(request.capability),
                secondaryIntents: [],
                user: buildHelperControlUser(
                  options.params,
                  request,
                  nestedContributions,
                  helperSpecificNotes,
                  depth,
                ),
              },
              selected.modelId,
              isResearchPass
                ? [
                    "You are Katie's live-research retrieval specialist.",
                    "Retrieve and inspect the live sources requested by the user.",
                    "Return a factual evidence packet only: observed page text, headings, CTAs, offers, trust signals, source URLs, and access limitations.",
                    "Do not make marketing recommendations or ask other models for help. Do not wrap the response in collaboration-control JSON.",
                  ].join("\n")
                : getHelperCollaborationInstruction(),
            ),
            helper,
            "helper-control",
          );

          const response = await callControl(
            selected.provider,
            selected.modelId,
            helperParams,
            `Collaboration helper ${helper.provider}:${helper.modelId}`,
            request.capability === "research" ? researchTimeoutMs : participantTimeoutMs,
          );

          if (response.researchEvidence) {
            helperResearchEvidence = response.researchEvidence;
          }

          if (isResearchPass) {
            const rawResearch = response.text.trim();
            if (!rawResearch) {
              throw new Error("Research helper returned an empty evidence response.");
            }
            decision = {
              action: "answer",
              answer: rawResearch,
              confidence: helperResearchEvidence?.sources.length ? "high" : "medium",
              caveats: helperResearchEvidence?.sources.length
                ? undefined
                : ["The retrieval provider returned research text but no structured source metadata."],
            };
          } else {
            decision = parseHelperControlDecision(response.text);
          }

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
            helperSpecificNotes.push(
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
          ...(helperResearchEvidence ? { researchEvidence: helperResearchEvidence } : {}),
          durationMs: Date.now() - startedAt,
        };

        if (helperResearchEvidence) {
          await emit({
            type: "research_evidence_collected",
            depth,
            delegationIndex,
            requester,
            helper,
            capability: request.capability,
            taskPreview: compactTaskPreview(request.task),
            detail: `Captured ${helperResearchEvidence.sources.length} structured web source(s) for shared collaboration context.`,
            durationMs: contribution.durationMs,
          });
        }

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
        lastFailureDetail = error instanceof Error ? error.message : String(error);
        await emit({
          type: "helper_failed",
          depth,
          delegationIndex,
          requester,
          helper,
          capability: request.capability,
          taskPreview: compactTaskPreview(request.task),
          durationMs: Date.now() - startedAt,
          detail: lastFailureDetail,
        });

        if (candidateAttempt >= candidateAttemptLimit) {
          return null;
        }
      }
    }

    return null;
  };

  const ensureIndependentMarketingCritique = async (): Promise<void> => {
    if (
      options.params.requestIntent !== "marketing-analysis" ||
      independentMarketingCritiqueAttempted ||
      contributions.some((contribution) => contribution.capability === "critique")
    ) {
      return;
    }

    const researchContributions = contributions.filter(
      (contribution) => contribution.capability === "research",
    );
    if (!researchContributions.length || delegationCount >= maxDelegations) {
      return;
    }

    independentMarketingCritiqueAttempted = true;
    const independentReview = await resolveHelper(
      {
        task:
          "Independently review the shared live website evidence for marketing, positioning, messaging, user experience, trust, offer clarity, and conversion implications. Challenge weak assumptions and identify the highest-impact findings.",
        capability: "critique",
        reason:
          "Marketing review benefits from an independent analytical perspective separate from the retrieval model and the lead.",
        context: clip(buildContributionBlock(researchContributions), 14_000),
      },
      lead,
      1,
    );

    if (independentReview) {
      addContribution(independentReview);
      leadNotes.push(
        "An independent cross-provider critique of the live research evidence is available and should be reconciled with your own judgment.",
      );
    } else {
      leadNotes.push(
        "Katie attempted an independent critique of the live research evidence, but no eligible critique helper completed. Continue using the verified research evidence without implying a second review occurred.",
      );
    }
  };

  let synthesisBrief =
    "Answer the user's original request directly using your own analysis and any useful helper contributions.";

  const requiresLiveResearch = options.params.secondaryIntents?.includes("web-search") ?? false;
  if (requiresLiveResearch && delegationCount < maxDelegations) {
    const researchContribution = await resolveHelper(
      {
        task:
          "Retrieve and inspect the live external source material required by the user's request. Build a factual evidence packet that another model can analyze without native web access.",
        capability: "research",
        reason:
          "The primary task requires live source material, but retrieval is a supporting capability rather than the substantive analysis.",
      },
      lead,
      1,
    );

    if (researchContribution) {
      addContribution(researchContribution);
      leadNotes.push(
        "Live research was completed by a specialist. Treat the retrieved evidence as shared source material; independently analyze it rather than deferring to the research model's conclusions.",
      );
      await ensureIndependentMarketingCritique();
    } else {
      await emit({
        type: "research_evidence_collection_failed",
        requester: lead,
        capability: "research",
        detail:
          "Katie could not obtain the secondary live-research evidence. Final analysis must state any resulting verification limitation.",
      });
      leadNotes.push(
        "The required live-research helper could not be completed. Do not imply that live source material was verified.",
      );
    }
  }

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
      addContribution(contribution);
      await ensureIndependentMarketingCritique();
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

  let synthesisLead = lead;
  let synthesisProvider = options.leadProvider;
  let synthesisModelId = options.leadModelId;

  await emit({
    type: "final_synthesis_started",
    requester: synthesisLead,
    detail: `Synthesizing with ${contributions.length} helper contribution(s).`,
  });

  const runFinalSynthesisAttempt = async (
    provider: LlmProvider,
    modelId: string,
    participantValue: CollaborationParticipant,
  ): Promise<{ result: ProviderResponse; text: string }> => {
    const remaining = remainingTotalMs();
    if (remaining < MIN_CONTROL_TIME_MS) {
      throw new Error("Collaboration final synthesis ran out of reserved execution time.");
    }

    const finalParams = prepareParams(
      withPersona(
        {
          ...options.params,
          user: buildFinalUser(options.params, synthesisBrief, contributions),
        },
        modelId,
        getFinalSynthesisInstruction(),
      ),
      participantValue,
      "final-synthesis",
    );

    const finalTimeoutMs = Math.max(
      MIN_CONTROL_TIME_MS,
      Math.min(participantTimeoutMs * 2, remaining),
    );

    let bufferedText = "";
    const result = provider.generateStream
      ? await withTimeout(
          provider.generateStream(finalParams, {
            async onTextDelta(delta) {
              bufferedText += delta;
            },
          }),
          finalTimeoutMs,
          `Collaboration final synthesis ${participantValue.provider}:${participantValue.modelId}`,
        )
      : await withTimeout(
          provider.generate(finalParams),
          finalTimeoutMs,
          `Collaboration final synthesis ${participantValue.provider}:${participantValue.modelId}`,
        );

    const text = result.text || bufferedText;
    if (!text.trim()) {
      throw new Error("Collaboration final synthesis returned an empty response.");
    }

    return { result, text };
  };

  let finalResult: ProviderResponse | null = null;
  let finalText = "";
  let finalSynthesisError: unknown = null;

  for (let synthesisAttempt = 0; synthesisAttempt < 3; synthesisAttempt += 1) {
    try {
      const completed = await runFinalSynthesisAttempt(
        synthesisProvider,
        synthesisModelId,
        synthesisLead,
      );
      finalResult = completed.result;
      finalText = completed.text;
      break;
    } catch (error) {
      finalSynthesisError = error;
      await emit({
        type: "lead_failed",
        requester: synthesisLead,
        detail: error instanceof Error ? error.message : String(error),
      });

      if (!options.selectReplacementLead || synthesisAttempt >= 2) {
        break;
      }

      const replacementLead = await options.selectReplacementLead({
        requestId: options.requestId,
        failedLead: synthesisLead,
        error,
        usedParticipants: [...usedParticipants.values()],
        contributions: [...contributions],
      });

      if (!replacementLead) {
        break;
      }

      synthesisProvider = replacementLead.provider;
      synthesisModelId = replacementLead.modelId;
      synthesisLead = participant(synthesisProvider, synthesisModelId);
      usedParticipants.set(participantKey(synthesisLead), synthesisLead);

      await emit({
        type: "lead_replaced",
        requester: synthesisLead,
        detail:
          replacementLead.reasoning ??
          "Katie selected a different provider to preserve completed collaboration work and finish synthesis.",
      });
    }
  }

  if (!finalResult || !finalText.trim()) {
    throw (
      finalSynthesisError ??
      new Error("Collaboration final synthesis failed for all eligible lead models.")
    );
  }

  await options.onFinalTextDelta?.(finalText);
  const streamedText = finalText;

  const metadata: CollaborationMetadata = {
    used: contributions.length > 0 || delegationCount > 0,
    delegationCount,
    maxDepthReached,
    contributors: [...usedParticipants.values()].filter(
      (value) =>
        participantKey(value) !== participantKey(lead) &&
        participantKey(value) !== participantKey(synthesisLead),
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
    provider: synthesisProvider.name,
    model: synthesisModelId,
    text: finalText,
    collaboration: metadata,
  };

  await emit({
    type: "collaboration_completed",
    requester: synthesisLead,
    detail: `delegations=${delegationCount}; contributions=${contributions.length}; maxDepth=${maxDepthReached}; finalLead=${synthesisLead.provider}:${synthesisLead.modelId}`,
    durationMs: Date.now() - collaborationStartedAt,
  });

  return {
    result,
    streamedText,
    metadata,
    trace,
  };
}
