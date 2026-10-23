"use client";

import Image from "next/image";
import { chatFailureContent } from "@/lib/chat/request-failure";
import EmojiPicker, { Theme } from "emoji-picker-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readPendingAttachments,savePendingAttachments } from "@/lib/ui/pending-attachments";
import { useSavedState } from "@/components/saved-workspace-state";
import type { FileReference } from "@/lib/providers/types";
import { acknowledgeVideoUploads, uploadFilesDirect } from "@/lib/uploads/direct-upload-client";
import type { Message } from "@/lib/types/chat";
import { canSubmitChatRequest } from "@/lib/chat/request-guards";
import {
  applyReasoningEvent,
  createReasoningUiState,
  type ReasoningStreamEvent,
  type ReasoningUiState
} from "@/lib/chat/reasoning-stream";
import { ReasoningExplainerPanel } from "@/components/reasoning-explainer-panel";
import { RememberFaceControl } from "@/components/remember-face-control";
import { MessageReactions } from "@/components/message-reactions";
import { ProjectApprovalCard, type ProjectApproval } from "@/components/project-approval-card";
import {DeveloperResourceCard,type RecoveryProposal} from "@/components/developer-resource-card";

type ProviderName = "openai" | "google" | "grok" | "anthropic";

type ModelRegistryOption = {
  model_id?: unknown;
  modelId?: unknown;
  id?: unknown;
};

type AvailableModelsPayload = Partial<Record<ProviderName, Array<string | ModelRegistryOption>>>;
type AvailableModels = Partial<Record<ProviderName, string[]>>;

type SelectedOverride = {
  providerName: ProviderName;
  modelId: string;
} | null;

interface ChatPanelProps {
  actorId: string;
  chatId: string;
  managedAgentId?: string;
  activeActorName: string;
  activeChatTitle: string;
  activeRepoId: string;
  repoInjectionEnabled: boolean;
}

type CollaborationParticipantUi = {
  provider: string;
  modelId: string;
};

type CollaborationUiEvent = {
  type:
    | "collaboration_started"
    | "research_evidence_collected"
    | "research_evidence_reused"
    | "research_evidence_collection_failed"
    | "delegation_requested"
    | "helper_selected"
    | "helper_completed"
    | "helper_failed"
    | "helper_retrying"
    | "lead_ready"
    | "lead_failed"
    | "lead_replaced"
    | "collaboration_resumed"
    | "reconciliation_started"
    | "reconciliation_completed"
    | "final_synthesis_started"
    | "collaboration_completed"
    | "limit_reached";
  capability?: string;
  delegationIndex?: number;
  depth?: number;
  requester?: CollaborationParticipantUi;
  helper?: CollaborationParticipantUi;
  taskPreview?: string;
  detail?: string;
  durationMs?: number;
};

type CollaborationActivityItem = {
  id: string;
  type: CollaborationUiEvent["type"];
  message: string;
  tone: "active" | "success" | "warning" | "info";
};

type CollaborationUiMetadata = {
  used: boolean;
  delegationCount: number;
  maxDepthReached: number;
  contributors?: Array<{ provider: string; modelId: string }>;
  durationMs?: number;
};

type ChatMetadataChunk = {
  type: "metadata";
  modelId: string;
  provider: string;
  explainer?: SelectionExplainer;
  resetText?: boolean;
  collaborationEvent?: CollaborationUiEvent;
  collaboration?: CollaborationUiMetadata;
  providerFailover?: {
    kind?: "error" | "refusal";
    from: { provider: string; modelId: string };
    to: { provider: string; modelId: string };
    reason: string;
  };
  degradedContext?: {
    kind: string;
    repository?: string | null;
    reason: string;
  } | null;
  replayed?: boolean;
  requestId?: string;
};

function describeProviderFailover(failover: NonNullable<ChatMetadataChunk["providerFailover"]>): string {
  if (failover.kind === "refusal") {
    return `${failover.from.modelId} declined this request. Katie switched to ${failover.to.modelId}.`;
  }
  return `${failover.from.modelId} failed (${failover.reason}). Katie switched to ${failover.to.modelId}.`;
}

function participantLabel(participant?: CollaborationParticipantUi): string {
  return participant?.modelId?.trim() || "another model";
}

function formatDuration(durationMs?: number): string {
  if (typeof durationMs !== "number" || durationMs < 0) {
    return "";
  }
  if (durationMs < 1_000) {
    return ` in ${durationMs} ms`;
  }
  return ` in ${(durationMs / 1_000).toFixed(1)}s`;
}

function userSafeCollaborationDetail(detail?: string): string {
  const normalized = detail?.trim() ?? "";
  if (!normalized) {
    return "";
  }
  if (/empty control response|empty response/i.test(normalized)) {
    return "returned no usable response";
  }
  if (/timed out|timeout/i.test(normalized)) {
    return "timed out";
  }
  if (/no eligible helper|no additional eligible helper/i.test(normalized)) {
    return "no eligible replacement model was available";
  }
  if (/reserved.*final synthesis|time budget/i.test(normalized)) {
    return "Katie is reserving the remaining time for the final answer";
  }
  return "the provider could not complete the delegated task";
}

function collaborationStatusMessage(event: CollaborationUiEvent): string {
  const requester = participantLabel(event.requester);
  const helper = participantLabel(event.helper);
  const capability = event.capability ? ` for ${event.capability}` : "";

  switch (event.type) {
    case "collaboration_started":
      return `${requester} is leading this answer and evaluating where another model can help…`;
    case "research_evidence_collected":
      return `${helper} gathered live source evidence${formatDuration(event.durationMs)}. Katie is sharing it with the other models…`;
    case "research_evidence_reused":
      return "Katie already has current live-source evidence and is reusing it instead of fetching the same pages again.";
    case "research_evidence_collection_failed":
      return "Katie could not complete live source retrieval. The final answer will identify what remains unverified.";
    case "delegation_requested":
      return `${requester} requested another model${capability}…`;
    case "helper_selected":
      return `Katie selected ${helper}${capability}. Waiting for its findings…`;
    case "helper_retrying":
      return `The previous helper failed. Katie is retrying the same task with ${helper}${capability}…`;
    case "helper_completed":
      return `${helper} returned ${event.capability ?? "its"} findings${formatDuration(event.durationMs)}. Katie is evaluating them…`;
    case "helper_failed": {
      const detail = userSafeCollaborationDetail(event.detail);
      return event.helper
        ? `${helper} could not complete the delegated task${detail ? `: ${detail}` : "."}`
        : `Katie could not find a usable helper${capability}${detail ? `: ${detail}` : "."}`;
    }
    case "lead_ready":
      return `${requester} has enough evidence and is preparing the final answer…`;
    case "lead_failed":
      return `${requester} could not complete its pass. Katie is preserving completed work for the final answer…`;
    case "lead_replaced":
      return `${requester} is taking over final synthesis with the completed collaborator evidence intact…`;
    case "collaboration_resumed":
      return "Katie is continuing with the completed research and reviews intact…";
    case "reconciliation_started":
      return "Katie is checking conflicting recommendations against your goals and the evidence…";
    case "reconciliation_completed":
      return "Katie has compared the recommendations and is preparing the final answer…";
    case "final_synthesis_started":
      return `${requester} is synthesizing the collaborators’ findings into one answer…`;
    case "limit_reached": {
      const detail = userSafeCollaborationDetail(event.detail);
      return detail
        ? `${detail}. Katie is moving to final synthesis.`
        : "Katie reached the collaboration budget and is moving to final synthesis.";
    }
    case "collaboration_completed":
      return `Multi-model collaboration complete${formatDuration(event.durationMs)}.`;
    default:
      return "Katie is collaborating across models…";
  }
}

function collaborationActivityTone(
  event: CollaborationUiEvent,
): CollaborationActivityItem["tone"] {
  if (
    event.type === "helper_completed" ||
    event.type === "research_evidence_collected" ||
    event.type === "research_evidence_reused" ||
    event.type === "collaboration_completed"
  ) {
    return "success";
  }
  if (
    event.type === "helper_failed" ||
    event.type === "research_evidence_collection_failed" ||
    event.type === "lead_failed" ||
    event.type === "limit_reached"
  ) {
    return "warning";
  }
  if (
    event.type === "delegation_requested" ||
    event.type === "helper_selected" ||
    event.type === "helper_retrying" ||
    event.type === "lead_replaced" ||
    event.type === "final_synthesis_started"
  ) {
    return "active";
  }
  return "info";
}

type SelectionExplainer = {
  selected_model?: string;
  selected_provider?: string;
  intent?: { label?: string; confidence?: number | null };
  summary?: string;
  preference_profile_applied?: string;
  top_factors?: Array<{ label: string; detail?: string; delta?: number | null }>;
  top_candidates?: Array<{ model?: string; provider?: string; score?: number | null; why_not_selected?: string }> | null;
  selected_source?: "llm-primary" | "deterministic-fallback";
  top_candidate_score?: number | null;
  hard_rule_applied?: string | null;
  fallback_used?: boolean;
  fallback_reason?: string | null;
  override?: { applied?: boolean; reason?: string | null } | null;
};

const MODEL_EXPLAINER_HIDDEN_STORAGE_KEY = "ui:modelExplainerHidden";
const LIVE_REASONING_VISIBLE_STORAGE_KEY = "ui:liveReasoningExplainerVisible";
const FALLBACK_REASONING_CATEGORIES = ["Architecture", "Security", "Complexity", "Cost", "Reliability"];
const MAX_DIRECT_IMAGE_BYTES = 1_750_000;
const MAX_IMAGE_DIMENSION = 1600;
const MIN_IMAGE_DIMENSION = 640;
const IMAGE_JPEG_QUALITY = 0.82;
const MAX_CHAT_REQUEST_BYTES = 3_800_000;
const REQUEST_SIZE_SAFETY_BYTES = 150_000;
const PENDING_CHAT_REQUEST_STORAGE_PREFIX = "chat:pending-request:";
const MOBILE_RECOVERY_POLL_INTERVAL_MS = 1_500;
const MOBILE_RECOVERY_WINDOW_MS = 4 * 60 * 1_000;
const MOBILE_PENDING_MAX_AGE_MS = 30 * 60 * 1_000;

type PendingChatRequest = {
  chatId: string;
  content: string;
  startedAt: string;
  requestId?: string;
};

function pendingChatRequestStorageKey(chatId: string): string {
  return `${PENDING_CHAT_REQUEST_STORAGE_PREFIX}${chatId}`;
}

function readPendingChatRequest(chatId: string): PendingChatRequest | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(pendingChatRequestStorageKey(chatId));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PendingChatRequest>;
    if (
      parsed.chatId !== chatId ||
      typeof parsed.content !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }

    return {
      chatId,
      content: parsed.content,
      startedAt: parsed.startedAt,
      ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}),
    };
  } catch {
    return null;
  }
}

function writePendingChatRequest(pending: PendingChatRequest): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    pendingChatRequestStorageKey(pending.chatId),
    JSON.stringify(pending),
  );
}

function clearPendingChatRequest(chatId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(pendingChatRequestStorageKey(chatId));
}

function waitForRecoveryPoll(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, MOBILE_RECOVERY_POLL_INTERVAL_MS);
  });
}

class TerminalChatError extends Error {
  constructor(message: string, readonly messageId?: string) { super(message); }
}

async function pollForPersistedAssistant(
  chatId: string,
  pending: PendingChatRequest,
  maxWaitMs = MOBILE_RECOVERY_WINDOW_MS,
): Promise<Message[] | null> {
  const startedAtMs = Date.parse(pending.startedAt);
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() <= deadline) {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return null;
    }

    try {
      let requiredAssistantMessageId: string | null = null;

      if (pending.requestId) {
        const statusResponse = await fetch(
          `/api/chat/status?requestId=${encodeURIComponent(pending.requestId)}&chatId=${encodeURIComponent(chatId)}`,
          { cache: "no-store" },
        );

        // An aged, verified missing POST is terminal, rather than trapping the composer.
        if (statusResponse.status === 404 && Number.isFinite(startedAtMs) && Date.now() - startedAtMs >= 30_000) {
          throw new TerminalChatError("Katie did not receive this request. Your message has been restored as a draft; resend it when ready.");
        }

        if (statusResponse.ok) {
          const statusPayload = (await statusResponse.json()) as {
            status?: "processing" | "completed" | "failed";
            assistantMessageId?: string | null;
            error?: string | null;
          };

          if (statusPayload.status === "failed") {
            throw new TerminalChatError(
              statusPayload.error ?? "Katie's server-side request failed.",
              statusPayload.assistantMessageId ?? undefined,
            );
          }

          if (statusPayload.status === "processing") {
            if (Date.now() >= deadline) {
              break;
            }
            await waitForRecoveryPoll();
            continue;
          }

          if (statusPayload.status === "completed") {
            requiredAssistantMessageId = statusPayload.assistantMessageId ?? null;
          }
        }
      }

      const response = await fetch(
        `/api/messages?chatId=${encodeURIComponent(chatId)}`,
        { cache: "no-store" },
      );

      if (response.ok) {
        const payload = (await response.json()) as { messages?: Message[] };
        const serverMessages = payload.messages ?? [];

        if (
          requiredAssistantMessageId &&
          serverMessages.some(
            (candidate) =>
              candidate.role === "assistant" &&
              candidate.id === requiredAssistantMessageId,
          )
        ) {
          return serverMessages;
        }

        let matchingUserIndex = -1;

        for (let index = serverMessages.length - 1; index >= 0; index -= 1) {
          const candidate = serverMessages[index];
          const candidateCreatedAt = Date.parse(candidate.createdAt);
          if (
            candidate.role === "user" &&
            candidate.content === pending.content &&
            Number.isFinite(candidateCreatedAt) &&
            (!Number.isFinite(startedAtMs) || candidateCreatedAt >= startedAtMs - 120_000)
          ) {
            matchingUserIndex = index;
            break;
          }
        }

        if (matchingUserIndex >= 0) {
          const recoveredAssistant = serverMessages
            .slice(matchingUserIndex + 1)
            .find((candidate) => candidate.role === "assistant");

          if (recoveredAssistant) {
            return serverMessages;
          }
        }
      }
    } catch (error) {
      if (error instanceof TerminalChatError) throw error;
      // Mobile connectivity may still be settling after the app resumes.
    }

    if (Date.now() >= deadline) {
      break;
    }
    await waitForRecoveryPoll();
  }

  return null;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image."));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Image reader returned an unexpected result."));
    };
    reader.readAsDataURL(blob);
  });
}

async function normalizeImageForChat(file: File): Promise<string> {
  const directTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (directTypes.has(file.type.toLowerCase()) && file.size <= MAX_DIRECT_IMAGE_BYTES) {
    return readBlobAsDataUrl(file);
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new window.Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`Unable to decode image type ${file.type || "unknown"}.`));
      element.src = objectUrl;
    });

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) {
      throw new Error("Image has invalid dimensions.");
    }

    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Image conversion is unavailable in this browser.");
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const jpegBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
            return;
          }
          reject(new Error("Image conversion failed."));
        },
        "image/jpeg",
        IMAGE_JPEG_QUALITY,
      );
    });

    return readBlobAsDataUrl(jpegBlob);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}


async function compressImageDataUrlToBudget(dataUrl: string, targetBytes: number): Promise<string> {
  if (dataUrl.length <= targetBytes) {
    return dataUrl;
  }

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new window.Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("Unable to decode an image while reducing request size."));
    element.src = dataUrl;
  });

  const originalWidth = image.naturalWidth || image.width;
  const originalHeight = image.naturalHeight || image.height;
  if (!originalWidth || !originalHeight) {
    throw new Error("Image has invalid dimensions.");
  }

  let maxDimension = Math.min(MAX_IMAGE_DIMENSION, Math.max(originalWidth, originalHeight));
  let quality = IMAGE_JPEG_QUALITY;
  let best = dataUrl;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const scale = Math.min(1, maxDimension / Math.max(originalWidth, originalHeight));
    const targetWidth = Math.max(1, Math.round(originalWidth * scale));
    const targetHeight = Math.max(1, Math.round(originalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Image conversion is unavailable in this browser.");
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const jpegBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
            return;
          }
          reject(new Error("Image compression failed."));
        },
        "image/jpeg",
        quality,
      );
    });

    best = await readBlobAsDataUrl(jpegBlob);
    if (best.length <= targetBytes) {
      return best;
    }

    if (quality > 0.58) {
      quality = Math.max(0.58, quality - 0.08);
    } else {
      maxDimension = Math.max(MIN_IMAGE_DIMENSION, Math.floor(maxDimension * 0.8));
    }
  }

  return best;
}

async function fitImagesToAggregateBudget(images: string[], targetBytes: number): Promise<string[]> {
  if (!images.length) {
    return images;
  }

  let next = [...images];
  if (next.reduce((total, image) => total + image.length, 0) <= targetBytes) {
    return next;
  }

  for (let round = 0; round < 4; round += 1) {
    const totalBytes = next.reduce((total, image) => total + image.length, 0);
    if (totalBytes <= targetBytes) {
      return next;
    }

    const ratio = Math.max(0.35, Math.min(0.92, targetBytes / totalBytes));
    const perImageTargets = next.map((image) =>
      Math.max(120_000, Math.floor(image.length * ratio * 0.92)),
    );

    next = await Promise.all(
      next.map((image, index) => compressImageDataUrlToBudget(image, perImageTargets[index])),
    );
  }

  return next;
}

function serializedByteSize(value: string): number {
  return new Blob([value]).size;
}

function hasExplainerData(explainer: SelectionExplainer | null): explainer is SelectionExplainer {
  if (!explainer) {
    return false;
  }

  return Boolean(
    explainer.selected_model ||
      explainer.selected_provider ||
      explainer.intent?.label ||
      (explainer.top_factors && explainer.top_factors.length > 0) ||
      (explainer.top_candidates && explainer.top_candidates.length > 0) ||
      typeof explainer.top_candidate_score === "number" ||
      explainer.hard_rule_applied ||
      explainer.selected_source ||
      explainer.fallback_used ||
      (explainer.override?.applied && explainer.override.reason),
  );
}

function formatSignedDelta(delta?: number | null): string {
  if (typeof delta !== "number" || Number.isNaN(delta)) {
    return "—";
  }
  return delta > 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
}

function formatIntentLabel(label?: string): string {
  if (!label) {
    return "unknown";
  }
  return label.replaceAll("-", " ");
}

function normalizeModelOption(option: string | ModelRegistryOption): string | null {
  if (typeof option === "string") {
    const value = option.trim();
    return value.length > 0 ? value : null;
  }

  if (!option || typeof option !== "object") {
    return null;
  }

  const candidate =
    typeof option.model_id === "string"
      ? option.model_id
      : typeof option.modelId === "string"
        ? option.modelId
        : typeof option.id === "string"
          ? option.id
          : "";
  const value = candidate.trim();
  return value.length > 0 ? value : null;
}

function normalizeAvailableModels(payload: unknown): AvailableModels {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const normalized: AvailableModels = {};
  for (const providerName of Object.keys(payload) as ProviderName[]) {
    const rawOptions = (payload as AvailableModelsPayload)[providerName];
    if (!Array.isArray(rawOptions)) {
      normalized[providerName] = [];
      continue;
    }

    const options = rawOptions
      .map((option) => normalizeModelOption(option))
      .filter((option): option is string => Boolean(option));

    normalized[providerName] = Array.from(new Set(options));
  }

  return normalized;
}

export function ChatPanel({
  managedAgentId,
  actorId,
  chatId,
  activeActorName,
  activeChatTitle,
  activeRepoId,
  repoInjectionEnabled,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [projectApproval, setProjectApproval] = useState<{chatId:string;approval:ProjectApproval}|null>(null);
  const [projectApprovalPending, setProjectApprovalPending] = useState(false);
  const [resourceRecovery, setResourceRecovery] = useState<{chatId:string;proposal:RecoveryProposal}|null>(null);
  const [projectApprovalError, setProjectApprovalError] = useState<string|null>(null);
  const [messagesByChatId, setMessagesByChatId] = useState<Record<string, Message[]>>({});
  const [isHydratingMessages, setIsHydratingMessages] = useState(false);
  const [input, setInput] = useState("");
  const draft=useSavedState(`chat:${chatId}`);
  const saveDraft=draft.save;
  const [draftReady,setDraftReady]=useState(false);
  useEffect(()=>{const compose=(event:Event)=>{const value=(event as CustomEvent<{chatId:string;text:string}>).detail;if(value.chatId===chatId){setInput(value.text);requestAnimationFrame(()=>textareaRef.current?.focus());}};window.addEventListener("katie:compose-correction",compose);return()=>window.removeEventListener("katie:compose-correction",compose);},[chatId]);
  const draftInitialized=useRef(false);
  useEffect(()=>{
    if(draftInitialized.current||!draft.state)return;
    draftInitialized.current=true;
    let local="";try{local=window.sessionStorage.getItem(`katie.draft.v1.${chatId}`)??"";}catch{}
    setInput(local||draft.state.value.draft||"");setDraftReady(true);
  },[chatId,draft.state]);
  useEffect(()=>{
    if(!draft.error||draftInitialized.current)return;
    draftInitialized.current=true;
    try{setInput(window.sessionStorage.getItem(`katie.draft.v1.${chatId}`)??"");}catch{}
    setDraftReady(true);
  },[chatId,draft.error]);
  useEffect(()=>{if(!draftReady)return;try{window.sessionStorage.setItem(`katie.draft.v1.${chatId}`,input);}catch{}},[input,chatId,draftReady]);
  useEffect(()=>{
    if(!draftReady||!draft.state||draft.state.value.draft===input||draft.error)return;
    const timer=window.setTimeout(()=>{void saveDraft({draft:input});},700);
    return()=>window.clearTimeout(timer);
  },[input,draftReady,draft.state,saveDraft,draft.error]);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<{ provider: string; model: string } | null>(
    null,
  );
  const [availableModels, setAvailableModels] = useState<AvailableModels>({});
  const [selectedOverride, setSelectedOverride] =
    useState<SelectedOverride>(null);
  const [streamingModel, setStreamingModel] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [selectedImageFiles, setSelectedImageFiles] = useState<File[]>([]);
  const [selectedVideos, setSelectedVideos] = useState<File[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [fileReferences, setFileReferences] = useState<FileReference[]>([]);
  const [attachmentsReady,setAttachmentsReady]=useState(false);
  const [attachmentSaveError,setAttachmentSaveError]=useState(false);
  useEffect(()=>{let active=true;readPendingAttachments(chatId).then(value=>{if(!active)return;if(value){setSelectedImages(value.images);setSelectedImageFiles(value.imageFiles);setSelectedVideos(value.videos);setSelectedFiles(value.files);setFileReferences(value.references);}setAttachmentsReady(true);}).catch(()=>{if(active)setAttachmentsReady(true);});return()=>{active=false;};},[chatId]);
  useEffect(()=>{if(!attachmentsReady)return;void savePendingAttachments(chatId,{images:selectedImages,imageFiles:selectedImageFiles,videos:selectedVideos,files:selectedFiles,references:fileReferences}).then(()=>setAttachmentSaveError(false)).catch(()=>setAttachmentSaveError(true));},[chatId,attachmentsReady,selectedImages,selectedImageFiles,selectedVideos,selectedFiles,fileReferences]);
  const [statusMessage, setStatusMessage] = useState("");
  const [failoverNotice, setFailoverNotice] = useState("");
  const [collaborationActivity, setCollaborationActivity] = useState<CollaborationActivityItem[]>([]);
  const [collaborationActive, setCollaborationActive] = useState(false);
  const [collaborationSummary, setCollaborationSummary] = useState<CollaborationUiMetadata | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [showModelControls, setShowModelControls] = useState(true);
  const [selectionExplainer, setSelectionExplainer] = useState<SelectionExplainer | null>(null);
  const [isRoutingSelectionInFlight, setIsRoutingSelectionInFlight] = useState(false);
  const [modelExplainerHidden, setModelExplainerHidden] = useState(false);
  const [showLiveReasoningExplainer, setShowLiveReasoningExplainer] = useState(true);
  const [reasoningState, setReasoningState] = useState<ReasoningUiState>(createReasoningUiState);
  const [reasoningPopupVisible, setReasoningPopupVisible] = useState(false);
  const [reasoningPopupDismissed, setReasoningPopupDismissed] = useState(false);
  const [explainerOpen, setExplainerOpen] = useState(false);
  const messagesContainerRef = useRef<HTMLElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const recoveryPollingRef = useRef(false);
  const buildVersionRef = useRef<string | null>(null);
  const copiedFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reasoningPopupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explainerContainerRef = useRef<HTMLDivElement>(null);

  const hasValidChatSelection = useMemo(
    () => canSubmitChatRequest(actorId, chatId),
    [actorId, chatId],
  );

  const canSend = useMemo(
    () =>
      !managedAgentId && draftReady && attachmentsReady && hasValidChatSelection &&
      (input.trim().length > 0 ||
        selectedImages.length > 0 ||
        selectedVideos.length > 0 ||
        selectedFiles.length > 0 ||
        fileReferences.length > 0) &&
      !loading &&
      !uploadingFiles,
    [
      input,
      loading,
      selectedFiles.length,
      selectedImages.length,
      selectedVideos.length,
      uploadingFiles,
      fileReferences.length,
      hasValidChatSelection,
      managedAgentId,
      draftReady,
      attachmentsReady,
    ],
  );

  const scrollToTop = () => {
    messagesContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const scrollToBottom = () => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      return;
    }

    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const recordCollaborationEvent = (event: CollaborationUiEvent) => {
    const message = collaborationStatusMessage(event);
    setStatusMessage(message);
    setCollaborationActivity((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        type: event.type,
        message,
        tone: collaborationActivityTone(event),
      },
    ].slice(-14));

    if (event.type === "collaboration_started" || event.type === "collaboration_resumed") {
      setCollaborationActive(true);
    }
    if (event.type === "collaboration_completed") {
      setCollaborationActive(false);
    }

    if (
      (event.type === "helper_selected" || event.type === "helper_retrying") &&
      event.helper?.modelId
    ) {
      setStreamingModel(event.helper.modelId);
    } else if (
      (event.type === "collaboration_started" ||
        event.type === "lead_ready" ||
        event.type === "lead_failed" ||
        event.type === "lead_replaced" ||
        event.type === "collaboration_resumed" ||
        event.type === "reconciliation_started" ||
        event.type === "reconciliation_completed" ||
        event.type === "final_synthesis_started" ||
        event.type === "helper_failed" ||
        event.type === "limit_reached") &&
      event.requester?.modelId
    ) {
      setStreamingModel(event.requester.modelId);
    }
  };

  useEffect(() => {
    async function fetchModels() {
      const response = await fetch("/api/models");
      const data = (await response.json()) as unknown;

      if (!response.ok) {
        return;
      }

      setAvailableModels(normalizeAvailableModels(data));
    }

    void fetchModels();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  useEffect(() => {
    let cancelled = false;

    async function checkBuildVersion() {
      if (
        typeof window === "undefined" ||
        typeof document === "undefined" ||
        document.visibilityState === "hidden"
      ) {
        return;
      }

      try {
        const response = await fetch("/api/version", { cache: "no-store" });
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { version?: string };
        const version = typeof payload.version === "string" ? payload.version : "";
        if (!version || cancelled) {
          return;
        }

        if (!buildVersionRef.current) {
          buildVersionRef.current = version;
          return;
        }

        if (buildVersionRef.current === version) {
          return;
        }

        // Do not reload while a request is actively being sent/recovered.
        // The next foreground event will check again after that work settles.
        if (
          abortControllerRef.current ||
          recoveryPollingRef.current ||
          readPendingChatRequest(chatId)
        ) {
          return;
        }

        window.location.reload();
      } catch {
        // Version detection is best-effort and must never interrupt chat use.
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void checkBuildVersion();
      }
    }

    function handlePageShow() {
      void checkBuildVersion();
    }

    void checkBuildVersion();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [chatId]);

  useEffect(()=>{if(isHydratingMessages)return;const frame=requestAnimationFrame(()=>{try{const saved=window.sessionStorage.getItem(`katie.scroll.v1.${chatId}`);if(saved&&messagesContainerRef.current)messagesContainerRef.current.scrollTop=Number(saved);}catch{}});return()=>cancelAnimationFrame(frame);},[chatId,isHydratingMessages]);

  const messagesByChatIdRef = useRef<Record<string, Message[]>>({});

  useEffect(() => {
    messagesByChatIdRef.current = messagesByChatId;
  }, [messagesByChatId]);

  useEffect(() => {
    let cancelled = false;

    async function fetchMessages() {
      abortControllerRef.current?.abort();
      setMeta(null);
      setSelectionExplainer(null);
      setIsRoutingSelectionInFlight(false);
      setExplainerOpen(false);
      setStatusMessage("");
      setFailoverNotice("");
      setStreamingModel(null);
      setCollaborationActivity([]);
      setCollaborationActive(false);
      setCollaborationSummary(null);
      setReasoningState(createReasoningUiState());
      setReasoningPopupVisible(false);
      setCopiedMessageId(null);

      if (!chatId) {
        setMessages([]);
        setIsHydratingMessages(false);
        return;
      }

      const cachedMessages = messagesByChatIdRef.current[chatId];
      if (cachedMessages !== undefined) {
        setMessages(cachedMessages);
        setIsHydratingMessages(false);
      } else {
        setIsHydratingMessages(true);
      }

      try {
        const response = await fetch(`/api/messages?chatId=${encodeURIComponent(chatId)}`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as { messages?: Message[]; error?: string };

        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to load messages.");
        }

        if (!cancelled) {
          const nextMessages = payload.messages ?? [];
          setMessages(nextMessages);
          setMessagesByChatId((current) => ({ ...current, [chatId]: nextMessages }));
          setIsHydratingMessages(false);
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setStatusMessage(error instanceof Error ? error.message : "Failed to load messages.");
          setIsHydratingMessages(false);
        }
      }
    }

    void fetchMessages();

    return () => {
      cancelled = true;
    };
  }, [chatId]);

  const projectProgressSignature = useMemo(() => messages.filter(m=>m.role==='assistant'&&m.content.includes('<!-- katie-project-status:')).map(m=>m.id+':'+m.content.match(/<!-- katie-project-status:[a-f0-9-]+:([^ ]+) -->/)?.[1]).join('|'),[messages]);
  useEffect(()=>{
    if(!chatId||!actorId||loading)return;
    let cancelled=false,inFlight=false,done=false;
    setProjectApproval(null);
    setResourceRecovery(null);
    setProjectApprovalError(null);
    const refresh=async()=>{
      if(cancelled||inFlight||done||document.visibilityState==='hidden')return;
      inFlight=true;
      try {
        const r=await fetch('/api/projects?chatId='+encodeURIComponent(chatId)+'&actorId='+encodeURIComponent(actorId),{cache:'no-store'});
        if(!r.ok)return;
        const p=await r.json() as {active:boolean;status:string|null;executivePending?:boolean;approval:ProjectApproval|null;resourceRecovery:RecoveryProposal|null;messages:Message[]};
        if(cancelled)return;
        setProjectApproval(p.approval?{chatId,approval:p.approval}:null);
        setResourceRecovery(p.resourceRecovery?{chatId,proposal:p.resourceRecovery}:null);
        // Executive missions can deliver after the immediate chat reply, even
        // without a software project (or after its completion). Stop only when
        // its terminal reply is included in this persisted message snapshot.
        done=(!p.status||['completed','stopped'].includes(p.status))&&!p.executivePending;
        if(!Array.isArray(p.messages))return;
        setMessages(current=>current.length===p.messages.length&&current.every((m,i)=>m.id===p.messages[i].id&&m.content===p.messages[i].content)?current:p.messages);
        setMessagesByChatId(current=>({...current,[chatId]:p.messages}));
      } catch { /* Persisted progress remains available; retry on the next tick. */ }
      finally {inFlight=false;}
    };
    const timer=window.setInterval(()=>{void refresh();},15000);
    const resume=()=>{done=false;void refresh();};
    window.addEventListener('focus',resume);
    document.addEventListener('visibilitychange',resume);
    void refresh();
    return()=>{cancelled=true;window.clearInterval(timer);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};
  },[actorId,chatId,loading,projectProgressSignature]);

  async function approveProject(hash:string) {
    if(!chatId||!actorId||projectApprovalPending||loading)return;
    setProjectApprovalPending(true);
    setProjectApprovalError(null);
    try {
      const response=await fetch('/api/projects',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({actorId,chatId,approvalHash:hash}),
      });
      const result=await response.json() as {error?:string;status?:string;messages?:Message[]};
      if(!response.ok)throw Error(result.error??'Could not approve project.');
      setProjectApproval(null);
      if(Array.isArray(result.messages)){
        setMessages(result.messages);
        setMessagesByChatId(current=>({...current,[chatId]:result.messages!}));
      }
      setStatusMessage('Project approved. Katie can now begin approved coding milestones.');
    }catch(error){
      setProjectApprovalError(error instanceof Error?error.message:'Approval failed. Refresh the project scope.');
    }finally {setProjectApprovalPending(false);}
  }

  async function approveRecovery(hash:string,ceiling:number,hours:48|72){
    if(!chatId||!actorId||projectApprovalPending||loading)return;
    setProjectApprovalPending(true);setProjectApprovalError(null);
    try{
      const response=await fetch('/api/projects',{method:'PATCH',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({actorId,chatId,scopeHash:hash,authorizedCeiling:ceiling,renewalHours:hours})});
      const result=await response.json() as {error?:string};
      if(!response.ok)throw Error(result.error??'Resource approval failed');
      setResourceRecovery(null);
      setStatusMessage('Resource authorization saved. Katie will attempt recovery from the existing checkpoint.');
    }catch(e){setProjectApprovalError(e instanceof Error?e.message:'Resource approval failed');}
    finally{setProjectApprovalPending(false);}
  }

  function requestProjectChanges() {
    setInput("Change this project's scope: ");
    requestAnimationFrame(()=>textareaRef.current?.focus());
  }

  // The RunPod/Grok work is durable and finishes after the chat stream closes.
  // Re-fetch only while a video placeholder exists, including after mobile
  // backgrounding. No persistent browser connection is required.
  const [videoProgress, setVideoProgress] = useState<Record<string, {
    stage: string; submittedAt: string; elapsedSeconds: number;
    videoCount: number; completedCount: number; failedCount: number;
  }>>({});
  const pendingVideoMessageIds = useMemo(() =>
    messages.filter(message => message.role === "assistant" &&
      message.content.startsWith("[Katie video analysis pending:"))
      .map(message => message.id).sort().join("|"), [messages]);

  useEffect(() => {
    if (!chatId || !pendingVideoMessageIds || loading) return;
    let cancelled = false;
    let inFlight = false;
    async function refreshCompletedVideos() {
      if (cancelled || inFlight ||
          (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      inFlight = true;
      try {
        const response = await fetch("/api/messages?chatId=" + encodeURIComponent(chatId), {
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = await response.json() as {
          messages?: Message[];
          videoProgress?: Record<string, { stage: string; submittedAt: string;
            elapsedSeconds: number; videoCount: number; completedCount: number; failedCount: number }>;
        };
        if (!cancelled) setVideoProgress(payload.videoProgress ?? {});
        if (cancelled || !Array.isArray(payload.messages)) return;
        const nextMessages = payload.messages;
        setMessages(current => {
          const unchanged = current.length === nextMessages.length &&
            current.every((message, index) =>
              message.id === nextMessages[index].id &&
              message.content === nextMessages[index].content);
          return unchanged ? current : nextMessages;
        });
        setMessagesByChatId(current => ({ ...current, [chatId]: nextMessages }));
      } catch (error) {
        console.warn("[Video Delivery] chat refresh will retry", error);
      } finally {
        inFlight = false;
      }
    }
    const interval = window.setInterval(() => { void refreshCompletedVideos(); }, 7_000);
    const onResume = () => { void refreshCompletedVideos(); };
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    void refreshCompletedVideos();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [chatId, pendingVideoMessageIds, loading]);

  useEffect(() => {
    let cancelled = false;

    async function recoverAfterResume() {
      if (
        typeof window === "undefined" ||
        typeof document === "undefined" ||
        document.visibilityState === "hidden" ||
        abortControllerRef.current ||
        recoveryPollingRef.current
      ) {
        return;
      }

      const pending = readPendingChatRequest(chatId);
      if (!pending) {
        return;
      }

      const pendingAgeMs = Date.now() - Date.parse(pending.startedAt);
      if (Number.isFinite(pendingAgeMs) && pendingAgeMs > MOBILE_PENDING_MAX_AGE_MS) {
        clearPendingChatRequest(chatId);
        return;
      }

      recoveryPollingRef.current = true;
      setLoading(true);
      setStatusMessage("Reconnecting to Katie and checking for the completed response…");

      try {
        const recoveredMessages = await pollForPersistedAssistant(
          chatId,
          pending,
          MOBILE_RECOVERY_WINDOW_MS,
        );

        if (cancelled || !recoveredMessages) {
          return;
        }

        clearPendingChatRequest(chatId);
        setMessages(recoveredMessages);
        setMessagesByChatId((current) => ({
          ...current,
          [chatId]: recoveredMessages,
        }));

        const recoveredAssistant = [...recoveredMessages]
          .reverse()
          .find((message) => message.role === "assistant");
        if (recoveredAssistant?.model) {
          setMeta({ provider: "recovered", model: recoveredAssistant.model });
        }

        setStatusMessage(
          "Katie finished while this screen was away. The saved response has been restored.",
        );
      } catch (error) {
        if (error instanceof TerminalChatError) {
          clearPendingChatRequest(chatId);
          if (!cancelled) setInput(pending.content);
          if (!cancelled) {
            const failure: Message = { id: error.messageId ?? pending.requestId ?? crypto.randomUUID(), chatId,
              role: "assistant", content: chatFailureContent(error.message), createdAt: new Date().toISOString() };
            setMessages(current => {
              const next = [...current.filter(entry => entry.id !== failure.id), failure];
              setMessagesByChatId(cache => ({ ...cache, [chatId]: next }));
              return next;
            });
            setStatusMessage(failure.content);
          }
        } else {
          console.error("[ChatPanel] recovery failed", error);
        }
      } finally {
        recoveryPollingRef.current = false;
        if (!cancelled) {
          setLoading(false);
          setStreamingModel(null);
          setIsRoutingSelectionInFlight(false);
        }
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void recoverAfterResume();
      }
    }

    function handlePageShow() {
      void recoverAfterResume();
    }

    void recoverAfterResume();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [chatId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const saved = window.localStorage.getItem(LIVE_REASONING_VISIBLE_STORAGE_KEY);
    if (saved === "false") {
      setShowLiveReasoningExplainer(false);
    }
  }, []);

  function handleLiveReasoningVisibility(nextVisible: boolean) {
    setShowLiveReasoningExplainer(nextVisible);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LIVE_REASONING_VISIBLE_STORAGE_KEY, nextVisible ? "true" : "false");
    }
  }

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
      if (copiedFeedbackTimeoutRef.current) {
        clearTimeout(copiedFeedbackTimeoutRef.current);
      }
      if (reasoningPopupTimeoutRef.current) {
        clearTimeout(reasoningPopupTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (reasoningPopupTimeoutRef.current) {
      clearTimeout(reasoningPopupTimeoutRef.current);
      reasoningPopupTimeoutRef.current = null;
    }

    if (!showLiveReasoningExplainer) {
      setReasoningPopupVisible(false);
      setReasoningPopupDismissed(false);
      return;
    }

    if (loading) {
      if (!reasoningPopupDismissed) {
        setReasoningPopupVisible(true);
      }
      return;
    }

    if (!reasoningPopupVisible) {
      return;
    }

    const closeDelay = reasoningState.error
      ? 3000
      : collaborationActivity.length > 0
        ? 5000
        : 1500;
    reasoningPopupTimeoutRef.current = setTimeout(() => {
      setReasoningPopupVisible(false);
    }, closeDelay);

    return () => {
      if (reasoningPopupTimeoutRef.current) {
        clearTimeout(reasoningPopupTimeoutRef.current);
        reasoningPopupTimeoutRef.current = null;
      }
    };
  }, [
    collaborationActivity.length,
    loading,
    reasoningPopupDismissed,
    reasoningPopupVisible,
    reasoningState.error,
    showLiveReasoningExplainer,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storedValue = window.localStorage.getItem(MODEL_EXPLAINER_HIDDEN_STORAGE_KEY);
    setModelExplainerHidden(storedValue === "true");
  }, []);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!explainerContainerRef.current) {
        return;
      }

      const target = event.target;
      if (target instanceof Node && !explainerContainerRef.current.contains(target)) {
        setExplainerOpen(false);
      }
    }

    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setExplainerOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  async function uploadFiles(files: File[], handoffRequestId?: string): Promise<FileReference[]> {
    if (files.length === 0) {
      return [];
    }

    setUploadingFiles(true);
    setStatusMessage(
      `Uploading ${files.length} file${files.length > 1 ? "s" : ""}...`,
    );

    try {
      return await uploadFilesDirect(files, setStatusMessage, undefined, undefined,
        handoffRequestId ? { handoffRequestId } : {});
    } finally {
      setUploadingFiles(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (managedAgentId) {
      setStatusMessage("Continue managed tasks from Agents management to preserve the saved configuration.");
      return;
    }
    if (!hasValidChatSelection) {
      setStatusMessage(
        "Open a conversation before sending a message.",
      );
      return;
    }
    if (!canSend) {
      return;
    }

    const content = input.trim();
    let imagesToSend = [...selectedImages];
    const imageFilesToUpload = [...selectedImageFiles];
    const videosToUpload = [...selectedVideos];
    const filesToUpload = [...selectedFiles];
    const priorReferences = [...fileReferences];
    const hasImages = imagesToSend.length > 0;

    setInput("");
    setSelectedImages([]);
    setSelectedImageFiles([]);
    setSelectedVideos([]);
    setSelectedFiles([]);
    setFileReferences([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setLoading(true);
    setStreamingModel(null);
    setSelectionExplainer(null);
    setIsRoutingSelectionInFlight(true);
    setExplainerOpen(true);
    setCollaborationActivity([]);
    setCollaborationActive(false);
    setCollaborationSummary(null);
    setStatusMessage("Routing request and selecting the lead model…");
    setFailoverNotice("");
    setReasoningState(createReasoningUiState());
    if (showLiveReasoningExplainer) {
      setReasoningPopupDismissed(false);
      setReasoningPopupVisible(true);
    }

    const optimisticUserMessage: Message = {
      id: crypto.randomUUID(),
      chatId,
      role: "user",
      content,
      assets: imagesToSend.map((url) => ({ type: "image", url })),
      createdAt: new Date().toISOString(),
    };

    setMessages((current) => {
      const nextMessages = [...current, optimisticUserMessage];
      setMessagesByChatId((cache) => ({ ...cache, [chatId]: nextMessages }));
      return nextMessages;
    });

    let requestStage = "preparing attachments";
    let uploadedReferencesForRetry: FileReference[] | null = null;
    const clientRequestId = crypto.randomUUID();

    try {
      // Register an actor/chat-scoped server-side obligation BEFORE transferring
      // video bytes. A mobile disconnect no longer strands a completed upload.
      // Mixed messages retain their established chat path until their full
      // attachment manifest can be persisted and replayed identically.
      const durableVideo = videosToUpload.length > 0 &&
        filesToUpload.length === 0 && imageFilesToUpload.length === 0 &&
        priorReferences.length === 0 && imagesToSend.length === 0;
      if (durableVideo) {
        requestStage = "registering durable video request";
        setStatusMessage("Saving video request so Katie can finish if this device disconnects…");
        const registered = await fetch("/api/video-handoffs", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: clientRequestId, actorId, chatId,
            message: content || "[video]",
            files: videosToUpload.map(file => ({
              name: file.name, type: file.type, size: file.size,
            })),
            overrideProvider: selectedOverride?.providerName,
            overrideModel: selectedOverride?.modelId,
            activeRepoId: activeRepoId || undefined, repoInjectionEnabled,
          }),
        });
        if (!registered.ok) {
          const failure = await registered.json().catch(() => ({})) as {error?: string};
          throw new Error(failure.error || "Cannot save the video recovery record.");
        }
      }
      const uploadedReferences =
        filesToUpload.length + videosToUpload.length + imageFilesToUpload.length > 0
          ? await uploadFiles([...filesToUpload, ...videosToUpload, ...imageFilesToUpload],
              durableVideo ? clientRequestId : undefined)
          : [];
      const refsToSend = [...priorReferences, ...uploadedReferences];
      uploadedReferencesForRetry = refsToSend;
      // Images now travel through private direct storage, just like other files.
      imagesToSend = [];
      console.log("[ChatPanel] sending file references", {
        count: refsToSend.length,
        fileReferences: refsToSend.map((reference) => ({
          fileName: reference.fileName,
          attachmentKind: reference.attachmentKind,
          extractedTextLength: reference.extractedText?.length ?? 0,
          extractedChunksLength: reference.extractedChunks?.length ?? 0,
        })),
      });

      const requestContent =
        content || (hasImages ? "[image]" : videosToUpload.length > 0 ? "[video]" : "[file]");

      const buildChatRequestBody = (requestImages: string[]) =>
        JSON.stringify({
          actorId,
          chatId,
          message: requestContent,
          images: requestImages,
          fileReferences: refsToSend,
          overrideProvider: selectedOverride?.providerName,
          overrideModel: selectedOverride?.modelId,
          activeRepoId: activeRepoId || undefined,
          repoInjectionEnabled,
        });

      let requestBody = buildChatRequestBody(imagesToSend);
      let requestBytes = serializedByteSize(requestBody);

      if (requestBytes > MAX_CHAT_REQUEST_BYTES && imagesToSend.length > 0) {
        requestStage = "optimizing images for request size";
        setStatusMessage("Optimizing images for upload…");

        const bodyWithoutImages = buildChatRequestBody([]);
        const nonImageBytes = serializedByteSize(bodyWithoutImages);
        const imageBudget = MAX_CHAT_REQUEST_BYTES - nonImageBytes - REQUEST_SIZE_SAFETY_BYTES;

        if (imageBudget <= 0) {
          throw new Error("The non-image attachments in this message are too large to send.");
        }

        imagesToSend = await fitImagesToAggregateBudget(imagesToSend, imageBudget);
        requestBody = buildChatRequestBody(imagesToSend);
        requestBytes = serializedByteSize(requestBody);
      }

      console.info("[ChatPanel] chat request size", {
        requestBytes,
        maxRequestBytes: MAX_CHAT_REQUEST_BYTES,
        imageCount: imagesToSend.length,
        imageBytes: imagesToSend.reduce((total, image) => total + image.length, 0),
      });

      if (requestBytes > MAX_CHAT_REQUEST_BYTES) {
        throw new Error(
          `This message is still too large to send after image compression (${Math.ceil(requestBytes / 1_000_000)} MB). Remove an attachment and try again.`,
        );
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      writePendingChatRequest({
        chatId,
        content: requestContent,
        startedAt: optimisticUserMessage.createdAt,
        requestId: clientRequestId,
      });

      requestStage = "sending chat request";
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": clientRequestId,
        },
        signal: abortController.signal,
        body: requestBody,
      });

      if (response.ok) {
        // Only discard resumable receipts after the server accepts the chat.
        acknowledgeVideoUploads(videosToUpload);
      }

      if (response.status === 202) {
        setStatusMessage(
          "Katie is already processing this request. Reconnecting to the existing server-side job…",
        );
        const pending =
          readPendingChatRequest(chatId) ?? {
            chatId,
            content: requestContent,
            startedAt: optimisticUserMessage.createdAt,
            requestId: clientRequestId,
          };
        const recoveredMessages = await pollForPersistedAssistant(
          chatId,
          pending,
          MOBILE_RECOVERY_WINDOW_MS,
        );

        if (recoveredMessages) {
          clearPendingChatRequest(chatId);
          setMessages(recoveredMessages);
          setMessagesByChatId((cache) => ({
            ...cache,
            [chatId]: recoveredMessages,
          }));
          setStatusMessage("Existing Katie request completed and was restored.");
        }
        return;
      }

      if (!response.ok) {
        const responseText = await response.text();
        let serverMessage = responseText || `Request failed with status ${response.status}.`;

        try {
          const parsed = JSON.parse(responseText) as { error?: string };
          serverMessage = parsed.error ?? serverMessage;
        } catch {
          // Vercel can reject oversized requests before Next.js executes, returning a non-JSON 413 response.
        }

        if (response.status === 413) {
          serverMessage = "The image upload is still too large for the server. Katie compressed it, but the request exceeded the upload limit.";
        }

        const httpCause =
          response.status === 413
            ? serverMessage
            : `Server request failed (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}): ${serverMessage}`;

        const failureMessage: Message = {
          id: crypto.randomUUID(),
          chatId,
          role: "assistant",
          content: httpCause,
          createdAt: new Date().toISOString(),
        };
        setMessages((current) => {
          const nextMessages = [...current, failureMessage];
          setMessagesByChatId((cache) => ({ ...cache, [chatId]: nextMessages }));
          return nextMessages;
        });
        clearPendingChatRequest(chatId);
        // Video data has already been saved; preserve its compact reference
        // for the next send rather than uploading the file a second time.
        if (uploadedReferencesForRetry) setFileReferences(uploadedReferencesForRetry);
        setInput(content);
        setStatusMessage(httpCause);
        return;
      }

      if (!response.body) {
        throw new Error("Missing response stream from /api/chat.");
      }

      requestStage = "reading response stream";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let textContent = "";
      let assets: Array<{ type: string; url: string }> = [];
      let provider = "unknown";
      let model = "unknown";
      let sawInitialMetadata = false;
      let sawReasoningStart = false;
      let sawFinalReasoningAnswer = false;
      let fallbackReasoningDeltaCount = 0;
      let fallbackProgress = 0;

      const applyFallbackReasoningFromDelta = (delta: string) => {
        if (!delta.trim() || sawReasoningStart) {
          return;
        }
        const now = new Date().toISOString();
        setReasoningState((current) =>
          applyReasoningEvent(current, {
            type: "reasoning_start",
            requestId: `fallback-${chatId}`,
            categories: FALLBACK_REASONING_CATEGORIES,
            startedAt: now
          }),
        );
        sawReasoningStart = true;
      };

      const applyFallbackReasoningUpdate = (delta: string) => {
        if (!delta.trim() || !sawReasoningStart) {
          return;
        }
        const category = FALLBACK_REASONING_CATEGORIES[fallbackReasoningDeltaCount % FALLBACK_REASONING_CATEGORIES.length];
        fallbackReasoningDeltaCount += 1;
        fallbackProgress = Math.min(95, fallbackProgress + 4);
        setReasoningState((current) =>
          applyReasoningEvent(current, {
            type: "reasoning_update",
            requestId: current.requestId ?? `fallback-${chatId}`,
            category,
            explanationDelta: delta,
            score: null,
            confidence: null,
            progress: fallbackProgress,
            updatedAt: new Date().toISOString()
          }),
        );
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const chunk = JSON.parse(line) as
            | ChatMetadataChunk
            | { type: "delta"; text: string }
            | ReasoningStreamEvent
            | {
                type: "content";
                text: string;
                assets?: Array<{ type: string; url: string }>;
                provider?: string;
                model?: string;
              };

          if (chunk.type === "reasoning_error") throw new TerminalChatError(chunk.message, chunk.messageId);

          if (chunk.type === "metadata") {
            if (chunk.resetText) {
              textContent = "";
            }
            setStreamingModel(chunk.modelId);
            provider = chunk.provider;
            setSelectionExplainer(chunk.explainer ?? null);
            setIsRoutingSelectionInFlight(false);

            if (!sawInitialMetadata && !chunk.collaborationEvent) {
              sawInitialMetadata = true;
              setStatusMessage(
                chunk.modelId && chunk.modelId !== "unknown"
                  ? `${chunk.modelId} selected as lead. Preparing the answer…`
                  : "Lead model selected. Preparing the answer…",
              );
            }

            if (chunk.collaborationEvent) {
              sawInitialMetadata = true;
              recordCollaborationEvent(chunk.collaborationEvent);
            }

            if (chunk.providerFailover) {
              const notice = describeProviderFailover(chunk.providerFailover);
              setFailoverNotice(notice);
              setStatusMessage(notice);
            }

            if (chunk.degradedContext?.kind === "repository") {
              setStatusMessage(
                `Repository context is temporarily unavailable. Katie is continuing with the context it already has.`,
              );
            }

            if (chunk.collaboration) {
              setCollaborationSummary(chunk.collaboration);
              setCollaborationActive(false);
            }
          }

          if (chunk.type === "delta") {
            textContent += chunk.text;
            applyFallbackReasoningFromDelta(chunk.text);
            applyFallbackReasoningUpdate(chunk.text);
          }

          if (
            chunk.type === "reasoning_start" ||
            chunk.type === "reasoning_update" ||
            chunk.type === "reasoning_snapshot" ||
            chunk.type === "final_answer"
          ) {
            if (chunk.type === "reasoning_start") {
              sawReasoningStart = true;
            }
            if (chunk.type === "final_answer") {
              sawFinalReasoningAnswer = true;
            }
            setReasoningState((current) => applyReasoningEvent(current, chunk));
          }

          if (chunk.type === "content") {
            if (!textContent) {
              textContent = chunk.text;
            }
            if (chunk.assets?.length) {
              assets = [...assets, ...chunk.assets];
            }
            provider = chunk.provider ?? provider;
            model = chunk.model ?? model;
          }
        }
      }

      if (buffered.trim()) {
        const trailingChunk = JSON.parse(buffered) as
          | ChatMetadataChunk
          | { type: "delta"; text: string }
          | ReasoningStreamEvent
          | {
              type: "content";
              text: string;
              assets?: Array<{ type: string; url: string }>;
              provider?: string;
              model?: string;
            };

        if (trailingChunk.type === "reasoning_error") throw new TerminalChatError(trailingChunk.message, trailingChunk.messageId);

        if (trailingChunk.type === "metadata") {
          if (trailingChunk.resetText) {
            textContent = "";
          }
          setStreamingModel(trailingChunk.modelId);
          provider = trailingChunk.provider;
          setSelectionExplainer(trailingChunk.explainer ?? null);
          setIsRoutingSelectionInFlight(false);

          if (!sawInitialMetadata && !trailingChunk.collaborationEvent) {
            sawInitialMetadata = true;
            setStatusMessage(
              trailingChunk.modelId && trailingChunk.modelId !== "unknown"
                ? `${trailingChunk.modelId} selected as lead. Preparing the answer…`
                : "Lead model selected. Preparing the answer…",
            );
          }

          if (trailingChunk.collaborationEvent) {
            sawInitialMetadata = true;
            recordCollaborationEvent(trailingChunk.collaborationEvent);
          }

          if (trailingChunk.providerFailover) {
            const notice = describeProviderFailover(trailingChunk.providerFailover);
            setFailoverNotice(notice);
            setStatusMessage(notice);
          }

          if (trailingChunk.collaboration) {
            setCollaborationSummary(trailingChunk.collaboration);
            setCollaborationActive(false);
          }
        }

        if (trailingChunk.type === "delta") {
          textContent += trailingChunk.text;
          applyFallbackReasoningFromDelta(trailingChunk.text);
          applyFallbackReasoningUpdate(trailingChunk.text);
        }

        if (
          trailingChunk.type === "reasoning_start" ||
          trailingChunk.type === "reasoning_update" ||
          trailingChunk.type === "reasoning_snapshot" ||
          trailingChunk.type === "final_answer"
        ) {
          if (trailingChunk.type === "reasoning_start") {
            sawReasoningStart = true;
          }
          if (trailingChunk.type === "final_answer") {
            sawFinalReasoningAnswer = true;
          }
          setReasoningState((current) => applyReasoningEvent(current, trailingChunk));
        }

        if (trailingChunk.type === "content") {
          if (!textContent) {
            textContent = trailingChunk.text;
          }
          if (trailingChunk.assets?.length) {
            assets = [...assets, ...trailingChunk.assets];
          }
          provider = trailingChunk.provider ?? provider;
          model = trailingChunk.model ?? model;
        }
      }

      abortControllerRef.current = null;
      setMeta({ provider, model });
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        chatId,
        role: "assistant",
        model,
        content: textContent,
        assets,
        createdAt: new Date().toISOString(),
      };
      setMessages((current) => {
        const nextMessages = [...current, assistantMessage];
        setMessagesByChatId((cache) => ({ ...cache, [chatId]: nextMessages }));
        return nextMessages;
      });
      if (!sawFinalReasoningAnswer) {
        setReasoningState((current) =>
          applyReasoningEvent(current, {
            type: "final_answer",
            requestId: current.requestId ?? `fallback-${chatId}`,
            answer: textContent,
            summaryScores: current.categories.map((category) => ({
              name: category.name,
              score: category.score,
              confidence: category.confidence
            })),
            completedAt: new Date().toISOString()
          }),
        );
      }
      clearPendingChatRequest(chatId);
      setStatusMessage("Response received.");
    } catch (error: unknown) {
      abortControllerRef.current = null;

      if (requestStage === "preparing attachments") {
        // The optimistic message never reached /api/chat. Restore its draft
        // and the original browser File objects so a retry can consult the
        // durable /api/upload/result instead of uploading video bytes again.
        setInput(content);
        setSelectedFiles(filesToUpload);
        setSelectedVideos(videosToUpload);
        setSelectedImageFiles(imageFilesToUpload);
        setSelectedImages(selectedImages);
        setFileReferences(priorReferences);
        setMessages((current) => {
          const withoutOptimistic = current.filter((message) => message.id !== optimisticUserMessage.id);
          setMessagesByChatId((cache) => ({ ...cache, [chatId]: withoutOptimistic }));
          return withoutOptimistic;
        });
      } else if (requestStage === "sending chat request" && uploadedReferencesForRetry) {
        // Server acceptance may be uncertain, but no bytes need transferring
        // if the user chooses to retry after the existing-request recovery.
        setFileReferences(uploadedReferencesForRetry);
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        setStatusMessage("Request canceled.");
        return;
      }

      let rawMessage =
        error instanceof Error ? error.message : "Something went wrong.";
      const isTransportFailure =
        requestStage === "sending chat request" &&
        /load failed|failed to fetch|networkerror|network request failed/i.test(rawMessage);

      console.error("[ChatPanel] request failed", {
        stage: requestStage,
        error,
        browserOnline: typeof navigator !== "undefined" ? navigator.onLine : undefined,
        imageCount: imagesToSend.length,
        imageLengths: imagesToSend.map((image) => image.length),
      });

      let terminalFailure = error instanceof TerminalChatError;
      let failureMessageId = error instanceof TerminalChatError ? error.messageId : undefined;
      const isRecoverableStreamFailure =
        !terminalFailure && (isTransportFailure || requestStage === "reading response stream");

      if (isRecoverableStreamFailure) {
        try {
          const pending =
            readPendingChatRequest(chatId) ?? {
              chatId,
              content:
                content ||
                (hasImages
                  ? "[image]"
                  : videosToUpload.length > 0
                    ? "[video]"
                    : "[file]"),
              startedAt: optimisticUserMessage.createdAt,
              requestId: clientRequestId,
            };

          setStatusMessage(
            "The mobile connection to Katie was interrupted. Waiting for the server-side response to finish…",
          );

          const recoveredMessages = await pollForPersistedAssistant(
            chatId,
            pending,
            MOBILE_RECOVERY_WINDOW_MS,
          );

          if (recoveredMessages) {
            clearPendingChatRequest(chatId);
            setMessages(recoveredMessages);
            setMessagesByChatId((cache) => ({
              ...cache,
              [chatId]: recoveredMessages,
            }));

            const recoveredAssistant = [...recoveredMessages]
              .reverse()
              .find((candidate) => candidate.role === "assistant");
            if (recoveredAssistant?.model) {
              setMeta({
                provider: "recovered",
                model: recoveredAssistant.model,
              });
            }
            setStatusMessage(
              "The live mobile stream disconnected, but Katie finished on the server. The saved response was restored.",
            );
            return;
          }
        } catch (recoveryError: unknown) {
          if (recoveryError instanceof TerminalChatError) {
            terminalFailure = true;
            clearPendingChatRequest(chatId);
            setInput(content);
            rawMessage = recoveryError.message;
            failureMessageId = recoveryError.messageId;
          }
          console.error("[ChatPanel] response recovery failed", {
            stage: requestStage,
            recoveryError,
          });
        }
      }

      if (terminalFailure || !isRecoverableStreamFailure) {
        clearPendingChatRequest(chatId);
      }

      const cause = terminalFailure ? "Katie could not complete this request." : isTransportFailure
        ? "Network/transport error: the mobile browser lost its live connection to Katie. Server-side generation may still be running, and Katie will retry recovery when this screen becomes active again."
        : requestStage === "reading response stream"
          ? "Response-stream error: the mobile browser lost or could not finish reading the live stream. Server-side generation may still be running, and Katie will retry recovery when this screen becomes active again."
          : requestStage.includes("upload")
            ? "Attachment upload error: the message could not be sent because an attachment failed during upload or preparation."
            : `Request error during ${requestStage}.`;

      const message = terminalFailure ? chatFailureContent(rawMessage) : `${cause}\n\nTechnical detail: ${rawMessage}\nStage: ${requestStage}`;
      const errorMessage: Message = {
        id: failureMessageId ?? crypto.randomUUID(),
        chatId,
        role: "assistant",
        content: message,
        createdAt: new Date().toISOString(),
      };
      setMessages((current) => {
        const nextMessages = [...current.filter(entry => entry.id !== errorMessage.id), errorMessage];
        setMessagesByChatId((cache) => ({ ...cache, [chatId]: nextMessages }));
        return nextMessages;
      });
      setStatusMessage(message);
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
      setStreamingModel(null);
      setIsRoutingSelectionInFlight(false);
    }
  }

  function handleCancelRequest() {
    abortControllerRef.current?.abort();
  }

  async function handleCopyMessage(messageId: string, content: string) {
    await navigator.clipboard.writeText(content);
    setCopiedMessageId(messageId);

    if (copiedFeedbackTimeoutRef.current) {
      clearTimeout(copiedFeedbackTimeoutRef.current);
    }

    copiedFeedbackTimeoutRef.current = setTimeout(() => {
      setCopiedMessageId((current) => (current === messageId ? null : current));
    }, 1500);
  }


  useEffect(() => {
    if (!emojiPickerOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      if (emojiPickerRef.current?.contains(target)) {
        return;
      }

      setEmojiPickerOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [emojiPickerOpen]);

  function handleEmojiToggle(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setEmojiPickerOpen((current) => !current);
  }

  function handleEmojiSelect(emoji: { emoji: string }) {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? input.length;
    const selectionEnd = textarea?.selectionEnd ?? input.length;
    const nextValue = `${input.slice(0, selectionStart)}${emoji.emoji}${input.slice(selectionEnd)}`;
    const nextCursorPosition = selectionStart + emoji.emoji.length;

    setInput(nextValue);
    setEmojiPickerOpen(false);

    requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;

      if (!nextTextarea) {
        return;
      }

      nextTextarea.focus();
      nextTextarea.setSelectionRange(nextCursorPosition, nextCursorPosition);
      nextTextarea.style.height = "auto";
      nextTextarea.style.height = `${Math.min(nextTextarea.scrollHeight, 192)}px`;
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void onSubmit(event);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (!imageFiles.length) {
      return;
    }

    setUploadingFiles(true);
    void Promise.all(imageFiles.map((file) => normalizeImageForChat(file)))
      .then((images) => {
        setSelectedImages((current) => [...current, ...images]);
        setSelectedImageFiles((current) => [...current, ...imageFiles.map((file, index) => {
          if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) return file;
          const match = images[index].match(/^data:([^;]+);base64,(.*)$/);
          if (!match) throw new Error("Could not prepare image for storage.");
          const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
          return new File([bytes], `${file.name}.jpg`, { type: match[1] });
        })]);
        setStatusMessage(`${images.length} image${images.length === 1 ? "" : "s"} ready.`);
      })
      .catch((error: unknown) => {
        setStatusMessage(error instanceof Error ? error.message : "Failed to prepare pasted image.");
      })
      .finally(() => setUploadingFiles(false));
  }

  function handleFileChange(event: FormEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);

    if (files.length === 0) {
      return;
    }

    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const nextFiles = files.filter(
      (file) => !file.type.startsWith("image/") && !file.type.startsWith("video/"),
    );
    const nextVideos = files.filter((file) => file.type.startsWith("video/"));

    setSelectedVideos((current) => [...current, ...nextVideos]);
    setSelectedFiles((current) => [...current, ...nextFiles]);

    if (imageFiles.length === 0) {
      const statusSegments = [
        nextFiles.length > 0
          ? `${nextFiles.length} file${nextFiles.length === 1 ? "" : "s"}`
          : null,
        nextVideos.length > 0
          ? `${nextVideos.length} video${nextVideos.length === 1 ? "" : "s"}`
          : null
      ].filter((segment): segment is string => Boolean(segment));
      setStatusMessage(
        statusSegments.length > 0
          ? `${statusSegments.join(" and ")} ready for upload.`
          : "Attachments ready for upload.",
      );
      return;
    }

    setUploadingFiles(true);
    setStatusMessage(`Preparing ${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"}…`);

    void Promise.all(
      imageFiles.map(async (file) => {
        const normalized = await normalizeImageForChat(file);
        console.info("[ChatPanel] normalized image for chat", {
          originalName: file.name,
          originalType: file.type || "unknown",
          originalBytes: file.size,
          encodedChars: normalized.length,
        });
        return normalized;
      }),
    )
      .then((images) => {
        setSelectedImages((current) => [...current, ...images]);
        setSelectedImageFiles((current) => [...current, ...imageFiles.map((file, index) => {
          if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) return file;
          const match = images[index].match(/^data:([^;]+);base64,(.*)$/);
          if (!match) throw new Error("Could not prepare image for storage.");
          const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
          return new File([bytes], `${file.name}.jpg`, { type: match[1] });
        })]);

        const statusSegments = [
          images.length > 0
            ? `${images.length} image${images.length === 1 ? "" : "s"}`
            : null,
          nextFiles.length > 0
            ? `${nextFiles.length} file${nextFiles.length === 1 ? "" : "s"}`
            : null,
          nextVideos.length > 0
            ? `${nextVideos.length} video${nextVideos.length === 1 ? "" : "s"}`
            : null
        ].filter((segment): segment is string => Boolean(segment));

        setStatusMessage(`${statusSegments.join(", ")} ready.`);
      })
      .catch((error: unknown) => {
        setStatusMessage(error instanceof Error ? error.message : "Failed to prepare image.");
      })
      .finally(() => {
        setUploadingFiles(false);
      });
  }

  function handleInputChange(event: FormEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    setInput(textarea.value);

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`;
  }

  useEffect(() => {
    if (!textareaRef.current || input.length !== 0) {
      return;
    }

    textareaRef.current.style.height = "auto";
  }, [input]);

  const providerNames = Object.keys(availableModels) as ProviderName[];
  const showExplainer = !modelExplainerHidden && (isRoutingSelectionInFlight || hasExplainerData(selectionExplainer));
  const showExplainerPanel = isRoutingSelectionInFlight || explainerOpen;
  const overrideReason =
    !isRoutingSelectionInFlight && selectionExplainer?.override?.applied
      ? selectionExplainer.override?.reason
      : null;
    
    useEffect(() => {
      if (!isRoutingSelectionInFlight && !hasExplainerData(selectionExplainer)) {
        setExplainerOpen(false);
      }
    }, [isRoutingSelectionInFlight, selectionExplainer]);
    
    useEffect(() => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      
      if (!isRoutingSelectionInFlight && hasExplainerData(selectionExplainer)) {
        // Give 1.5s to read the "Why this model" details, then hide
        timeout = setTimeout(() => setExplainerOpen(false), 3000);
      }
    
      return () => {
        if (timeout) clearTimeout(timeout);
      };
    }, [isRoutingSelectionInFlight, selectionExplainer]);          
  
    function handleModelExplainerVisibility(nextHidden: boolean) {
      setModelExplainerHidden(nextHidden);
      if (nextHidden) {
        setExplainerOpen(false);
      }

    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODEL_EXPLAINER_HIDDEN_STORAGE_KEY, String(nextHidden));
    }
  }

  async function handleDownload(imageUrl: string, filename: string) {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Image download failed with status ${response.status}`);
      }

      const imageBlob = await response.blob();
      const blobUrl = URL.createObjectURL(imageBlob);

      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(imageUrl, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <main className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-gradient-to-b from-white/[0.02] via-transparent to-black/10">
      <header className="shrink-0 border-b border-white/10 pb-2 pl-4 pr-3 pt-[calc(env(safe-area-inset-top)+0.55rem)] sm:px-6 sm:py-3">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="hidden h-8 w-8 flex-none items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br from-sky-400/15 via-white/10 to-emerald-400/10 shadow-[0_8px_24px_rgba(0,0,0,0.24)] sm:flex">
                <span className="text-sm">✦</span>
              </div>
              <div className="min-w-0">
                <p className="hidden text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-500 sm:block">
                  With {activeActorName || "Katie"}
                </p>
                <div className="sm:hidden">
                  <h2 className="truncate text-[15px] font-semibold tracking-tight text-white">
                    {activeChatTitle || "New conversation"}
                  </h2>
                  <p className="truncate text-[11px] text-zinc-500">
                    With {activeActorName || "Katie"}
                  </p>
                </div>
                <h2 className="hidden truncate text-xl font-semibold tracking-tight text-white sm:block">
                  {activeChatTitle || "New conversation"}
                </h2>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {meta ? (
                <p className="hidden max-w-full items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-400 sm:inline-flex">
                  <span className="h-1.5 w-1.5 flex-none rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]" />
                  <span className="truncate">Last response via <span className="text-zinc-200">{meta.provider}</span> · {meta.model}</span>
                </p>
              ) : null}
              {showExplainer ? (
                <div
                  ref={explainerContainerRef}
                  className="relative hidden sm:block"
                  onMouseEnter={() => {
                    if (typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
                      setExplainerOpen(true);
                    }
                  }}
                  onMouseLeave={() => {
                    if (typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
                      setExplainerOpen(false);
                    }
                  }}
                >
                  <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] pl-2.5 pr-1 py-1 text-[11px] text-zinc-300">
                    <button
                      type="button"
                      onClick={() => setExplainerOpen((current) => !current)}
                      className="inline-flex items-center gap-1 rounded-full px-1 text-left text-zinc-300 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                      aria-expanded={explainerOpen}
                      aria-controls="model-selection-explainer"
                      aria-label="Open model selection explainer"
                    >
                      <span className="truncate">
                        {isRoutingSelectionInFlight
                          ? "Model: Selecting best model…"
                          : `Model: ${selectionExplainer?.selected_provider ?? meta?.provider ?? "unknown"} / ${selectionExplainer?.selected_model ?? meta?.model ?? "Unknown"} · Why?`}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleModelExplainerVisibility(true)}
                      className="rounded-full border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                      aria-label="Hide model selection explainer"
                    >
                      Hide
                    </button>
                  </div>
                  {showExplainerPanel ? (
                    <div
                      id="model-selection-explainer"
                      role="dialog"
                      aria-label="Model selection explainer details"
                      className="absolute right-0 z-50 mt-2 w-80 rounded-2xl border border-white/10 bg-zinc-950/95 p-3 text-xs text-zinc-300 shadow-[0_18px_48px_rgba(0,0,0,0.45)] backdrop-blur"
                    >
                      {isRoutingSelectionInFlight || !selectionExplainer ? (
                        <div className="space-y-2">
                          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
                            <p className="font-semibold text-zinc-100">Selecting best model…</p>
                            <p className="mt-1 text-[11px] text-zinc-400">Routing request and preparing explainer.</p>
                            <div className="mt-2 space-y-1.5">
                              <div className="h-2.5 w-44 animate-pulse rounded bg-white/10" />
                              <div className="h-2.5 w-56 animate-pulse rounded bg-white/10" />
                              <div className="h-2.5 w-36 animate-pulse rounded bg-white/10" />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
                            <p className="font-semibold text-zinc-100">Why this model</p>
                            <p className="mt-1 text-[11px] text-zinc-400">
                              {selectionExplainer.selected_provider ?? "unknown"} / {selectionExplainer.selected_model ?? "unknown"}
                            </p>
                            {selectionExplainer.summary ? <p className="mt-1 text-zinc-300">{selectionExplainer.summary}</p> : null}
                          </div>

                          <div className="grid grid-cols-2 gap-2 text-[11px]">
                            <p className="rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1.5 text-zinc-400">
                              Intent: <span className="text-zinc-200">{formatIntentLabel(selectionExplainer.intent?.label)}</span>
                            </p>
                            <p className="rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1.5 text-zinc-400">
                              Score: <span className="text-zinc-200">{selectionExplainer.top_candidate_score ?? "—"}</span>
                            </p>
                          </div>

                          {selectionExplainer.preference_profile_applied ? (
                            <p className="rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1.5 text-[11px] text-zinc-300">
                              {selectionExplainer.preference_profile_applied}
                            </p>
                          ) : null}

                          {selectionExplainer.top_factors?.length ? (
                            <div className="space-y-1.5">
                              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Key reasons</p>
                              <ul className="space-y-1.5">
                                {selectionExplainer.top_factors.slice(0, 5).map((factor, index) => (
                                  <li
                                    key={`${factor.label}-${index}`}
                                    className="rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1.5 transition-opacity duration-300"
                                    style={{ transitionDelay: `${index * 45}ms` }}
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="truncate text-zinc-300">{factor.label}</span>
                                      <span className="font-mono text-zinc-200">{formatSignedDelta(factor.delta)}</span>
                                    </div>
                                    {factor.detail ? <p className="mt-1 text-[11px] text-zinc-500">{factor.detail}</p> : null}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          {selectionExplainer.top_candidates?.length ? (
                            <div className="space-y-1.5">
                              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Top alternatives</p>
                              <ul className="space-y-1.5">
                                {selectionExplainer.top_candidates.slice(0, 3).map((candidate, index) => (
                                  <li key={`${candidate.provider}-${candidate.model}-${index}`} className="rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1.5">
                                    <p className="text-zinc-200">{candidate.provider ?? "unknown"} / {candidate.model ?? "unknown"}</p>
                                    <p className="text-[11px] text-zinc-500">{candidate.why_not_selected ?? "Valid alternative."}</p>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          <div className="flex flex-wrap gap-1.5 pt-1">
                            <span className="rounded-full border border-white/10 bg-white/[0.02] px-2 py-0.5 text-[10px] text-zinc-400">
                              {selectionExplainer.selected_source === "llm-primary" ? "routing: llm-primary" : "routing: deterministic-fallback"}
                            </span>
                            {selectionExplainer.hard_rule_applied ? (
                              <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">
                                hard rule: {selectionExplainer.hard_rule_applied}
                              </span>
                            ) : null}
                            {selectionExplainer.fallback_used ? (
                              <span className="rounded-full border border-indigo-400/30 bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-200">
                                fallback used{selectionExplainer.fallback_reason ? ` · ${selectionExplainer.fallback_reason}` : ""}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      )}
                      {overrideReason ? <p className="mt-2 text-amber-200/90">Override: {overrideReason}</p> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => setShowModelControls((current) => !current)}
                className="inline-flex h-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] px-3 text-[11px] font-medium text-zinc-200 transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                aria-expanded={showModelControls}
                aria-controls="model-controls"
              >
                {showModelControls ? "Hide answering models" : selectedOverride ? `Answering model: ${selectedOverride.modelId}` : "Choose answering model"}
              </button>
            </div>
          </div>

          <div
            id="model-controls"
            className={[
              "grid gap-2 overflow-hidden transition-all",
              showModelControls ? "grid-rows-[1fr] opacity-100" : "hidden",
            ].join(" ")}
          >
            <div className="min-h-0">
              <div className="max-h-[45dvh] overflow-y-auto rounded-xl bg-black/10 p-1.5 md:flex md:max-h-none md:flex-row md:flex-wrap md:items-center md:gap-2 md:overflow-auto md:bg-transparent md:p-0">
                <label
                  className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.035] px-2.5 py-1.5 text-[11px] text-zinc-300"
                  title="Show model selection explainer"
                >
                  <input
                    type="checkbox"
                    checked={!modelExplainerHidden}
                    onChange={(event) => handleModelExplainerVisibility(!event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-white/15 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                    aria-label="Show model selection explainer"
                  />
                  <span>Model explainer</span>
                </label>
                <label
                  className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.035] px-2.5 py-1.5 text-[11px] text-zinc-300"
                  title="Show live reasoning explainer"
                >
                  <input
                    type="checkbox"
                    checked={showLiveReasoningExplainer}
                    onChange={(event) => handleLiveReasoningVisibility(event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-white/15 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                    aria-label="Show live reasoning explainer"
                  />
                  <span>Live reasoning</span>
                </label>
                {providerNames.map((providerName) => {
                  const options = availableModels[providerName] ?? [];
                  const selectedValue =
                    selectedOverride?.providerName === providerName
                      ? selectedOverride.modelId
                      : "";

                  return (
                    <label
                      key={providerName}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.035] px-2 py-1.5 text-[10px] text-zinc-300"
                    >
                      <span className="shrink-0 capitalize text-zinc-500">{providerName}</span>
                      <select
                        aria-label={`Answering model for ${providerName}`}
                        value={selectedValue}
                        onChange={(event) => {
                          const nextModel = event.target.value;
                          setSelectedOverride(
                            nextModel ? { providerName, modelId: nextModel } : null,
                          );
                        }}
                        className="min-w-0 flex-1 rounded-lg border border-white/10 bg-zinc-950/90 px-2 py-1.5 text-[11px] text-zinc-100 outline-none ring-emerald-500 transition focus:ring"
                      >
                        <option value="">Automatic</option>
                        {options.map((modelId) => (
                          <option key={modelId} value={modelId}>
                            {modelId}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </header>

      {attachmentSaveError&&<p role="alert" className="px-5 text-xs text-amber-200">Attachments are retained for this session; browser storage could not save them for refresh.</p>}
      {draftReady && <p role="status" className="shrink-0 px-5 py-1 text-xs text-zinc-500">{draft.error?"Draft retained in this browser; server save unavailable.":draft.saving?"Saving draft…":input&&draft.state?.value.draft===input?"Draft saved":""}</p>}
      {resourceRecovery?.chatId===chatId && !managedAgentId ? (
        <DeveloperResourceCard proposal={resourceRecovery.proposal}
         pending={projectApprovalPending||loading} error={projectApprovalError}
         onApprove={(hash,ceiling,hours)=>{void approveRecovery(hash,ceiling,hours);}}/>
      ):null}
      {projectApproval?.chatId===chatId && !managedAgentId ? (
        <ProjectApprovalCard
          approval={projectApproval.approval}
          pending={projectApprovalPending || loading}
          error={projectApprovalError}
          onApprove={(hash)=>{void approveProject(hash);}}
          onRequestChanges={requestProjectChanges}
        />
      ) : null}

      {showLiveReasoningExplainer && reasoningPopupVisible ? (
        <div className="pointer-events-none absolute inset-x-[5%] bottom-24 z-40 sm:bottom-28">
          <div className="pointer-events-auto mx-auto w-full">
            <ReasoningExplainerPanel
              loading={loading}
              state={reasoningState}
              statusMessage={statusMessage}
              collaborationActive={collaborationActive}
              collaborationActivity={collaborationActivity}
              collaborationSummary={collaborationSummary}
              onClose={() => {
                setReasoningPopupVisible(false);
                setReasoningPopupDismissed(true);
              }}
            />
          </div>
        </div>
      ) : null}

      <section
        ref={messagesContainerRef}
        onScroll={event=>{try{window.sessionStorage.setItem(`katie.scroll.v1.${chatId}`,String(event.currentTarget.scrollTop));}catch{}}}
        className="relative min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 pb-5 overscroll-contain sm:space-y-5 sm:px-6 sm:py-5 sm:pb-28"
      >
        {isHydratingMessages ? (
          <div className="max-w-2xl rounded-[28px] border border-white/10 bg-white/[0.035] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-sm">
            <p className="text-sm font-medium text-zinc-200">Loading saved thread…</p>
            <p className="mt-2 text-sm leading-6 text-zinc-500">Restoring this conversation.</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="max-w-2xl rounded-[28px] border border-white/10 bg-white/[0.035] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-sm">
            <p className="text-sm font-medium text-zinc-200">What would you like to get done?</p>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              Describe the outcome you need, or ask a question.
            </p>
          </div>
        ) : null}
        {messages.map((message) => (
          <div
            key={message.id} id={`message-${message.id}`}
            className={[
              "max-w-4xl overflow-hidden rounded-2xl border px-3 py-3 text-[15px] shadow-[0_14px_36px_rgba(0,0,0,0.16)] backdrop-blur-sm sm:w-full sm:rounded-[24px] sm:px-5 sm:py-4 sm:text-sm sm:shadow-[0_20px_60px_rgba(0,0,0,0.18)]",
              message.role === "user"
                ? "ml-auto w-[92%] border-emerald-400/20 bg-gradient-to-br from-emerald-400/14 via-emerald-500/8 to-sky-500/10 sm:w-full"
                : "w-full border-white/10 bg-white/[0.035]"
            ].join(" ")}
          >
            <div className="mb-2 flex items-center justify-between gap-2 sm:mb-3 sm:items-start">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-400">
                {message.role}
                {message.role === "assistant" && message.model
                  ? ` (${message.model})`
                  : ""}
              </p>
              <button
                type="button"
                onClick={() =>
                  void handleCopyMessage(message.id, message.content ?? "")
                }
                className="shrink-0 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] font-medium text-zinc-400 transition hover:border-white/20 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:rounded-xl sm:px-2.5 sm:py-1.5 sm:text-[11px]"
              >
                {copiedMessageId === message.id ? "Copied" : "Copy"}
              </button>
            </div>
            {message.role === "assistant" &&
            message.content.startsWith("[Katie video analysis pending:") ? (() => {
              const id = message.content.match(/pending: ([a-f0-9-]{36})/i)?.[1];
              const job = id ? videoProgress[id] : undefined;
              const label = job?.stage === "qwen_queued" ? "Qwen is waiting for a RunPod worker." :
                job?.stage === "qwen_analyzing" ? "Qwen is analyzing the video." :
                job?.stage === "grok_queued" ? "Grok fallback is queued." :
                job?.stage === "grok_analyzing" ? "Grok is analyzing recovered frames." :
                job?.stage === "delivering" ? "Analysis finished; saving your answer." :
                "Checking the video processing queue.";
              return <div role="status" aria-live="polite"
                className="mb-4 rounded-xl border border-sky-400/25 bg-sky-400/10 p-3 text-sm text-sky-100">
                <div className="flex items-center gap-2 font-semibold">
                  <span aria-hidden="true" className="h-2.5 w-2.5 animate-pulse rounded-full bg-sky-400" />
                  Katie is still working on your video
                </div>
                <p className="mt-1">{label}</p>
                <p className="mt-1 text-xs text-sky-100/70">
                  {job ? "Elapsed: " + Math.floor(job.elapsedSeconds / 60) + " min · " +
                    job.completedCount + "/" + job.videoCount + " Qwen analyses completed" :
                    "Waiting for live status"}
                  {" · Checking every 7 seconds"}
                </p>
              </div>;
            })() : null}
            {message.content ? (
              message.role === "assistant" ? (
                <div className="break-words text-zinc-100/95">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => (
                        <h1 className="mb-4 mt-6 text-2xl font-semibold tracking-tight text-white first:mt-0">
                          {children}
                        </h1>
                      ),
                      h2: ({ children }) => (
                        <h2 className="mb-3 mt-6 text-xl font-semibold tracking-tight text-white first:mt-0">
                          {children}
                        </h2>
                      ),
                      h3: ({ children }) => (
                        <h3 className="mb-2 mt-5 text-base font-semibold text-zinc-100 first:mt-0">
                          {children}
                        </h3>
                      ),
                      p: ({ children }) => (
                        <p className="my-3 leading-7 first:mt-0 last:mb-0">{children}</p>
                      ),
                      strong: ({ children }) => (
                        <strong className="font-semibold text-white">{children}</strong>
                      ),
                      em: ({ children }) => <em className="text-zinc-200">{children}</em>,
                      ul: ({ children }) => (
                        <ul className="my-3 list-disc space-y-1.5 pl-6 marker:text-zinc-500">{children}</ul>
                      ),
                      ol: ({ children }) => (
                        <ol className="my-3 list-decimal space-y-1.5 pl-6 marker:text-zinc-500">{children}</ol>
                      ),
                      li: ({ children }) => <li className="pl-1 leading-7">{children}</li>,
                      blockquote: ({ children }) => (
                        <blockquote className="my-4 border-l-2 border-emerald-400/50 bg-white/[0.025] py-1 pl-4 pr-3 text-zinc-300">
                          {children}
                        </blockquote>
                      ),
                      hr: () => <hr className="my-6 border-white/10" />,
                      a: ({ href, children }) => (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-sky-300 underline decoration-sky-400/40 underline-offset-4 transition hover:text-sky-200 hover:decoration-sky-300"
                        >
                          {children}
                        </a>
                      ),
                      pre: ({ children }) => (
                        <pre className="my-4 overflow-x-auto rounded-2xl border border-white/10 bg-black/35 p-4 text-[13px] leading-6 text-zinc-100 shadow-inner">
                          {children}
                        </pre>
                      ),
                      code: ({ className, children }) => {
                        const isBlock = Boolean(className) || String(children).includes("\n");
                        return (
                          <code
                            className={
                              isBlock
                                ? `font-mono ${className ?? ""}`
                                : "rounded-md border border-white/10 bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.9em] text-zinc-100"
                            }
                          >
                            {children}
                          </code>
                        );
                      },
                      table: ({ children }) => (
                        <div className="my-4 overflow-x-auto rounded-2xl border border-white/10">
                          <table className="w-full border-collapse text-left text-sm">{children}</table>
                        </div>
                      ),
                      thead: ({ children }) => <thead className="bg-white/[0.06] text-zinc-100">{children}</thead>,
                      tbody: ({ children }) => <tbody className="divide-y divide-white/10">{children}</tbody>,
                      tr: ({ children }) => <tr className="divide-x divide-white/10">{children}</tr>,
                      th: ({ children }) => (
                        <th className="px-3 py-2.5 font-semibold text-white">{children}</th>
                      ),
                      td: ({ children }) => <td className="px-3 py-2.5 align-top leading-6">{children}</td>,
                      del: ({ children }) => <del className="text-zinc-500">{children}</del>,
                      input: ({ node, ...props }) => {
                        void node;
                        return <input {...props} className="mr-2 accent-emerald-500" disabled />;
                      },
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap break-words leading-7 text-zinc-100/95">{message.content}</p>
              )
            ) : null}
            {message.role === "assistant" && message.id && <MessageReactions actorId={actorId} chatId={chatId} messageId={message.id} />}
            {message.attachments?.length ? (
              <ul aria-label="Referenced files" className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-300">
                {message.attachments.map(file => (
                  <li key={file.id} title={file.fileName} className="max-w-full truncate rounded-lg border border-white/10 bg-white/5 px-2 py-1">
                    📎 {file.fileName}
                  </li>
                ))}
              </ul>
            ) : null}
            {message.assets
              ?.filter((asset) => asset.type === "image")
              .map((asset) => (
                <div key={asset.url} className="group relative mt-4">
                  <div className="relative h-80 w-full overflow-hidden rounded-[22px] border border-white/10 bg-black/20">
                    <Image
                      src={asset.url}
                      alt="Generated asset"
                      fill
                      sizes="(max-width: 768px) 100vw, 768px"
                      className="object-contain"
                      unoptimized
                    />
                  </div>
                  {message.role === "assistant" ? (
                    <RememberFaceControl
                      actorId={actorId}
                      chatId={message.chatId}
                      messageId={message.id}
                      assetIndex={message.assets?.indexOf(asset) ?? 0}
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      void handleDownload(
                        asset.url,
                        `katie-generated-${Date.now()}.png`,
                      )
                    }
                    className="absolute right-3 top-3 rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-1.5 text-xs font-medium text-white opacity-0 transition-opacity hover:bg-zinc-900 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 group-hover:opacity-100"
                  >
                    Download
                  </button>
                </div>
              ))}
          </div>
        ))}
        {loading && (
          <div className="flex w-fit items-center gap-3 rounded-[24px] border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-zinc-300 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-sm">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
            <p className="italic text-zinc-400">
              {uploadingFiles
                ? "Uploading attachments..."
                : statusMessage ||
                  `${streamingModel ?? selectedOverride?.modelId ?? "Master Router"} is thinking...`}
            </p>
          </div>
        )}
        <div className="pointer-events-none sticky bottom-3 z-10 ml-auto hidden w-fit flex-col gap-2 pr-1 sm:bottom-4 sm:flex">
          <button
            type="button"
            onClick={scrollToTop}
            className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-zinc-950/80 text-sm text-zinc-200 shadow-[0_14px_30px_rgba(0,0,0,0.3)] backdrop-blur transition hover:border-white/20 hover:bg-zinc-900/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label="Scroll to top"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={scrollToBottom}
            className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-zinc-950/80 text-sm text-zinc-200 shadow-[0_14px_30px_rgba(0,0,0,0.3)] backdrop-blur transition hover:border-white/20 hover:bg-zinc-900/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label="Scroll to bottom"
          >
            ↓
          </button>
        </div>
        <div ref={messagesEndRef} />
      </section>

      {failoverNotice && (
        <p role="status" className="mx-3 mb-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100 sm:mx-6">
          {failoverNotice}
        </p>
      )}
      {managedAgentId && <p className="border-t border-white/10 px-4 py-3 text-sm text-zinc-300">This is a managed agent workspace. <a href={`/agents?chat=${encodeURIComponent(chatId)}`} className="underline">Open Agents management to continue the saved task.</a></p>}
      <form hidden={Boolean(managedAgentId)} onSubmit={onSubmit} className="shrink-0 border-t border-white/10 bg-zinc-950/92 px-2 py-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] backdrop-blur-xl sm:bg-transparent sm:px-6 sm:py-4 sm:backdrop-blur-none">
        <p className="sr-only" role="status" aria-live="polite">
          {statusMessage}
        </p>
        {!hasValidChatSelection ? (
          <p className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            Open a conversation to send a message.
          </p>
        ) : null}

        {selectedImages.length > 0 ? (
          <div className="mb-4 flex flex-wrap gap-3">
            {selectedImages.map((image, index) => (
              <div
                key={`${image.slice(0, 32)}-${index}`}
                className="relative h-24 w-24 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]"
              >
                <Image
                  src={image}
                  alt={`Selected image ${index + 1}`}
                  fill
                  sizes="96px"
                  className="object-cover"
                  unoptimized
                />
                <button
                  type="button"
                  onClick={() => {
                    setSelectedImageFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
                    setSelectedImages((current) =>
                      current.filter(
                        (_, currentIndex) => currentIndex !== index,
                      ),
                    );
                  }}
                  className="absolute right-1.5 top-1.5 rounded-full bg-red-500/90 px-1.5 py-0.5 text-xs text-white shadow-lg"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {selectedFiles.length > 0 ? (
          <ul
            className="mb-4 space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-zinc-400"
            aria-live="polite"
          >
            {selectedFiles.map((file, index) => (
              <li key={`${file.name}-${index}`}>📄 {file.name}</li>
            ))}
          </ul>
        ) : null}
        {selectedVideos.length > 0 ? (
          <ul
            className="mb-4 space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-zinc-400"
            aria-live="polite"
          >
            {selectedVideos.map((file, index) => (
              <li key={`${file.name}-${index}`}>🎬 {file.name}</li>
            ))}
          </ul>
        ) : null}

        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-2 shadow-[0_14px_36px_rgba(0,0,0,0.2)] backdrop-blur-sm sm:rounded-[28px] sm:p-3 sm:shadow-[0_20px_60px_rgba(0,0,0,0.2)]">
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] p-0 text-sm text-zinc-300 transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:w-auto sm:rounded-2xl sm:px-3.5 sm:py-3"
              aria-label="Attach files"
            >
              📷
            </button>
            <div className="relative min-w-0 flex-1">
              <textarea
                ref={textareaRef}
                rows={1}
                enterKeyHint="send"
                autoComplete="off"
                autoCorrect="on"
                spellCheck
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={`Ask ${activeActorName || "Katie"}…`}
                className="min-h-[44px] max-h-36 w-full resize-none overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-2.5 text-[16px] leading-6 text-zinc-100 outline-none ring-emerald-500 placeholder:text-zinc-500 focus:ring sm:min-h-[48px] sm:max-h-48 sm:rounded-2xl sm:px-4 sm:py-3 sm:pr-14 sm:text-sm"
              />
              <div ref={emojiPickerRef} className="absolute bottom-2 right-2 block">
                <button
                  type="button"
                  onClick={handleEmojiToggle}
                  className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-base text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  aria-label="Insert emoji"
                  aria-expanded={emojiPickerOpen}
                >
                  😊
                </button>
                {emojiPickerOpen ? (
                  <div className="absolute bottom-12 right-0 z-20 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
                    <EmojiPicker
                      onEmojiClick={handleEmojiSelect}
                      theme={Theme.DARK}
                      autoFocusSearch={false}
                      lazyLoadEmojis
                      skinTonesDisabled
                      width={320}
                      height={400}
                    />
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex flex-none items-end gap-2">
              {loading ? (
                <button
                  type="button"
                  onClick={handleCancelRequest}
                  className="h-11 rounded-xl border border-red-400/30 bg-red-500/10 px-3 text-xs font-medium text-red-100 transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 sm:rounded-2xl sm:px-4 sm:text-sm"
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="submit"
                disabled={!canSend}
                className="h-11 min-w-16 flex-none rounded-xl bg-gradient-to-r from-emerald-500 to-sky-500 px-4 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(16,185,129,0.25)] transition active:scale-95 disabled:opacity-50 sm:rounded-2xl sm:px-5 sm:py-3"
              >
                {uploadingFiles
                  ? "Uploading..."
                  : loading
                    ? collaborationActive
                      ? "Collaborating..."
                      : isRoutingSelectionInFlight
                        ? "Routing..."
                        : statusMessage.toLowerCase().includes("synthes")
                          ? "Synthesizing..."
                          : "Thinking..."
                    : "Send"}
              </button>
            </div>
          </div>
        </div>
      </form>
    </main>
  );
}
