import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assembleContext } from "@/lib/memory/assemble-context";
import { maybeUpdateSummary } from "@/lib/memory/summarizer";
import { maybeUpdateLongTermMemory } from "@/lib/memory/long-term-editor";
import { saveMessage, setShortTermMemory } from "@/lib/data/persistence-store";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { getAvailableProviders } from "@/lib/providers";
import { chooseProvider, selectControlPlaneDecisionModels } from "@/lib/router/master-router";
import {
  hasDirectWebSearchHint,
  inferRequestClassification,
  RequestIntent,
  RoutingHint,
  validateRoutingDecision
} from "@/lib/router/model-intent";
import {
  ACK_CONTEXT_TTL_MS,
  isAcknowledgment,
  isSubstantiveIntent,
  parseIntentSessionState
} from "@/lib/router/intent-context";
import { LlmProvider, ProviderResponse } from "@/lib/providers/types";
import type { ResolvedRoutingIntent, SelectionExplainer } from "@/lib/router/master-router";
import { DEFAULT_REASONING_CATEGORIES, ReasoningStateAccumulator } from "@/lib/chat/reasoning-stream";
import { isLikelyProviderRefusal, runWithRefusalFallback, shouldRetryOnProviderRefusal } from "@/lib/router/refusal-detection";
import {
  getAttachmentSupportForProvider,
  isVideoAttachment,
  resolveVideoRoutingPolicy,
  selectGoogleModelForVideoRouting
} from "@/lib/chat/video-routing";
import { injectRelevantContents, registerRepoBinding } from "@/lib/repo/content-injector";
import { analyzeChunkedAttachments, shouldRunChunkedWorkflow } from "@/lib/providers/chunked-document-workflow";
import {
  __resolveRepoSourceClassifierFailureForTests,
  type RepoSourceClassifierDecision
} from "@/lib/chat/repo-source-classifier-fallback";

// This endpoint streams long-running responses (e.g., deep financial/workbook analysis).
// Keep the function timeout above Vercel's default 300s ceiling to avoid truncating streamed replies.
export const maxDuration = 800;

const fileReferenceSchema = z.object({
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  preview: z.string().min(1).max(2200),
  extractedText: z.string().min(1).max(2_500_000).optional(),
  extractedChunks: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        total: z.number().int().positive(),
        text: z.string().min(1).max(15_000),
        hash: z.string().min(1).optional()
      })
    )
    .optional(),
  totalChunks: z.number().int().positive().optional(),
  truncatedForContext: z.boolean().optional(),
  extractionCoverage: z.enum(["preview-only", "partial", "full"]).optional(),
  attachmentKind: z.enum(["image", "video", "text", "file"]).optional(),
  providerRef: z
    .object({
      openaiFileId: z.string().min(1).optional(),
      googleFileUri: z.string().min(1).optional()
    })
    .optional()
});

const requestSchema = z.object({
  actorId: z.string().min(1),
  chatId: z.string().min(1),
  message: z.string().min(1),
  images: z.array(z.string()).optional(),
  fileReferences: z.array(fileReferenceSchema).optional(),
  overrideProvider: z.string().min(1).optional(),
  overrideModel: z.string().min(1).optional(),
  routingTraceEnabled: z.boolean().optional(),
  activeRepoId: z.string().min(1).optional(),
  repoInjectionEnabled: z.boolean().optional(),
});

type RequestPayload = z.infer<typeof requestSchema>;

type ActiveRepoContext = {
  id: string;
  repositoryFullName: string;
};

type RepoGenerationContext = {
  defaultBranch: string;
  metadataLine: string;
  fileSummaryLine: string;
  sourceContextLine: string;
  fetchedFilePaths: string[];
  attachedSourceFileCount: number;
  attachedCharacterCount: number;
  attachedApproxTokenCount: number;
};

type ChatSessionContext = {
  activeRepo: {
    id: string;
    fullName: string;
  } | null;
};


function buildGenerationParams({
  name,
  persona,
  summary,
  history,
  message,
  requestIntent,
  images,
  modelId,
  attachments
}: {
  name: string;
  persona: string;
  summary: string;
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
  requestIntent?: RequestIntent;
  images?: string[];
  modelId: string;
  attachments: NonNullable<RequestPayload["fileReferences"]>;
}) {
  return {
    name,
    persona,
    summary,
    history,
    user: message,
    requestIntent,
    images,
    modelId,
    attachments
  };
}

async function runGeneration({
  provider,
  params,
  onTextDelta
}: {
  provider: LlmProvider;
  params: ReturnType<typeof buildGenerationParams>;
  onTextDelta: (delta: string) => void;
}): Promise<{ result: ProviderResponse; streamedText: string }> {
  let streamedText = "";

  const result = provider.generateStream
    ? await provider.generateStream(params, {
        onTextDelta(delta) {
          streamedText += delta;
          onTextDelta(delta);
        }
      })
    : await provider.generate(params);

  return { result, streamedText };
}

async function parseIncomingPayload(request: NextRequest): Promise<RequestPayload> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    throw new Error("Invalid request payload");
  }

  const body = await request.json();
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    console.error("[Chat API] Validation Failed:", parsed.error.format());
    throw new Error("Invalid request payload");
  }

  return parsed.data;
}

function extractImageUrl(part: { type?: string; [key: string]: unknown }): string | null {
  if (typeof part.url === "string") {
    return part.url;
  }

  if (typeof part.image_url === "string") {
    return part.image_url;
  }

  if (
    part.image_url &&
    typeof part.image_url === "object" &&
    "url" in part.image_url &&
    typeof (part.image_url as { url?: unknown }).url === "string"
  ) {
    return (part.image_url as { url: string }).url;
  }

  if (typeof part.b64_json === "string") {
    return `data:image/png;base64,${part.b64_json}`;
  }

  if (part.inlineData && typeof part.inlineData === "object") {
    const inlineData = part.inlineData as Record<string, unknown>;
    const data = typeof inlineData.data === "string" ? inlineData.data : null;

    if (!data) {
      return null;
    }

    const mimeType = typeof inlineData.mimeType === "string" ? inlineData.mimeType : "image/png";

    return `data:${mimeType};base64,${data}`;
  }

  return null;
}

async function loadActiveRepoContext(repoId: string): Promise<ActiveRepoContext | null> {
  const client = getSupabaseAdminClient();
  const response = await client
    .from("repo_sync_runs")
    .select("id, repository_full_name")
    .eq("id", repoId)
    .maybeSingle<{ id: string; repository_full_name: string }>();

  if (response.error) {
    throw new Error(`Failed to load active repository: ${response.error.message}`);
  }

  if (!response.data) {
    return null;
  }

  return {
    id: response.data.id,
    repositoryFullName: response.data.repository_full_name,
  };
}

function parseRepositoryFullName(repositoryFullName: string): { owner: string; repo: string } | null {
  const [owner, repo] = repositoryFullName.split("/");
  if (!owner || !repo) {
    return null;
  }

  return { owner, repo };
}

function getGithubApiHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function loadRepoGenerationContext(activeRepo: ActiveRepoContext): Promise<RepoGenerationContext | null> {
  const parsedRepo = parseRepositoryFullName(activeRepo.repositoryFullName);

  if (!parsedRepo) {
    console.warn("[Chat API] Unable to parse active repo full name", {
      repositoryFullName: activeRepo.repositoryFullName,
    });
    return null;
  }

  const { owner, repo } = parsedRepo;
  const headers = getGithubApiHeaders();

  const metadataResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers, cache: "no-store" });
  if (!metadataResponse.ok) {
    throw new Error(`Failed to load repository metadata (${metadataResponse.status})`);
  }

  const repoMetadata = await metadataResponse.json() as {
    default_branch?: string;
    description?: string | null;
    language?: string | null;
    stargazers_count?: number;
    open_issues_count?: number;
  };
  const metadataLine = [
    `default branch ${repoMetadata.default_branch ?? "unknown"}`,
    `language ${repoMetadata.language ?? "unknown"}`,
    `stars ${repoMetadata.stargazers_count ?? 0}`,
    `open issues ${repoMetadata.open_issues_count ?? 0}`,
    repoMetadata.description ? `description: ${repoMetadata.description}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  console.log("[Chat API] Repo metadata loaded", {
    repositoryFullName: activeRepo.repositoryFullName,
    defaultBranch: repoMetadata.default_branch ?? null,
    language: repoMetadata.language ?? null,
  });

  const contentsResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents?per_page=30`, {
    headers,
    cache: "no-store",
  });

  if (!contentsResponse.ok) {
    throw new Error(`Failed to load repository file summary (${contentsResponse.status})`);
  }

  const contents = await contentsResponse.json() as Array<{ name?: string; type?: string }>;
  const files = contents
    .filter((entry) => entry.type === "file" && typeof entry.name === "string")
    .map((entry) => entry.name as string)
    .slice(0, 12);
  const directories = contents
    .filter((entry) => entry.type === "dir" && typeof entry.name === "string")
    .map((entry) => `${entry.name}/`)
    .slice(0, 8);

  const fileSummaryLine = [
    directories.length ? `root directories: ${directories.join(", ")}` : null,
    files.length ? `root files: ${files.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  console.log("[Chat API] Repo file/context loaded", {
    repositoryFullName: activeRepo.repositoryFullName,
    directoryCount: directories.length,
    fileCount: files.length,
  });

  return {
    defaultBranch: repoMetadata.default_branch ?? "HEAD",
    metadataLine,
    fileSummaryLine,
    sourceContextLine: "",
    fetchedFilePaths: [],
    attachedSourceFileCount: 0,
    attachedCharacterCount: 0,
    attachedApproxTokenCount: 0,
  };
}

function parseRepoSourceClassifierResponse(raw: string): RepoSourceClassifierDecision | null {
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as Partial<RepoSourceClassifierDecision>;
    if (typeof parsed.attach_repo_source !== "boolean") {
      return null;
    }

    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : null;

    return {
      attach_repo_source: parsed.attach_repo_source,
      reason: typeof parsed.reason === "string" ? parsed.reason : "No reason provided",
      confidence,
    };
  } catch {
    return null;
  }
}



async function classifyRepoSourceAttachmentNeed({
  provider,
  modelId,
  message,
  requestIntent,
  activeRepo,
  repoSummary,
  attachmentSummaryForClassifier,
  activeRepoContextAttached,
  routingSignals,
}: {
  provider: LlmProvider;
  modelId: string;
  message: string;
  requestIntent?: RequestIntent;
  activeRepo: boolean;
  repoSummary?: string;
  attachmentSummaryForClassifier?: { total: number; imageCount: number; videoCount: number; textLikeCount: number };
  activeRepoContextAttached?: boolean;
  routingSignals?: Record<string, unknown>;
}): Promise<RepoSourceClassifierDecision> {
  try {
    const classificationPrompt = [
      "Decide whether the assistant should attach real repository source file excerpts for this request.",
      "Only return strict JSON.",
      "Use this schema exactly:",
      '{"attach_repo_source": boolean, "reason": string, "confidence": number | null}',
      "",
      "Your job is to infer whether real source code or file contents from the active repository would materially improve the answer.",
      "",
      "Set attach_repo_source=true whenever the user’s request would benefit from seeing actual repository files, code, configuration, implementation details, project structure, or concrete source context. This includes but is not limited to:",
      "- code review",
      "- debugging",
      "- architecture analysis",
      "- implementation questions",
      "- questions about whether the assistant can see, access, read, inspect, verify, or reason about the codebase",
      "- requests that reference behavior, capabilities, integrations, file handling, prompts, routing, tools, or system logic that may depend on actual code",
      "- ambiguous technical questions where source context would likely improve accuracy",
      "",
      "Set attach_repo_source=false only when the request is clearly answerable without repository source contents, such as:",
      "- casual conversation",
      "- purely conceptual discussion unrelated to this repo",
      "- questions answered fully by high-level metadata alone",
      "",
      "If an active repo is attached and you are uncertain, prefer true.",
      "",
      "If no active repo is attached, attach_repo_source must be false.",
      "",
      `User message: ${JSON.stringify(message)}`,
      `Resolved intent: ${requestIntent ?? "unknown"}`,
      `Active repo attached: ${activeRepo ? "yes" : "no"}`,
      `Repo summary: ${repoSummary ?? "none"}`,
      `Attachment summary: ${JSON.stringify(attachmentSummaryForClassifier ?? { total: 0, imageCount: 0, videoCount: 0, textLikeCount: 0 })}`,
      `Active repo context attached: ${activeRepoContextAttached ? "yes" : "no"}`,
      `Routing signals: ${JSON.stringify(routingSignals ?? {})}`
    ].join("\n");

    const result = await provider.generate({
      name: "Repo Source Classifier",
      persona: "You are a strict JSON classifier.",
      summary: "",
      history: [],
      user: classificationPrompt,
      modelId,
    });

    const parsed = parseRepoSourceClassifierResponse(result.text ?? "");
    if (parsed) {
      return parsed;
    }

    const fallback = __resolveRepoSourceClassifierFailureForTests(activeRepo);
    if (fallback.attach_repo_source) {
      console.warn("[Chat API] Repo source classifier invalid JSON; falling open for active repo.");
    }
    return fallback;
  } catch (error) {
    const fallback = __resolveRepoSourceClassifierFailureForTests(activeRepo, `Classifier failed: ${error instanceof Error ? error.message : String(error)}`);
    if (fallback.attach_repo_source) {
      console.warn("[Chat API] Repo source classifier failed; falling open for active repo.", error);
    }
    return fallback;
  }
}

export async function POST(request: NextRequest) {
  try {
    const payload = await parseIncomingPayload(request);
    const {
      actorId,
      chatId,
      message,
      images,
      fileReferences,
      overrideProvider,
      overrideModel,
      routingTraceEnabled,
      activeRepoId,
      repoInjectionEnabled: repoInjectionEnabledFromPayload,
    } = payload;
    const repoInjectionEnabled = repoInjectionEnabledFromPayload !== false;
    const attachments = fileReferences ?? [];
    console.log("[Chat API] received attachments", { count: attachments.length });
    attachments.forEach((attachment) => {
      console.log("[Chat API] received attachment", {
        fileName: attachment.fileName,
        attachmentKind: attachment.attachmentKind,
        mimeType: attachment.mimeType,
        previewLength: attachment.preview.length,
        extractedTextLength: attachment.extractedText?.length ?? 0,
        extractedChunksLength: attachment.extractedChunks?.length ?? 0,
        extractionCoverage: attachment.extractionCoverage ?? null,
      });
    });
    let messageForGeneration = message;
    const hasVideoInput = attachments.some(isVideoAttachment);
    const encoder = new TextEncoder();
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

    console.log(
      `[Chat API] Processing - Actor: ${actorId}, Chat: ${chatId}, ActiveRepoId: ${activeRepoId ?? "none"}`,
    );
    console.log("[Chat API] Repo injection override", {
      requestId,
      activeRepoId: activeRepoId ?? null,
      repoInjectionEnabled,
    });

    const providers = getAvailableProviders();
    if (!providers.length) {
      console.error("[Chat API] Error: No AI providers found in environment variables.");
      return NextResponse.json(
        { error: "No providers configured. Add OPENAI_API_KEY, GOOGLE_API_KEY, grok_api_key, and/or CLAUDE_API_KEY." },
        { status: 500 }
      );
    }

    console.log("[Chat API] Assembling context and selecting provider...");
    const { name, persona, summary, history, shortTermMemory, actorRoutingProfile } = await assembleContext(actorId, chatId);
    const activeRepoContext = activeRepoId ? await loadActiveRepoContext(activeRepoId) : null;
    const sessionContext: ChatSessionContext = {
      activeRepo: activeRepoContext
        ? {
            id: activeRepoContext.id,
            fullName: activeRepoContext.repositoryFullName,
          }
        : null,
    };
    const shortTermMemoryWithSession = {
      ...shortTermMemory,
      sessionContext,
    };
    await setShortTermMemory(actorId, chatId, shortTermMemoryWithSession);
    console.log("[Chat API] Session context", {
      requestId,
      actorId,
      chatId,
      activeRepo: sessionContext.activeRepo ?? null,
    });
    if (activeRepoContext) {
      console.log("[Chat API] Active repo detected", {
        repoId: activeRepoContext.id,
        repositoryFullName: activeRepoContext.repositoryFullName,
      });
    }

    const repoContextLine = activeRepoContext
      ? `Attached repository: ${activeRepoContext.repositoryFullName} (repo_id: ${activeRepoContext.id}).`
      : "";
    const personaWithRepoContext = repoContextLine
      ? `${persona}\n\n${repoContextLine}\nUse this repository context when answering questions about code.`
      : persona;

    let repoGenerationContextLine = "";
    let personaForGeneration = personaWithRepoContext;
    let loadedRepoContext: RepoGenerationContext | null = null;
    if (activeRepoContext) {
      try {
        loadedRepoContext = await loadRepoGenerationContext(activeRepoContext);
        if (loadedRepoContext) {
          repoGenerationContextLine = `Repository metadata: ${loadedRepoContext.metadataLine}. Repository summary: ${loadedRepoContext.fileSummaryLine}.`;
        }
      } catch (error) {
        console.error("[Chat API] Failed to load repository context", {
          requestId,
          repositoryFullName: activeRepoContext.repositoryFullName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (repoGenerationContextLine) {
      personaForGeneration = `${personaWithRepoContext}\n\n${repoGenerationContextLine}`;
      console.log("[Chat API] Repo context attached to generation request", {
        requestId,
        repositoryFullName: activeRepoContext?.repositoryFullName ?? null,
      });
    }
    const historyForProvider = history.map(({ role, content }) => ({ role, content }));
    let provider = providers[0];
    let modelId = "";
    let fallbackChain: Array<{ provider: LlmProvider; modelId: string; score: number }> = [];
    let selectionExplainer: SelectionExplainer | undefined;
    let resolvedRequestIntent: RequestIntent | undefined;
    let intentAuthority: "llm" | "heuristic" | "override" | "fallback" | "capability" = "fallback";
    let intentResolutionReason = "default";
    let routingHints: RoutingHint[] = [];
    const videoRoutingPolicy = resolveVideoRoutingPolicy(hasVideoInput, overrideProvider);

    if (hasVideoInput) {
      console.log("[Video Routing] detected video attachment(s); forcing provider=google");
    }

    if (videoRoutingPolicy.mode === "reject-override") {
      console.warn(`[Video Routing] rejected override provider=${videoRoutingPolicy.provider} for video input`);
      return NextResponse.json(
        { error: "Video attachments are only supported through the Google/Gemini provider in this chat flow." },
        { status: 400 }
      );
    }

    if (overrideProvider && overrideModel) {
      const manualProvider = providers.find((candidate) => candidate.name === overrideProvider);
      if (!manualProvider) {
        return NextResponse.json({ error: `Unknown override provider: ${overrideProvider}` }, { status: 400 });
      }

      const hasImages = Array.isArray(images) && images.length > 0;
      const hasImageAttachments = attachments.some((attachment) => attachment.mimeType.startsWith("image/"));
      const hasVisualInput = hasImages || hasImageAttachments;
      const modelEntries = await Promise.all(
        providers.map(async (candidate) => ({ provider: candidate, models: await candidate.listModels() }))
      );
      const controlPlaneDecisionProviders = selectControlPlaneDecisionModels(modelEntries);
      const overrideClassification = await inferRequestClassification(
        message,
        { hasImages: hasVisualInput, hasVideoInput },
        { decisionProviders: controlPlaneDecisionProviders }
      );
      const overrideIntent = overrideClassification.intent;
      const validatedOverride = validateRoutingDecision(
        { providerName: manualProvider.name, modelId: overrideModel },
        [{ provider: manualProvider, models: await manualProvider.listModels() }],
        overrideIntent
      );
      if (validatedOverride.changed) {
        return NextResponse.json(
          {
            error: `Override ${manualProvider.name}:${overrideModel} is incompatible with intent=${overrideIntent} or capabilities.`
          },
          { status: 400 }
        );
      }

      provider = manualProvider;
      modelId = overrideModel;
      intentAuthority = "override";
      intentResolutionReason = "user-override";
      console.log(`[Chat API] Override active. Provider: ${provider.name}, Model: ${modelId}`);
    } else if (videoRoutingPolicy.mode === "force-google") {
      const googleProvider = providers.find((candidate) => candidate.name === "google");
      if (!googleProvider) {
        return NextResponse.json(
          { error: "Video attachments require the Google/Gemini provider, but it is not configured." },
          { status: 400 }
        );
      }

      provider = googleProvider;
      modelId = await selectGoogleModelForVideoRouting(provider);
      fallbackChain = [];
      intentAuthority = "capability";
      intentResolutionReason = "forced-video-google";
      console.log(`[Video Routing] detected video attachment(s); forcing provider=google model=${modelId}`);
    } else if (videoRoutingPolicy.mode === "manual-google") {
      const googleProvider = providers.find((candidate) => candidate.name === "google");
      if (!googleProvider) {
        return NextResponse.json(
          { error: "Video attachments require the Google/Gemini provider, but it is not configured." },
          { status: 400 }
        );
      }

      provider = googleProvider;
      modelId = await selectGoogleModelForVideoRouting(provider, overrideModel);
      fallbackChain = [];
      intentAuthority = "override";
      intentResolutionReason = "manual-google-override";
      console.log(`[Video Routing] override accepted; provider=google model=${modelId}`);
    } else {
      const hasImages = Array.isArray(images) && images.length > 0;
      const hasImageAttachments = attachments.some((attachment) => attachment.mimeType.startsWith("image/"));
      const hasVisualInput = hasImages || hasImageAttachments;
      const explicitIntent: RequestIntent | undefined = hasDirectWebSearchHint(message) ? "web-search" : undefined;
      const assistantReflectionHint =
        /\b(what do you think about your last answer|critique (?:the )?assistant(?:'s)? previous response|review your system message|evaluate your own output|improve (?:the )?last reply|assess the quality of (?:that|your) response|your last answer|your previous response|your own output|your system message|reflect on your answer|self-critique|critique your response)\b/i.test(
          message
        );
      const socialEmotionalHint =
        /\b(what(?:'s| is)? up(?:\s+\w+)?|what up(?:\s+\w+)?|how are you feeling|how do you feel|what do you think of me|are you okay|how does (?:that|this) feel|how does (?:that|this) strike you|what(?:'s| is) your sense of this|develop\b[^.!?\n]{0,40}\bpersonality|have\b[^.!?\n]{0,30}\bpersonality|stop being robotic|loosen up)\b/i.test(
          message
        );
      const now = Date.now();
      const intentSession = parseIntentSessionState(shortTermMemory);
      const isAckMessage = isAcknowledgment(message);
      let requestIntent: RequestIntent | undefined;
      routingHints = [];

      if (explicitIntent) {
        requestIntent = explicitIntent;
        routingHints.push({ hintIntent: explicitIntent, hintSource: "explicit-command", hintConfidence: 0.95, note: "direct web-search detection" });
      }
      if (assistantReflectionHint) {
        requestIntent = requestIntent ?? "assistant-reflection";
        routingHints.push({ hintIntent: "assistant-reflection", hintSource: "heuristic", hintConfidence: 0.9, note: "reflection regex matched" });
      }
      if (socialEmotionalHint) {
        requestIntent = requestIntent ?? "social-emotional";
        routingHints.push({ hintIntent: "social-emotional", hintSource: "heuristic", hintConfidence: 0.9, note: "social regex matched" });
      }
      if (
        isAckMessage &&
        intentSession.lastSubstantiveIntent &&
        intentSession.lastIntentTimestamp &&
        now - intentSession.lastIntentTimestamp < ACK_CONTEXT_TTL_MS
      ) {
        requestIntent = requestIntent ?? intentSession.lastSubstantiveIntent;
        routingHints.push({ hintIntent: intentSession.lastSubstantiveIntent, hintSource: "short-term-memory", hintConfidence: 0.7, note: "ack reuse" });
        console.log(
          `[Intent Reuse] Reusing ${intentSession.lastSubstantiveIntent} from ${new Date(intentSession.lastIntentTimestamp).toISOString()} for ack message "${message}".`
        );
      }

      resolvedRequestIntent = requestIntent;
      const routingContext = `\n  Persona: ${personaWithRepoContext}\n  Rolling Summary: ${summary}\n  Recent History: ${JSON.stringify(history.slice(-3))}\n  Has Attached Images: ${hasVisualInput}\n  Active Repo: ${sessionContext.activeRepo ? `${sessionContext.activeRepo.fullName} (${sessionContext.activeRepo.id})` : "none"}\n`;
      console.log(
        `[Chat API] Routing intent diagnostic callerRequestIntent=${explicitIntent ?? "none"} heuristicIntent=${requestIntent ?? "none"} effectiveIntentPassedToRouter=none intentSource=router-fallback`
      );
      const routingDecision = await chooseProvider(message, routingContext, providers, {
        hasImages: hasVisualInput,
        hasVideoInput,
        actorId,
        actorRoutingProfile,
        routingHints,
        routingTraceEnabled,
        routingRequestId: request.headers.get("x-request-id") ?? undefined
      });

      provider = routingDecision.provider;
      modelId = routingDecision.modelId;
      fallbackChain = routingDecision.fallbackChain;
      selectionExplainer = routingDecision.explainer;
      resolvedRequestIntent = routingDecision.resolvedIntent.intent;
      intentAuthority = routingDecision.authority ?? "fallback";
      intentResolutionReason = routingDecision.intentResolutionReason ?? "router-default";
      console.log("[Chat API] Final resolved intent", {
        requestId,
        routerIntent: routingDecision.resolvedIntent.intent,
        routerIntentSource: routingDecision.resolvedIntent.intentSource,
        chatApiResolvedIntent: resolvedRequestIntent
      });

      console.log(`[Chat API] Selected Provider: ${provider.name}, Model: ${modelId}`);
      console.log(`[Chat API] Routing Model For UI: ${routingDecision.routerModel}`);
      console.log(`[Chat API] Routing Reasoning: ${routingDecision.reasoning}`);
    }

    const attachmentSummaryForClassifier = {
      total: attachments.length,
      imageCount: attachments.filter((attachment) => attachment.mimeType.startsWith("image/")).length,
      videoCount: attachments.filter((attachment) => attachment.mimeType.startsWith("video/")).length,
      textLikeCount: attachments.filter((attachment) => attachment.mimeType.startsWith("text/") || attachment.mimeType === "application/pdf").length,
    };
    const activeRepoContextAttached = Boolean(activeRepoContext && loadedRepoContext);
    const routingSignals = {
      routingHints,
      intentAuthority,
      intentResolutionReason,
      hasVideoInput,
    };

    if (resolvedRequestIntent && isSubstantiveIntent(resolvedRequestIntent)) {
      const now = Date.now();
      await setShortTermMemory(actorId, chatId, {
        ...shortTermMemoryWithSession,
        intentSession: {
          lastSubstantiveIntent: resolvedRequestIntent,
          lastIntentTimestamp: now,
        },
      });
      console.log(`[Intent Update] Stored final substantive intent ${resolvedRequestIntent} at ${new Date(now).toISOString()}.`);
    }

    let repoSourceClassifierDecision: RepoSourceClassifierDecision = {
      attach_repo_source: false,
      reason: "No active repository context available",
      confidence: null,
    };

    if (activeRepoContext && loadedRepoContext) {
      registerRepoBinding(
        activeRepoContext.id,
        activeRepoContext.repositoryFullName,
        loadedRepoContext.defaultBranch || "main",
      );
      repoSourceClassifierDecision = await classifyRepoSourceAttachmentNeed({
        provider,
        modelId,
        message,
        requestIntent: resolvedRequestIntent,
        activeRepo: true,
        repoSummary: loadedRepoContext.fileSummaryLine,
        attachmentSummaryForClassifier,
        activeRepoContextAttached,
        routingSignals,
      });
    }

    const shouldAttachSourceContext =
      repoInjectionEnabled &&
      activeRepoContext !== null &&
      loadedRepoContext !== null &&
      repoSourceClassifierDecision.attach_repo_source;

    console.log("[Chat API] Repo source classifier result", {
      requestId,
      repositoryFullName: activeRepoContext?.repositoryFullName ?? null,
      attachRepoSource: repoSourceClassifierDecision.attach_repo_source,
      reason: repoSourceClassifierDecision.reason,
      confidence: repoSourceClassifierDecision.confidence,
    });
    console.log("[Chat API] Repo source loading triggered", {
      requestId,
      triggered: shouldAttachSourceContext,
    });
    console.log("[Chat API] Repo source attachment gate", {
      requestId,
      shouldAttachSourceContext,
      repoInjectionEnabled,
      activeRepoContextPresent: activeRepoContext !== null,
      loadedRepoContextPresent: loadedRepoContext !== null,
      resolvedRequestIntent: resolvedRequestIntent ?? null,
    });
    if (!repoInjectionEnabled && activeRepoContext) {
      console.log("[Chat API] Repo source injection skipped by override", {
        requestId,
        activeRepo: activeRepoContext.repositoryFullName,
        repoInjectionEnabled,
        skippedByOverride: true,
      });
    }

    if (shouldAttachSourceContext && activeRepoContext && loadedRepoContext) {
      try {
        const injectedContents = await injectRelevantContents(message, activeRepoContext.id, 5);
        personaForGeneration = `${personaForGeneration}\n\n${injectedContents}`;
        const injectedFileCount = (injectedContents.match(/^File:/gm) ?? []).length;
        console.info(`[info] [Repo Injector] Injected ${injectedFileCount} files for requestId=${requestId}`);
      } catch (error) {
        console.error("[Chat API] Failed to inject repository source context", {
          requestId,
          repositoryFullName: activeRepoContext.repositoryFullName,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const selectedProviderSupport = getAttachmentSupportForProvider(provider.name, attachments);
    if (!selectedProviderSupport.supported && !overrideProvider) {
      const compatibleFallback = fallbackChain.find((candidate) => {
        const support = getAttachmentSupportForProvider(candidate.provider.name, attachments);
        return support.supported;
      });

      if (compatibleFallback) {
        provider = compatibleFallback.provider;
        modelId = compatibleFallback.modelId;
      }
    }

    const finalProviderSupport = getAttachmentSupportForProvider(provider.name, attachments);
    if (!finalProviderSupport.supported) {
      return NextResponse.json(
        { error: finalProviderSupport.reason },
        { status: 400 }
      );
    }

    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          const requestStartedAtMs = Date.now();
          let firstReasoningUpdateAtMs: number | null = null;
          let reasoningUpdateCount = 0;
          const reasoningState = new ReasoningStateAccumulator(requestId, [...DEFAULT_REASONING_CATEGORIES]);
          let lastSnapshotEmitAt = Date.now();
          const emitChunk = (chunk: Record<string, unknown>) => {
            if (streamCancelled) {
              return;
            }
            controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
          };

          try {
            emitChunk({
              type: "metadata",
              modelId,
              provider: provider.name,
              explainer: selectionExplainer,
              activeRepo: activeRepoContext
                ? {
                    id: activeRepoContext.id,
                    fullName: activeRepoContext.repositoryFullName,
                  }
                : null,
              intentHints: routingHints,
              intentAuthority,
              intentFinal: resolvedRequestIntent ?? null,
              intentResolutionReason,
              repoSourceAttachDecision: {
                attach: repoSourceClassifierDecision.attach_repo_source,
                reason: repoSourceClassifierDecision.reason,
                classifierConfidence: repoSourceClassifierDecision.confidence,
              },
              attachmentSummaryForClassifier,
              activeRepoContextAttached,
              routingSignals,
            });

            const startEvent = reasoningState.start();
            emitChunk(startEvent);
            console.log("[Chat API] reasoning_start emitted", { requestId, categories: startEvent.categories });

            console.log("[Chat API] Saving user message...");
            await saveMessage(chatId, {
              id: crypto.randomUUID(),
              role: "user",
              content: message,
            });

            console.log(`[Chat API] Requesting generation from ${provider.name} using model ${modelId}...`);
            const enqueueDelta = (delta: string) => {
              if (streamCancelled) {
                throw new Error("stream cancelled");
              }
              emitChunk({ type: "delta", text: delta });
              const reasoningUpdate = reasoningState.addDelta(delta);
              if (reasoningUpdate) {
                reasoningUpdateCount += 1;
                if (firstReasoningUpdateAtMs === null) {
                  firstReasoningUpdateAtMs = Date.now();
                }
                emitChunk(reasoningUpdate);

                if (Date.now() - lastSnapshotEmitAt > 900 || reasoningUpdateCount % 6 === 0) {
                  emitChunk(reasoningState.snapshot());
                  lastSnapshotEmitAt = Date.now();
                }
              }
            };

            const createParams = (selectedModelId: string) =>
              buildGenerationParams({
                name,
                persona: personaForGeneration,
                summary,
                history: historyForProvider,
                message: messageForGeneration,
                requestIntent: resolvedRequestIntent,
                images,
                modelId: selectedModelId,
                attachments
              });

            if (shouldRunChunkedWorkflow(message, attachments)) {
              const chunkWorkflowSummary = await analyzeChunkedAttachments({
                provider,
                modelId,
                name,
                persona: personaForGeneration,
                summary,
                userMessage: message,
                attachments
              });

              if (chunkWorkflowSummary) {
                messageForGeneration = `${message}

${chunkWorkflowSummary}`;
                emitChunk({
                  type: "metadata",
                  chunkWorkflow: "enabled",
                  detail: "Performed server-side chunk-by-chunk pre-analysis for large attachments."
                });
              }
            }

            let result: ProviderResponse | null = null;
            let streamedText = "";
            const attempts = [{ provider, modelId }, ...fallbackChain];
            const retryOnProviderRefusal = shouldRetryOnProviderRefusal();
            const generationAttempt = await runWithRefusalFallback({
              attempts,
              shouldRetryRefusal: retryOnProviderRefusal,
              runAttempt: async (candidate, attemptIndex) => {
                provider = candidate.provider;
                modelId = candidate.modelId;

                if (attemptIndex > 0) {
                  emitChunk({
                    type: "metadata",
                    modelId,
                    provider: provider.name
                  });
                }

                const generation = await runGeneration({
                  provider,
                  params: createParams(modelId),
                  onTextDelta: enqueueDelta
                });

                streamedText = generation.streamedText;
                return {
                  ...generation.result,
                  text: generation.result.text || generation.streamedText
                };
              },
              detectRefusal: (generationResult, candidate) => isLikelyProviderRefusal(generationResult, candidate.provider.name),
              onRefusalFallback: ({ attempt, nextAttempt }) => {
                console.warn("[Chat API] Provider refusal detected. Attempting fallback candidate.", {
                  requestId,
                  provider: attempt.provider.name,
                  modelId: attempt.modelId,
                  nextProvider: nextAttempt.provider.name,
                  nextModelId: nextAttempt.modelId
                });
              },
              onError: ({ attempt, error }) => {
                console.warn(
                  `[Chat API] Generation failed for ${attempt.provider.name}:${attempt.modelId} (${error instanceof Error ? error.message : String(error)}).`
                );
              }
            });
            result = generationAttempt.result;
            provider = generationAttempt.attempt.provider;
            modelId = generationAttempt.attempt.modelId;

            if (!result || (!result.text && !(result.content?.length) && !streamedText)) {
              throw new Error(`AI Provider ${provider.name} returned an empty response.`);
            }

            const imageAssets =
              result.content
                ?.map((part) => {
                  const partType = typeof part.type === "string" ? part.type.toLowerCase() : "";
                  if (!partType.includes("image")) {
                    return null;
                  }

                  const url = extractImageUrl(part);
                  if (!url) {
                    return null;
                  }

                  return { type: "image", url };
                })
                .filter((asset): asset is { type: "image"; url: string } => Boolean(asset)) ?? [];

            emitChunk({
              type: "content",
              text: result.text || streamedText,
              assets: imageAssets,
              provider: result.provider,
              model: result.model
            });

            const finalAnswerEvent = reasoningState.finalize(result.text || streamedText);
            emitChunk(reasoningState.snapshot());
            emitChunk(finalAnswerEvent);

            console.log("[Chat API] Generation successful. Saving assistant response.");
            const assistantText = result.text || streamedText;
            await saveMessage(chatId, {
              id: crypto.randomUUID(),
              role: "assistant",
              model: result.model,
              content: assistantText,
              assets: imageAssets,
            });

            after(async () => {
              try {
                console.log("[Chat API] Background Long-Term Memory Update Start", { actorId, chatId });
                await maybeUpdateLongTermMemory(actorId, chatId, message);
              } catch (error: unknown) {
                console.error("[Chat API] Background Long-Term Memory Update Error:", error);
              }

              try {
                await maybeUpdateSummary(chatId);
              } catch (error: unknown) {
                console.error("[Chat API] Background Summary Update Error:", error);
              }
            });
            console.log("[Chat API] reasoning stream metrics", {
              requestId,
              reasoningUpdateCount,
              timeToFirstReasoningUpdateMs: firstReasoningUpdateAtMs === null ? null : firstReasoningUpdateAtMs - requestStartedAtMs,
              timeToFinalAnswerMs: Date.now() - requestStartedAtMs
            });

            controller.close();
          } catch (error: unknown) {
            console.error("[Chat API] Stream Runtime Error:", error);
            const message = error instanceof Error ? error.message : "Unknown stream error";
            emitChunk(reasoningState.error(message, true));
            console.error("[Chat API] reasoning stream error", { requestId, message });
            controller.error(error);
          }
        })();
      },
      cancel() {
        streamCancelled = true;
        console.log("[Chat API] stream cancelled by client", { requestId });
      }
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unexpected error";

    if (errorMessage === "Invalid request payload") {
      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    if (errorMessage.includes("not found")) {
      return NextResponse.json({ error: errorMessage }, { status: 404 });
    }

    console.error("[Chat API] Fatal Runtime Error:", {
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined
    });

    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
