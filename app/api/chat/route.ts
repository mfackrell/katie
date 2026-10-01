import { attachmentAccessContext, selectFollowUpAttachments, type ConversationAttachment } from "@/lib/chat/attachment-continuity";
import { persistConversationAttachment, restoreConversationAttachment } from "@/lib/uploads/stored-uploads";
import { describeVideoEvidence } from "@/lib/uploads/video-observations";
import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assembleContext } from "@/lib/memory/assemble-context";
import { maybeUpdateSummary } from "@/lib/memory/summarizer";
import { maybeUpdateLongTermMemory } from "@/lib/memory/long-term-editor";
import { getRecentMessages, saveMessage } from "@/lib/data/persistence-store";
import {
  claimChatRequest,
  completeChatRequest,
  failChatRequest,
  fingerprintChatRequest,
} from "@/lib/chat/request-idempotency";
import { refreshShortTermMemory } from "@/lib/memory/short-term";
import { resolveLocalKatieResponse } from "@/lib/chat/local-katie";
import { maintainMemoryArchitecture } from "@/lib/memory/hygiene";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { getAvailableProviders } from "@/lib/providers";
import { chooseProvider, selectControlPlaneDecisionModels } from "@/lib/router/master-router";
import {
  detectWebSearchSignals,
  inferRequestClassification,
  RequestIntent,
  RoutingHint,
  validateRoutingDecision
} from "@/lib/router/model-intent";

import { LlmProvider, ProviderResponse } from "@/lib/providers/types";
import type { ResolvedRoutingIntent, SelectionExplainer } from "@/lib/router/master-router";
import { DEFAULT_REASONING_CATEGORIES, ReasoningStateAccumulator } from "@/lib/chat/reasoning-stream";
import { isLikelyProviderRefusal, runWithRefusalFallback, shouldRetryOnProviderRefusal } from "@/lib/router/refusal-detection";
import {
  classifyGenerationFailure,
  describeGenerationFailure,
  filterHealthyProviders,
} from "@/lib/router/provider-error";
import {
  filterProvidersBySharedHealth,
  recordSharedProviderFailure,
} from "@/lib/router/provider-health";
import {
  getAttachmentSupportForProvider,
  isVideoAttachment,
  resolveVideoRoutingPolicy,
  selectGoogleModelForVideoRouting
} from "@/lib/chat/video-routing";
import {
  buildInclusionManifest,
  fetchFullFile,
  selectFilesForInjection,
} from "@/lib/repo/content-injector";
import {
  getRepoFile,
  getRepoFileRange,
  getRepoVisibilityManifest,
  listRepoTree,
  registerRepoBinding,
  searchRepo
} from "@/lib/repo/repo-access";
import { analyzeChunkedAttachments, shouldRunChunkedWorkflow } from "@/lib/providers/chunked-document-workflow";
import { sanitizeCalculationResponse, shouldSuppressCalculationScaffolding } from "@/lib/providers/calculation-output";
import { shouldUseAdaptiveCollaboration } from "@/lib/collaboration/activation";
import { getCollaborationConfig } from "@/lib/collaboration/config";
import { runAdaptiveCollaboration } from "@/lib/collaboration/orchestrator";
import { runOnDemandCapabilityEscalation } from "@/lib/collaboration/capability-escalation-runner";
import { selectCollaborationHelper } from "@/lib/collaboration/routing";
import type { CollaborationTraceEvent, CollaborationResumeState } from "@/lib/collaboration/types";
import { getRoutingRegistryByProvider, type RegistryRoutingModel } from "@/lib/models/registry";
import { hydrateStoredAttachments } from "@/lib/uploads/stored-uploads";

// This endpoint streams long-running responses (e.g., deep financial/workbook analysis).
// Keep the function timeout above Vercel's default 300s ceiling to avoid truncating streamed replies.
export const maxDuration = 800;

const fileReferenceSchema = z.object({
  storageToken: z.string().max(3000).optional(),
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

function inspectImagePayloads(images: string[] | undefined): Array<{ mimeType: string; encodedChars: number }> {
  if (!images?.length) {
    return [];
  }

  return images.map((image, index) => {
    const match = image.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
    if (!match) {
      throw new Error(`Image ${index + 1} is not a valid base64 image data URL.`);
    }

    return {
      mimeType: match[1].toLowerCase(),
      encodedChars: image.length,
    };
  });
}

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


function inferModelTier(modelId: string): "premium" | "medium" | "light" {
  const normalized = (modelId || "").toLowerCase();

  if (
    normalized.includes("o3-pro") ||
    normalized.includes("opus") ||
    normalized.includes("gpt-5.5") ||
    normalized.includes("gpt-5.3") ||
    normalized.includes("claude-opus") ||
    normalized.includes("grok-4") ||
    normalized.includes("unified")
  ) {
    return "premium";
  }

  if (
    normalized.includes("flash") ||
    normalized.includes("mini") ||
    normalized.includes("haiku") ||
    normalized.includes("lite") ||
    normalized.includes("pulse")
  ) {
    return "light";
  }

  return "medium";
}

function buildKatieRuntimeContext({
  provider,
  modelId,
  modelTier,
  classifiedIntent,
  routingAuthority,
  requestId
}: {
  provider?: string;
  modelId?: string;
  modelTier?: "premium" | "medium" | "light";
  classifiedIntent?: string;
  routingAuthority?: string;
  requestId?: string;
}): string {
  return `KATIE_RUNTIME_CONTEXT:
- current_provider: ${provider || "unknown"}
- current_model: ${modelId || "unknown"}
- model_tier: ${modelTier || "unknown"}
- routing_intent: ${classifiedIntent || "unknown"}
- routing_authority: ${routingAuthority || "unknown"}
- request_id: ${requestId || "unknown"}
---`;
}

function replaceKatieRuntimeContext(persona: string, runtimeContext: string): string {
  const withoutExistingContext = persona
    .replace(/\n*KATIE_RUNTIME_CONTEXT:\n[\s\S]*?\n---\n*/m, "")
    .trimEnd();

  return withoutExistingContext
    ? `${withoutExistingContext}\n\n${runtimeContext}`
    : runtimeContext;
}

function shouldRunRepoAuditMode(message: string): boolean {
  return /\b(audit|review|inspect|debug|explain)\b/i.test(message);
}

const CODE_PATCH_OR_DIFF_ROUTING_REGEX = /\b(diff|patch|@@|\+\+\+\s|---\s|pull request|\bpr\b|\bcommit\b)\b/i;
const REPO_REVIEW_LANGUAGE_ROUTING_REGEX = /\b(repo|repository|code|file|files|source|routing|architecture|audit|review|debug|test|tests|deployment|kubernetes|docker|ci\/?cd)\b/i;
const REPO_SOURCE_EXPLICIT_MESSAGE_REGEX =
  /\b(repo|repository|github|source code|codebase|typescript|javascript|route\.ts|\.tsx?\b|component|function|class|endpoint|api route|routing|architecture|debug|debugging|bug|deployment|kubernetes|docker|ci\/?cd)\b/i;

const REPO_SOURCE_INTENTS = new Set<RequestIntent>([
  "architecture-review",
  "code-review",
  "technical-debugging",
  "code-generation",
]);

function shouldAttachRepoSourceDeterministically(input: {
  repoInjectionEnabled: boolean;
  hasActiveRepo: boolean;
  requestIntent?: RequestIntent;
  message: string;
}): { attach: boolean; reason: string } {
  if (!input.repoInjectionEnabled) {
    return { attach: false, reason: "Repository injection disabled by user setting." };
  }
  if (!input.hasActiveRepo) {
    return { attach: false, reason: "No active repository is attached." };
  }
  if (input.requestIntent && REPO_SOURCE_INTENTS.has(input.requestIntent)) {
    return {
      attach: true,
      reason: `Resolved intent ${input.requestIntent} requires repository source context.`,
    };
  }
  if (
    CODE_PATCH_OR_DIFF_ROUTING_REGEX.test(input.message) ||
    REPO_SOURCE_EXPLICIT_MESSAGE_REGEX.test(input.message)
  ) {
    return {
      attach: true,
      reason: "Message explicitly references code, repository, architecture, debugging, review, or implementation work.",
    };
  }
  return {
    attach: false,
    reason: "Request is not repo-dependent; skipping GitHub/source retrieval.",
  };
}

function deriveRepoSearchTerms(message: string): string[] {
  const tokens = message
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .filter((token) => token.length >= 3);
  return Array.from(new Set(tokens)).slice(0, 8);
}

type RepoAuditDiscovery = {
  searchTerms: string[];
  prioritizedPaths: string[];
  treeSummary: Record<string, number>;
};

function discoverRepoAuditTargets(message: string, filePaths: string[]): RepoAuditDiscovery {
  const normalized = filePaths.map((path) => path.toLowerCase());
  const byCategory: Record<string, string[]> = {
    dependency_manifest: ["package.json", "requirements.txt", "pyproject.toml", "pom.xml", "go.mod", "cargo.toml", "gemfile"],
    readme_docs: ["readme", "docs/", ".md"],
    source_entry: ["src/index", "src/main", "main.", "app.", "server.", "index."],
    api_routes: ["route.", "routes/", "api/"],
    router_orchestration: ["router", "routing", "orchestration"],
    repo_access_layer: ["repo-access", "repository", "github", "gitlab", "connector"],
    providers_integrations: ["provider", "integration", "adapter", "client"],
    memory_data: ["memory", "store", "db", "database", "persistence"],
    tests: ["test", "spec"],
    deployment_config: ["docker", "kubernetes", "helm", "vercel", "netlify", "terraform", ".github/workflows", "compose"]
  };
  const treeSummary: Record<string, number> = {};
  const prioritized = new Set<string>();
  for (const [category, patterns] of Object.entries(byCategory)) {
    const hits = normalized
      .map((path, index) => ({ path: filePaths[index], matched: patterns.some((pattern) => path.includes(pattern)) }))
      .filter((entry) => entry.matched)
      .slice(0, 3)
      .map((entry) => entry.path);
    treeSummary[category] = hits.length;
    hits.forEach((path) => prioritized.add(path));
  }

  const searchTerms = deriveRepoSearchTerms(message);
  for (const path of filePaths.slice(0, 60)) {
    if (searchTerms.some((term) => path.toLowerCase().includes(term))) prioritized.add(path);
    if (prioritized.size >= 24) break;
  }
  return { searchTerms, prioritizedPaths: Array.from(prioritized).slice(0, 24), treeSummary };
}

function buildRepoAuditContextBlock(params: {
  manifest: Awaited<ReturnType<typeof getRepoVisibilityManifest>>;
  repoFullName: string;
  defaultBranch: string;
  totalFilesKnown: number;
  accessibleTextFiles: number;
  treeSummary: Record<string, number>;
  filesInspected: string[];
  searchTerms: string[];
  fetchErrors: string[];
  omitted: string[];
  excerpts: string[];
}): string {
  const { manifest, repoFullName, defaultBranch, totalFilesKnown, accessibleTextFiles, treeSummary, filesInspected, searchTerms, fetchErrors, omitted, excerpts } = params;
  return [
    "REPO_AUDIT_CONTEXT_START",
    `active_repo_full_name: ${repoFullName}`,
    `default_branch: ${defaultBranch}`,
    `total_files_known: ${totalFilesKnown}`,
    `accessible_text_files: ${accessibleTextFiles}`,
    `tree_summary: ${JSON.stringify(treeSummary)}`,
    `visibility_manifest: ${JSON.stringify(manifest)}`,
    `files_inspected: ${JSON.stringify(filesInspected)}`,
    `search_terms_used: ${JSON.stringify(searchTerms)}`,
    `fetch_errors: ${JSON.stringify(fetchErrors)}`,
    `omitted_files_or_limits: ${JSON.stringify(omitted)}`,
    "selected_source_excerpts:",
    ...excerpts,
    `confidence_visibility_summary: ${filesInspected.length > 0 ? "partial visibility based on inspected files only" : "low visibility; no files inspected"}`,
    "Answer from inspected files and excerpts when possible.",
    "When repo audit context is present and active repo access is available, do not ask the user to paste files.",
    "State which files were inspected and what was omitted due to limits.",
    "Do not claim full repository visibility unless inspected files cover the relevant scope.",
    "REPO_AUDIT_CONTEXT_END"
  ].join("\n");
}


function buildGenerationParams({
  name,
  persona,
  summary,
  history,
  message,
  requestIntent,
  secondaryIntents,
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
  secondaryIntents?: RequestIntent[];
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
    secondaryIntents,
    images,
    modelId,
    attachments
  };
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

export async function POST(request: NextRequest) {
  let trackedRequestId: string | null = null;
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
    const attachments = await hydrateStoredAttachments(fileReferences ?? []);
    const attachmentHistory = await getRecentMessages(chatId, 60);
    const savedAttachments: ConversationAttachment[] = [];
    const unavailableAttachments: string[] = [];
    if (!attachments.length && !images?.length) {
      for (const saved of selectFollowUpAttachments(message, attachmentHistory)) {
        savedAttachments.push(saved);
        try { attachments.push(await restoreConversationAttachment(chatId, saved)); }
        catch { unavailableAttachments.push(saved.fileName); }
      }
    }
    console.info("[Attachments] Follow-up source resolution", { restored: attachments.length, reused: savedAttachments.length, unavailable: unavailableAttachments });
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
    const suppliedRequestId = request.headers.get("x-request-id")?.trim();
    const requestId =
      suppliedRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)
        ? suppliedRequestId
        : crypto.randomUUID();
    const requestFingerprint = await fingerprintChatRequest({
      actorId,
      chatId,
      message,
      images: images ?? [],
      fileReferences: attachments.map((attachment) => ({
        fileId: attachment.fileId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
      })),
      overrideProvider: overrideProvider ?? null,
      overrideModel: overrideModel ?? null,
      activeRepoId: activeRepoId ?? null,
      repoInjectionEnabled,
    });
    const idempotencyClaim = await claimChatRequest({
      requestId,
      actorId,
      chatId,
      requestFingerprint,
    });

    if (idempotencyClaim.mode === "conflict") {
      return NextResponse.json(
        { error: "Request ID was reused with different request content.", requestId },
        { status: 409 },
      );
    }

    if (idempotencyClaim.mode === "existing") {
      if (idempotencyClaim.record.status === "completed") {
        const replayBody = [
          JSON.stringify({
            type: "metadata",
            modelId: idempotencyClaim.record.assistantModel ?? "unknown",
            provider: "replay",
            requestId,
            replayed: true,
          }),
          JSON.stringify({
            type: "content",
            text: idempotencyClaim.record.assistantContent ?? "",
            assets: idempotencyClaim.record.assistantAssets,
            provider: "replay",
            model: idempotencyClaim.record.assistantModel ?? "unknown",
          }),
          "",
        ].join("\n");
        return new NextResponse(replayBody, {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }

      if (idempotencyClaim.record.status === "processing") {
        return NextResponse.json(
          { status: "processing", requestId },
          { status: 202 },
        );
      }

      return NextResponse.json(
        {
          status: "failed",
          requestId,
          error:
            idempotencyClaim.record.errorMessage ??
            "The previous attempt for this request ID failed.",
        },
        { status: 409 },
      );
    }

    if (idempotencyClaim.mode === "untracked") {
      console.warn("[Idempotency] Durable request tracking unavailable; continuing fail-open.", {
        requestId,
        reason: idempotencyClaim.reason,
      });
    }

    const requestTracked = idempotencyClaim.tracked;
    if (requestTracked) {
      trackedRequestId = requestId;
    }
    const imagePayloadMetadata = inspectImagePayloads(images);

    console.log("[Chat API] Image payloads", {
      requestId,
      count: imagePayloadMetadata.length,
      images: imagePayloadMetadata,
    });

    console.log("[Chat API] User message", {
      requestId,
      message,
      messageLength: message.length,
    });

    console.log(
      `[Chat API] Processing - Actor: ${actorId}, Chat: ${chatId}, ActiveRepoId: ${activeRepoId ?? "none"}`,
    );
    console.log("[Chat API] Repo injection override", {
      requestId,
      activeRepoId: activeRepoId ?? null,
      repoInjectionEnabled,
    });

    await maintainMemoryArchitecture(actorId, chatId);

    const localKatieResponse = await resolveLocalKatieResponse({
      actorId,
      chatId,
      message,
    });

    if (localKatieResponse) {
      console.log("[Chat API] Local Katie response", {
        requestId,
        reason: localKatieResponse.reason,
        actorId,
        chatId,
      });

      const localUserMessageId = crypto.randomUUID();
      const localAssistantMessageId = crypto.randomUUID();
      await saveMessage(chatId, {
        id: localUserMessageId,
        role: "user",
        content: message,
      });

      await saveMessage(chatId, {
        id: localAssistantMessageId,
        role: "assistant",
        model: "katie-local",
        content: localKatieResponse.text,
      });
      if (requestTracked) {
        await completeChatRequest(requestId, {
          assistantMessageId: localAssistantMessageId,
          assistantModel: "katie-local",
          assistantContent: localKatieResponse.text,
          assistantAssets: [],
        });
      }
      await refreshShortTermMemory(actorId, chatId);
      after(async () => {
        try {
          await maybeUpdateSummary(chatId);
        } catch (error: unknown) {
          console.error("[Chat API] Local response intermediate memory update failed:", error);
        }
      });

      const localBody = [
        JSON.stringify({
          type: "metadata",
          modelId: "katie-local",
          provider: "local",
          explainer: {
            selected_model: "katie-local",
            selected_provider: "local",
            summary: `Handled directly by Katie without an external LLM (${localKatieResponse.reason}).`,
            selected_source: "deterministic-fallback",
            fallback_used: false,
          },
        }),
        JSON.stringify({
          type: "content",
          text: localKatieResponse.text,
          assets: [],
          provider: "local",
          model: "katie-local",
        }),
        "",
      ].join("\n");

      return new NextResponse(localBody, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    const configuredProviders = getAvailableProviders();
    if (!configuredProviders.length) {
      console.error("[Chat API] Error: No AI providers found in environment variables.");
      if (requestTracked) {
        await failChatRequest(requestId, new Error("No AI providers configured."));
      }
      return NextResponse.json(
        { error: "No providers configured. Add OPENAI_API_KEY, GOOGLE_API_KEY, grok_api_key, and/or CLAUDE_API_KEY." },
        { status: 500 }
      );
    }

    const sharedHealth =
      overrideProvider || hasVideoInput
        ? { providers: configuredProviders, blocked: [], available: true }
        : await filterProvidersBySharedHealth(configuredProviders);
    const providers = sharedHealth.providers;

    if (sharedHealth.blocked.length > 0) {
      console.warn("[ProviderHealth] Router excluded temporarily blocked providers.", {
        requestId,
        blocked: sharedHealth.blocked,
      });
    }

    console.log("[Chat API] Assembling context and selecting provider...");
    const { name, persona, summary, history, actorRoutingProfile } = await assembleContext(actorId, chatId);
    const activeRepoContext = activeRepoId ? await loadActiveRepoContext(activeRepoId) : null;
    const sessionContext: ChatSessionContext = {
      activeRepo: activeRepoContext
        ? {
            id: activeRepoContext.id,
            fullName: activeRepoContext.repositoryFullName,
          }
        : null,
    };
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
    let repoContextDegraded: { reason: string } | null = null;
    const historyForProvider = history.map(({ role, content }) => ({ role, content }));
    const controlPlaneConversationContext = [
      summary ? `Conversation summary: ${summary}` : "",
      history.length ? `Recent conversation: ${JSON.stringify(history.slice(-4))}` : "",
      `Has attached images: ${Boolean((Array.isArray(images) && images.length > 0) || attachments.some((attachment) => attachment.mimeType.startsWith("image/")))}`,
      `Active repo: ${sessionContext.activeRepo ? `${sessionContext.activeRepo.fullName} (${sessionContext.activeRepo.id})` : "none"}`
    ]
      .filter(Boolean)
      .join("\n");

    let provider = providers[0];
    let modelId = "";
    let fallbackChain: Array<{ provider: LlmProvider; modelId: string; score: number }> = [];
    let selectionExplainer: SelectionExplainer | undefined;
    let resolvedRoutingIntentForReroute: ResolvedRoutingIntent | undefined;
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
        {
          decisionProviders: controlPlaneDecisionProviders,
          conversationContext: controlPlaneConversationContext,
          requestId
        }
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
      const hasCodePatchOrDiff = CODE_PATCH_OR_DIFF_ROUTING_REGEX.test(message);
      const hasRepoReviewLanguage = REPO_REVIEW_LANGUAGE_ROUTING_REGEX.test(message);
      const repoReviewContextActive = Boolean(activeRepoContext) && (hasCodePatchOrDiff || hasRepoReviewLanguage);
      const directWebSearchSignals = detectWebSearchSignals(message);
      const explicitIntent: RequestIntent | undefined =
        directWebSearchSignals.keywordMatch && !repoReviewContextActive
          ? "web-search"
          : undefined;
      const assistantReflectionHint =
        /\b(what do you think about your last answer|critique (?:the )?assistant(?:'s)? previous response|review your system message|evaluate your own output|improve (?:the )?last reply|assess the quality of (?:that|your) response|your last answer|your previous response|your own output|your system message|reflect on your answer|self-critique|critique your response)\b/i.test(
          message
        );
      const socialEmotionalHint =
        /\b(what(?:'s| is)? up(?:\s+\w+)?|what up(?:\s+\w+)?|how are you feeling|how do you feel|what do you think of me|are you okay|how does (?:that|this) feel|how does (?:that|this) strike you|what(?:'s| is) your sense of this|develop\b[^.!?\n]{0,40}\bpersonality|have\b[^.!?\n]{0,30}\bpersonality|stop being robotic|loosen up)\b/i.test(
          message
        );
      let requestIntent: RequestIntent | undefined;
      routingHints = [];

      if (explicitIntent) {
        requestIntent = explicitIntent;
        routingHints.push({ hintIntent: explicitIntent, hintSource: "explicit-command", hintConfidence: repoReviewContextActive ? 0.55 : 0.95, note: repoReviewContextActive ? "direct web-search detection (weak due to active repo review context)" : "direct web-search detection" });
      }
      if (assistantReflectionHint) {
        requestIntent = requestIntent ?? "assistant-reflection";
        routingHints.push({ hintIntent: "assistant-reflection", hintSource: "heuristic", hintConfidence: 0.9, note: "reflection regex matched" });
      }
      if (socialEmotionalHint) {
        requestIntent = requestIntent ?? "social-emotional";
        routingHints.push({ hintIntent: "social-emotional", hintSource: "heuristic", hintConfidence: 0.9, note: "social regex matched" });
      }
      resolvedRequestIntent = requestIntent;
      const routingContext = controlPlaneConversationContext;
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
        routingRequestId: requestId
      });

      provider = routingDecision.provider;
      modelId = routingDecision.modelId;
      fallbackChain = routingDecision.fallbackChain;
      selectionExplainer = routingDecision.explainer;
      resolvedRoutingIntentForReroute = routingDecision.resolvedIntent;
      resolvedRequestIntent = routingDecision.resolvedIntent.intent;
      intentAuthority = routingDecision.authority ?? "fallback";
      intentResolutionReason = routingDecision.intentResolutionReason ?? "router-default";
      console.log("[Chat API] Final resolved intent", {
        requestId,
        routerIntent: routingDecision.resolvedIntent.intent,
        routerIntentSource: routingDecision.resolvedIntent.intentSource,
        chatApiResolvedIntent: resolvedRequestIntent,
        secondaryIntents: routingDecision.resolvedIntent.secondaryIntents ?? []
      });

      console.log(`[Chat API] Selected Provider: ${provider.name}, Model: ${modelId}`);
      console.log(`[Chat API] Routing Model For UI: ${routingDecision.routerModel}`);
      console.log(`[Chat API] Routing Reasoning: ${routingDecision.reasoning}`);
    }

    const repoGate = shouldAttachRepoSourceDeterministically({
      repoInjectionEnabled,
      hasActiveRepo: activeRepoContext !== null,
      requestIntent: resolvedRequestIntent,
      message,
    });

    if (repoGate.attach && activeRepoContext) {
      try {
        loadedRepoContext = await loadRepoGenerationContext(activeRepoContext);
        if (loadedRepoContext) {
          repoGenerationContextLine = `Repository metadata: ${loadedRepoContext.metadataLine}. Repository summary: ${loadedRepoContext.fileSummaryLine}.`;
          personaForGeneration = `${personaWithRepoContext}\n\n${repoGenerationContextLine}`;
          registerRepoBinding(
            activeRepoContext.id,
            activeRepoContext.repositoryFullName,
            loadedRepoContext.defaultBranch || "main",
          );
          console.log("[Chat API] Repo context attached to generation request", {
            requestId,
            repositoryFullName: activeRepoContext.repositoryFullName,
          });
        }
      } catch (error) {
        repoContextDegraded = {
          reason: error instanceof Error ? error.message : String(error),
        };
        console.error("[Chat API] Failed to load repository context", {
          requestId,
          repositoryFullName: activeRepoContext.repositoryFullName,
          error: repoContextDegraded.reason,
        });
      }
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
      activeRepoContextPresent: activeRepoContext !== null,
      containsCodePatchOrDiff: CODE_PATCH_OR_DIFF_ROUTING_REGEX.test(message),
      containsRepoReviewLanguage: REPO_REVIEW_LANGUAGE_ROUTING_REGEX.test(message),
    };

    const repoSourceClassifierDecision = {
      attach_repo_source:
        repoGate.attach &&
        activeRepoContext !== null &&
        loadedRepoContext !== null,
      reason: repoContextDegraded
        ? `Repository context degraded: ${repoContextDegraded.reason}`
        : repoGate.reason,
      confidence: 1,
    };

    const shouldAttachSourceContext = repoSourceClassifierDecision.attach_repo_source;

    console.log("[Chat API] Deterministic repo source gate", {
      requestId,
      repositoryFullName: activeRepoContext?.repositoryFullName ?? null,
      attachRepoSource: repoSourceClassifierDecision.attach_repo_source,
      reason: repoSourceClassifierDecision.reason,
      githubAccessAttempted: repoGate.attach,
      degraded: Boolean(repoContextDegraded),
    });
    if (shouldAttachSourceContext && activeRepoContext && loadedRepoContext) {
      try {
        const fileSelection = await selectFilesForInjection(activeRepoContext.id, message, [], "smart");
        const settled = await Promise.allSettled(
          fileSelection.selected.map((filePath) => fetchFullFile(activeRepoContext.id, filePath, 250_000)),
        );
        const fullFileResults = settled
          .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchFullFile>>> => result.status === "fulfilled")
          .map((result) => result.value);
        const included = fullFileResults.filter((file) => !file.isTruncated);
        const truncated = fullFileResults.filter((file) => file.isTruncated).map((file) => file.filePath);
        const skipped = settled
          .map((result, index) => (result.status === "rejected" ? { path: fileSelection.selected[index], reason: "fetch failed" } : null))
          .filter((item): item is { path: string; reason: string } => item !== null);
        const inclusionManifest = buildInclusionManifest(included, truncated, skipped);
        const fullFileContents = included
          .map((file) => `--- ${file.filePath} (${file.byteCount} bytes, sha256: ${file.sha256}) ---\n${file.content}`)
          .join("\n\n");

        console.info("[Chat API] Full-file injection metadata", {
          requestId,
          filesRequested: fileSelection.selected.length,
          filesIncludedFull: included.length,
          filesTruncated: truncated.length,
          filesSkipped: skipped.length,
          totalBytesIncluded: fullFileResults.reduce((sum, file) => sum + file.byteCount, 0),
          selectionReason: fileSelection.reason,
          manifestBlock: inclusionManifest,
        });

        const promptContractBlock = `You have access to the following complete files:\n${
          included.map((file) => `- ${file.filePath} (${file.byteCount} bytes)`).join("\n") || "- none"
        }\n\nIf a file is marked as truncated, its content was cut at the byte limit; reason may be provided.\nIf a file is marked as skipped or not included, you cannot reference its contents.\nNever claim to have seen a file that is not listed in FILES_INCLUSION_MANIFEST.\nIf a user asks you to review/fix a file not in the manifest, say so explicitly.\n\n---`;
        const warningBlock = skipped.length
          ? `\nWARNING: The following requested files could not be included:\n${skipped.map((item) => `- ${item.path} (${item.reason})`).join("\n")}\nAnalysis is based only on available files above.`
          : "";

        personaForGeneration = `${personaForGeneration}\n\n${inclusionManifest}\n\n${promptContractBlock}\n\n${fullFileContents}${warningBlock}`;
      } catch (error) {
        console.error("[Chat API] Full-file injection failed", { requestId, reason: error instanceof Error ? error.message : String(error) });
        personaForGeneration = `${personaForGeneration}\nFull-file injection failed. Repository context may be incomplete.`;
      }
    }
    const shouldRunRepoAudit = shouldAttachSourceContext && shouldRunRepoAuditMode(message);
    if (shouldRunRepoAudit && activeRepoContext && loadedRepoContext) {
      try {
        const visibilityManifest = await getRepoVisibilityManifest(activeRepoContext.id);
        const repoTree = await listRepoTree(activeRepoContext.id);
        const candidateFiles = repoTree.filter((node) => node.kind === "file").map((node) => node.path);
        const accessibleTextFiles = candidateFiles.filter((path) => /\.(ts|tsx|js|jsx|json|md|mjs|cjs|py|go|rs|java|yml|yaml|toml|ini|env|sh|sql)$/i.test(path)).length;
        const discovery = discoverRepoAuditTargets(message, candidateFiles);
        const searchTerms = discovery.searchTerms;
        const fetchErrors: string[] = [];
        const omitted: string[] = [];
        const inspected = new Set<string>();
        const excerpts: string[] = [];
        const prioritizedFiles = discovery.prioritizedPaths;

        for (const term of searchTerms.slice(0, 5)) {
          const results = await searchRepo(activeRepoContext.id, term, { maxResults: 5, maxSnippetLines: 6 });
          for (const result of results.slice(0, 2)) {
            if (excerpts.length >= 12) break;
            inspected.add(result.path);
            try {
              const range = await getRepoFileRange(activeRepoContext.id, result.path, result.lineStart, result.lineEnd + 8);
              excerpts.push(`File: ${result.path}:${range.lineStart}-${range.lineEnd}\n${range.content}`);
            } catch (error) {
              fetchErrors.push(`${result.path}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }

        for (const path of prioritizedFiles) {
          if (excerpts.length >= 12) break;
          if (inspected.has(path)) continue;
          inspected.add(path);
          try {
            const file = await getRepoFile(activeRepoContext.id, path);
            excerpts.push(`File: ${file.path}:${file.lineStart}-${Math.min(file.lineEnd, 200)}\n${file.content.slice(0, 4000)}`);
            if (file.truncated) omitted.push(`${path} truncated to repo file limits`);
          } catch (error) {
            fetchErrors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        if (candidateFiles.length > inspected.size) {
          omitted.push(`${candidateFiles.length - inspected.size} files omitted due to per-turn audit limits`);
        }

        const auditBlock = buildRepoAuditContextBlock({
          manifest: visibilityManifest,
          repoFullName: activeRepoContext.repositoryFullName,
          defaultBranch: loadedRepoContext.defaultBranch || "main",
          totalFilesKnown: candidateFiles.length,
          accessibleTextFiles,
          treeSummary: discovery.treeSummary,
          filesInspected: Array.from(inspected),
          searchTerms,
          fetchErrors,
          omitted,
          excerpts,
        });
        personaForGeneration = `${personaForGeneration}\n\n${auditBlock}`;
      } catch (error) {
        console.error("[Chat API] Repo audit mode failed", {
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

    const collaborationConfig = getCollaborationConfig();
    const collaborationEnabledForRequest = shouldUseAdaptiveCollaboration({
      message,
      intent: resolvedRequestIntent ?? null,
      complexity: resolvedRoutingIntentForReroute?.complexity ?? null,
      hasManualOverride: Boolean(overrideProvider && overrideModel),
      hasVideoInput,
    });

    console.info("[Collaboration] activation", {
      requestId,
      enabled: collaborationEnabledForRequest,
      intent: resolvedRequestIntent ?? null,
      complexity: resolvedRoutingIntentForReroute?.complexity ?? null,
      explicitManualOverride: Boolean(overrideProvider && overrideModel),
    });

    let collaborationRegistrySnapshotPromise:
      | Promise<Map<LlmProvider["name"], RegistryRoutingModel[]>>
      | null = null;
    const getCollaborationRegistrySnapshot = async () => {
      if (!collaborationRegistrySnapshotPromise) {
        collaborationRegistrySnapshotPromise = getRoutingRegistryByProvider(providers).catch((error) => {
          console.warn("[Collaboration] registry snapshot unavailable; helper router will use provider discovery fallback", {
            requestId,
            reason: error instanceof Error ? error.message : String(error),
          });
          return new Map<LlmProvider["name"], RegistryRoutingModel[]>();
        });
      }
      return collaborationRegistrySnapshotPromise;
    };

    const modelTier = inferModelTier(modelId);
    const runtimeContext = buildKatieRuntimeContext({
      provider: provider.name,
      modelId,
      modelTier,
      classifiedIntent: resolvedRequestIntent,
      routingAuthority: intentAuthority === "llm" ? "llm-classifier" : intentAuthority === "override" ? "explicit-preference" : intentAuthority,
      requestId,
    });
    personaForGeneration = replaceKatieRuntimeContext(
      personaForGeneration,
      runtimeContext,
    );
    console.debug("[Chat API] Katie runtime context injected", {
      requestId,
      selectedProvider: provider.name,
      selectedModelId: modelId,
      modelTier,
      classifiedIntent: resolvedRequestIntent ?? "unknown",
      routingAuthority: intentAuthority,
      included: personaForGeneration.includes("KATIE_RUNTIME_CONTEXT:")
    });

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
              degradedContext: repoContextDegraded
                ? {
                    kind: "repository",
                    repository: activeRepoContext?.repositoryFullName ?? null,
                    reason: repoContextDegraded.reason,
                  }
                : null,
              attachmentSummaryForClassifier,
              activeRepoContextAttached,
              routingSignals,
            });

            const startEvent = reasoningState.start();
            emitChunk(startEvent);
            console.log("[Chat API] reasoning_start emitted", { requestId, categories: startEvent.categories });

            console.log("[Chat API] Saving user message...");
            if (!savedAttachments.length && attachments.length) {
              for (const [index, attachment] of attachments.entries()) {
                const saved = await persistConversationAttachment(chatId, attachment, fileReferences?.[index]?.storageToken);
                const observations = await describeVideoEvidence(attachment);
                savedAttachments.push({ ...saved, ...observations });
              }
            }
            personaForGeneration += `\n\n${attachmentAccessContext(attachmentHistory, savedAttachments, unavailableAttachments)}`;
            await saveMessage(chatId, {
              id: crypto.randomUUID(),
              role: "user",
              content: message,
              ...(savedAttachments.length ? { attachments: savedAttachments } : {}),
            });

            console.log(`[Chat API] Requesting generation from ${provider.name} using model ${modelId}...`);
            const enqueueDelta = (delta: string) => {
              // Mobile browsers routinely suspend or drop streaming fetches when
              // the app is backgrounded. A disconnected UI must not cancel the
              // actual model generation: keep consuming the provider stream so
              // the completed assistant response can still be persisted.
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
                secondaryIntents: resolvedRoutingIntentForReroute?.secondaryIntents ?? [],
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
            type GenerationAttempt = {
              provider: LlmProvider;
              modelId: string;
              score?: number;
              explainer?: SelectionExplainer;
              routingSource?: "initial" | "ai-reroute" | "deterministic-fallback";
            };
            const attempts: GenerationAttempt[] = [
              { provider, modelId, explainer: selectionExplainer, routingSource: "initial" },
              ...fallbackChain.map((candidate) => ({
                ...candidate,
                routingSource: "deterministic-fallback" as const
              }))
            ];
            const retryOnProviderRefusal = shouldRetryOnProviderRefusal();
            const refusedCandidates: Array<{ providerName: LlmProvider["name"]; modelId: string }> = [];
            const refusedCandidateKeys = new Set<string>();
            const failedGenerationCandidates: Array<{ providerName: LlmProvider["name"]; modelId: string }> = [];
            const failedGenerationCandidateKeys = new Set<string>();
            const failedProviderNames = new Set<LlmProvider["name"]>();
            const maxRefusalReroutes = 3;
            const maxErrorReroutes = 4;
            let refusalRerouteCount = 0;
            let errorRerouteCount = 0;
            const rerouteHasImages = Array.isArray(images) && images.length > 0;
            const rerouteHasImageAttachments = attachments.some((attachment) => attachment.mimeType.startsWith("image/"));
            const rerouteHasVisualInput = rerouteHasImages || rerouteHasImageAttachments;
            const rerouteRoutingContext = [
              controlPlaneConversationContext,
              `Refusal reroute has visual input: ${rerouteHasVisualInput}`
            ].join("\n");

            // Keep completed evidence through both provider errors and refusal reroutes.
            let collaborationResumeState: CollaborationResumeState | undefined;
            const generationAttempt = await runWithRefusalFallback<GenerationAttempt>({
              attempts,
              shouldRetryRefusal: retryOnProviderRefusal,
              runAttempt: async (candidate, attemptIndex) => {
                provider = candidate.provider;
                modelId = candidate.modelId;
                if (candidate.explainer) {
                  selectionExplainer = candidate.explainer;
                }

                if (attemptIndex > 0) {
                  emitChunk({
                    type: "metadata",
                    modelId,
                    provider: provider.name,
                    explainer: candidate.explainer,
                    resetText: true
                  });
                }

                const candidateRuntimeContext = buildKatieRuntimeContext({
                  provider: provider.name,
                  modelId,
                  modelTier: inferModelTier(modelId),
                  classifiedIntent: resolvedRequestIntent,
                  routingAuthority: intentAuthority === "llm" ? "llm-classifier" : intentAuthority === "override" ? "explicit-preference" : intentAuthority,
                  requestId,
                });
                const baseParams = createParams(modelId);
                const finalParams = {
                  ...baseParams,
                  persona: replaceKatieRuntimeContext(
                    baseParams.persona,
                    candidateRuntimeContext,
                  ),
                };
                const finalPayloadPreview = finalParams.persona.slice(0, 120).replace(/\s+/g, " ");
                console.log("[Chat API] FINAL provider payload contains KATIE_RUNTIME_CONTEXT?", {
                  included: finalParams.persona.includes("KATIE_RUNTIME_CONTEXT:"),
                  provider: provider.name,
                  modelId,
                  requestId,
                  preview: finalPayloadPreview
                });

                const suppressCalculationScaffolding = shouldSuppressCalculationScaffolding(
                  message,
                  resolvedRequestIntent
                );

                const generation = collaborationEnabledForRequest
                  ? await (async () => {
                      const collaborationBaseParams = baseParams;
                      const collaboration = await runAdaptiveCollaboration({
                        requestId,
                        leadProvider: provider,
                        leadModelId: modelId,
                        providers,
                        params: collaborationBaseParams,
                        resumeState: collaborationResumeState,
                        onCheckpoint: (state) => { collaborationResumeState = state; },
                        prepareParticipantParams: (participantParams, participantValue) => {
                          const participantRuntimeContext = buildKatieRuntimeContext({
                            provider: participantValue.provider,
                            modelId: participantValue.modelId,
                            modelTier: inferModelTier(participantValue.modelId),
                            classifiedIntent: resolvedRequestIntent,
                            routingAuthority:
                              intentAuthority === "llm"
                                ? "llm-classifier"
                                : intentAuthority === "override"
                                  ? "explicit-preference"
                                  : intentAuthority,
                            requestId,
                          });
                          return {
                            ...participantParams,
                            persona: replaceKatieRuntimeContext(
                              participantParams.persona,
                              participantRuntimeContext,
                            ),
                          };
                        },
                        selectHelper: async (context) => {
                          const registrySnapshot = await getCollaborationRegistrySnapshot();
                          const attachmentCompatibleProviders = providers.filter(
                            (candidateProvider) =>
                              !failedProviderNames.has(candidateProvider.name) &&
                              getAttachmentSupportForProvider(
                                candidateProvider.name,
                                attachments,
                              ).supported,
                          );
                          return selectCollaborationHelper({
                            requestId: context.requestId,
                            request: context.request,
                            requester: context.requester,
                            providers: attachmentCompatibleProviders,
                            usedParticipants: context.usedParticipants,
                            modelRegistrySnapshot: registrySnapshot,
                            actorId,
                            actorRoutingProfile,
                            hasImages: Boolean(context.hasImages || (Array.isArray(images) && images.length > 0)),
                            hasVideoInput,
                          });
                        },
                        selectReplacementLead: async (context) => {
                          failedProviderNames.add(context.failedLead.provider);
                          await recordSharedProviderFailure(
                            context.failedLead.provider,
                            context.error,
                          );
                          const registrySnapshot = await getCollaborationRegistrySnapshot();
                          const healthyProviders = filterHealthyProviders(
                            providers.filter(
                              (candidateProvider) =>
                                getAttachmentSupportForProvider(
                                  candidateProvider.name,
                                  attachments,
                                ).supported,
                            ),
                            failedProviderNames,
                            context.failedLead.provider,
                          );

                          const capability =
                            resolvedRequestIntent === "architecture-review"
                              ? "architecture"
                              : resolvedRequestIntent === "technical-debugging"
                                ? "debugging"
                                : resolvedRequestIntent === "code-review" ||
                                    resolvedRequestIntent === "code-generation"
                                  ? "coding"
                                  : resolvedRequestIntent === "web-search"
                                    ? "research"
                                    : resolvedRequestIntent === "multimodal-reasoning" ||
                                        resolvedRequestIntent === "vision-analysis"
                                      ? "vision"
                                      : "analysis";

                          return selectCollaborationHelper({
                            requestId: `${context.requestId}:replacement-lead`,
                            request: {
                              task: "Synthesize the final answer to the original user request using the completed collaboration evidence. Do not redo completed helper work.",
                              capability,
                              reason:
                                "The previous lead failed during control or final synthesis. Preserve completed helper work and finish with a healthy replacement lead.",
                            },
                            requester: context.failedLead,
                            providers: healthyProviders,
                            usedParticipants: context.usedParticipants,
                            modelRegistrySnapshot: registrySnapshot,
                            actorId,
                            actorRoutingProfile,
                            hasImages: context.hasImages,
                            hasVideoInput,
                          });
                        },
                        onTrace: async (event: CollaborationTraceEvent) => {
                          console.info("[Collaboration] event", event);
                          emitChunk({
                            type: "metadata",
                            modelId,
                            provider: provider.name,
                            explainer: selectionExplainer,
                            collaborationEvent: {
                              type: event.type,
                              capability: event.capability,
                              delegationIndex: event.delegationIndex,
                              depth: event.depth,
                              requester: event.requester,
                              helper: event.helper,
                              taskPreview: event.taskPreview,
                              detail: event.detail,
                              durationMs: event.durationMs,
                            },
                          });
                        },
                        onFinalTextDelta: suppressCalculationScaffolding
                          ? async () => {}
                          : async (delta) => enqueueDelta(delta),
                        maxDelegations: collaborationConfig.maxDelegations,
                        maxDepth: collaborationConfig.maxDepth,
                        maxContributionChars: collaborationConfig.maxContributionChars,
                        maxTotalContributionChars: collaborationConfig.maxTotalContributionChars,
                        participantTimeoutMs: collaborationConfig.participantTimeoutMs,
                        researchTimeoutMs: collaborationConfig.researchTimeoutMs,
                        maxTotalDurationMs: collaborationConfig.maxTotalDurationMs,
                      });

                      emitChunk({
                        type: "metadata",
                        modelId: collaboration.result.model,
                        provider: collaboration.result.provider,
                        explainer: selectionExplainer,
                        collaboration: collaboration.metadata,
                      });

                      return {
                        result: collaboration.result,
                        streamedText: collaboration.streamedText,
                      };
                    })()
                  : await (async () => {
                      const capabilityEscalation =
                        await runOnDemandCapabilityEscalation({
                          requestId,
                          leadProvider: provider,
                          leadModelId: modelId,
                          params: finalParams,
                          prepareParticipantParams: (
                            participantParams,
                            participantValue,
                          ) => {
                            const participantRuntimeContext =
                              buildKatieRuntimeContext({
                                provider: participantValue.provider,
                                modelId: participantValue.modelId,
                                modelTier: inferModelTier(
                                  participantValue.modelId,
                                ),
                                classifiedIntent: resolvedRequestIntent,
                                routingAuthority:
                                  intentAuthority === "llm"
                                    ? "llm-classifier"
                                    : intentAuthority === "override"
                                      ? "explicit-preference"
                                      : intentAuthority,
                                requestId,
                              });
                            return {
                              ...participantParams,
                              persona: replaceKatieRuntimeContext(
                                participantParams.persona,
                                participantRuntimeContext,
                              ),
                            };
                          },
                          selectHelper: async (context) => {
                            const registrySnapshot =
                              await getCollaborationRegistrySnapshot();
                            const attachmentCompatibleProviders =
                              providers.filter(
                                (candidateProvider) =>
                                  !failedProviderNames.has(
                                    candidateProvider.name,
                                  ) &&
                                  getAttachmentSupportForProvider(
                                    candidateProvider.name,
                                    attachments,
                                  ).supported,
                              );

                            return selectCollaborationHelper({
                              requestId: context.requestId,
                              request: context.request,
                              requester: context.requester,
                              providers: attachmentCompatibleProviders,
                              usedParticipants: context.usedParticipants,
                              modelRegistrySnapshot: registrySnapshot,
                              actorId,
                              actorRoutingProfile,
                              hasImages:
                                Boolean(context.hasImages || (Array.isArray(images) && images.length > 0)),
                              hasVideoInput,
                            });
                          },
                          onTrace: async (event: CollaborationTraceEvent) => {
                            console.info(
                              "[CapabilityEscalation] event",
                              event,
                            );
                            emitChunk({
                              type: "metadata",
                              modelId,
                              provider: provider.name,
                              explainer: selectionExplainer,
                              collaborationEvent: {
                                type: event.type,
                                capability: event.capability,
                                delegationIndex: event.delegationIndex,
                                depth: event.depth,
                                requester: event.requester,
                                helper: event.helper,
                                taskPreview: event.taskPreview,
                                detail: event.detail,
                                durationMs: event.durationMs,
                              },
                            });
                          },
                          onFinalTextDelta: suppressCalculationScaffolding
                            ? async () => {}
                            : async (delta) => enqueueDelta(delta),
                          maxEscalations: 2,
                        });

                      if (capabilityEscalation.metadata) {
                        emitChunk({
                          type: "metadata",
                          modelId: capabilityEscalation.result.model,
                          provider: capabilityEscalation.result.provider,
                          explainer: selectionExplainer,
                          collaboration:
                            capabilityEscalation.metadata,
                        });
                      }

                      return {
                        result: capabilityEscalation.result,
                        streamedText:
                          capabilityEscalation.streamedText,
                      };
                    })();

                const rawText = generation.result.text || generation.streamedText;
                const cleanedText = suppressCalculationScaffolding
                  ? sanitizeCalculationResponse(rawText)
                  : rawText;

                if (suppressCalculationScaffolding && cleanedText !== rawText) {
                  console.info("[Chat API] Removed calculation scratch scaffolding from model response.", {
                    requestId,
                    provider: provider.name,
                    modelId
                  });
                }

                streamedText = cleanedText;
                return {
                  ...generation.result,
                  text: cleanedText
                };
              },
              detectRefusal: (generationResult, candidate) => isLikelyProviderRefusal(generationResult, candidate.provider.name),
              rerouteOnRefusal: async ({ attempt }) => {
                if (!resolvedRoutingIntentForReroute || refusalRerouteCount >= maxRefusalReroutes) {
                  return null;
                }

                const failedKey = `${attempt.provider.name}:${attempt.modelId.trim().toLowerCase()}`;
                if (!refusedCandidateKeys.has(failedKey)) {
                  refusedCandidateKeys.add(failedKey);
                  refusedCandidates.push({
                    providerName: attempt.provider.name,
                    modelId: attempt.modelId
                  });
                }

                refusalRerouteCount += 1;
                const rerouteDecision = await chooseProvider(message, rerouteRoutingContext, providers, {
                  hasImages: rerouteHasVisualInput,
                  hasVideoInput,
                  actorId,
                  actorRoutingProfile,
                  routingHints,
                  routingTraceEnabled,
                  routingRequestId: `${requestId}:refusal-reroute-${refusalRerouteCount}`,
                  resolvedIntent: {
                    ...resolvedRoutingIntentForReroute,
                    intentSource: "upstream"
                  },
                  excludedCandidates: refusedCandidates,
                  rerouteContext: {
                    reason: "provider-refusal",
                    failed_candidates: refusedCandidates.map((candidate) => ({
                      provider: candidate.providerName,
                      model: candidate.modelId
                    }))
                  }
                });

                if (rerouteDecision.explainer?.selected_source !== "llm-primary") {
                  console.warn("[Chat API] AI refusal reroute unavailable; deterministic fallback will be used.", {
                    requestId,
                    refusedCandidates,
                    fallbackReason: rerouteDecision.explainer?.fallback_reason ?? "router-not-llm-primary"
                  });
                  return null;
                }

                resolvedRoutingIntentForReroute = rerouteDecision.resolvedIntent;
                resolvedRequestIntent = rerouteDecision.resolvedIntent.intent;
                intentAuthority = rerouteDecision.authority ?? intentAuthority;
                intentResolutionReason = rerouteDecision.intentResolutionReason ?? intentResolutionReason;

                return {
                  provider: rerouteDecision.provider,
                  modelId: rerouteDecision.modelId,
                  explainer: rerouteDecision.explainer,
                  routingSource: "ai-reroute"
                };
              },
              onRefusalReroute: ({ attempt, reroutedAttempt }) => {
                console.warn("[Chat API] Provider refusal detected. AI router selected a new candidate.", {
                  requestId,
                  refusedProvider: attempt.provider.name,
                  refusedModelId: attempt.modelId,
                  reroutedProvider: reroutedAttempt.provider.name,
                  reroutedModelId: reroutedAttempt.modelId
                });
              },
              onRefusalFallback: ({ attempt, nextAttempt }) => {
                console.warn("[Chat API] Provider refusal detected. AI reroute unavailable; attempting deterministic fallback candidate.", {
                  requestId,
                  provider: attempt.provider.name,
                  modelId: attempt.modelId,
                  nextProvider: nextAttempt.provider.name,
                  nextModelId: nextAttempt.modelId
                });
              },
              onRerouteError: ({ attempt, error }) => {
                console.warn("[Chat API] AI refusal reroute failed; deterministic fallback remains available.", {
                  requestId,
                  provider: attempt.provider.name,
                  modelId: attempt.modelId,
                  reason: error instanceof Error ? error.message : String(error)
                });
              },
              rerouteOnError: async ({ attempt, error }) => {
                if (!resolvedRoutingIntentForReroute || errorRerouteCount >= maxErrorReroutes) {
                  return null;
                }

                const failedKey = `${attempt.provider.name}:${attempt.modelId.trim().toLowerCase()}`;
                if (!failedGenerationCandidateKeys.has(failedKey)) {
                  failedGenerationCandidateKeys.add(failedKey);
                  failedGenerationCandidates.push({
                    providerName: attempt.provider.name,
                    modelId: attempt.modelId,
                  });
                }

                const failureScope = classifyGenerationFailure(error);
                if (failureScope === "provider") {
                  failedProviderNames.add(attempt.provider.name);
                }

                errorRerouteCount += 1;
                const healthyProviders = filterHealthyProviders(
                  providers,
                  failedProviderNames,
                  attempt.provider.name,
                );
                const excludedCandidates = [
                  ...refusedCandidates,
                  ...failedGenerationCandidates,
                ];

                if (healthyProviders.length === 0) {
                  return null;
                }

                const rerouteDecision = await chooseProvider(
                  message,
                  [
                    rerouteRoutingContext,
                    `Generation failure: ${describeGenerationFailure(error)}`,
                    `Failed provider scope: ${failureScope}`,
                  ].join("\n"),
                  healthyProviders,
                  {
                    hasImages: rerouteHasVisualInput,
                    hasVideoInput,
                    actorId,
                    actorRoutingProfile,
                    routingHints,
                    routingTraceEnabled,
                    routingRequestId: `${requestId}:error-reroute-${errorRerouteCount}`,
                    resolvedIntent: {
                      ...resolvedRoutingIntentForReroute,
                      intentSource: "upstream",
                    },
                    excludedCandidates,
                    rerouteContext: {
                      reason: "provider-error",
                      failed_candidates: excludedCandidates.map((candidate) => ({
                        provider: candidate.providerName,
                        model: candidate.modelId,
                      })),
                    },
                  },
                );

                resolvedRoutingIntentForReroute = rerouteDecision.resolvedIntent;
                resolvedRequestIntent = rerouteDecision.resolvedIntent.intent;
                intentAuthority = rerouteDecision.authority ?? intentAuthority;
                intentResolutionReason =
                  rerouteDecision.intentResolutionReason ?? intentResolutionReason;

                return {
                  provider: rerouteDecision.provider,
                  modelId: rerouteDecision.modelId,
                  explainer: rerouteDecision.explainer,
                  routingSource: "ai-reroute",
                };
              },
              onErrorReroute: ({ attempt, reroutedAttempt, error }) => {
                console.warn("[Chat API] Generation error rerouted to a new provider/model.", {
                  requestId,
                  failedProvider: attempt.provider.name,
                  failedModelId: attempt.modelId,
                  failureScope: classifyGenerationFailure(error),
                  failureSummary: describeGenerationFailure(error),
                  reroutedProvider: reroutedAttempt.provider.name,
                  reroutedModelId: reroutedAttempt.modelId,
                });
                emitChunk({
                  type: "metadata",
                  modelId: reroutedAttempt.modelId,
                  provider: reroutedAttempt.provider.name,
                  explainer: reroutedAttempt.explainer,
                  resetText: true,
                  providerFailover: {
                    from: {
                      provider: attempt.provider.name,
                      modelId: attempt.modelId,
                    },
                    to: {
                      provider: reroutedAttempt.provider.name,
                      modelId: reroutedAttempt.modelId,
                    },
                    reason: describeGenerationFailure(error),
                  },
                });
              },
              onError: ({ attempt, error }) => {
                const failureScope = classifyGenerationFailure(error);
                if (failureScope === "provider") {
                  failedProviderNames.add(attempt.provider.name);
                  void recordSharedProviderFailure(attempt.provider.name, error);
                }
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

            if ((result.continuationCount ?? 0) > 0 || result.truncated) {
              console.warn("[Chat API] Provider output continuation metadata", {
                requestId,
                provider: result.provider,
                model: result.model,
                finishReason: result.finishReason ?? null,
                continuationCount: result.continuationCount ?? 0,
                truncated: result.truncated ?? false
              });
              emitChunk({
                type: "metadata",
                provider: result.provider,
                modelId: result.model,
                finishReason: result.finishReason,
                continuationCount: result.continuationCount ?? 0,
                truncated: result.truncated ?? false
              });
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
            const assistantMessageId = crypto.randomUUID();
            await saveMessage(chatId, {
              id: assistantMessageId,
              role: "assistant",
              model: result.model,
              content: assistantText,
              assets: imageAssets,
            });
            if (requestTracked) {
              await completeChatRequest(requestId, {
                assistantMessageId,
                assistantModel: result.model,
                assistantContent: assistantText,
                assistantAssets: imageAssets,
              });
            }
            await refreshShortTermMemory(actorId, chatId);

            console.log("[Chat API] Memory persistence start", { actorId, chatId });
            const memoryResults = await Promise.allSettled([
              maybeUpdateLongTermMemory(actorId, chatId, message),
              maybeUpdateSummary(chatId),
            ]);
            memoryResults.forEach((memoryResult, index) => {
              if (memoryResult.status === "rejected") {
                console.error(
                  index === 0
                    ? "[Chat API] Long-Term Memory Update Error:"
                    : "[Chat API] Intermediate Memory Update Error:",
                  memoryResult.reason,
                );
              }
            });
            console.log("[Chat API] Memory persistence complete", { actorId, chatId });
            console.log("[Chat API] reasoning stream metrics", {
              requestId,
              reasoningUpdateCount,
              timeToFirstReasoningUpdateMs: firstReasoningUpdateAtMs === null ? null : firstReasoningUpdateAtMs - requestStartedAtMs,
              timeToFinalAnswerMs: Date.now() - requestStartedAtMs
            });

            if (!streamCancelled) {
              controller.close();
            } else {
              console.log("[Chat API] generation completed after client disconnect", {
                requestId,
                chatId,
                provider: result.provider,
                model: result.model,
                responseLength: assistantText.length
              });
            }
          } catch (error: unknown) {
            console.error("[Chat API] Stream Runtime Error:", error);
            const message = error instanceof Error ? error.message : "Unknown stream error";
            if (requestTracked) {
              await failChatRequest(requestId, error);
            }
            emitChunk(reasoningState.error(message, true));
            console.error("[Chat API] reasoning stream error", { requestId, message, streamCancelled });
            if (!streamCancelled) {
              controller.error(error);
            }
          }
        })();
      },
      cancel() {
        streamCancelled = true;
        console.log("[Chat API] client stream disconnected; generation will continue for persistence", {
          requestId,
          chatId
        });
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
    if (trackedRequestId) {
      await failChatRequest(trackedRequestId, error);
    }

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
