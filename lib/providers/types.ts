import type { VisualReview, VisualComparison } from "@/lib/research/visual-review";
export interface ResearchEvidenceSource {
  url: string;
  title?: string;
  snippet?: string;
}

export interface WebsiteEvidence {
  objective?: string;
  comparisons?: VisualComparison[];
  capturedAt: string;
  targetSource?: "current-message" | "history" | "summary" | "none";
  pages: WebsitePageEvidence[];
  limitations: string[];
}

export interface WebsitePageEvidence {
  requestedUrl: string;
  url: string;
  title: string;
  status?: number;
  html: string;
  htmlTruncated: boolean;
  stylesheets: Array<{ url: string; css: string; truncated: boolean }>;
  views: Array<{
    device: "desktop" | "mobile";
    viewport: { width: number; height: number };
    document: { width: number; height: number; horizontalOverflow: boolean };
    text: string;
    elements: Array<{
      tag: string;
      text: string;
      bounds: { x: number; y: number; width: number; height: number };
      styles: Record<string, string>;
    }>;
    images: Array<{ src: string; alt: string; loaded: boolean; width: number; height: number }>;
    visualReview?: VisualReview;
    screenshot?: { dataUrl: string; width: number; height: number; truncated: boolean };
    limitations: string[];
  }>;
  limitations: string[];
}

export interface ResearchEvidenceBundle {
  kind: "web";
  retrievedBy: {
    provider: "openai" | "google" | "grok" | "anthropic" | "katie";
    modelId: string;
  };
  query: string;
  summary: string;
  sources: ResearchEvidenceSource[];
  retrievedAt: string;
  website?: WebsiteEvidence;
}

export interface ExtractedTextChunkReference {
  physicalPage?: number;
  index: number;
  total: number;
  text: string;
  hash?: string;
}

export interface FileReference {
  /** Server-side provider rendering; omitted from compact browser references. */
  imageDataUrl?: string;
  nativeInspectionRequired?: boolean;
  storageToken?: string;
  sourceFingerprint?: string;
  pdfInventory?: import("@/lib/uploads/pdf-inventory").PdfInventory;
  pdfSourceOccurrence?: number;
  pdfContextBlocked?: boolean;
  pdfEvidence?: import("@/lib/uploads/pdf-evidence").PdfEvidence;
  fileId: string;
  fileName: string;
  mimeType: string;
  preview: string;
  extractedText?: string;
  extractedChunks?: ExtractedTextChunkReference[];
  totalChunks?: number;
  truncatedForContext?: boolean;
  extractionCoverage?: "preview-only" | "partial" | "full";
  attachmentKind?: "image" | "video" | "text" | "file";
  /** Timestamped JPEG frames captured from a video for vision-only fallback. */
  videoFrames?: Array<{ timestampSeconds: number; dataUrl: string }>;
  providerRef?: {
    openaiFileId?: string;
    googleFileUri?: string;
  };
}

export interface ProviderSystemAudit {
  provider: "openai" | "google" | "grok" | "anthropic";
  model: string;
  endpoint: string;
  /** The literal system-role messages or systemInstruction field constructed by the adapter. */
  systemMessages: string[];
  /** xAI Imagine has no system role: this is the literal bounded body.prompt. */
  imagePrompt?: string;
  contextSynthesis?: {
    mode: "direct" | "condensed"; sourceHistoryTurns: number;
    sourceSummaryChars: number; sourcePersonaChars: number; truncated: boolean;
  };
}

export interface ChatGenerateParams {
  /** Cancels the actual upstream transmission, including response consumption. */
  signal?: AbortSignal;
  /** Server-derived actor/conversation scope, shared by helper calls. */
  promptCacheKey?: string;
  /** Internal opt-in: bounded structured frame observations, no SDK inference retries. */
  boundedFrameObservations?: true;
  /** Server-restored historical evidence; never accepted directly from the browser request. */
  previousWebsiteEvidence?: WebsiteEvidence;
  name: string;
  persona: string;
  summary: string;
  user: string;
  history: { role: "user" | "assistant"; content: string }[];
  requestIntent?: string;
  secondaryIntents?: string[];
  modelId?: string;
  images?: string[];
  attachments?: FileReference[];
  researchEvidence?: ResearchEvidenceBundle;
  /** Inspection hook. Never supplies credentials, binary attachments, or full request headers. */
  onProviderSystemPrepared?: (audit: ProviderSystemAudit) => Promise<void>;
}

export interface ProviderResponse {
  text: string;
  model: string;
  provider: "openai" | "google" | "grok" | "anthropic";
  finishReason?: string;
  truncated?: boolean;
  continuationCount?: number;
  researchEvidence?: ResearchEvidenceBundle;
  collaboration?: {
    used: boolean;
    delegationCount: number;
    maxDepthReached: number;
    contributors: Array<{
      provider: "openai" | "google" | "grok" | "anthropic";
      modelId: string;
    }>;
    contributions: Array<{
      helper: {
        provider: "openai" | "google" | "grok" | "anthropic";
        modelId: string;
      };
      capability:
        | "analysis"
        | "verification"
        | "critique"
        | "coding"
        | "debugging"
        | "architecture"
        | "research"
        | "writing"
        | "math"
        | "vision"
        | "other";
      task: string;
      confidence?: "high" | "medium" | "low";
    }>;
    durationMs?: number;
  };
  content?: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    [key: string]: unknown;
  };
}

export interface ProviderStreamHandlers {
  onTextDelta?: (delta: string) => void | Promise<void>;
}

export interface LlmProvider {
  name: "openai" | "google" | "grok" | "anthropic";
  listModels(): Promise<string[]>;
  generateToolTurn?(params: import("@/lib/tools/types").ToolTurnParams): Promise<import("@/lib/tools/types").ToolTurn>;
  generate(params: ChatGenerateParams): Promise<ProviderResponse>;
  generateStream?(
    params: ChatGenerateParams,
    handlers: ProviderStreamHandlers
  ): Promise<ProviderResponse>;
}
