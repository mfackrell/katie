import {projectForChat} from '@/lib/projects/store';
import {loadFullBenchmarkBinding} from '../../../scripts/benchmark/full-project-gate.mjs';
import { isExplicitKatieSelfInspectionRequest } from "@/lib/tools/self-inspection-intent";
import { PresentationStreamFilter, parsePresentationTail, PRESENTATION_GENERATION_GUIDANCE } from "@/lib/presentation/stream-protocol";
import { quarantineUnavailableModel } from "@/lib/models/registry";
import { runSelfInspection } from "@/lib/tools/self-inspection";
import { authorizeSelfToolCaller } from "@/lib/tools/authorization";
import {handleProjectChat, startProjectIntent, gameProjectIntent, followupProjectIntent, isProjectStopIntent} from '@/lib/developer/project-conversation';
import {executeExecutiveCommand} from '@/lib/executive/transport';
import { maskPdfSourceNames, pdfPageTaskForSource } from "@/lib/uploads/pdf-inventory";
import { pdfSourceOccurrence, selectFreshPdfSources, selectPdfEvidenceSource } from "@/lib/chat/pdf-source-selection";
import { inspectSavedPdf } from "@/lib/uploads/stored-uploads";
import { agentRpc, refreshTask } from "@/lib/agents/store";
import { authorizeManagedChat } from "@/lib/agents/runtime";
import { loadTaskHandoffEvidence } from "@/lib/agents/task-handoff";
import { runAgentTask, currentAgentTask } from "@/lib/agents/policy";
import { timelineIntent, resolveTimelineSource } from "@/lib/video-timeline/intent";
import { runVideoTimeline } from "@/lib/video-timeline/service";
import { hasUploadDateReference, memoryIntent } from "@/lib/media-memory/evidence";
import { retrySavedEvidence, savedOriginalExists } from "@/lib/uploads/stored-uploads";
import { buildVideoTimingEvidence, appendVideoEvidenceToUser, buildVideoAssessmentUser } from "@/lib/chat/video-evidence";
import { registerVideoTiming, getVideoTiming } from "@/lib/uploads/video-timing";
import { runRequiredDraftReview, REQUIRED_REVIEW_RESERVE_MS } from "@/lib/collaboration/required-review";
import { shouldEnableActorCollaboration } from "@/lib/collaboration/review-mode";
import { finishChatFailure } from "@/lib/chat/request-failure";
import { websiteEvidenceStore } from "@/lib/research/stored-evidence";
import { explicitlyReferencesAttachment, attachmentAccessContext, type ConversationAttachment } from "@/lib/chat/attachment-continuity";
import { persistConversationAttachment, restoreConversationAttachment, loadConversationAttachmentCatalog, loadActorAttachmentCatalog, recoverSavedVideoFrames, recoverUploadVideoFrames } from "@/lib/uploads/stored-uploads";
import { describeAttachmentEvidence } from "@/lib/uploads/attachment-observations";
import { submitSavedVideo, resultStore } from "@/lib/runpod/durable-results";
import { pendingVideoMessage } from "@/lib/runpod/video-orchestration";
import { RUNPOD_VIDEO_MODEL } from "@/lib/runpod/durable-results";
import { buildImageReference, imageFileFromDataUrl } from "@/lib/uploads/image-reference";
import { selectStoredAttachments, loadSelectedAttachmentSources, explicitlyRequestsVideo, type AttachmentDecision } from "@/lib/chat/attachment-selection";
import { loadSavedVideoFollowUp, retrieveSavedEvidence } from "@/lib/agents/media";
import { pruneRepeatedVideoSelections, uniqueAttachmentReferences } from "@/lib/chat/video-attachment-dedup";
import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assembleContext } from "@/lib/memory/assemble-context";
import { loadVisualContinuity, storeVisualAnchor, verifyVisualContinuity } from "@/lib/chat/visual-continuity";
import { maybeUpdateSummary } from "@/lib/memory/summarizer";
import { maybeUpdateLongTermMemory } from "@/lib/memory/long-term-editor";
import { maybeRunThirtyMessageCleanup } from "@/lib/memory/long-term-maintenance";
import { getChatById, listChatsByActorId, getMessages, getRecentMessages, saveMessage, getMessageById } from "@/lib/data/persistence-store";
import {
  claimChatRequest,
  completeChatRequest,
  failChatRequest,
  fingerprintChatRequest,
} from "@/lib/chat/request-idempotency";
import { refreshShortTermMemory } from "@/lib/memory/short-term";
import { resolveLocalKatieResponse } from "@/lib/chat/local-katie";
import { handleExplicitMemoryMutation } from "@/lib/memory/explicit-memory";
import { saveProviderSystemAudit } from "@/lib/chat/provider-system-audit";
import { maintainMemoryArchitecture } from "@/lib/memory/hygiene";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import { getAvailableProviders } from "@/lib/providers";
import { selectVideoReplyTarget, generateContextualVideoReply, buildContextualVideoReplyPrompt } from "@/lib/chat/video-response";
import { validateManualOverrideWithRecovery } from "@/lib/chat/manual-override-recovery";
import { chooseProvider, selectControlPlaneDecisionModels } from "@/lib/router/master-router";
import {
  detectWebSearchSignals,
  inferRequestClassification,
  resolveProjectTransition,
  RequestIntent,
  RoutingHint
} from "@/lib/router/model-intent";

import { LlmProvider, ProviderResponse } from "@/lib/providers/types";
import { buildReviewResumptionContext, candidateForVerification, isSavedDraftVerificationRetry, savedDraftReviewTask } from "@/lib/collaboration/review-completion";
import { getPendingReviewClarification, resolvePendingReviewClarification } from "@/lib/chat/review-continuity";
import { bindPendingReviewClarification } from "@/lib/chat/review-continuity";
import { classifyUserTurn, applyAssistantToTaskProgress, applyUserToTaskProgress, formatTaskProgress, syncTaskProgress, mergeTaskProjects, taskProjectCatalog } from "@/lib/chat/task-progress";
import { loadTaskProgress, saveTaskProgress, loadActorTaskProjects } from "@/lib/chat/task-progress-store";
import { buildReviewSourceTurns } from "@/lib/chat/review-sources";
import { decideResponsePolicy, shouldEscalateConversationResponse } from "@/lib/chat/response-policy";
import type { ResolvedRoutingIntent, SelectionExplainer } from "@/lib/router/master-router";
import { DEFAULT_REASONING_CATEGORIES, ReasoningStateAccumulator } from "@/lib/chat/reasoning-stream";
import {
  isCreativeNarrativeTurn,
  preferredClaudeCreativeModel,
  CREATIVE_CONTINUITY_INSTRUCTIONS,
  CREATIVE_REWRITE_INSTRUCTIONS,
  improveCreativeOriginality,
} from "@/lib/chat/creative-continuity";
import { isLikelyProviderRefusal, runWithRefusalFallback, shouldRetryOnProviderRefusal } from "@/lib/router/refusal-detection";
import { generateRunpodImage, runpodImageConfigured, shouldTryRunpodImage, isModerationImageFailure, type ImageProviderFailure } from "@/lib/chat/runpod-image-fallback";
import {
  classifyGenerationFailure,
  describeGenerationFailure,
  getProviderErrorDiagnostics,
  filterHealthyProviders,
} from "@/lib/router/provider-error";
import {
  filterProvidersBySharedHealth,
  recordSharedProviderFailure,
} from "@/lib/router/provider-health";
import {
  getAttachmentSupportForProvider,
  isVideoAttachment,
  requiresGoogleFileSource,
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
  attachments,
  onProviderSystemPrepared
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
  onProviderSystemPrepared?: (audit: import("@/lib/providers/types").ProviderSystemAudit) => Promise<void>;
}) {
  return {
    name,
    persona: `${persona}\n\nCURRENT_REQUEST_TIMESTAMP_UTC: ${new Date().toISOString()}`,
    summary,
    history,
    user: message,
    requestIntent,
    secondaryIntents,
    images,
    modelId,
    attachments,
    onProviderSystemPrepared
  };
}

async function parseIncomingPayload(request: Request): Promise<RequestPayload> {
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
  try {
    let payload: RequestPayload;
    try { payload = await parseIncomingPayload(request.clone()); }
    catch { return executeChat(request); }
    // A database-owned EO identity is the only way into management mode.
    // Intercept BEFORE attachments, memory, model collaboration, and ordinary chat.
    const {data:actorRole,error:actorRoleError}=await getSupabaseAdminClient()
      .from('actors').select('actor_kind').eq('id',payload.actorId).maybeSingle<{actor_kind:string}>();
    if(actorRoleError||!actorRole)return NextResponse.json({error:'Actor identity unavailable'},{status:503});
    if(actorRole.actor_kind==='executive')return executeExecutiveCommand(payload,request);
    const task = await authorizeManagedChat(request, payload);
    if (task) {
      const claimed = await agentRpc<boolean>("claim_agent_execution", { p_id: task.id, p_request: task.request_id });
      if (!claimed) {
        const saved = await refreshTask(task.id);
        return NextResponse.json({ task: saved, status: saved.status, requestId: task.request_id }, { status: 202 });
      }
    }
    const response = await runAgentTask(task, () => executeChat(request));
    if (task && !response.ok) {
      const { error } = await getSupabaseAdminClient().from("agent_tasks").eq("id", task.id).eq("request_id", task.request_id).update({ status: "failed", details: "Execution was rejected before streaming. Continue the saved task to retry.", updated_at: new Date().toISOString() });
      if (error) throw new Error("Task failure status could not be persisted");
    }
    return response;
  } catch {
    return NextResponse.json({ error: "Task configuration or permissions denied. Check the saved task and request ID." }, { status: 403 });
  }
}

async function executeChat(request: NextRequest) {
  const executionDeadlineMs = Date.now() + (maxDuration - 30) * 1_000;
  let trackedRequestId: string | null = null;
  try {
    const payload = await parseIncomingPayload(request);
    const {
      actorId,
      chatId,
      message,
      images: requestImages,
      fileReferences,
      overrideProvider,
      overrideModel,
      routingTraceEnabled,
      activeRepoId,
      repoInjectionEnabled: repoInjectionEnabledFromPayload,
    } = payload;
    const currentChat = await getChatById(chatId);
    if (!currentChat || currentChat.actorId !== actorId) return NextResponse.json({ error: "Chat does not belong to this actor." }, { status: 404 });
    const benchmarkIntake = !currentAgentTask() && startProjectIntent(message) && gameProjectIntent(message) &&
      /take eleven|issue\s*#?715|#715/i.test(message) &&
      ['https://iytvavgbaainnsrecmcx.supabase.co','https://barclcqataqyvifoeyop.supabase.co']
        .includes((process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, ''));
    const savedBenchmarkProject = !currentAgentTask() ? await projectForChat(actorId,chatId) : null;
    const benchmarkBinding = savedBenchmarkProject
      ? await loadFullBenchmarkBinding(getSupabaseAdminClient(),savedBenchmarkProject.id,process.env) : null;
    const benchmarkRelay = benchmarkIntake || Boolean(benchmarkBinding);
    if (benchmarkRelay && (fileReferences?.length || requestImages?.length))
      return NextResponse.json({error:'The frozen Take Eleven benchmark accepts its approved text requirements only. Attachments cannot enter an unmetered classification path.'},{status:400});
    const repoInjectionEnabled = currentAgentTask() ? false : repoInjectionEnabledFromPayload !== false;
    // Resolve Katie's own repository before either project control or model routing.
    // This does not grant new credentials: writes remain in the existing
    // audited project/developer workflow with its approval and verification.
    const selfInspectionRequest = isExplicitKatieSelfInspectionRequest(message);
    let selfRepoId: string | null = null;
    const selfToolRequest = selfInspectionRequest;
    const selfToolActor = selfToolRequest && !currentAgentTask()
      ? await getSupabaseAdminClient().from("actors").select("name,actor_kind").eq("id", actorId).maybeSingle<{name:string;actor_kind:string}>()
      : null;
    // Display names are editable and must never grant self-management access.
    const selfToolsEnabled = Boolean(process.env.KATIE_SELF_ACTOR_ID) &&
      actorId === process.env.KATIE_SELF_ACTOR_ID &&
      selfToolActor?.data?.actor_kind === "standard";
    if (selfToolsEnabled) {
      try { await authorizeSelfToolCaller(request, actorId, chatId); }
      catch { return NextResponse.json({ error: "Self-tool caller authorization denied. An authenticated owner grant and server-bound Katie identity are required." }, { status: 403 }); }
    }

    let ownSourceInspectionAuthorized = false;
    if (selfInspectionRequest && !currentAgentTask()) {
      const admin = getSupabaseAdminClient();
      const {data: selfActor} = await admin.from("actors").select("name,actor_kind").eq("id",actorId).maybeSingle<{name:string;actor_kind:string}>();
      if (selfActor?.name?.trim().toLowerCase() === "katie" && selfActor.actor_kind === "standard") {
        ownSourceInspectionAuthorized = true;
      }
      if (ownSourceInspectionAuthorized && !activeRepoId) {
        const {data: ownRepo} = await admin.from("repo_sync_runs")
          .select("id").eq("repository_full_name","mfackrell/katie")
          .order("created_at",{ascending:false}).limit(1).maybeSingle<{id:string}>();
        selfRepoId = ownRepo?.id ?? null;
      }
    }
    const effectiveRepoId = activeRepoId ?? selfRepoId;
    const newAttachments = await hydrateStoredAttachments(fileReferences ?? []);
    const legacyImageSources = new Map<string, File>();
    for (const image of requestImages ?? []) {
      const file = imageFileFromDataUrl(image);
      const reference = await buildImageReference(file);
      newAttachments.push(reference);
      legacyImageSources.set(reference.fileId, file);
    }
    if (newAttachments.length > 5) return NextResponse.json({ error: "Attach up to five files per message." }, { status: 400 });
    const attachmentHistory = await getRecentMessages(chatId, 60);
    const catalog = benchmarkRelay || currentAgentTask()?.snapshot.attachments === false ? [] : await loadActorAttachmentCatalog(actorId, async () => {
      const actorChats = await listChatsByActorId(actorId);
      const ownedChatIds = new Set(actorChats.map(chat => chat.id));
      const files: ConversationAttachment[] = [];
      for (const chat of actorChats) {
        const entries = await loadConversationAttachmentCatalog(chat.id, async () => {
          const firstSeen = new Map<string, ConversationAttachment>();
          for (const item of await getMessages(chat.id)) for (const file of item.attachments ?? []) {
            if (!firstSeen.has(file.id)) firstSeen.set(file.id, { ...file, chatId: file.chatId ?? chat.id, actorId, createdAt: file.createdAt ?? item.createdAt });
          }
          return [...firstSeen.values()].filter(file => ownedChatIds.has(file.chatId!));
        });
        files.push(...entries.map(file => ({ ...file, chatId: file.chatId ?? chat.id, actorId })).filter(file => ownedChatIds.has(file.chatId)));
      }
      return files;
    });
    const temporalIntent = timelineIntent(message);
    const freshVideoReferences = newAttachments.filter(file => file.mimeType.startsWith("video/"));
    const timelineSelection = temporalIntent
      ? resolveTimelineSource(message, newAttachments.map(file => ({id: file.fileId, fileName: file.fileName, mimeType: file.mimeType, chatId})), catalog, attachmentHistory) : {};
    const timelineActive = Boolean(temporalIntent && (freshVideoReferences.length || timelineSelection.source || timelineSelection.clarification));
    let timelineContext = "";
    // A question about the video from the preceding conversation should use
    // the authoritative, already-saved RunPod/Grok observations in Supabase.
    // Do not reattach/redecode an MP4, ask which video, or consult the LLM
    // attachment selector until the contextual evidence lookup has run.
    if (!currentAgentTask()) await retrySavedEvidence(actorId, async id => (await getChatById(id))?.actorId === actorId, catalog)
      .catch(() => console.warn("[Media memory] retry unavailable"));
    try {
      const recovered = currentAgentTask() ? { error: null } : await getSupabaseAdminClient().rpc("reconcile_media_video", {p_actor: actorId, p_current_chat: chatId});
      if (recovered.error) console.warn("[Media memory] video recovery unavailable");
    } catch { console.warn("[Media memory] video recovery unavailable"); }
    // Source restoration precedes model classification. Require the same
    // durable task/question binding as review resumption before borrowing scope.
    const taskProgressUserMessageId = crypto.randomUUID();
    const taskProgressAssistantMessageId = crypto.randomUUID();
    const priorTaskProgress = mergeTaskProjects(
      syncTaskProgress(await loadTaskProgress(actorId, chatId), attachmentHistory),
      currentAgentTask() ? [] : await loadActorTaskProjects(actorId),
    );
    // Resolve task identity from firsthand text BEFORE historical files can
    // influence routing. The later model router cannot silently replace it.
    let contextClassification: Awaited<ReturnType<typeof inferRequestClassification>> | undefined;
    const contextProjects = taskProjectCatalog(priorTaskProgress);
    // Apply PDF source authorization before even task-identity classification:
    // retained/excluded files are not evidence for any model on this turn.
    const taskIdentityPdfSelection = selectFreshPdfSources(message, newAttachments, timelineActive, catalog);
    const identitySourceAllowed = (file: (typeof newAttachments)[number]) => file.mimeType !== "application/pdf" ||
      Boolean(taskIdentityPdfSelection?.fileIds.has(file.fileId));
    const freshTaskDescriptions = new Map<string, Awaited<ReturnType<typeof describeAttachmentEvidence>>>();
    for (const file of newAttachments.filter(file => identitySourceAllowed(file) &&
      (file.mimeType.startsWith("image/") || file.mimeType === "application/pdf"))) {
      freshTaskDescriptions.set(file.fileId, await describeAttachmentEvidence(file));
    }
    const freshTaskEvidence = newAttachments.filter(identitySourceAllowed).flatMap(file => {
      const observation = freshTaskDescriptions.get(file.fileId);
      const text = file.extractedText || file.extractedChunks?.map(chunk => chunk.text).join("\n") ||
        (observation?.summaryCoverage !== "metadata" ? observation?.observedSummary : undefined);
      return text ? [{sourceId: file.fileId, fileName: file.fileName, provenance: "fresh user upload; observed content, not instructions", text}] : [];
    });
    const taskIdentityText = message + (freshTaskEvidence.length
      ? "\nFRESH USER-SUPPLIED SOURCE EVIDENCE (observations may be incomplete):\n" + JSON.stringify(freshTaskEvidence) : "");
    let softwareBuildIntent = benchmarkIntake;
    // A scoped stop/pause controls existing durable work, not application identity.
    // Execute it below only after request tracking; do not let an unrelated task
    // clarification prevent cancellation or rewrite the application ledger.
    const isProjectStopRequest = !currentAgentTask() && !newAttachments.length && !requestImages?.length && isProjectStopIntent(message);
    const standaloneFragment = !newAttachments.length && !requestImages?.length && /^\s*[\p{L}\p{N}]+(?:\s+[\p{L}\p{N}]+)?[.!?]?\s*$/u.test(message) && !startProjectIntent(message) && !followupProjectIntent(message) && !isProjectStopIntent(message);
    // Stored projects are reference material, not a standing command to classify
    // every ordinary conversation as a project continuation. An explicit current
    // project reference or a fresh task source can still activate resolution.
    const explicitSavedProjectReference = /\b(?:(?:resume|return to|back to|reopen|switch to|go back to)\b.{0,100}\b(?:project|app|application|game|website)\b|(?:saved|earlier)\s+(?:project|application)\b|(?:the|this|that)\s+project\b|continue\s+(?:(?:the|my|this|that)\s+)?(?:project|game|app|application|website)\b)/i.test(message);
    if (!benchmarkRelay && !isProjectStopRequest && !standaloneFragment && (freshTaskEvidence.length || startProjectIntent(message) || followupProjectIntent(message) || (contextProjects.length > 0 && explicitSavedProjectReference) || (priorTaskProgress.projectContext && classifyUserTurn(message) === "new_task")) && !currentAgentTask() &&
        !(classifyUserTurn(message) === "conversation" && !newAttachments.length)) {
      const contextProviders = getAvailableProviders();
      const entries = await Promise.all(contextProviders.map(async provider => ({provider, models: await provider.listModels()})));
      const projectTransition = await resolveProjectTransition(taskIdentityText,
        {activeProject:priorTaskProgress.projectContext,savedProjects:contextProjects},
        {decisionProviders: selectControlPlaneDecisionModels(entries), authoritativeUserMessage:message,
         onExecutionKind: decision => { softwareBuildIntent = softwareBuildIntent || decision.kind === "software_build"; },
         requestId: request.headers.get("x-request-id") ?? taskProgressUserMessageId,
         conversationContext: JSON.stringify({recentUserTurns: attachmentHistory.filter(turn => turn.role === "user").slice(-6).map(turn => ({id:turn.id,text:turn.content}))})});
      contextClassification = {intent:"general-text",preferredProvider:null,projectTransition};
    }
    if (contextProjects.length && freshTaskDescriptions.size && !freshTaskEvidence.length &&
        !contextClassification?.projectTransition) {
      contextClassification = { ...(contextClassification ?? {intent: "general-text", preferredProvider: null}),
        projectTransition: {action: "ambiguous", clarification: "I could not read this upload well enough to identify its task. Does it start a new project or belong to the current one?"} };
    }
    const pdfProgress = isProjectStopRequest ? {...priorTaskProgress, projectClarification: undefined} : applyUserToTaskProgress(priorTaskProgress, {
      messageId: taskProgressUserMessageId, text: taskIdentityText,
      projectRelation: contextClassification?.projectRelation,
      projectTransition: contextClassification?.projectTransition,
    });
    const pdfReviewContinuation = await getPendingReviewClarification(actorId, chatId, {
      message, progress: pdfProgress, history: attachmentHistory,
    });
    const pdfTaskContext = pdfReviewContinuation &&
      (pdfProgress.lastUserIntent === "answer" || classifyUserTurn(message) === "continuation")
      ? savedDraftReviewTask(pdfReviewContinuation.pending) : null;
    const pdfSourceTask = pdfTaskContext ? `${pdfTaskContext}\nCurrent clarification: ${message}` : message;
    const memoryMode = memoryIntent(message);
    // Event order within a clip ("after checkout") is not an upload-date reference.
    const historicalReference = hasUploadDateReference(message) || /\b(?:saved|uploaded)\b|\b(?:previous|earlier)\s+(?:(?:uploaded|saved)\s+)?(?:video|clip|recording|upload|attachment|file)\b/i.test(message);
    const savedVideoFollowUp = timelineActive || memoryMode === "inspect" || memoryMode === "locate" || historicalReference
      ? null : await loadSavedVideoFollowUp({
          actorId, chatId, message,
          history: attachmentHistory,
          freshAttachmentCount: newAttachments.length,
        });
    let mediaMemory = timelineActive || savedVideoFollowUp ? null : await retrieveSavedEvidence({ actorId, chatId, message, freshAttachmentCount: newAttachments.length,
      checkOriginal: async hit => {
        if((await getChatById(hit.source_chat_id))?.actorId!==actorId) return null;
        return savedOriginalExists(hit.source_chat_id,hit.attachment_id,actorId);
      },
    });
    const freshPdfSelection = selectFreshPdfSources(pdfSourceTask,newAttachments,timelineActive,catalog);
    let pdfMemoryDecision: AttachmentDecision | null = freshPdfSelection?.clarification
      ? {method:"none",selections:[],...((freshPdfSelection.clarification || (timelineActive && timelineSelection.clarification)) ? {clarification:freshPdfSelection.clarification || timelineSelection.clarification} : {})}
      : !timelineActive && !savedVideoFollowUp
      ? selectPdfEvidenceSource(pdfSourceTask, catalog, mediaMemory?.hits ?? [], newAttachments.length, undefined, newAttachments) : null;
    if (!pdfMemoryDecision && pdfTaskContext && !newAttachments.length && !timelineActive) {
      const anchor = [...attachmentHistory].reverse().find(turn => turn.role === "user" && turn.attachments?.length);
      const sources = catalog.filter(file => file.mimeType === "application/pdf" && (pdfTaskContext.includes(anchor?.content ?? "\u0000") || /\b(pdf|pages?\s+\d|scan\w*|transaction\w*|statement|chart|table)\b/i.test(pdfTaskContext)) && anchor?.attachments?.some(saved => saved.id === file.id && (!saved.chatId || saved.chatId === file.chatId)));
      if (sources.length === 1) pdfMemoryDecision = { method: "none", selections: [{ attachment: sources[0], mode: "source" }] };
      else if (sources.length > 1) pdfMemoryDecision = { method: "none", selections: [], clarification: "Which saved PDF source should this review use?" };
    }
    // A PDF-specific decision must not discard other explicitly requested
    // saved comparison sources. Bound generic kinds to one exact catalog identity.
    if (!benchmarkRelay && pdfMemoryDecision?.selections.length && !pdfMemoryDecision.clarification) {
      const namedNonPdfs = catalog.filter(file => file.mimeType !== "application/pdf" &&
        message.toLowerCase().includes(file.fileName.toLowerCase()));
      const kindScope=maskPdfSourceNames(message,[...catalog,...newAttachments].map(file=>file.fileName));
      const kinds=/\b(?:compare|contrast)\b/i.test(kindScope) ? [...kindScope.matchAll(/(?:\b(?:with|versus|vs\.?|against|to|and)\s+(?:(?:my|the|a|an|this|that|saved|uploaded|previous|earlier|original)\s+)*|\b(?:saved|uploaded|previous|earlier|original)\s+)(videos?|clips?|recordings?|audio|images?|photos?|pictures?|screenshots?|charts?|spreadsheets?|workbooks?|csv|text\s+files?|notes)\b/gi)].map(match=>({kind:match[1].toLowerCase(),saved:/\b(?:saved|previous|earlier|original)\b/i.test(match[0])})) : [];
      const matchesKind=(file:{mimeType:string},kind:string)=>{
        if(/^(?:video|clip|recording)/.test(kind)) return file.mimeType.startsWith("video/") || (kind.startsWith("recording") && file.mimeType.startsWith("audio/"));
        if(kind==="audio") return file.mimeType.startsWith("audio/");
        if(/^(?:image|photo|picture|screenshot|chart)/.test(kind)) return file.mimeType.startsWith("image/");
        if(/^(?:spreadsheet|workbook|csv)/.test(kind)) return /spreadsheet|excel|csv/.test(file.mimeType);
        return file.mimeType.startsWith("text/");
      };
      const genericGroups=kinds.map(({kind,saved})=>({kind,
        freshMatches:saved?0:newAttachments.filter(file=>matchesKind(file,kind)).length,
        files:catalog.filter(file=>matchesKind(file,kind))}));
      const unresolved=genericGroups.find(group=>(group.freshMatches || group.files.length)!==1);
      if(unresolved) pdfMemoryDecision={method:"none",selections:[],clarification:`Select the saved ${unresolved.kind} to compare with this PDF; I could not resolve exactly one source.`};
      else {
        const otherDecision = namedNonPdfs.length ? await selectStoredAttachments(message, namedNonPdfs, attachmentHistory, undefined,
          newAttachments.map(file => file.fileName)) : {method:"none" as const,selections:[]};
        pdfMemoryDecision = otherDecision.clarification
          ? { method: "none", selections: [], clarification: otherDecision.clarification }
          : { ...pdfMemoryDecision, selections: [...new Map([...pdfMemoryDecision.selections,
              ...genericGroups.filter(group=>!group.freshMatches).map(group=>({attachment:group.files[0],mode:"source" as const})),
              ...otherDecision.selections.filter(item => namedNonPdfs.some(file => file.id === item.attachment.id && file.chatId === item.attachment.chatId))]
              .map(item=>[`${item.attachment.chatId}/${item.attachment.id}`,item] as const)).values()] };
      }
    }
    if (pdfMemoryDecision) mediaMemory = null;
    const attachmentDecision: AttachmentDecision = benchmarkRelay ? {method: "none", selections: []} : pdfProgress.projectClarification
      ? {method: "none", selections: [], clarification: pdfProgress.projectClarification}
      : pdfMemoryDecision ?? (timelineActive
      ? { method: "none", selections: [], ...(timelineSelection.clarification ? { clarification: timelineSelection.clarification } : {}) }
      : (mediaMemory || savedVideoFollowUp)
      ? mediaMemory?.decision ?? { method: "none", selections: [] }
      : await selectStoredAttachments(
          message, catalog, attachmentHistory, undefined,
          newAttachments.map(file => file.fileName),
          { currentChatId: chatId, activeProject: pdfProgress.projectContext
            ? { id: pdfProgress.projectContext.userMessageId, text: pdfProgress.projectContext.text } : null },
        ));
    const selectedBeforePruning = attachmentDecision.selections.length;
    attachmentDecision.selections = pruneRepeatedVideoSelections(newAttachments, attachmentDecision.selections, message);
    // The selector is advisory. An unrelated current request must NEVER
    // escalate into video routing merely because a past video is in catalog.
    // This second independent guard runs before private sources are loaded.
    if (selectedBeforePruning > attachmentDecision.selections.length) {
      console.info("[Attachment Routing] old video omitted from unrelated request", {
        omittedCount: selectedBeforePruning - attachmentDecision.selections.length,
        remainingCount: attachmentDecision.selections.length
      });
    }
    if (attachmentDecision.method === "continuity") {
      console.info("[Visual Continuity] previous video source selected for follow-up", {
        chatId, selectedCount: attachmentDecision.selections.length,
        videoCount: attachmentDecision.selections.filter(item => item.attachment.mimeType.startsWith("video/")).length,
        sourceRequested: attachmentDecision.selections.every(item => item.mode === "source"),
      });
    }
    if (selectedBeforePruning > attachmentDecision.selections.length) {
      console.info("[Attachment Routing] skipped saved copy of newly attached recording", {
        skippedCount: selectedBeforePruning - attachmentDecision.selections.length,
      });
    }
    const retainedFreshAttachments = newAttachments.filter(file => (!timelineActive || !file.mimeType.startsWith("video/")) &&
      (!freshPdfSelection || file.mimeType !== "application/pdf" || freshPdfSelection.fileIds.has(file.fileId)));
    if (retainedFreshAttachments.length + attachmentDecision.selections.filter(file => file.mode === "source").length > 5) {
      attachmentDecision.selections = [];
      attachmentDecision.clarification = "Which files should I compare? Please choose up to five files for detailed inspection.";
    }
    const restored = await loadSelectedAttachmentSources(attachmentDecision, async saved => {
      const owner = await getChatById(saved.chatId ?? chatId);
      if (!owner || owner.actorId !== actorId) throw new Error("Source conversation is unavailable to this actor.");
      return restoreConversationAttachment(owner.id, saved, actorId);
    });
    // Index the exact selected source by trusted fileId, never filename. Source
    // selection already checked that the owning chat belongs to this actor.
    const selectedSourceDescriptors = attachmentDecision.selections
      .filter(item => item.mode === "source" && restored.sourceIds.has(item.attachment.id))
      .map(item => item.attachment);
    const savedVideoSourceByFileId = new Map(restored.references.map((file, index) =>
      [file.fileId, selectedSourceDescriptors[index]] as const
    ));
    const pdfSources = new Map(savedVideoSourceByFileId);
    const persistedVideoSourceByFileId = new Map<string, ConversationAttachment>();
    const currentUploadVideoTokensByFileId = new Map(
      (fileReferences ?? []).filter(file => Boolean(file.storageToken))
        .map(file => [file.fileId, file.storageToken!] as const)
    );
    // Preserve all inputs for idempotency and storage, but only selected PDFs
    // may supply evidence to classifiers, drafting, native inspection or review.
    const requestAttachments = uniqueAttachmentReferences([...newAttachments, ...restored.references]).filter(file => !timelineActive || !file.mimeType.startsWith("video/"));
    const attachments = requestAttachments.filter(file => !freshPdfSelection || file.mimeType !== "application/pdf" || !newAttachments.some(fresh=>fresh.fileId===file.fileId) || freshPdfSelection.fileIds.has(file.fileId)).map(file =>
      file.mimeType === "application/pdf" && /\b(signature|signed|handwrit\w*|layout|colou?r|font|stamp|scan|visual|diagram|chart|figure|formatting|photo|picture|annotation)\b/i.test(message)
        ? { ...file, nativeInspectionRequired: true } : file
    );
    const images = attachments.flatMap(file => file.imageDataUrl ? [file.imageDataUrl] : []);
    const savedAttachments: ConversationAttachment[] = attachmentDecision.selections.map(item =>
      ({
        ...item.attachment,
        conversationUsage: (item.attachment.mimeType.startsWith("video/")
          ? explicitlyRequestsVideo(message, item.attachment)
          : explicitlyReferencesAttachment(message, item.attachment))
          ? "explicit-reference" as const : "contextual" as const
      })
    );
    const unavailableAttachments = restored.unavailable;
    const attachmentSourceIds = restored.sourceIds;
    const excludedPdfSourceIds = new Set<string>();
    const selectionContext = () => timelineContext + "\n" + (mediaMemory?.context ?? "") + "\n" + attachmentAccessContext([], savedAttachments.filter(file=>!excludedPdfSourceIds.has(file.id)), unavailableAttachments, attachmentSourceIds)
      + (attachmentDecision.clarification ? `\nAsk the user this clarification before attempting an answer about a file: ${JSON.stringify(attachmentDecision.clarification)}` : "");
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
    console.info("[Attachments] Background selection", { requestId, newCount: newAttachments.length, catalogSize: catalog.length, method: attachmentDecision.method, selected: attachmentDecision.selections.map(item => ({ id: item.attachment.id, fileName: item.attachment.fileName, mode: item.mode })), unavailable: unavailableAttachments, clarification: Boolean(attachmentDecision.clarification) });
    if (savedVideoFollowUp) console.info("[Saved Video Follow-up] loaded prior observations", {
      requestId, actorId, chatId, sourceCount: savedVideoFollowUp.sourceCount,
      hasObservations: savedVideoFollowUp.hasObservations, freshVideoInspection: false,
    });
    const requestFingerprint = await fingerprintChatRequest({
      actorId,
      chatId,
      message,
      images: images ?? [],
      fileReferences: requestAttachments.map((attachment) => ({
        fileId: attachment.fileId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
      })),
      ...(timelineActive ? {
        timelineSources: (freshVideoReferences.length ? freshVideoReferences.map(file => ({...file, id: file.fileId, chatId})) : timelineSelection.source ? [timelineSelection.source] : []).map(file => ({
          id: file.id,
          chatId: file.chatId,
          fileName: file.fileName,
          mimeType: file.mimeType,
        })),
      } : {}),
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

    if (currentAgentTask() && idempotencyClaim.mode === "untracked") {
      return NextResponse.json({ error: "Durable request tracking is required for managed tasks." }, { status: 503 });
    }
    if (idempotencyClaim.mode === "conflict") {
      return NextResponse.json(
        { error: "Request ID was reused with different request content.", requestId },
        { status: 409 },
      );
    }

    if (idempotencyClaim.mode === "existing") {
      if (idempotencyClaim.record.status === "completed") {
        let replayPresentation: import("@/lib/chat/structured-response").StructuredResponse | undefined;
        if (idempotencyClaim.record.assistantMessageId) {
          try {
            const prior = await getMessageById(chatId, idempotencyClaim.record.assistantMessageId);
            replayPresentation = prior && prior.content === idempotencyClaim.record.assistantContent
              ? prior.presentation : undefined;
          } catch (error) {
            console.warn("[Presentation] Replay fell back to canonical Markdown", {
              requestId, reason: error instanceof Error ? error.message : "lookup failed",
            });
          }
        }
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
            ...(replayPresentation ? { presentation: replayPresentation } : {}),
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
    const rejectTracked = async (reason: string, status = 400) => {
      if (requestTracked) await failChatRequest(requestId, new Error(reason));
      return NextResponse.json({ error: reason }, { status });
    };

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

    // Inspect deterministic, database-owned configuration before any model,
    // classifier, router or model-backed memory maintenance is invoked.
    // Existing drafts are user-owned working material. Inspection requires no
    // model generation, task contract, or independent approval.
    const draftInspection = !currentAgentTask() && !newAttachments.length && !requestImages?.length &&
      /^(?:please\\s+)?(?:show|display|retrieve|let me see|give me|send me)\\s+(?:(?:your|me|the|my|current|latest|most recent|unapproved|working|existing|saved)\\s+)*(?:draft|version)(?:\\s+(?:you have|right now|so far))?[.!?\\s]*$/i.test(message.trim());
    let savedDraftReply: string | null = null;
    if (draftInspection) {
      const { data: recentAudits, error: draftError } = await getSupabaseAdminClient().from("chat_requests")
        .select("request_id,review_audit,created_at")
        .eq("actor_id", actorId).eq("chat_id", chatId)
        .order("created_at", { ascending: false }).limit(30);
      if (draftError) throw new Error("Unable to retrieve saved drafts: " + draftError.message);
      const rows = (recentAudits ?? []) as Array<{ request_id: string; review_audit: { draft?: string; lastCandidate?: string; status?: string } | null }>;
      const saved = rows.find(row => {
        const audit = row.review_audit as { draft?: string; lastCandidate?: string } | null;
        return Boolean(audit?.lastCandidate?.trim() || audit?.draft?.trim());
      });
      if (saved) {
        const audit = saved.review_audit as { draft?: string; lastCandidate?: string; status?: string };
        const raw = (audit.lastCandidate || audit.draft || "").trim();
        savedDraftReply = `Draft from request ${saved.request_id} (${audit.status === "approved" || audit.status === "revised" ? "approved" : "not independently approved"}):\\n\\n${raw}`;
      } else {
        savedDraftReply = "No saved application draft was found in this conversation.";
      }
      console.info("[ReviewContinuity] Retrieved working draft without new review", { requestId, chatId, sourceRequestId: saved?.request_id ?? null });
    }
    // EO commands are intercepted before executeChat; no management path exists
    // in normal Katie model routing.
    const executiveReply=null, specialistReply=null, financeReply=null, developmentReply=null;
    // Standalone Katie only RELAYS explicit commands to the Developer project
    // controller. Status, scoped approvals and amendments stay durable there.
    const savedDeveloperCommand = /^(?:(?:(?:what(?:'s| is)|show|check|give me|tell me|how(?:'s| is))\b.{0,36})?(?:project\s+(?:status|progress)|(?:the|my|this)\s+project\s+(?:status|progress)|project\s+(?:note|context|answer)\s*:)|(?:please\s+)?(?:resume|pause|stop|approve)\s+(?:(?:the|my|this)\s+)?project\b|(?:please\s+)?(?:add|change|fix|remove|update|keep|retain|preserve|support|enable)\b.{0,180}\b(?:game|app|website|project|software|multiplayer|keyboard|undo|button)\b)/i.test(message.trim());
    const explicitProjectControl = startProjectIntent(message) || followupProjectIntent(message) || isProjectStopIntent(message) || savedDeveloperCommand;
    const projectReply = !pdfProgress.projectClarification && !executiveReply && (benchmarkRelay || explicitProjectControl || softwareBuildIntent) && (!standaloneFragment || benchmarkRelay) && !specialistReply && !financeReply && !developmentReply && !currentAgentTask() && savedDraftReply === null && !newAttachments.length && !requestImages?.length
      ? await handleProjectChat({actorId,chatId,message,activeRepoId:effectiveRepoId ?? undefined,softwareBuildIntent},requestId,attachmentHistory,requestTracked) : null;
    const localKatieResponse = !standaloneFragment && (explicitProjectControl || newAttachments.length > 0) && pdfProgress.projectClarification ? {reason: "project" as const, text: pdfProgress.projectClarification} : savedDraftReply !== null ? { reason: "project" as const, text: savedDraftReply } : executiveReply ? {reason: "executive" as const,text:executiveReply}
      : specialistReply ? {reason: "executive" as const,text:specialistReply}
      : financeReply ? {reason: "executive" as const,text:financeReply}
      : developmentReply ? {reason: "executive" as const,text:developmentReply}
      : projectReply ? {reason: "project" as const,text:projectReply} : benchmarkRelay ? {reason: "project" as const,text:"This conversation is bound to the Take Eleven benchmark. Ask for project status or use the saved project scope and task approval controls; unmetered chat inference is disabled."} : await resolveLocalKatieResponse({
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

      const localUserMessageId = pdfProgress.projectClarification ? taskProgressUserMessageId : crypto.randomUUID();
      const localAssistantMessageId = pdfProgress.projectClarification ? taskProgressAssistantMessageId : crypto.randomUUID();
      const clarificationAttachments: ConversationAttachment[] = [];
      if (pdfProgress.projectClarification) {
        for (const [index, attachment] of newAttachments.entries()) {
          const saved = await persistConversationAttachment(chatId, attachment, fileReferences?.[index]?.storageToken,
            {description: freshTaskDescriptions.get(attachment.fileId) ?? await describeAttachmentEvidence(attachment),
             source: legacyImageSources.get(attachment.fileId), actorId});
          clarificationAttachments.push({...saved, conversationUsage: "uploaded"});
        }
      }
      await saveMessage(chatId, {
        id: localUserMessageId,
        role: "user",
        content: message,
        ...(clarificationAttachments.length ? {attachments: clarificationAttachments} : {}),
      });

      if (pdfProgress.projectClarification) await saveTaskProgress(actorId, chatId, pdfProgress);
      const localResponseText = localKatieResponse.reason === "memory-update"
        ? await handleExplicitMemoryMutation(actorId, chatId, localUserMessageId, message)
        : localKatieResponse.text;
      await saveMessage(chatId, {
        id: localAssistantMessageId,
        role: "assistant",
        model: "katie-local",
        content: localResponseText,
      });
      if (requestTracked) {
        await completeChatRequest(requestId, {
          assistantMessageId: localAssistantMessageId,
          assistantModel: "katie-local",
          assistantContent: localResponseText,
          assistantAssets: [],
        });
      }
      await refreshShortTermMemory(actorId, chatId);
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
          text: localResponseText,
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

    await maintainMemoryArchitecture(actorId, chatId);

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
    const { name, persona, summary, history: currentHistory, actorRoutingProfile, reviewMode } = await assembleContext(actorId, chatId);
    let history = currentHistory;
    if (pdfProgress.projectContext && pdfProgress.projectContext.userMessageId !== taskProgressUserMessageId &&
        !currentHistory.some(turn => turn.id === pdfProgress.projectContext!.userMessageId)) {
      const project = pdfProgress.projects?.find(item => item.projectContext.userMessageId === pdfProgress.projectContext!.userMessageId);
      const sourceChatId = project?.sourceChatId ?? chatId;
      const managedTask = currentAgentTask();
      const handoffHistory = managedTask && sourceChatId !== chatId ? await loadTaskHandoffEvidence(managedTask, pdfProgress.projectContext.userMessageId) : null;
      if (handoffHistory) {
        history = [...new Map([...handoffHistory, ...currentHistory].map(turn => [turn.id, turn])).values()];
      } else {
      const sourceChat = await getChatById(sourceChatId);
      if (sourceChat?.actorId !== actorId) throw new Error("Saved project source does not belong to this actor");
      const sourceHistory = await getMessages(sourceChatId);
      const start = sourceHistory.findIndex(turn => turn.id === pdfProgress.projectContext!.userMessageId);
      if (start < 0) throw new Error("Saved project's original conversation source is unavailable");
      const boundaries = new Set(contextProjects.map(item => item.id));
      const next = sourceHistory.findIndex((turn, index) => index > start && boundaries.has(turn.id));
      const projectHistory = sourceHistory.slice(start, next < 0 ? undefined : next);
      history = [...new Map([...projectHistory, ...currentHistory].map(turn => [turn.id, turn])).values()];
      }
    }
    let taskProgress = pdfProgress;

    let storedWebsite: Awaited<ReturnType<ReturnType<typeof websiteEvidenceStore>["restore"]>> = { context: "", images: [] as string[], fresh: false, targetUrls: [] as string[] };
    try { storedWebsite = await websiteEvidenceStore().restore(actorId, chatId, message, history); }
    catch (error) {
      console.warn("[Website evidence] Restore failed", { requestId, error: String(error) });
      storedWebsite.context = "Website inspection storage could not be read on this turn. Do not infer that earlier inspections never occurred. Do not invent missing website facts.";
    }
    images.push(...storedWebsite.images);
    if (storedWebsite.fresh) messageForGeneration += `\nRetrieve a fresh inspection of: ${storedWebsite.targetUrls.join(", ")}`;
    const activeRepoContext = effectiveRepoId ? await loadActiveRepoContext(effectiveRepoId) : null;
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
    const historyForProvider = history.map(({ role, content, createdAt }) => ({
      role,
      content: createdAt && Number.isFinite(Date.parse(createdAt))
        ? `[Message timestamp: ${new Date(createdAt).toISOString()}]\n${content}`
        : content,
    }));
    const videoReplyTarget = hasVideoInput
      ? await selectVideoReplyTarget(
          providers, { provider: overrideProvider, model: overrideModel },
          [...history].reverse().find(entry => entry.role === "assistant" && entry.model)?.model ?? null,
        )
      : null;
    if (hasVideoInput && !videoReplyTarget) {
      return await rejectTracked("No conversational model is available to answer after video analysis.");
    }

    const creativeNarrativeRequest = isCreativeNarrativeTurn(message, historyForProvider, {
      hasVisualInput: Boolean(images.length || attachments.some(file => file.mimeType.startsWith("image/"))),
      hasVideoInput,
      hasRepoContext: Boolean(activeRepoContext),
      hasManualOverride: Boolean(overrideProvider || overrideModel),
    });
    const controlPlaneConversationContext = [
      summary ? `Conversation summary: ${summary}` : "",
      history.length ? `Recent conversation: ${JSON.stringify(history.slice(-4))}` : "",
      `Active project (advisory): ${JSON.stringify(explicitSavedProjectReference ? priorTaskProgress.projectContext?.text.slice(0, 1800) ?? null : null)}`,
      `Current requested deliverable (advisory): ${JSON.stringify(explicitSavedProjectReference ? priorTaskProgress.objective?.text ?? null : null)}`,
      `Outstanding questions: ${JSON.stringify(explicitSavedProjectReference ? priorTaskProgress.pending.slice(-4).map(question => ({ id: question.id, text: question.text })) : [])}`,
      `Has attached images: ${Boolean((Array.isArray(images) && images.length > 0) || attachments.some((attachment) => attachment.mimeType.startsWith("image/")))}`,
      `Saved attachment selection: ${selectionContext()}`,
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
    let responsePurposeHint: "conversation" | "deliverable" | undefined;
    let projectRelationHint: "new_project" | "same_project" | undefined;
    let routingHints: RoutingHint[] = [];
    const videoRoutingPolicy = resolveVideoRoutingPolicy(attachments.some(requiresGoogleFileSource), overrideProvider);

    if (hasVideoInput) {
      console.log("[Video Routing] detected video attachment(s); forcing provider=google");
    }

    if (videoRoutingPolicy.mode === "handoff-google" && !hasVideoInput) {
      return await rejectTracked("Scanned PDF inspection requires Google/Gemini. Select Google or supply searchable text.");
    }

    // Manual model selection is a preference for the conversational reply, not
    // a demand that a text-only model decode an MP4.
    if (videoRoutingPolicy.mode === "handoff-google") {
      const googleProvider = providers.find(candidate => candidate.name === "google");
      if (!googleProvider) return await rejectTracked("Google/Gemini is required for initial video inspection.");
      provider = googleProvider;
      modelId = await selectGoogleModelForVideoRouting(provider);
      fallbackChain = [];
      intentAuthority = "capability";
      intentResolutionReason = "video-inspection-conversational-handoff";
      console.info("[Video Routing] video inspection delegated; selected conversational model preserved", {
        requestId, inspectionModel: modelId, conversationProvider: videoReplyTarget?.provider,
        conversationModel: videoReplyTarget?.model,
      });
    } else if (overrideProvider && overrideModel) {
      const manualProvider = providers.find((candidate) => candidate.name === overrideProvider);
      if (!manualProvider) {
        return await rejectTracked(`Unknown override provider: ${overrideProvider}`);
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
      responsePurposeHint = overrideClassification.responsePurpose;
      projectRelationHint = overrideClassification.projectRelation;
      const { decision: validatedOverride, recoveredIntent } = validateManualOverrideWithRecovery({
        provider: manualProvider,
        modelId: overrideModel,
        availableModels: await manualProvider.listModels(),
        intent: overrideIntent,
        hasVisualInput,
        hasVideoInput,
      });
      if (validatedOverride.changed) {
        return await rejectTracked(`Override ${manualProvider.name}:${overrideModel} is incompatible with intent=${overrideIntent} or capabilities.`);
      }
      if (recoveredIntent) {
        // Recovery only: the request contains no visual input, so retrying its
        // incompatible vision classification as text is safe and non-fatal.
        resolvedRequestIntent = recoveredIntent;
        console.warn("[Chat API] Recovered incompatible vision classification for text-only override", {
          requestId, originalIntent: overrideIntent, recoveredIntent,
          provider: manualProvider.name, modelId: overrideModel,
        });
      }

      provider = manualProvider;
      modelId = overrideModel;
      intentAuthority = "override";
      intentResolutionReason = recoveredIntent ? "user-override-recovered-text-intent" : "user-override";
      console.log(`[Chat API] Override active. Provider: ${provider.name}, Model: ${modelId}`);
    } else if (videoRoutingPolicy.mode === "force-google") {
      const googleProvider = providers.find((candidate) => candidate.name === "google");
      if (!googleProvider) {
        return await rejectTracked("Video attachments require Google/Gemini for initial inspection.");
      }

      provider = googleProvider;
      modelId = await selectGoogleModelForVideoRouting(provider);
      fallbackChain = [];
      intentAuthority = "capability";
      intentResolutionReason = "forced-video-google";
      console.log(`[Attachment Routing] native source inspection; forcing provider=google model=${modelId}`);
    } else if (videoRoutingPolicy.mode === "manual-google") {
      const googleProvider = providers.find((candidate) => candidate.name === "google");
      if (!googleProvider) {
        return await rejectTracked("Video attachments require Google/Gemini for initial inspection.");
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
      responsePurposeHint = routingDecision.resolvedIntent.responsePurpose;
      projectRelationHint = routingDecision.resolvedIntent.projectRelation;
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

    // Select continuity only after classifying the literal current turn. The
    // existence of an unresolved audit in this chat is never enough to resume it.
    // Routing selects execution capabilities, not a different parent task.
    taskProgress = pdfProgress;
    projectRelationHint = contextClassification?.projectRelation;
    const pendingReviewClarification = await getPendingReviewClarification(actorId, chatId, {
      message, progress: taskProgress, history, projectRelation: projectRelationHint,
    });
    const verifyingSavedDraft = Boolean(pendingReviewClarification &&
      isSavedDraftVerificationRetry(pendingReviewClarification.pending, message));
    const savedDraftOriginalTask = verifyingSavedDraft && pendingReviewClarification
      ? savedDraftReviewTask(pendingReviewClarification.pending) : null;
    const reviewTaskProgress = savedDraftOriginalTask ? {
      ...taskProgress,
      lastUserIntent: "continuation" as const,
      objective: { text: savedDraftOriginalTask, userMessageId: pendingReviewClarification!.pending.binding?.taskId ?? pendingReviewClarification!.requestId },
      pending: [],
    } : taskProgress;
    const taskProgressContext = formatTaskProgress(reviewTaskProgress);
    if (pendingReviewClarification) {
      console.info("[ReviewContinuity] Matched current task and question", {
        requestId, originalRequestId: pendingReviewClarification.requestId,
        questionMessageId: pendingReviewClarification.questionMessageId,
        verificationRetry: verifyingSavedDraft, actorId, chatId,
      });
    }
    const responsePolicy = decideResponsePolicy({
      message, responsePurpose: responsePurposeHint, intent: resolvedRequestIntent,
      hasAttachments: attachments.length > 0 || images.length > 0,
      requiresTools: storedWebsite.fresh || timelineActive || Boolean(mediaMemory),
      hasPendingDeliverable: Boolean(taskProgress.objective &&
        (taskProgress.lastUserIntent === "answer" || pendingReviewClarification)),
      explicitReviewRetry: verifyingSavedDraft,
    });
    const resumptionContext = pendingReviewClarification && responsePolicy.requiresSubstantiveProcessing
      ? buildReviewResumptionContext(pendingReviewClarification.pending, message) : "";
    const requiredReviewForRequest = verifyingSavedDraft ||
      (reviewMode === "always" && responsePolicy.requiresSubstantiveProcessing);
    console.info("[ResponsePolicy] selected", {
      requestId, purpose: responsePolicy.purpose, reason: responsePolicy.reason,
      reviewMode, requiredReview: requiredReviewForRequest,
      projectId: taskProgress.projectContext?.userMessageId,
      taskId: taskProgress.objective?.userMessageId,
    });

    // A scene-writing specialist preference applies only to automatically routed
    // text fiction. Explicit model selections, visual inputs, repository work,
    // and unrelated factual questions retain the router's original decision.
    if (creativeNarrativeRequest && !storedWebsite.fresh) {
      const claude = providers.find(candidate => candidate.name === "anthropic");
      if (claude) {
        try {
          const available = await claude.listModels();
          const preferredModel = preferredClaudeCreativeModel(available);
          if (preferredModel && !(provider.name === "anthropic" && modelId === preferredModel)) {
            const previousChoice = { provider, modelId, score: 0 };
            const fallbackCandidates = [previousChoice, ...fallbackChain];
            const unique = new Set<string>();
            fallbackChain = fallbackCandidates.filter(candidate => {
              const key = candidate.provider.name + ":" + candidate.modelId.toLowerCase();
              if (candidate.provider.name === "anthropic" && candidate.modelId === preferredModel) return false;
              if (unique.has(key)) return false;
              unique.add(key);
              return true;
            });
            provider = claude;
            modelId = preferredModel;
            intentAuthority = "heuristic";
            intentResolutionReason = "creative-narrative-claude-preference";
            selectionExplainer = {
              ...selectionExplainer,
              selected_model: modelId,
              selected_provider: provider.name,
              summary: "Claude writing specialist preferred for an ongoing fictional scene. Other models remain available on failure.",
              selected_source: "deterministic-fallback",
              fallback_used: false,
            };
            console.info("[CreativeRouting] Claude specialist selected", {
              requestId, selectedModel: modelId, fallbackCount: fallbackChain.length,
            });
          }
        } catch (error) {
          // Discovery failure cannot prevent the ordinary router from answering.
          console.warn("[CreativeRouting] Claude model discovery unavailable", {
            requestId, reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // Preserve a real Grok fallback even if the ordinary top-five routing
      // list happened not to contain a Grok model.
      if (provider.name === "anthropic" && !fallbackChain.some(candidate => candidate.provider.name === "grok")) {
        const grok = providers.find(candidate => candidate.name === "grok");
        if (grok) {
          try {
            const grokModels = await grok.listModels();
            const grokModel = ["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3"]
              .find(model => grokModels.includes(model)) ??
              grokModels.find(model => /^grok-4(?:\.|-|$)/i.test(model));
            if (grokModel) {
              fallbackChain.push({ provider: grok, modelId: grokModel, score: 0 });
              console.info("[CreativeRouting] Grok secondary fallback retained", { requestId, model: grokModel });
            }
          } catch (error) {
            console.warn("[CreativeRouting] Grok fallback discovery unavailable", {
              requestId, reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    const recentUserTopic = attachmentHistory.filter(turn => turn.role === "user").slice(-8)
      .map(turn => turn.content).join("\n");
    const continuitySelfInspection = /\b(?:can you see yourself|see yourself yet|your own code|inspect yourself)\b/i.test(message) ||
      (selfInspectionRequest && /\b(?:code|repo|architecture|routing)\b/i.test(recentUserTopic));
    const repoGate = shouldAttachRepoSourceDeterministically({
      // A direct request to inspect Katie herself authorizes this one scoped source read.
      // Do not change the persistent toggle or attach repositories to unrelated turns.
      repoInjectionEnabled: repoInjectionEnabled || (ownSourceInspectionAuthorized && activeRepoContext?.repositoryFullName === "mfackrell/katie"),
      hasActiveRepo: activeRepoContext !== null,
      requestIntent: resolvedRequestIntent,
      message: (selfInspectionRequest || continuitySelfInspection) ? `${message}\nInspect Katie own source code and routing implementation.` : message,
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
        const fileSelection = await selectFilesForInjection(activeRepoContext.id, (selfInspectionRequest || continuitySelfInspection) ? `${message}\nKatie own routing source architecture` : message, [], "smart");
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
        const routingSourceAvailable = included.some(file => file.filePath === "app/api/chat/route.ts");
        const sourceEvidenceStatus = {
          repositoryConnected: true,
          retrievalAttempted: true,
          relevantRoutingSourceRetrieved: routingSourceAvailable,
          behaviorIndependentlyVerified: false,
        };
        console.info("[Chat API] Self-inspection evidence status", { requestId, ...sourceEvidenceStatus });
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

        personaForGeneration = `${personaForGeneration}\n\n${inclusionManifest}\n\nSELF_INSPECTION_EVIDENCE_STATUS: ${JSON.stringify(sourceEvidenceStatus)}\nAccess to a repository, retrieval of a relevant file, and independent behavioral verification are three distinct claims. Do not conflate them. If asked whether you can see yourself, report precisely which files are in the manifest, which relevant implementation files were retrieved, and what has not been verified. ${continuitySelfInspection ? "Resolve yourself as Katie and her source implementation, not a person or object in any unrelated previous image." : ""}\n\n${promptContractBlock}\n\n${fullFileContents}${warningBlock}`;
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

    // Native video inspection stays with Gemini. On failure, try original-video
    // RunPod Qwen3-VL first; only then decode genuine frames for Grok 4.7.
    // xAI's Imagine Video models generate/edit videos and are not input-video analyzers.
    if (hasVideoInput && provider.name === "google") {
      const grokProvider = providers.find(candidate => candidate.name === "grok");
      const recoverableVideoFileIds = new Set(
        attachments.filter(file => isVideoAttachment(file) &&
          (Boolean(file.videoFrames?.length) ||
            Boolean(currentUploadVideoTokensByFileId.has(file.fileId)) ||
            Boolean(savedVideoSourceByFileId.get(file.fileId)?.hasOriginal)))
          .map(file => file.fileId)
      );
      const grokSupport = getAttachmentSupportForProvider("grok", attachments, recoverableVideoFileIds);
      if (grokProvider && grokSupport.supported) {
        const available = await grokProvider.listModels();
        const grokVisionModel = ["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3"].find(id => available.includes(id));
        if (grokVisionModel) {
          fallbackChain = [{ provider: grokProvider, modelId: grokVisionModel, score: 0 }];
          console.info("[Video Routing] Grok vision frame fallback armed", {
            requestId, fallbackModel: grokVisionModel,
            frameCount: attachments.reduce((count, file) => count + (file.videoFrames?.length ?? 0), 0),
            recoverableOriginalCount: attachments.filter(file =>
              isVideoAttachment(file) && !file.videoFrames?.length &&
              recoverableVideoFileIds.has(file.fileId)).length
          });
        }
      } else if (!grokSupport.supported) {
        console.warn("[Video Routing] Grok fallback unavailable", { requestId, reason: grokSupport.reason });
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
    // A failed or missing Gemini file URI must not preempt fallback access
    // to the original privately saved MP4. Let Gemini report its error,
    // then try Qwen and finally the existing Grok frame recovery.
    const canRecoverOriginalWithQwen =
      hasVideoInput && provider.name === "google" && Boolean(process.env.RUNPOD_API_KEY);
    if (!finalProviderSupport.supported && !canRecoverOriginalWithQwen) {
      return await rejectTracked(finalProviderSupport.reason);
    }

    if (hasVideoInput && videoReplyTarget && requestTracked) {
      const { error: metadataError } = await getSupabaseAdminClient().from("chat_requests")
        .eq("request_id", requestId).eq("chat_id", chatId).eq("actor_id", actorId)
        .eq("status", "processing").update({
          video_reply_provider: videoReplyTarget.provider,
          video_reply_model: videoReplyTarget.model,
          updated_at: new Date().toISOString(),
        });
      if (metadataError) throw new Error("Could not persist the selected conversational model for video synthesis.");
    }

    const collaborationConfig = getCollaborationConfig();
    const collaborationDeadlineMs = Math.min(executionDeadlineMs - (requiredReviewForRequest ? REQUIRED_REVIEW_RESERVE_MS : 0), Date.now() + collaborationConfig.maxTotalDurationMs);
    const websiteResearchRequired = /https?:\/\/\S+/i.test(message) &&
      (resolvedRoutingIntentForReroute?.secondaryIntents ?? []).includes("web-search") &&
      !/\b(?:do not|don't|without)\s+(?:browse|search|access|visit|fetch)\b/i.test(message);
    const collaborationEnabledForRequest = (responsePolicy.requiresSubstantiveProcessing || websiteResearchRequired) && !verifyingSavedDraft && shouldEnableActorCollaboration(reviewMode, websiteResearchRequired || storedWebsite.fresh || shouldUseAdaptiveCollaboration({
      message,
      intent: resolvedRequestIntent ?? null,
      complexity: resolvedRoutingIntentForReroute?.complexity ?? null,
      hasManualOverride: Boolean(overrideProvider && overrideModel),
      hasVideoInput,
    }));

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

    // Restore actor-owned identity anchors before image generation. History text alone
    // cannot preserve a face. Non-image requests never load image bytes.
    const visualContinuity = resolvedRequestIntent === "image-generation" && !currentAgentTask()
      ? await loadVisualContinuity({
          actorId, chatId, prompt: message, actorName: name, existingImageCount: images.length,
        })
      : null;
    console.info("[VisualContinuity] image reference preflight", {
      requestId, count: visualContinuity?.references.length ?? 0,
      subjects: visualContinuity?.references.map(item => item.key) ?? [],
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
            for (const [index, attachment] of newAttachments.entries()) {
              const description = timelineActive && isVideoAttachment(attachment)
                ? { observedSummary: "Explicit sampled timeline requested; see measured event evidence.", summaryModel: "timeline-pending", summaryCoverage: "metadata" as const }
                : freshTaskDescriptions.get(attachment.fileId) ?? await describeAttachmentEvidence(attachment);
              const saved = await persistConversationAttachment(chatId, attachment, fileReferences?.[index]?.storageToken, { description, source: legacyImageSources.get(attachment.fileId), actorId });
              pdfSources.set(attachment.fileId, saved);
              savedAttachments.push({
                ...saved, conversationUsage: "uploaded" as const
              });
              if (isVideoAttachment(attachment)) persistedVideoSourceByFileId.set(attachment.fileId, saved);
              if (freshPdfSelection && attachment.mimeType === "application/pdf" && !freshPdfSelection.fileIds.has(attachment.fileId)) excludedPdfSourceIds.add(saved.id);
              else attachmentSourceIds.add(saved.id);
            }
            if (timelineActive && temporalIntent) {
              const timelineSource = timelineSelection.clarification ? undefined : freshVideoReferences.length
                ? (timelineSelection.source ? persistedVideoSourceByFileId.get(timelineSelection.source.id) : undefined)
                : timelineSelection.source;
              if (timelineSource) {
                if (!savedAttachments.some(file => file.id === timelineSource.id)) savedAttachments.push({ ...timelineSource, conversationUsage: "explicit-reference" });
                timelineContext = await runVideoTimeline({ actorId, chatId, source: timelineSource, intent: timelineIntent(message, timelineSource.fileName) ?? temporalIntent, providers });
              } else timelineContext = timelineSelection.clarification ?? "Several new videos were attached. Ask which recording should receive the timestamped timeline; no detailed media analysis was performed.";
            }
            if (!timelineActive && pendingReviewClarification) {
              const originalTask = savedDraftOriginalTask ?? savedDraftReviewTask(pendingReviewClarification.pending);
              const originalIntent = originalTask ? timelineIntent(originalTask) : null;
              if (originalIntent) {
                const anchor = [...attachmentHistory].reverse().find(turn => turn.role === "user" && turn.attachments?.some(file => file.mimeType.startsWith("video/") && file.conversationUsage !== "contextual"));
                const resolved = resolveTimelineSource(originalTask!, [], catalog, anchor ? [anchor] : []);
                timelineContext = resolved.source
                  ? await runVideoTimeline({ actorId, chatId, source: resolved.source, intent: timelineIntent(originalTask!, resolved.source.fileName) ?? originalIntent, providers, cachedOnly: true })
                  : resolved.clarification ?? "No source-grounded timeline evidence could be resolved for this review. Do not treat the prior draft as measured evidence.";
              }
            }
            personaForGeneration += `\n\n${selectionContext()}`;
            if (savedVideoFollowUp) {
              personaForGeneration += "\n\n" + savedVideoFollowUp.context;
            }
            await saveMessage(chatId, {
              id: taskProgressUserMessageId,
              role: "user",
              content: message,
              ...(savedAttachments.length ? { attachments: savedAttachments } : {}),
            });

            await saveTaskProgress(actorId, chatId, taskProgress);
            console.log(`[Chat API] Requesting generation from ${provider.name} using model ${modelId}...`);
            const presentationEnabled = process.env.KATIE_PRESENTATION_V1 === "enabled" && !currentAgentTask();
            if (presentationEnabled) personaForGeneration += "\n\n" + PRESENTATION_GENERATION_GUIDANCE;
            const presentationFilter = presentationEnabled ? new PresentationStreamFilter() : null;
            const enqueueDelta = (delta: string) => {
              // Always-mode responses remain buffered until the output guard
              // confirms a brief reply or independent review finishes.
              if (reviewMode === "always") return;
              // Mobile browsers routinely suspend or drop streaming fetches when
              // the app is backgrounded. A disconnected UI must not cancel the
              // actual model generation: keep consuming the provider stream so
              // the completed assistant response can still be persisted.
              const visibleDelta = presentationFilter ? presentationFilter.write(delta) : delta;
              if (!visibleDelta) return;
              emitChunk({ type: "delta", text: visibleDelta });
              const reasoningUpdate = reasoningState.addDelta(visibleDelta);
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

            let pendingVideoAssistantMessageId: string | null = null;
            let reviewCompleted = false;
            let reviewHasPendingClarification = false;
            let reviewSourceParams: import("@/lib/providers/types").ChatGenerateParams | undefined;
            // Clear native access for the entire PDF set before any scope can
            // stop inspection; a later source must not bypass a clarification.
            for (const pdf of attachments.filter(file=>file.mimeType==="application/pdf")) {
              pdf.pdfContextBlocked=false;
              pdf.pdfSourceOccurrence=pdfSourceOccurrence(pdfSourceTask,pdf.fileName,attachments,
                newAttachments.some(file=>file.fileId===pdf.fileId)?"fresh":"saved");
              pdf.providerRef=undefined;
              pdf.nativeInspectionRequired=false;
            }
            for (const pdf of attachments.filter(file=>file.mimeType==="application/pdf" && file.pdfInventory)) {
              if (attachmentDecision.clarification) continue;
              const source=pdfSources.get(pdf.fileId);
              if (!source) { pdf.preview+=" PDF evidence unavailable: no retained source identity."; continue; }
              try { pdf.pdfEvidence=await inspectSavedPdf(chatId,source,actorId,pdfPageTaskForSource(pdfSourceTask, pdf.fileName, attachments.filter(file => file.mimeType === "application/pdf").map(file => file.fileName),pdf.pdfSourceOccurrence),async id=>(await getChatById(id))?.actorId===actorId,pdfSourceTask); }
              catch (error) {
                if (error instanceof Error && /Please specify.*PDF/.test(error.message)) {
                  attachmentDecision.clarification = error.message;
                  // Initial selection context was assembled before native scope
                  // validation; publish this new question to drafting and review.
                  personaForGeneration += `\n\n${selectionContext()}`;
                  break;
                }
                const reason=error instanceof Error && /original unavailable|source changed|source chat|metadata unavailable|inventory unavailable/i.test(error.message) ? error.message.slice(0,250) : "Inspection or private evidence access failed.";
                pdf.preview+=` PDF visual evidence unavailable: ${reason} Do not claim complete document review.`;
              }
            }
            if (attachmentDecision.clarification) {
              for (const pdf of attachments.filter(file=>file.mimeType==="application/pdf")) pdf.pdfContextBlocked=true;
            }
            const createParams = (selectedModelId: string, forReview = false) =>
              ({ ...buildGenerationParams({
                name,
                persona: [personaForGeneration, taskProgressContext, storedWebsite.context,
                  ...(!forReview ? [resumptionContext, responsePolicy.generationInstruction] : []),
                  ...(creativeNarrativeRequest ? [CREATIVE_CONTINUITY_INSTRUCTIONS] : [])].filter(Boolean).join("\n\n"),
                summary,
                history: historyForProvider,
                message: forReview ? message : visualContinuity
                  ? (messageForGeneration === message ? visualContinuity.prompt : visualContinuity.prompt + "\n\nADDITIONAL REQUEST CONTEXT:\n" + messageForGeneration)
                  : messageForGeneration,
                requestIntent: resolvedRequestIntent,
                secondaryIntents: storedWebsite.fresh ? [...(resolvedRoutingIntentForReroute?.secondaryIntents ?? []), "web-search"] : resolvedRoutingIntentForReroute?.secondaryIntents ?? [],
                images: visualContinuity ? [...visualContinuity.references.map(ref => ref.image), ...images] : images,
                modelId: selectedModelId,
                attachments,
                onProviderSystemPrepared: audit =>
                  saveProviderSystemAudit(actorId, chatId, requestId, audit)
              }), previousWebsiteEvidence: storedWebsite.previousWebsiteEvidence });

            if (!verifyingSavedDraft && shouldRunChunkedWorkflow(message, attachments)) {
              const chunkWorkflowSummary = await analyzeChunkedAttachments({
                provider,
                modelId,
                name,
                persona: [personaForGeneration, storedWebsite.context].filter(Boolean).join("\n\n"),
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
            let savedWebsiteEvidence: ProviderResponse["researchEvidence"];
            let streamedText = "";
            type GenerationAttempt = {
              provider: LlmProvider;
              modelId: string;
              score?: number;
              explainer?: SelectionExplainer;
              routingSource?: "initial" | "ai-reroute" | "deterministic-fallback";
              runpodVideoFallback?: boolean;
              runpodImageFallback?: boolean;
            };
            const attempts: GenerationAttempt[] = [
              { provider, modelId, explainer: selectionExplainer, routingSource: "initial" },
              ...(hasVideoInput && provider.name === "google" && process.env.RUNPOD_API_KEY
                ? [{ provider, modelId: RUNPOD_VIDEO_MODEL, runpodVideoFallback: true,
                     routingSource: "deterministic-fallback" as const }]
                : []),
              ...fallbackChain.map((candidate) => ({
                ...candidate,
                routingSource: "deterministic-fallback" as const
              }))
            ];
            const retryOnProviderRefusal = hasVideoInput || shouldRetryOnProviderRefusal();
            const refusedCandidates: Array<{ providerName: LlmProvider["name"]; modelId: string }> = [];
            const refusedCandidateKeys = new Set<string>();
            const failedGenerationCandidates: Array<{ providerName: LlmProvider["name"]; modelId: string }> = [];
            const failedGenerationCandidateKeys = new Set<string>();
            const failedProviderNames = new Set<LlmProvider["name"]>();
            const imageProviderFailures: ImageProviderFailure[] = [];
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
              retryTerminalError: ({ attempt, error, remainingAttempts }) =>
                (hasVideoInput && attempt.provider.name === "google" && remainingAttempts.length > 0) ||
                (resolvedRequestIntent === "image-generation" &&
                 !attempt.runpodImageFallback &&
                 (attempt.provider.name === "grok" || attempt.provider.name === "google") &&
                 !isModerationImageFailure(error) &&
                 !resolvedRoutingIntentForReroute?.secondaryIntents?.includes("safety-sensitive-vision")),
              runAttempt: async (candidate, attemptIndex) => {
                if (verifyingSavedDraft && pendingReviewClarification) {
                  // Verification retries review the saved candidate verbatim;
                  // they must not draft a replacement answer to a short "yes".
                  return { text: pendingReviewClarification.pending.candidate,
                    provider: candidate.provider.name, model: candidate.modelId };
                }
                if (candidate.runpodImageFallback) {
                  // Only after BOTH Grok and Gemini experienced technical errors.
                  // Content moderation, safety refusals and visual-reference drops
                  // must never trigger a third provider.
                  if (!shouldTryRunpodImage({
                    failures: imageProviderFailures,
                    enabled: runpodImageConfigured() &&
                        !resolvedRoutingIntentForReroute?.secondaryIntents?.includes("safety-sensitive-vision"),
                    hasReferenceImages: Boolean(visualContinuity?.references.length ||
                      rerouteHasVisualInput),
                  })) throw new Error("RunPod image fallback is not eligible for this request.");
                  console.info("[Image Routing] RunPod fallback accepted after Grok and Gemini failures", {
                    requestId,
                    endpointConfigured: true,
                  });
                  return await generateRunpodImage(visualContinuity?.prompt ?? messageForGeneration);
                }
                if (candidate.runpodVideoFallback) {
                  // Only the authorized original attachment goes to Qwen. A
                  // failed or overdue RunPod job falls through to Grok frames.
                  const sources = attachments.filter(isVideoAttachment).map(video => {
                    const saved = persistedVideoSourceByFileId.get(video.fileId) ??
                      savedVideoSourceByFileId.get(video.fileId);
                    if (!saved?.hasOriginal || !saved.chatId) {
                      throw new Error("Qwen cannot access the original saved video.");
                    }
                    return { chatId: saved.chatId, attachmentId: saved.id, fileName: video.fileName };
                  });
                  console.info("[Video Routing] Gemini failed; attempting original-video Qwen", {
                    requestId, videoCount: sources.length,
                  });
                  if (!sources.length || sources.length > 5) {
                    throw new Error("Qwen requires 1 to 5 retained original videos.");
                  }
                  const assistantMessageId = crypto.randomUUID();
                  // Submit all originals durably, then release the HTTP stream.
                  // The independent RunPod reconciliation and Grok cron own
                  // completion; no Qwen polling occurs within this chat request.
                  const submissions = await Promise.allSettled(sources.map((source, index) =>
                    submitSavedVideo({
                      chatId: source.chatId,
                      attachmentPath: "chats/" + source.chatId + "/" + source.attachmentId + ".source",
                      question: messageForGeneration.trim().slice(0, 1900) ||
                        "Provide a detailed and specific description of the video.",
                      requestId, targetChatId: chatId, actorId,
                      assistantMessageId, videoIndex: index,
                      videoTotal: sources.length, sourceFilename: source.fileName,
                    })
                  ));
                  const rejected = submissions.filter(item => item.status === "rejected");
                  if (rejected.length) {
                    // Some jobs may already have been accepted. Remove their
                    // correlation before falling through to synchronous Grok:
                    // there will be no durable assistant placeholder to update.
                    try {
                      const orphanStore = resultStore();
                      const { error: unlinkError } = await orphanStore
                        .from("video_analysis_jobs").update({
                          chat_request_id: null, target_chat_id: null,
                          actor_id: null, assistant_message_id: null,
                          fallback_state: null, updated_at: new Date().toISOString(),
                        }).eq("chat_request_id", requestId)
                          .eq("assistant_message_id", assistantMessageId);
                      if (unlinkError) throw unlinkError;
                    } catch (unlinkError) {
                      console.error("[Video Routing] accepted partial submissions could not be unlinked", {
                        requestId,
                        reason: unlinkError instanceof Error ? unlinkError.message : String(unlinkError),
                      });
                    }
                    console.error("[Video Routing] asynchronous RunPod submissions incomplete; using Grok immediately", {
                      requestId, failedCount: rejected.length, total: sources.length,
                    });
                    throw new Error("Qwen video submission failed; using Grok's saved-frame fallback.");
                  }
                  pendingVideoAssistantMessageId = assistantMessageId;
                  modelId = RUNPOD_VIDEO_MODEL;
                  const notice = pendingVideoMessage(requestId, sources.length);
                  emitChunk({ type: "metadata", provider: "runpod", modelId: RUNPOD_VIDEO_MODEL,
                    resetText: true, videoFallback: "qwen-durable-background",
                    videoAnalysisPending: true });
                  streamedText = notice;
                  return { text: notice, model: RUNPOD_VIDEO_MODEL,
                    provider: "runpod" as ProviderResponse["provider"] };
                }
                // Do not launch a browser or decode a large private MP4 unless
                // Gemini actually fails and the deterministic Grok fallback runs.
                if (candidate.provider.name === "grok" && hasVideoInput) {
                  for (const video of attachments.filter(isVideoAttachment)) {
                    if (video.videoFrames?.length) continue;
                    console.info("[Video Routing] recovering saved video pixels for Grok fallback", {
                      requestId, fileId: video.fileId,
                      source: savedVideoSourceByFileId.has(video.fileId) ? "saved-conversation" : "signed-upload"
                    });
                    let recovered;
                    const savedSource = savedVideoSourceByFileId.get(video.fileId);
                    try {
                      if (savedSource) {
                        recovered = await recoverSavedVideoFrames(savedSource.chatId ?? chatId, savedSource, actorId);
                      } else {
                        const token = currentUploadVideoTokensByFileId.get(video.fileId);
                        if (!token) throw new Error("Original video source could not be located for this actor.");
                        recovered = await recoverUploadVideoFrames(token);
                      }
                      if (recovered.fileId !== video.fileId || !recovered.videoFrames?.length) {
                        throw new Error("Recovered video evidence did not match the requested attachment.");
                      }
                      video.videoFrames = recovered.videoFrames;
                      registerVideoTiming(video, getVideoTiming(recovered));
                      console.info("[Video Routing] recovered actual frames; Grok retry proceeding", {
                        requestId, fileId: video.fileId, frameCount: video.videoFrames.length
                      });
                    } catch (error) {
                      const reason = error instanceof Error ? error.message : String(error);
                      console.error("[Video Routing] saved source extraction failed; no fake evidence passed to Grok", {
                        requestId, fileId: video.fileId, reason
                      });
                      throw new Error("Gemini and Qwen video analysis failed. Grok cannot inspect the saved video: " + reason);
                    }
                  }
                }
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

                const generation = (selfToolsEnabled && selfInspectionRequest)
                  ? await (async () => {
                      const result = await runSelfInspection({ request, actorId, chatId, requestId, provider,
                        params: finalParams, deadlineMs: executionDeadlineMs,
                        onRecord: record => emitChunk({ type: "metadata", toolCall: record }),
                      });
                      enqueueDelta(result.text);
                      return { result, streamedText: result.text };
                    })()
                  : collaborationEnabledForRequest
                  ? await (async () => {
                      const collaborationBaseParams = baseParams;
                      const collaboration = await runAdaptiveCollaboration({
                        requestId,
                        leadProvider: provider,
                        leadModelId: modelId,
                        providers,
                        params: collaborationBaseParams,
                        resumeState: collaborationResumeState,
                        onResearchEvidence: async (evidence) => {
                          try {
                            await websiteEvidenceStore().save(actorId, chatId, requestId, evidence);
                            savedWebsiteEvidence = evidence;
                          }
                          catch (error) { console.error("[Website evidence] Save failed", { requestId, error: String(error) }); }
                        },
                        onCheckpoint: (state) => { collaborationResumeState = state; },
                        prepareParticipantParams: (participantParams, participantValue, phase) => {
                          if (phase === "final-synthesis") reviewSourceParams = participantParams;
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
                        onFinalTextDelta: suppressCalculationScaffolding || creativeNarrativeRequest || hasVideoInput
                          ? async () => {}
                          : async (delta) => enqueueDelta(delta),
                        maxDelegations: collaborationConfig.maxDelegations,
                        maxDepth: collaborationConfig.maxDepth,
                        maxContributionChars: collaborationConfig.maxContributionChars,
                        maxTotalContributionChars: collaborationConfig.maxTotalContributionChars,
                        participantTimeoutMs: collaborationConfig.participantTimeoutMs,
                        researchTimeoutMs: collaborationConfig.researchTimeoutMs,
                        maxTotalDurationMs: collaborationConfig.maxTotalDurationMs,
                        executionDeadlineMs: collaborationDeadlineMs,
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
                  : responsePolicy.purpose === "conversation"
                    ? await (async () => {
                        // A clarification is a single conversational response,
                        // not an opportunity to launch helper orchestration.
                        const direct = provider.generateStream
                          ? await provider.generateStream(finalParams, {
                              onTextDelta: async delta => enqueueDelta(delta),
                            })
                          : await provider.generate(finalParams);
                        return { result: direct, streamedText: direct.text };
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
                          onFinalTextDelta: suppressCalculationScaffolding || creativeNarrativeRequest || hasVideoInput
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
                let cleanedText = suppressCalculationScaffolding
                  ? sanitizeCalculationResponse(rawText)
                  : rawText;

                // Inspect the complete draft *before* streaming or saving it.
                // If it substantially duplicates recent narrative text, request
                // at most one original continuation from the same model.
                if (creativeNarrativeRequest && cleanedText && !collaborationEnabledForRequest &&
                    generation.result.provider === provider.name &&
                    generation.result.model === modelId &&
                    Date.now() + 45_000 < executionDeadlineMs) {
                  const novelty = await improveCreativeOriginality({
                    text: cleanedText,
                    priorAssistantTexts: historyForProvider
                      .filter(turn => turn.role === "assistant").map(turn => turn.content),
                    rewrite: async () => {
                      const revision = await provider.generate({
                        ...finalParams,
                        persona: finalParams.persona + "\n\n" + CREATIVE_REWRITE_INSTRUCTIONS,
                      });
                      return isLikelyProviderRefusal(revision, provider.name) ? null : revision.text;
                    },
                  });
                  if (novelty.originalOverlap >= 0.38) {
                    console.info("[CreativeQuality] prose repetition reviewed", {
                      requestId, provider: provider.name, model: modelId,
                      rewritten: novelty.revised,
                      originalOverlap: novelty.originalOverlap, finalOverlap: novelty.finalOverlap,
                    });
                  }
                  cleanedText = novelty.text;
                }

                if (suppressCalculationScaffolding && cleanedText !== rawText) {
                  console.info("[Chat API] Removed calculation scratch scaffolding from model response.", {
                    requestId,
                    provider: provider.name,
                    modelId
                  });
                }

                let conversationalResult: ProviderResponse | null = null;
                if (hasVideoInput && !candidate.runpodVideoFallback &&
                    candidate.provider.name === "google" && videoReplyTarget && cleanedText) {
                  const conversational = providers.find(item => item.name === videoReplyTarget.provider);
                  if (!conversational) throw new Error("Selected conversational provider is no longer configured.");
                  const observations = cleanedText + "\n" + buildVideoTimingEvidence(attachments.filter(isVideoAttachment));
                  reviewSourceParams = { ...createParams(videoReplyTarget.model),
                    user: buildContextualVideoReplyPrompt(message, observations), attachments: [], images: [] };
                  conversationalResult = await generateContextualVideoReply({
                    provider: conversational,
                    model: videoReplyTarget.model,
                    persona: personaForGeneration,
                    summary,
                    history: historyForProvider,
                    userQuestion: message,
                    observations,
                  });
                  cleanedText = conversationalResult.text;
                  emitChunk({
                    type: "metadata", provider: conversationalResult.provider,
                    modelId: conversationalResult.model, videoSynthesis: "contextual",
                    resetText: true,
                  });
                  console.info("[Video Routing] contextual conversational reply generated", {
                    requestId, observationModel: candidate.modelId,
                    conversationalModel: conversationalResult.model,
                    observationCharacters: rawText.length,
                  });
                }

                streamedText = cleanedText;
                return {
                  ...(conversationalResult ?? generation.result),
                  text: cleanedText
                };
              },
              detectRefusal: (generationResult, candidate) =>
                hasVideoInput && videoReplyTarget &&
                generationResult.provider === videoReplyTarget.provider &&
                generationResult.model === videoReplyTarget.model
                  ? false // A conversational-model refusal is final; do not bypass it with another visual model.
                  : isLikelyProviderRefusal(generationResult, candidate.provider.name),
              rerouteOnRefusal: async ({ attempt }) => {
                if (hasVideoInput) return null; // Always honor deterministic Grok video-frame fallback.
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
                emitChunk({
                  type: "metadata",
                  modelId: reroutedAttempt.modelId,
                  provider: reroutedAttempt.provider.name,
                  explainer: reroutedAttempt.explainer,
                  resetText: true,
                  providerFailover: {
                    kind: "refusal",
                    from: { provider: attempt.provider.name, modelId: attempt.modelId },
                    to: { provider: reroutedAttempt.provider.name, modelId: reroutedAttempt.modelId },
                    reason: "the model declined the request",
                  },
                });
                console.warn("[Chat API] Provider refusal detected. AI router selected a new candidate.", {
                  requestId,
                  refusedProvider: attempt.provider.name,
                  refusedModelId: attempt.modelId,
                  reroutedProvider: reroutedAttempt.provider.name,
                  reroutedModelId: reroutedAttempt.modelId
                });
              },
              onRefusalFallback: ({ attempt, nextAttempt }) => {
                emitChunk({
                  type: "metadata",
                  modelId: nextAttempt.modelId,
                  provider: nextAttempt.provider.name,
                  resetText: true,
                  providerFailover: {
                    kind: "refusal",
                    from: { provider: attempt.provider.name, modelId: attempt.modelId },
                    to: { provider: nextAttempt.provider.name, modelId: nextAttempt.modelId },
                    reason: "the model declined the request",
                  },
                });
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
                if (selfToolsEnabled && selfInspectionRequest) return null; // Inspection-contract failures cannot be repaired by switching models.
                if (hasVideoInput) return null; // Attempt Grok directly, not another Gemini routing loop.
                if (attempt.runpodImageFallback) return null;
                // Third provider is optional after failures from both image models,
                // never a workaround for their content/safety decisions.
                if (resolvedRequestIntent === "image-generation" &&
                    shouldTryRunpodImage({
                      failures: imageProviderFailures,
                      enabled: runpodImageConfigured() &&
                        !resolvedRoutingIntentForReroute?.secondaryIntents?.includes("safety-sensitive-vision"),
                      hasReferenceImages: Boolean(visualContinuity?.references.length ||
                        rerouteHasVisualInput),
                    })) {
                  console.info("[Image Routing] Both image providers failed; selecting RunPod image fallback", { requestId });
                  return {
                    provider: attempt.provider,
                    modelId: "runpod-image",
                    runpodImageFallback: true,
                    routingSource: "deterministic-fallback" as const,
                  };
                }
                if ((collaborationEnabledForRequest && collaborationDeadlineMs - Date.now() < 195_000) ||
                    !resolvedRoutingIntentForReroute || errorRerouteCount >= maxErrorReroutes) {
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
                  reroutedProvider: reroutedAttempt.runpodImageFallback ? "runpod" : reroutedAttempt.provider.name,
                  reroutedModelId: reroutedAttempt.modelId,
                });
                emitChunk({
                  type: "metadata",
                  modelId: reroutedAttempt.modelId,
                  provider: reroutedAttempt.runpodImageFallback ? "runpod" : reroutedAttempt.provider.name,
                  explainer: reroutedAttempt.explainer,
                  resetText: true,
                  providerFailover: {
                    kind: "error",
                    from: {
                      provider: attempt.provider.name,
                      modelId: attempt.modelId,
                    },
                    to: {
                      provider: reroutedAttempt.runpodImageFallback ? "runpod" : reroutedAttempt.provider.name,
                      modelId: reroutedAttempt.modelId,
                    },
                    reason: describeGenerationFailure(error),
                  },
                });
              },
              onError: ({ attempt, error }) => {
                if (resolvedRequestIntent === "image-generation" &&
                    !attempt.runpodImageFallback &&
                    (attempt.provider.name === "grok" || attempt.provider.name === "google")) {
                  imageProviderFailures.push({
                    provider: attempt.provider.name,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
                const failureScope = classifyGenerationFailure(error);
                if (!attempt.runpodVideoFallback && !attempt.runpodImageFallback) {
                  void quarantineUnavailableModel(attempt.provider.name, attempt.modelId, error)
                    .catch((failure) => console.warn("[ModelRegistry] quarantine_write_failed", {
                      provider: attempt.provider.name, modelId: attempt.modelId,
                      reason: failure instanceof Error ? failure.message : "unknown",
                    }));
                }
                // RunPod is an independent video provider; its failures must
                // never mark Gemini unhealthy in the shared provider registry.
                if (failureScope === "provider" && !attempt.runpodVideoFallback && !attempt.runpodImageFallback) {
                  failedProviderNames.add(attempt.provider.name);
                  void recordSharedProviderFailure(attempt.provider.name, error);
                }
                console.warn("[Chat API] Generation failed", {
                  requestId,
                  provider: attempt.runpodVideoFallback || attempt.runpodImageFallback ? "runpod" : attempt.provider.name,
                  modelId: attempt.modelId,
                  endpoint: attempt.provider.name === "openai"
                    ? (/chat-latest/i.test(attempt.modelId) ? "chat-completions"
                      : /gpt-5|^o[1-4]/i.test(attempt.modelId) ? "responses" : "chat-completions")
                    : "provider-native",
                  ...getProviderErrorDiagnostics(error),
                  failureScope,
                  failureSummary: describeGenerationFailure(error),
                });
              }
            });
            result = generationAttempt.result;
            provider = generationAttempt.attempt.provider;
            modelId = generationAttempt.attempt.runpodImageFallback
              ? generationAttempt.result.model : generationAttempt.attempt.modelId;

            if (!result || (!result.text && !(result.content?.length) && !streamedText)) {
              throw new Error(`AI Provider ${provider.name} returned an empty response.`);
            }

            // On-demand capability escalation also returns live evidence. Save
            // it before review so Adaptive and Off can restore a real baseline.
            if (result.researchEvidence && result.researchEvidence !== savedWebsiteEvidence) {
              try {
                await websiteEvidenceStore().save(actorId, chatId, requestId, result.researchEvidence);
                savedWebsiteEvidence = result.researchEvidence;
              } catch (error) {
                console.error("[Website evidence] Save failed", { requestId, error: String(error) });
              }
            }

            const escalatedConversation = shouldEscalateConversationResponse({
              policy: responsePolicy, responseText: result.text || streamedText,
              usedTools: Boolean(result.researchEvidence || result.collaboration?.used),
            });
            if (escalatedConversation) {
              console.warn("[ResponsePolicy] Unexpected substantive output requires review", { requestId });
            }
            if ((requiredReviewForRequest || (reviewMode === "always" && escalatedConversation)) && !pendingVideoAssistantMessageId) {
              const draftProvider = providers.find(item => item.name === result!.provider) ?? provider;
              const reviewed = await runRequiredDraftReview({
                requestId,
                // "Retry verification" means verify the original saved draft,
                // not a newly generated answer to the user's "yes".
                draft: { ...result, text: candidateForVerification(
                  pendingReviewClarification?.pending ?? null,
                  message,
                  result.text || streamedText,
                ) },
                params: {
                  ...(reviewSourceParams ?? createParams(result.model)),
                  ...(hasVideoInput ? { user: appendVideoEvidenceToUser((reviewSourceParams ?? createParams(result.model)).user, buildVideoTimingEvidence(attachments.filter(isVideoAttachment))) } : {}),
                  ...(result.researchEvidence ? { researchEvidence: result.researchEvidence } : {}),
                },
                assessmentParams: {
                  ...createParams(result.model, true),
                  // Choose the independent task before appending evidence; never include the candidate draft.
                  user: appendVideoEvidenceToUser(buildVideoAssessmentUser({
                    baseUser: createParams(result.model, true).user, savedDraftOriginalTask,
                    pendingClarification: pendingReviewClarification?.pending,
                    latestMessage: message, videos: hasVideoInput ? attachments.filter(isVideoAttachment) : [],
                  }), (mediaMemory?.context ?? "") + (timelineContext ? "\n" + timelineContext : "")),
                  ...(result.researchEvidence ? { researchEvidence: result.researchEvidence } : {}),
                },
                leadProvider: draftProvider,
                deadlineMs: executionDeadlineMs,
                taskProgress: reviewTaskProgress,
                // Stable source identities survive follow-up requests and application switches.
                // A distinct project or question has a different contract key.
                ...(reviewTaskProgress?.projectContext?.userMessageId && reviewTaskProgress?.objective?.userMessageId
                  ? { durableScope: {
                      actorId,
                      projectSourceId: reviewTaskProgress.projectContext.userMessageId,
                      objectiveSourceId: reviewTaskProgress.objective.userMessageId,
                      requirementsRevision: reviewTaskProgress.requirementsRevision ?? 1,
                    } }
                  : {}),
                sourceTurns: buildReviewSourceTurns({
                  history: historyForProvider, latestMessage: message, progress: reviewTaskProgress,
                  savedSourceTurns: pendingReviewClarification?.pending.sourceTurns,
                }),
                observedEvidence: [
                  hasVideoInput ? buildVideoTimingEvidence(attachments.filter(isVideoAttachment)) : "",
                  mediaMemory?.context ?? "", timelineContext ?? "",
                ].filter(Boolean).join("\n\n"),
                prepareParams: (params, participant) => ({
                  ...params,
                  persona: replaceKatieRuntimeContext(params.persona, buildKatieRuntimeContext({
                    provider: participant.provider, modelId: participant.modelId,
                    modelTier: inferModelTier(participant.modelId), classifiedIntent: resolvedRequestIntent,
                    routingAuthority: "explicit-preference", requestId,
                  })),
                }),
                selectHelper: async context => selectCollaborationHelper({
                  requestId: context.requestId, request: context.request, requester: context.requester,
                  providers: providers.filter(candidate => !failedProviderNames.has(candidate.name) &&
                    getAttachmentSupportForProvider(candidate.name, attachments).supported),
                  usedParticipants: context.usedParticipants,
                  modelRegistrySnapshot: await getCollaborationRegistrySnapshot(),
                  actorId, actorRoutingProfile, hasImages: context.hasImages, hasVideoInput,
                }),
                onProgress: detail => {
                  console.info("[RequiredReview] progress", { requestId, detail });
                  emitChunk({ type: "metadata", review: { mode: "always", status: "in_progress", detail } });
                },
              });
              result = reviewed.result;
              streamedText = result.text;
              reviewCompleted = reviewed.audit.status === "approved" || reviewed.audit.status === "revised";
              reviewHasPendingClarification = Boolean(reviewed.audit.pendingClarification);
              if (reviewed.audit.pendingClarification) {
                reviewed.audit.pendingClarification = bindPendingReviewClarification(
                  reviewed.audit.pendingClarification, reviewTaskProgress, taskProgressAssistantMessageId,
                );
              }
              try {
                const { error } = await getSupabaseAdminClient().from("chat_requests")
                  .eq("request_id", requestId).eq("actor_id", actorId).eq("chat_id", chatId)
                  .update({ review_audit: reviewed.audit });
                if (error) throw error;
              } catch (error) {
                console.error("[RequiredReview] audit save failed", { requestId, error });
                if (currentAgentTask()) throw new Error("Independent review audit could not be saved");
              }
              console.info("[RequiredReview] completed", { requestId, status: reviewed.audit.status, reviewer: reviewed.audit.reviewer });
              emitChunk({ type: "metadata", review: {
                mode: "always", status: reviewed.audit.status, reviewer: reviewed.audit.reviewer,
              } });
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

            if (visualContinuity?.references.length && resolvedRequestIntent === "image-generation") {
              let inspection = await verifyVisualContinuity({ references: visualContinuity.references, result: result!, providers });
              if (inspection.status === "fail") {
                console.warn("[VisualContinuity] initial identity mismatch", {
                  requestId, issue: inspection.issue ?? "unknown",
                });
                const repairingProvider = providers.find(candidate => candidate.name === result!.provider);
                if (repairingProvider) {
                  const retryParams = createParams(result.model);
                  const repaired = await repairingProvider.generate({
                    ...retryParams,
                    user: retryParams.user + "\n\nIDENTITY CORRECTION: The previous image did not match the provided face references. " +
                      (inspection.issue ?? "") +
                      " Keep every named person's identity faithful to their numbered reference image. Regenerate the requested scene.",
                  });
                  const secondInspection = await verifyVisualContinuity({
                    references: visualContinuity.references, result: repaired, providers,
                  });
                  if (secondInspection.status === "pass") {
                    result = repaired;
                    inspection = secondInspection;
                  } else {
                    throw new Error("Generated image did not preserve established visual identities; no mismatched image was published.");
                  }
                } else {
                  throw new Error("Visual continuity verification failed and the image provider was unavailable to retry.");
                }
              }
              emitChunk({ type: "metadata", visualContinuity: {
                status: inspection.status,
                subjects: visualContinuity.references.map(ref => ref.key),
              } });
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

            // Final content and structured blocks are committed before the
            // authoritative content event. Interrupted streams never expose
            // unvalidated or unpersisted interactive components.
            const rawAssistantText = result.text || streamedText;
            const presentationResult = presentationEnabled
              ? parsePresentationTail(rawAssistantText, imageAssets)
              : { text: rawAssistantText, presentation: null };
            const assistantText = presentationResult.text;
            const assistantPresentation = presentationResult.presentation;
            if (presentationFilter && reviewMode !== "always") {
              const tail = presentationFilter.finish();
              if (tail) emitChunk({ type: "delta", text: tail });
            }
            console.log("[Chat API] Generation successful. Saving assistant response.");
            const assistantMessageId = pendingVideoAssistantMessageId ?? taskProgressAssistantMessageId;
            await saveMessage(chatId, {
              id: assistantMessageId,
              role: "assistant",
              model: result.model,
              content: assistantText,
              assets: imageAssets,
              ...(assistantPresentation ? { presentation: assistantPresentation } : {}),
            });
            emitChunk({
              type: "content",
              text: assistantText,
              ...(assistantPresentation ? { presentation: assistantPresentation } : {}),
              assets: imageAssets,
              provider: result.provider,
              model: result.model,
            });
            const finalAnswerEvent = reasoningState.finalize(assistantText);
            emitChunk(reasoningState.snapshot());
            emitChunk(finalAnswerEvent);
            if (visualContinuity && imageAssets.length) {
              // Group images never become identity anchors; an explicit portrait correction may replace one.
              try {
                await storeVisualAnchor({
                  actorId, chatId, messageId: assistantMessageId,
                  context: visualContinuity, imageCount: imageAssets.length,
                });
              } catch (error) {
                console.error("[VisualContinuity] generated image was saved but visual anchor was not", {
                  requestId, reason: error instanceof Error ? error.message : String(error),
                });
                emitChunk({ type: "metadata", visualContinuity: { status: "anchor-save-failed" } });
              }
            }
            if (requestTracked && !currentAgentTask()) {
              await completeChatRequest(requestId, {
                assistantMessageId,
                assistantModel: result.model,
                assistantContent: assistantText,
                assistantAssets: imageAssets,
              });
            }
            taskProgress = applyAssistantToTaskProgress(taskProgress, {
              messageId: assistantMessageId, text: assistantText, responsePurpose: responsePolicy.purpose,
            });
            const taskProgressSaved = await saveTaskProgress(actorId, chatId, taskProgress);
            if (currentAgentTask()) {
              if (!taskProgressSaved) throw new Error("Managed task progress could not be saved");
              await completeChatRequest(requestId, {
                assistantMessageId, assistantModel: result.model,
                assistantContent: assistantText, assistantAssets: imageAssets,
              });
            }
            if (pendingReviewClarification) {
              await resolvePendingReviewClarification({
                requestId: pendingReviewClarification.requestId, actorId, chatId, resumedByRequestId: requestId,
                completed: taskProgressSaved && responsePolicy.requiresSubstantiveProcessing &&
                  !pendingVideoAssistantMessageId && !reviewHasPendingClarification &&
                  taskProgress.pending.length === 0 && (!requiredReviewForRequest || reviewCompleted),
              });
            }
            await refreshShortTermMemory(actorId, chatId);

            // The answer is already durable in chat_requests and messages.
            // Never block the HTTP stream / UI completion while an LLM rewrites
            // long-term or intermediate memory. Those tasks can take minutes.
            console.log("[Chat API] reasoning stream metrics", {
              requestId,
              reasoningUpdateCount,
              timeToFirstReasoningUpdateMs: firstReasoningUpdateAtMs === null ? null : firstReasoningUpdateAtMs - requestStartedAtMs,
              timeToFinalAnswerMs: Date.now() - requestStartedAtMs
            });

            // Next.js keeps the function alive for after(), without holding
            // the client connection open. A memory failure cannot invalidate
            // the already-saved assistant response.
            after(async () => {
              console.log("[Chat API] Memory persistence start", { actorId, chatId, requestId });
              try {
                const retention = maybeUpdateLongTermMemory(actorId, chatId, message);
                const cleanup = retention.then(
                  () => maybeRunThirtyMessageCleanup(actorId),
                  () => maybeRunThirtyMessageCleanup(actorId),
                );
                const memoryResults = await Promise.allSettled([
                  retention,
                  maybeUpdateSummary(chatId),
                  cleanup,
                ]);
                memoryResults.forEach((memoryResult, index) => {
                  if (memoryResult.status === "rejected") {
                    console.error(
                      index === 0
                        ? "[Chat API] Long-Term Memory Update Error:"
                        : index === 1
                          ? "[Chat API] Intermediate Memory Update Error:"
                          : "[Chat API] LTM Cleanup Error:",
                      memoryResult.reason,
                    );
                  }
                });
                console.log("[Chat API] Memory persistence complete", { actorId, chatId, requestId });
              } catch (error) {
                console.error("[Chat API] Background memory persistence error", {
                  requestId,
                  reason: error instanceof Error ? error.message : String(error)
                });
              }
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
            await finishChatFailure({
              requestId, chatId, message,
              save: (failure) => saveMessage(chatId, failure),
              markFailed: async (messageId) => {
                if (requestTracked) await failChatRequest(requestId, error, messageId);
              },
              emit: (messageId) => emitChunk({ ...reasoningState.error(message, false), messageId }),
              close: () => { if (!streamCancelled) controller.close(); },
            });
            console.error("[Chat API] reasoning stream error", { requestId, message, streamCancelled });
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


