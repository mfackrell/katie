export interface ResearchEvidenceSource {
  url: string;
  title?: string;
  snippet?: string;
}

export interface WebsiteEvidence {
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
    screenshot?: { dataUrl: string; width: number; height: number; truncated: boolean };
    limitations: string[];
  }>;
  limitations: string[];
}

export interface ResearchEvidenceBundle {
  kind: "web";
  retrievedBy: {
    provider: "openai" | "google" | "grok" | "anthropic";
    modelId: string;
  };
  query: string;
  summary: string;
  sources: ResearchEvidenceSource[];
  retrievedAt: string;
  website?: WebsiteEvidence;
}

export interface ExtractedTextChunkReference {
  index: number;
  total: number;
  text: string;
  hash?: string;
}

export interface FileReference {
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
  providerRef?: {
    openaiFileId?: string;
    googleFileUri?: string;
  };
}

export interface ChatGenerateParams {
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
  generate(params: ChatGenerateParams): Promise<ProviderResponse>;
  generateStream?(
    params: ChatGenerateParams,
    handlers: ProviderStreamHandlers
  ): Promise<ProviderResponse>;
}
