export interface FileReference {
  fileId: string;
  fileName: string;
  mimeType: string;
  preview: string;
  extractedText?: string;
  sourceFormat?: "text" | "word" | "excel" | "pdf" | "video";
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
  modelId?: string;
  images?: string[];
  attachments?: FileReference[];
}

export interface ProviderResponse {
  text: string;
  model: string;
  provider: "openai" | "google" | "grok" | "anthropic";
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
