"use client";

import Image from "next/image";
import EmojiPicker, { Theme } from "emoji-picker-react";
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
import type { FileReference } from "@/lib/providers/types";
import type { Message } from "@/lib/types/chat";
import { canSubmitChatRequest } from "@/lib/chat/request-guards";
import {
  applyReasoningEvent,
  createReasoningUiState,
  type ReasoningStreamEvent,
  type ReasoningUiState
} from "@/lib/chat/reasoning-stream";
import { ReasoningExplainerPanel } from "@/components/reasoning-explainer-panel";

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
  activeActorName: string;
  activeChatTitle: string;
  activeRepoId: string;
  repoInjectionEnabled: boolean;
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
  actorId,
  chatId,
  activeActorName,
  activeChatTitle,
  activeRepoId,
  repoInjectionEnabled,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesByChatId, setMessagesByChatId] = useState<Record<string, Message[]>>({});
  const [isHydratingMessages, setIsHydratingMessages] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<{ provider: string; model: string } | null>(
    null,
  );
  const [availableModels, setAvailableModels] = useState<AvailableModels>({});
  const [selectedOverride, setSelectedOverride] =
    useState<SelectedOverride>(null);
  const [streamingModel, setStreamingModel] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [selectedVideos, setSelectedVideos] = useState<File[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [fileReferences, setFileReferences] = useState<FileReference[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [showModelControls, setShowModelControls] = useState(false);
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
      hasValidChatSelection &&
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
      setStreamingModel(null);
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

    const closeDelay = reasoningState.error ? 3000 : 1500;
    reasoningPopupTimeoutRef.current = setTimeout(() => {
      setReasoningPopupVisible(false);
    }, closeDelay);

    return () => {
      if (reasoningPopupTimeoutRef.current) {
        clearTimeout(reasoningPopupTimeoutRef.current);
        reasoningPopupTimeoutRef.current = null;
      }
    };
  }, [loading, reasoningPopupDismissed, reasoningPopupVisible, reasoningState.error, showLiveReasoningExplainer]);

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

  async function uploadFiles(files: File[]): Promise<FileReference[]> {
    if (files.length === 0) {
      return [];
    }

    setUploadingFiles(true);
    setStatusMessage(
      `Uploading ${files.length} file${files.length > 1 ? "s" : ""}...`,
    );

    try {
      const formData = new FormData();
      files.forEach((file) => {
        formData.append("files", file);
      });

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json()) as {
        fileReferences?: FileReference[];
        error?: string;
      };

      if (!response.ok || !payload.fileReferences) {
        throw new Error(payload.error ?? "File upload failed.");
      }

      setStatusMessage(
        `Uploaded ${payload.fileReferences.length} file${payload.fileReferences.length > 1 ? "s" : ""}.`,
      );
      return payload.fileReferences;
    } finally {
      setUploadingFiles(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!hasValidChatSelection) {
      setStatusMessage(
        "Select an actor and chat before sending a message.",
      );
      return;
    }
    if (!canSend) {
      return;
    }

    const content = input.trim();
    const imagesToSend = [...selectedImages];
    const videosToUpload = [...selectedVideos];
    const filesToUpload = [...selectedFiles];
    const priorReferences = [...fileReferences];
    const hasImages = imagesToSend.length > 0;

    setInput("");
    setSelectedImages([]);
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
      createdAt: new Date().toISOString(),
    };

    setMessages((current) => {
      const nextMessages = [...current, optimisticUserMessage];
      setMessagesByChatId((cache) => ({ ...cache, [chatId]: nextMessages }));
      return nextMessages;
    });

    try {
      const uploadedReferences =
        filesToUpload.length + videosToUpload.length > 0
          ? await uploadFiles([...filesToUpload, ...videosToUpload])
          : [];
      const refsToSend = [...priorReferences, ...uploadedReferences];

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        signal: abortController.signal,
        body: JSON.stringify({
          actorId,
          chatId,
          message: content || (hasImages ? "[image]" : videosToUpload.length > 0 ? "[video]" : "[file]"),
          images: imagesToSend,
          fileReferences: refsToSend,
          overrideProvider: selectedOverride?.providerName,
          overrideModel: selectedOverride?.modelId,
          activeRepoId: activeRepoId || undefined,
          repoInjectionEnabled,
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        const failureMessage: Message = {
          id: crypto.randomUUID(),
          chatId,
          role: "assistant",
          content: errorData.error ?? "Something went wrong.",
          createdAt: new Date().toISOString(),
        };
        setMessages((current) => {
          const nextMessages = [...current, failureMessage];
          setMessagesByChatId((cache) => ({ ...cache, [chatId]: nextMessages }));
          return nextMessages;
        });
        setStatusMessage(errorData.error ?? "Message failed.");
        return;
      }

      if (!response.body) {
        throw new Error("Missing response stream from /api/chat.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let textContent = "";
      let assets: Array<{ type: string; url: string }> = [];
      let provider = "unknown";
      let model = "unknown";
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
            | { type: "metadata"; modelId: string; provider: string; explainer?: SelectionExplainer }
            | { type: "generation_status"; status: string; provider?: string; modelId?: string; attemptIndex?: number }
            | { type: "generation_failure"; message: string; provider?: string | null; modelId?: string | null; stage?: string; recoverable?: boolean }
            | { type: "delta"; text: string }
            | ReasoningStreamEvent
            | {
                type: "content";
                text: string;
                assets?: Array<{ type: string; url: string }>;
                provider?: string;
                model?: string;
              };

          if (chunk.type === "metadata") {
            setStreamingModel(chunk.modelId);
            provider = chunk.provider;
            setSelectionExplainer(chunk.explainer ?? null);
            setIsRoutingSelectionInFlight(false);
          }

          if (chunk.type === "generation_status") {
            if (chunk.provider) {
              provider = chunk.provider;
            }
            if (chunk.modelId) {
              model = chunk.modelId;
            }
          }

          if (chunk.type === "generation_failure") {
            if (!textContent.trim()) {
              textContent = chunk.message || "Generation failed before any tokens were produced.";
            }
            if (chunk.provider) {
              provider = chunk.provider;
            }
            if (chunk.modelId) {
              model = chunk.modelId;
            }
            setStatusMessage(chunk.message || "Generation failed.");
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
            chunk.type === "final_answer" ||
            chunk.type === "reasoning_error"
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
          | { type: "metadata"; modelId: string; provider: string; explainer?: SelectionExplainer }
          | { type: "generation_status"; status: string; provider?: string; modelId?: string; attemptIndex?: number }
          | { type: "generation_failure"; message: string; provider?: string | null; modelId?: string | null; stage?: string; recoverable?: boolean }
          | { type: "delta"; text: string }
          | ReasoningStreamEvent
          | {
              type: "content";
              text: string;
              assets?: Array<{ type: string; url: string }>;
              provider?: string;
              model?: string;
            };

        if (trailingChunk.type === "metadata") {
          setStreamingModel(trailingChunk.modelId);
          provider = trailingChunk.provider;
          setSelectionExplainer(trailingChunk.explainer ?? null);
          setIsRoutingSelectionInFlight(false);
        }

        if (trailingChunk.type === "generation_status") {
          if (trailingChunk.provider) {
            provider = trailingChunk.provider;
          }
          if (trailingChunk.modelId) {
            model = trailingChunk.modelId;
          }
        }

        if (trailingChunk.type === "generation_failure") {
          if (!textContent.trim()) {
            textContent = trailingChunk.message || "Generation failed before any tokens were produced.";
          }
          if (trailingChunk.provider) {
            provider = trailingChunk.provider;
          }
          if (trailingChunk.modelId) {
            model = trailingChunk.modelId;
          }
          setStatusMessage(trailingChunk.message || "Generation failed.");
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
          trailingChunk.type === "final_answer" ||
          trailingChunk.type === "reasoning_error"
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
      if (!textContent.trim()) {
        textContent = "The assistant could not generate a response for this request.";
      }
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
      setStatusMessage("Response received.");
    } catch (error: unknown) {
      abortControllerRef.current = null;

      if (error instanceof DOMException && error.name === "AbortError") {
        setStatusMessage("Request canceled.");
        return;
      }

      const message =
        error instanceof Error ? error.message : "Something went wrong.";
      const errorMessage: Message = {
        id: crypto.randomUUID(),
        chatId,
        role: "assistant",
        content: message,
        createdAt: new Date().toISOString(),
      };
      setMessages((current) => {
        const nextMessages = [...current, errorMessage];
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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (window.innerWidth >= 768) {
      setShowModelControls(true);
    }
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void onSubmit(event);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData.items;

    for (const item of items) {
      if (!item.type.startsWith("image/")) {
        continue;
      }

      const file = item.getAsFile();
      if (!file) {
        continue;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;

        if (typeof result === "string") {
          setSelectedImages((current) => [...current, result]);
        }
      };
      reader.readAsDataURL(file);
    }
  }

  function handleFileChange(event: FormEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);

    if (files.length === 0) {
      return;
    }

    const nextFiles = files.filter(
      (file) => !file.type.startsWith("image/") && !file.type.startsWith("video/"),
    );
    const nextVideos = files.filter((file) => file.type.startsWith("video/"));
    setSelectedVideos((current) => [...current, ...nextVideos]);
    setSelectedFiles((current) => [...current, ...nextFiles]);
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

    files
      .filter((file) => file.type.startsWith("image/"))
      .forEach((file) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result;

          if (typeof result === "string") {
            setSelectedImages((current) => [...current, result]);
          }
        };
        reader.readAsDataURL(file);
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
    <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-gradient-to-b from-white/[0.02] via-transparent to-black/10">
      <header className="shrink-0 border-b border-white/10 px-4 py-3 sm:px-6 sm:py-3.5">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-8 w-8 flex-none items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br from-sky-400/15 via-white/10 to-emerald-400/10 shadow-[0_8px_24px_rgba(0,0,0,0.24)]">
                <span className="text-sm">✦</span>
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-500">
                  Master Router
                </p>
                <h2 className="truncate text-base font-semibold tracking-tight text-white sm:text-xl">
                  Katie - AI Command Center
                </h2>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <p className="inline-flex max-w-full items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] text-emerald-100 sm:text-[11px]">
                <span className="h-1.5 w-1.5 flex-none rounded-full bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.8)]" />
                <span className="truncate">
                  Active:
                  {" "}
                  <span className="font-semibold text-white">
                    {activeActorName || "No actor"}
                  </span>
                  {" · "}
                  <span className="font-semibold text-white">
                    {activeChatTitle || "No chat"}
                  </span>
                </span>
              </p>
              {meta ? (
                <p className="inline-flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] text-zinc-400 sm:text-[11px]">
                  <span className="h-1.5 w-1.5 flex-none rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]" />
                  <span className="truncate">Last response via <span className="text-zinc-200">{meta.provider}</span> · {meta.model}</span>
                </p>
              ) : null}
              {showExplainer ? (
                <div
                  ref={explainerContainerRef}
                  className="relative"
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
                      className="absolute right-0 z-50 mt-2 w-[min(20rem,calc(100vw-2.25rem))] rounded-2xl border border-white/10 bg-zinc-950/95 p-3 text-xs text-zinc-300 shadow-[0_18px_48px_rgba(0,0,0,0.45)] backdrop-blur"
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
                className="inline-flex min-h-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 md:hidden"
                aria-expanded={showModelControls}
                aria-controls="model-controls"
              >
                {showModelControls ? "Hide model overrides" : "Model overrides"}
              </button>
            </div>
          </div>

          <div
            id="model-controls"
            className={[
              "grid gap-2 overflow-hidden transition-all",
              showModelControls ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 md:grid-rows-[1fr] md:opacity-100",
            ].join(" ")}
          >
            <div className="min-h-0">
              <div className="flex flex-col gap-2 md:flex-row md:flex-wrap">
                <label className="flex min-h-10 items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={!modelExplainerHidden}
                    onChange={(event) => handleModelExplainerVisibility(!event.target.checked)}
                    className="h-4 w-4 rounded border-white/15 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                    aria-label="Show model selection explainer"
                  />
                  <span>Show model selection explainer</span>
                </label>
                <label className="flex min-h-10 items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={showLiveReasoningExplainer}
                    onChange={(event) => handleLiveReasoningVisibility(event.target.checked)}
                    className="h-4 w-4 rounded border-white/15 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                    aria-label="Show live reasoning explainer"
                  />
                  <span>Show live reasoning explainer</span>
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
                      className="grid min-w-0 gap-1 rounded-2xl border border-white/10 bg-white/[0.035] p-2 text-[11px] text-zinc-300 md:w-[calc(50%-0.25rem)] lg:w-auto lg:min-w-[220px]"
                    >
                      <span className="capitalize text-zinc-500">{providerName}</span>
                      <select
                        value={selectedValue}
                        onChange={(event) => {
                          const nextModel = event.target.value;
                          setSelectedOverride(
                            nextModel ? { providerName, modelId: nextModel } : null,
                          );
                        }}
                        className="min-w-0 rounded-xl border border-white/10 bg-zinc-950/90 px-2.5 py-2 text-xs text-zinc-100 outline-none ring-emerald-500 transition focus:ring"
                      >
                        <option value="">Master Router (Auto)</option>
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

      {showLiveReasoningExplainer && reasoningPopupVisible ? (
        <div className="pointer-events-none absolute inset-x-[5%] bottom-24 z-40 sm:bottom-28">
          <div className="pointer-events-auto mx-auto w-full">
            <ReasoningExplainerPanel
              loading={loading}
              state={reasoningState}
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
        className="relative min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-28 sm:space-y-5 sm:px-6 sm:py-5 sm:pb-28"
      >
        {isHydratingMessages ? (
          <div className="max-w-2xl rounded-[28px] border border-white/10 bg-white/[0.035] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-sm">
            <p className="text-sm font-medium text-zinc-200">Loading saved thread…</p>
            <p className="mt-2 text-sm leading-6 text-zinc-500">Rehydrating the full persisted transcript for this chat.</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="max-w-2xl rounded-[28px] border border-white/10 bg-white/[0.035] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-sm">
            <p className="text-sm font-medium text-zinc-200">Ready for orchestration.</p>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              Start a new message to invoke the master router.
            </p>
          </div>
        ) : null}
        {messages.map((message) => (
          <div
            key={message.id}
            className={[
              "w-full max-w-4xl overflow-hidden rounded-[24px] border px-4 py-4 text-sm shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-sm sm:px-5",
              message.role === "user"
                ? "ml-auto border-emerald-400/20 bg-gradient-to-br from-emerald-400/14 via-emerald-500/8 to-sky-500/10"
                : "border-white/10 bg-white/[0.035]"
            ].join(" ")}
          >
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
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
                className="rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                {copiedMessageId === message.id ? "Copied" : "Copy"}
              </button>
            </div>
            {message.content ? (
              <p className="whitespace-pre-wrap break-words leading-7 text-zinc-100/95">{message.content}</p>
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
                : `${streamingModel ?? selectedOverride?.modelId ?? "Master Router"} is thinking...`}
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

      <form onSubmit={onSubmit} className="shrink-0 border-t border-white/10 px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:px-6 sm:py-4">
        <p className="sr-only" role="status" aria-live="polite">
          {statusMessage}
        </p>
        {!hasValidChatSelection ? (
          <p className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            Select an actor and chat to enable sending.
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
                  onClick={() =>
                    setSelectedImages((current) =>
                      current.filter(
                        (_, currentIndex) => currentIndex !== index,
                      ),
                    )
                  }
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

        <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-3 shadow-[0_20px_60px_rgba(0,0,0,0.2)] backdrop-blur-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.txt,.md,.json,.csv,.pdf,.docx,.doc,.xlsx,.xls,video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.webm,.m4v"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex min-h-11 items-center justify-center self-start rounded-2xl border border-white/10 bg-white/[0.05] px-3.5 py-3 text-sm text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:self-auto"
              aria-label="Attach files"
            >
              📷
            </button>
            <div className="relative min-w-0 flex-1">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="Ask your actor something..."
                className="min-h-[48px] max-h-48 w-full resize-none overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950/80 px-4 py-3 pr-14 text-sm text-zinc-100 outline-none ring-emerald-500 placeholder:text-zinc-500 focus:ring"
              />
              <div ref={emojiPickerRef} className="absolute bottom-2 right-2">
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
            <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto sm:flex-nowrap">
              {loading ? (
                <button
                  type="button"
                  onClick={handleCancelRequest}
                  className="min-h-11 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-100 transition hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="submit"
                disabled={!canSend}
                className="min-h-11 flex-1 rounded-2xl bg-gradient-to-r from-emerald-500 to-sky-500 px-5 py-3 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(16,185,129,0.25)] transition hover:brightness-110 disabled:opacity-50 sm:flex-none"
              >
                {loading || uploadingFiles ? "Routing..." : "Send"}
              </button>
            </div>
          </div>
        </div>
      </form>
    </main>
  );
}
