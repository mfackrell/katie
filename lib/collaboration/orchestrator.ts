import { isTerminalProviderError } from "@/lib/providers/response-errors";
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

import { collectWebsiteEvidence, websiteReviewUrls } from "@/lib/research/website-evidence";
import { formatResearchEvidence, mergeResearchEvidence, withWebsiteImages, websiteImages, websiteEvidenceStats, WEBSITE_REVIEW_INSTRUCTION } from "@/lib/research/shared-evidence";

const DEFAULT_MAX_DELEGATIONS = 5;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_CONTRIBUTION_CHARS = 12_000;
const DEFAULT_MAX_TOTAL_CONTRIBUTION_CHARS = 48_000;
const DEFAULT_PARTICIPANT_TIMEOUT_MS = 120_000;
const DEFAULT_RESEARCH_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOTAL_DURATION_MS = 770_000;
const FINAL_SYNTHESIS_TIMEOUT_MS = 180_000;
const ROUTING_RESERVE_MS = 15_000;
const RESEARCH_LATE_RESULT_GRACE_MS = 60_000;
const MIN_RESEARCH_RETRY_MS = 60_000;
const MIN_CONTROL_TIME_MS = 5_000;
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
        `Answer:\n${contribution.researchEvidence ? "See complete evidence packet below." : contribution.answer}${caveats}`,
        ...(contribution.researchEvidence
          ? ["", formatResearchEvidence(contribution.researchEvidence)]
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
          "For website reviews, include observed design evidence where your tools expose it: typography, colors, spacing, layout, imagery, navigation, visual hierarchy and responsive behavior. Do not infer rendered appearance from text or fabricate visual observations. Katie separately captures screenshots, HTML and applied CSS.",
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
    request.capability === "research"
      ? "Return the factual evidence packet directly; do not wrap it in collaboration-control JSON."
      : "Return only the collaboration-control JSON required by your system instructions.",
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
  lateResultGraceMs = 0,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error !== timeoutError || lateResultGraceMs <= 0) {
      throw error;
    }

    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }

    console.info("[Collaboration] helper exceeded nominal timeout; waiting briefly for a late usable result", {
      label,
      timeoutMs,
      lateResultGraceMs,
    });

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          graceTimer = setTimeout(() => reject(timeoutError), lateResultGraceMs);
        }),
      ]);
    } finally {
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
    }
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
  // Every retry shares the same request deadline; rerouting cannot reset it.
  const executionDeadlineMs = Math.min(
    collaborationStartedAt + maxTotalDurationMs,
    options.executionDeadlineMs ?? Infinity,
  );
  // Reserve one complete final answer, not two. A second final attempt is opportunistic.
  // Required live research and its backup should not be starved to pre-reserve an optional retry.
  const finalSynthesisReserveMs = FINAL_SYNTHESIS_TIMEOUT_MS + ROUTING_RESERVE_MS;
  const remainingTotalMs = () => Math.max(0, executionDeadlineMs - Date.now());
  const remainingBeforeFinalMs = () =>
    Math.max(0, remainingTotalMs() - finalSynthesisReserveMs);

  const resumed = options.resumeState?.requestId === options.requestId ? options.resumeState : undefined;
  const minimumLeadControlMs = participantTimeoutMs;
  const minimumFinalTimeMs = FINAL_SYNTHESIS_TIMEOUT_MS;
  const lead = participant(options.leadProvider, options.leadModelId);
  const trace: CollaborationTraceEvent[] = [];
  const contributions: CollaborationContribution[] = [...(resumed?.contributions ?? [])];
  const usedParticipants = new Map<string, CollaborationParticipant>([
    [participantKey(lead), lead],
    ...(resumed?.usedParticipants ?? []).map((value): [string, CollaborationParticipant] => [participantKey(value), value]),
  ]);
  const leadNotes: string[] = [...(resumed?.notes ?? [])];
  const completedHelpers = new Map<string, CollaborationParticipant>(
    (resumed?.completedHelpers ?? []).map((value) => [participantKey(value), value]),
  );
  let delegationCount = resumed?.delegationCount ?? 0;
  let maxDepthReached = resumed?.maxDepthReached ?? 0;
  let totalContributionChars = resumed?.totalContributionChars ?? 0;
  let independentMarketingCritiqueAttempted = false;
  let websiteEvidencePromise: ReturnType<typeof collectWebsiteEvidence> | undefined;
  let sharedWebsite: ResearchEvidenceBundle["website"] = resumed?.website;
  let synthesisBrief = resumed?.synthesisBrief ??
    "Answer the user's original request directly using your own analysis and any useful helper contributions.";
  const checkpoint = (): void => options.onCheckpoint?.({
    requestId: options.requestId,
    contributions: [...contributions], usedParticipants: [...usedParticipants.values()],
    completedHelpers: [...completedHelpers.values()],
    delegationCount, maxDepthReached, totalContributionChars, synthesisBrief,
    notes: [...leadNotes], website: sharedWebsite,
  });
  const collectWebsite = () => websiteEvidencePromise ??= (options.collectWebsiteEvidence ?? collectWebsiteEvidence)(options.params, {
    timeoutMs: Math.min(45_000, Math.max(1_000, remainingBeforeFinalMs() - MIN_CONTROL_TIME_MS)),
  }).catch((error) => ({ capturedAt: nowIso(), pages: [], limitations: ["Rendered inspection failed: " + String(error)] }));

  const addContribution = (contribution: CollaborationContribution): void => {
    if (!contributions.some((existing) => existing.id === contribution.id)) {
      contributions.push(contribution);
      checkpoint();
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

  if (resumed) {
    await emit({ type: "collaboration_resumed", requester: lead,
      detail: `Resuming final synthesis with ${contributions.length} completed contribution(s); retrieval and critique will not be repeated.` });
  }

  const prepareParams = (
    params: ChatGenerateParams,
    participantValue: CollaborationParticipant,
    role: "lead-control" | "helper-control" | "final-synthesis",
  ): ChatGenerateParams =>
    options.prepareParticipantParams
      ? options.prepareParticipantParams(withWebsiteImages(params, sharedWebsite), participantValue, role)
      : withWebsiteImages(params, sharedWebsite);

  const callControl = async (
    provider: LlmProvider,
    modelId: string,
    params: ChatGenerateParams,
    label: string,
    timeoutMs = participantTimeoutMs,
    minimumTimeMs = timeoutMs,
    lateResultGraceMs = 0,
  ): Promise<ProviderResponse> => {
    const remaining = remainingBeforeFinalMs();
    if (remaining < minimumTimeMs) {
      throw new Error(
        `${label} skipped because Katie reserved the remaining collaboration time for final synthesis.`,
      );
    }

    const effectiveTimeoutMs = Math.min(timeoutMs, remaining);
    const availableGraceMs = Math.max(0, remaining - effectiveTimeoutMs);
    const effectiveGraceMs = Math.min(lateResultGraceMs, availableGraceMs);

    return withTimeout(
      provider.generate({ ...params, modelId }),
      effectiveTimeoutMs,
      label,
      effectiveGraceMs,
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
      const helperWindowMs =
        request.capability === "research"
          ? candidateAttempt > 1
            ? MIN_RESEARCH_RETRY_MS
            : researchTimeoutMs
          : participantTimeoutMs;
      const minimumTimeNeeded = helperWindowMs + ROUTING_RESERVE_MS;
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
        hasImages: Boolean(options.params.images?.length || websiteImages(sharedWebsite).length),
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
                  [...contributions.filter((entry) => entry.capability === "research"), ...nestedContributions],
                  helperSpecificNotes,
                  depth,
                ),
              },
              selected.modelId,
              isResearchPass
                ? [
                    "You are Katie's live-research retrieval specialist.",
                    "Retrieve and inspect the live sources requested by the user.",
                    "Return a factual evidence packet only: observed page text, headings, CTAs, offers, trust signals, source URLs, design evidence exposed by your tools, and access limitations.",
                    WEBSITE_REVIEW_INSTRUCTION,
                    "Do not make marketing recommendations or ask other models for help. Do not wrap the response in collaboration-control JSON.",
                  ].join("\n")
                : getHelperCollaborationInstruction(),
            ),
            helper,
            "helper-control",
          );

          // Browser capture runs alongside live retrieval and is reused across retries.
          const capture = isResearchPass ? collectWebsite() : undefined;
          const helperTimeoutMs =
            request.capability === "research"
              ? candidateAttempt > 1
                ? Math.min(
                    researchTimeoutMs,
                    Math.max(MIN_RESEARCH_RETRY_MS, remainingBeforeFinalMs()),
                  )
                : researchTimeoutMs
              : participantTimeoutMs;
          const minimumHelperTimeMs =
            request.capability === "research" && candidateAttempt > 1
              ? MIN_RESEARCH_RETRY_MS
              : helperTimeoutMs;

          const response = await callControl(
            selected.provider,
            selected.modelId,
            helperParams,
            `Collaboration helper ${helper.provider}:${helper.modelId}`,
            helperTimeoutMs,
            minimumHelperTimeMs,
            request.capability === "research" ? RESEARCH_LATE_RESULT_GRACE_MS : 0,
          );

          if (isResearchPass) {
            sharedWebsite = await capture;
            helperResearchEvidence = mergeResearchEvidence(response, helper, options.params.user, sharedWebsite);
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
          await options.onResearchEvidence?.(helperResearchEvidence);
          await emit({
            type: "research_evidence_collected",
            depth,
            delegationIndex,
            requester,
            helper,
            capability: request.capability,
            taskPreview: compactTaskPreview(request.task),
            detail: `Captured ${helperResearchEvidence.sources.length} structured web source(s); complete research chars=${helperResearchEvidence.summary.length}; ${websiteEvidenceStats(helperResearchEvidence.website)}. Full packet shared without helper-answer clipping.`,
            durationMs: contribution.durationMs,
          });
        }

        completedHelpers.set(participantKey(helper), helper);
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
        if (isTerminalProviderError(error)) throw error;
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
          "Review what is needed to complete the user's current marketing deliverable using the shared website evidence and screenshots. If the user requested a website audit, assess positioning, messaging, trust, conversion, layout and desktop/mobile presentation. If they requested copy, packages or a plan, provide usable draft components and concrete corrections for that deliverable instead of another broad audit. Check completeness, scope consistency, evidence and the latest user constraints. State only material coverage limitations.",
        capability: "critique",
        reason:
          "Marketing review benefits from an independent analytical perspective separate from the retrieval model and the lead.",
        // All helpers receive the full shared research through buildHelperControlUser.
        context: "Use the complete shared research and rendered website evidence supplied below.",
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

  const requiresLiveResearch = (options.params.secondaryIntents?.includes("web-search") ?? false) ||
    websiteReviewUrls(options.params).length > 0;
  if (!resumed && requiresLiveResearch && delegationCount < maxDelegations) {
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

  let controlFailure: unknown;
  for (let leadPass = 0; leadPass <= maxDelegations && !resumed; leadPass += 1) {
    if (remainingBeforeFinalMs() < minimumLeadControlMs) {
      synthesisBrief =
        "The collaboration time budget is nearly exhausted. Produce the strongest complete answer now using the evidence already collected.";
      await emit({
        type: "limit_reached",
        requester: lead,
        detail: `Lead control skipped: remaining=${remainingBeforeFinalMs()}ms; minimum=${minimumLeadControlMs}ms. Preserving evidence for final synthesis and conflict reconciliation.`,
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

    await emit({ type: "reconciliation_started", requester: lead,
      detail: "Lead is checking disagreements, evidence quality and established objectives before synthesis." });
    let response: ProviderResponse;
    try {
      response = await callControl(
        options.leadProvider, options.leadModelId, leadParams,
        `Collaboration lead ${lead.provider}:${lead.modelId}`,
        participantTimeoutMs, minimumLeadControlMs,
      );
    } catch (error) {
        if (isTerminalProviderError(error)) throw error;
      // A failed control pass must not escape to the outer chat retry and erase helper work.
      await emit({ type: "lead_failed", requester: lead,
        detail: error instanceof Error ? error.message : String(error) });
      synthesisBrief = "Lead control failed. Reconcile conflicts and finish the original request using the preserved evidence and critique.";
      checkpoint();
      controlFailure = error;
      break;
    }

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
      if (decision.conflicts?.length) {
        synthesisBrief += "\nConflict reconciliation conclusions (advisory; verify against user context):\n" + JSON.stringify(decision.conflicts);
      }
      await emit({ type: "reconciliation_completed", requester: lead,
        detail: decision.conflicts
          ? `Classified conflicts=${decision.conflicts.length}; unresolved=${decision.conflicts.filter((entry) => entry.unresolved).length}.`
          : "Control omitted structured reconciliation; final synthesis must perform it." });
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

  checkpoint();
  if (controlFailure && options.selectReplacementLead && remainingTotalMs() >= minimumFinalTimeMs + ROUTING_RESERVE_MS) {
    const replacement = await options.selectReplacementLead({
      requestId: options.requestId, failedLead: lead, error: controlFailure,
      usedParticipants: [...usedParticipants.values()], contributions: [...contributions],
      hasImages: Boolean(options.params.images?.length || websiteImages(sharedWebsite).length),
    });
    if (replacement) {
      synthesisProvider = replacement.provider;
      synthesisModelId = replacement.modelId;
      synthesisLead = participant(synthesisProvider, synthesisModelId);
      usedParticipants.set(participantKey(synthesisLead), synthesisLead);
      checkpoint();
      await emit({ type: "lead_replaced", requester: synthesisLead,
        detail: "Replacing failed control lead; completed research, screenshots and critique retained for synthesis." });
    }
  }

  await emit({
    type: "final_synthesis_started",
    requester: synthesisLead,
    detail: `Reconciling any remaining conflicts and synthesizing with ${contributions.length} helper contribution(s).`,
  });

  const runFinalSynthesisAttempt = async (
    provider: LlmProvider,
    modelId: string,
    participantValue: CollaborationParticipant,
  ): Promise<{ result: ProviderResponse; text: string }> => {
    const remaining = remainingTotalMs();
    if (remaining < minimumFinalTimeMs) {
      throw new Error(`Collaboration final synthesis has insufficient execution time: remaining=${remaining}ms; minimum=${minimumFinalTimeMs}ms. Completed work is checkpointed for reroute.`);
    }

    const finalParams = prepareParams(
      withPersona(
        {
          ...options.params,
          user: buildFinalUser(options.params, [synthesisBrief, ...leadNotes].join("\n"), contributions),
        },
        modelId,
        getFinalSynthesisInstruction(),
      ),
      participantValue,
      "final-synthesis",
    );

    const finalTimeoutMs = FINAL_SYNTHESIS_TIMEOUT_MS;

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
        if (isTerminalProviderError(error)) throw error;
      finalSynthesisError = error;
      await emit({
        type: "lead_failed",
        requester: synthesisLead,
        detail: error instanceof Error ? error.message : String(error),
      });

      if (!options.selectReplacementLead || synthesisAttempt >= 2 ||
          remainingTotalMs() < minimumFinalTimeMs + ROUTING_RESERVE_MS) {
        break;
      }

      const replacementLead = await options.selectReplacementLead({
        requestId: options.requestId,
        failedLead: synthesisLead,
        error,
        usedParticipants: [...usedParticipants.values()],
        contributions: [...contributions],
        hasImages: Boolean(options.params.images?.length || websiteImages(sharedWebsite).length),
      });

      if (!replacementLead) {
        break;
      }

      synthesisProvider = replacementLead.provider;
      synthesisModelId = replacementLead.modelId;
      synthesisLead = participant(synthesisProvider, synthesisModelId);
      usedParticipants.set(participantKey(synthesisLead), synthesisLead);
      checkpoint();

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
    contributors: [...completedHelpers.values()].filter(
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
    ...(contributions.find((entry) => entry.researchEvidence)?.researchEvidence
      ? { researchEvidence: contributions.find((entry) => entry.researchEvidence)!.researchEvidence }
      : {}),
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
